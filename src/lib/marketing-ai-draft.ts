/**
 * OWNER-requested Marketing Studio content draft through the canonical
 * AI provider. Template drafts stay on Create Content. This path does
 * not publish a website, post socially, or send a customer message.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { resolveAiProvider } from "@/lib/ai/provider";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { runAiTask } from "@/lib/ai/service";
import {
  isAiAttemptId,
  type AiInteractionStatus,
  type AiProvider,
} from "@/lib/ai/types";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  MARKETING_AI_DRAFT_REVIEW_ONLY_MESSAGE,
  MARKETING_AI_DRAFT_SAVED_MESSAGE,
  MARKETING_AI_UNAVAILABLE_LABEL,
  OWNER_MARKETING_AI_DRAFT_MESSAGE,
  marketingAiDraftStatusLabel,
} from "@/lib/marketing";
import { createMarketingContent, MarketingError } from "@/lib/marketing-ops";

type Db = PrismaClient | Prisma.TransactionClient;

const MARKETING_DRAFT_FACT_KEYS = ["workPerformed", "city", "photoCount", "businessName"] as const;

export const MARKETING_AI_DRAFT_UNUSABLE_FALLBACK =
  "The AI provider did not return a usable marketing draft.";

export type BoundedMarketingDraftFacts = {
  businessName: string;
  workPerformed: string | null;
  city: string | null;
  photoCount: number;
  jobId: string | null;
};

export type OwnerMarketingAiDraftResult = {
  status: "UNAVAILABLE" | AiInteractionStatus;
  message: string;
  publishable: false;
  contentId: string | null;
  text?: string;
  inProgress?: boolean;
  interactionId?: string;
};

export { marketingAiDraftStatusLabel };

export async function loadBoundedMarketingDraftFacts(
  db: Db,
  businessId: string,
): Promise<BoundedMarketingDraftFacts> {
  const scope = { businessId };
  const [business, job] = await Promise.all([
    db.business.findFirst({
      where: { id: businessId },
      select: { name: true, publicServiceAreaLabel: true },
    }),
    db.job.findFirst({
      where: { ...scope, status: "COMPLETED" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        estimate: {
          select: {
            lineItems: {
              select: { description: true, serviceCatalogItemId: true },
              take: 1,
            },
          },
        },
        photos: {
          where: { marketingPermissionStatus: "APPROVED" },
          select: { id: true },
        },
      },
    }),
  ]);

  const line = job?.estimate?.lineItems[0];
  let workPerformed = line?.description?.trim() || null;
  if (line?.serviceCatalogItemId) {
    const catalog = await db.serviceCatalogItem.findFirst({
      where: { id: line.serviceCatalogItemId, ...scope },
      select: { name: true },
    });
    workPerformed = catalog?.name?.trim() || workPerformed;
  }

  return {
    businessName: business?.name?.trim() || "Business",
    workPerformed,
    city: business?.publicServiceAreaLabel?.trim() || null,
    photoCount: job?.photos.length ?? 0,
    jobId: job?.id ?? null,
  };
}

function draftTitle(text: string, workPerformed: string | null) {
  const firstLine = text.split("\n")[0]?.trim() || "";
  if (firstLine) return sanitizeAiText(firstLine, 80);
  return workPerformed
    ? `Draft: ${sanitizeAiText(workPerformed, 60)}`
    : "Marketing content draft";
}

export async function requestOwnerMarketingContentDraft(
  db: Db,
  access: BusinessAccess,
  input: {
    attemptId: string;
    provider?: AiProvider;
  },
): Promise<OwnerMarketingAiDraftResult> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingError(OWNER_MARKETING_AI_DRAFT_MESSAGE);
  }
  if (!isAiAttemptId(input.attemptId)) {
    throw new MarketingError("Retry that request from the form.");
  }

  const provider = input.provider ?? resolveAiProvider();
  if (!provider.connected) {
    return {
      status: "UNAVAILABLE",
      message: MARKETING_AI_UNAVAILABLE_LABEL,
      publishable: false,
      contentId: null,
    };
  }

  const facts = await loadBoundedMarketingDraftFacts(db, access.businessId);
  const idempotencyKey = `marketing:MARKETING_DRAFT:${access.businessId}:${input.attemptId}`;
  const result = await runAiTask(
    db,
    {
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
      userId: access.workspace.user.id,
    },
    {
      taskType: "MARKETING_DRAFT",
      system:
        "Draft one internal marketing caption from recorded TBBT context only. Return JSON {text, stance, citedFactKeys, notes}. Never invent reviews, customer names, phones, or results. Never publish, post, or send a customer message. Content remains DRAFT.",
      user: JSON.stringify({
        businessName: facts.businessName,
        workPerformed: facts.workPerformed,
        city: facts.city,
        photoCount: facts.photoCount,
      }),
      inputSummary: "owner marketing content draft",
      idempotencyKey,
      fallback: {
        text: MARKETING_AI_DRAFT_UNUSABLE_FALLBACK,
        stance: "RECOMMENDATION",
        citedFactKeys: [],
        notes: MARKETING_AI_DRAFT_REVIEW_ONLY_MESSAGE,
      },
      allowedFactKeys: [...MARKETING_DRAFT_FACT_KEYS],
      provider,
    },
  );

  if (result.status === "PENDING") {
    return {
      status: result.status,
      message: result.message,
      publishable: false,
      contentId: null,
      inProgress: true,
      interactionId: result.interactionId,
    };
  }

  const text = result.status === "COMPLETED" ? result.output?.text?.trim() : "";
  if (!text || result.status !== "COMPLETED") {
    return {
      status: result.status,
      message: result.message,
      publishable: false,
      contentId: null,
      interactionId: result.interactionId,
    };
  }

  const existing = await db.marketingContent.findFirst({
    where: {
      businessId: access.businessId,
      createdByMembershipId: access.workspace.membership.id,
      status: "DRAFT",
      body: text,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, body: true },
  });
  const content =
    existing ??
    (await createMarketingContent(db, access, {
      contentType: facts.workPerformed ? "COMPLETED_JOB" : "GENERAL_POST",
      title: draftTitle(text, facts.workPerformed),
      body: text,
      channelIntent: "UNASSIGNED",
      jobId: facts.jobId ?? undefined,
    }));

  return {
    status: result.status,
    message: MARKETING_AI_DRAFT_SAVED_MESSAGE,
    publishable: false,
    contentId: content.id,
    text: content.body,
    interactionId: result.interactionId,
  };
}
