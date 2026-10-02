import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import {
  AI_FAILURE_MESSAGE,
  AI_NOT_CONNECTED_MESSAGE,
  isAiAttemptId,
  type AiProvider,
} from "@/lib/ai/types";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { draftMarketingContent, type MarketingDraft, type MarketingDraftInput } from "@/lib/marketing-draft";
import { createMarketingContent, MarketingError } from "@/lib/marketing-ops";
import {
  canRequestOwnerMarketingContentDraft,
  MARKETING_OWNER_DRAFT_COST_BOUNDED_MESSAGE,
  MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS,
  MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS,
  MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT,
  MARKETING_OWNER_DRAFT_MONTHLY_TOKEN_BUDGET,
  MARKETING_OWNER_DRAFT_REVIEW_MESSAGE,
  MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE,
  OWNER_CONTENT_DRAFT_MESSAGE,
} from "@/lib/marketing";
import { runAiTask, type AiServiceActor } from "@/lib/ai/service";

type Db = PrismaClient | Prisma.TransactionClient;

export type MarketingDraftVariation = MarketingDraft & {
  variation: "A" | "B" | "C";
  hashtags: string[];
  cta: string;
};

function localHashtags(input: MarketingDraftInput) {
  const city = input.city?.trim().replace(/\s+/g, "") || "";
  return [
    "#LocalHandyman",
    city ? `#${city}` : "#HomeRepair",
    "#SmallBusiness",
  ].slice(0, 3);
}

function ctaFor(input: MarketingDraftInput) {
  return input.city
    ? `Ask about ${input.serviceName || "this service"} in ${input.city}.`
    : `Ask about ${input.serviceName || "this service"}.`;
}

export function draftMarketingVariations(input: MarketingDraftInput): MarketingDraftVariation[] {
  const base = draftMarketingContent(input);
  const tags = localHashtags(input);
  const cta = ctaFor(input);
  return [
    { ...base, variation: "A", hashtags: tags, cta },
    {
      ...base,
      variation: "B",
      title: `${base.title} — local update`,
      body: `${base.body}\n\n${cta}`,
      hashtags: tags,
      cta,
    },
    {
      ...base,
      variation: "C",
      title: `Homeowner note: ${input.serviceName || input.workPerformed || "completed work"}`,
      body: `${base.body}\n\nHashtags stay local and generic. Nothing is published.`,
      hashtags: tags,
      cta,
    },
  ];
}

export function weeklyMarketingPlanFromActivity(input: {
  completedJobs: number;
  approvedPhotos: number;
  reviews: number;
  campaigns: number;
  serviceAreas: number;
}) {
  const items = [];
  if (input.completedJobs > 0) {
    items.push({
      day: "Monday",
      title: "Completed-job post",
      why: `${input.completedJobs} completed job(s) are on file.`,
    });
  }
  if (input.approvedPhotos > 0) {
    items.push({
      day: "Wednesday",
      title: "Photo story draft",
      why: `${input.approvedPhotos} marketing-approved photo(s) can be attached.`,
    });
  }
  if (input.reviews > 0) {
    items.push({
      day: "Friday",
      title: "Review-to-content draft",
      why: `${input.reviews} recorded review(s) exist. Do not copy review text without permission.`,
    });
  }
  if (input.campaigns > 0 || input.serviceAreas > 0) {
    items.push({
      day: "Weekend",
      title: "Service-area reminder draft",
      why: "Campaign or service-area records exist. This is an internal plan, not an ad buy.",
    });
  }
  if (items.length === 0) {
    items.push({
      day: "This week",
      title: "Record more completed work first",
      why: "Not enough recorded marketing-ready activity to plan posts.",
    });
  }
  return {
    mode: "TEMPLATE" as const,
    message: AI_NOT_CONNECTED_MESSAGE,
    publishable: false as const,
    items,
  };
}

export async function weeklyMarketingPlanWithAi(
  db: Db,
  actor: AiServiceActor,
  input: Parameters<typeof weeklyMarketingPlanFromActivity>[0],
  idempotencyKey: string,
) {
  const fallbackText = weeklyMarketingPlanFromActivity(input)
    .items.map((item) => `${item.day}: ${item.title} — ${item.why}`)
    .join("\n");
  const result = await runAiTask(db, actor, {
    taskType: "WEEKLY_PLAN",
    system:
      "Draft an internal weekly marketing plan from recorded TBBT activity only. Return JSON {text, stance, citedFactKeys, notes}. Never invent audience size, ad spend, or published results. Content remains DRAFT.",
    user: JSON.stringify(input),
    inputSummary: "weekly marketing plan",
    idempotencyKey,
    fallback: {
      text: fallbackText,
      stance: "RECOMMENDATION",
      citedFactKeys: ["completedJobs", "approvedPhotos", "reviews"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["completedJobs", "approvedPhotos", "reviews", "campaigns", "serviceAreas"],
  });
  return {
    ...weeklyMarketingPlanFromActivity(input),
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? undefined : result.output?.text ?? fallbackText,
    publishable: false as const,
  };
}

export function campaignIdeasFromActivity(input: {
  leadSources: string[];
  completedJobs: number;
  unpaidInvoices: number;
}) {
  const ideas = [];
  if (input.completedJobs > 0) {
    ideas.push("Turn a completed job with approved photos into a DRAFT social post.");
  }
  if (input.leadSources.includes("REFERRAL")) {
    ideas.push("Recorded referrals already convert. Draft a referral thank-you, do not auto-send.");
  }
  if (input.leadSources.includes("GOOGLE") || input.leadSources.includes("WEBSITE")) {
    ideas.push("Website/Google leads are already attributed. Improve the public site draft, not an ad account.");
  }
  if (input.unpaidInvoices > 0) {
    ideas.push("Unpaid invoices are a collections task, not a marketing campaign.");
  }
  if (ideas.length === 0) {
    ideas.push("No recorded campaign-ready activity yet. TBBT will not invent audience size or ad results.");
  }
  return {
    mode: "TEMPLATE" as const,
    message: AI_NOT_CONNECTED_MESSAGE,
    publishable: false as const,
    ideas,
  };
}

export async function campaignIdeasWithAi(
  db: Db,
  actor: AiServiceActor,
  input: Parameters<typeof campaignIdeasFromActivity>[0],
  idempotencyKey: string,
) {
  const fallback = campaignIdeasFromActivity(input);
  const result = await runAiTask(db, actor, {
    taskType: "CAMPAIGN_IDEAS",
    system:
      "Suggest internal campaign ideas from recorded TBBT activity only. Return JSON {text, stance, citedFactKeys, notes}. Never invent ad results or spend money. Ideas stay DRAFT.",
    user: JSON.stringify(input),
    inputSummary: "campaign ideas",
    idempotencyKey,
    fallback: {
      text: fallback.ideas.join("\n"),
      stance: "RECOMMENDATION",
      citedFactKeys: ["completedJobs", "unpaidInvoices"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["completedJobs", "unpaidInvoices", "leadSources"],
  });
  return {
    ...fallback,
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? undefined : result.output?.text ?? fallback.ideas.join("\n"),
    publishable: false as const,
  };
}

export async function draftMarketingVariationsWithAi(
  db: Db,
  actor: AiServiceActor,
  input: MarketingDraftInput,
  idempotencyKey: string,
) {
  const fallback = draftMarketingVariations(input);
  const result = await runAiTask(db, actor, {
    taskType: "MARKETING_DRAFT",
    system:
      "Draft social-post variations from recorded TBBT context. Return JSON {text, stance, citedFactKeys, notes}. Never invent reviews, customer names, or publish anything.",
    user: JSON.stringify({
      serviceName: input.serviceName,
      workPerformed: input.workPerformed,
      city: input.city,
      photoCount: input.photoCount,
    }),
    inputSummary: "marketing draft variations",
    idempotencyKey,
    fallback: {
      text: fallback.map((row) => row.body).join("\n\n"),
      stance: "RECOMMENDATION",
      citedFactKeys: ["workPerformed"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["workPerformed", "city", "photoCount"],
  });
  return {
    variations: fallback,
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? undefined : result.output?.text ?? fallback.map((row) => row.body).join("\n\n"),
    publishable: false as const,
  };
}

const OWNER_DRAFT_ALLOWED_FACT_KEYS = ["businessName", "city", "workPerformed", "approvedPhotoCount"] as const;

function monthStartUtc(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function titleFromOwnerDraftText(text: string) {
  const line = text.split(/\n/)[0]?.trim() || "Owner-requested content draft";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export async function marketingOwnerDraftBudgetUsed(
  db: Db,
  businessId: string,
  now = new Date(),
) {
  const periodStart = monthStartUtc(now);
  const usage = await db.aiInteraction.aggregate({
    where: {
      businessId,
      taskType: "MARKETING_DRAFT",
      createdAt: { gte: periodStart },
      status: { in: ["COMPLETED", "FAILED", "VALIDATION_FAILED"] },
    },
    _count: true,
    _sum: { promptTokens: true, completionTokens: true },
  });
  const tokens = (usage._sum.promptTokens ?? 0) + (usage._sum.completionTokens ?? 0);
  return {
    requestCount: usage._count,
    tokens,
    exhausted:
      usage._count >= MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT ||
      tokens >= MARKETING_OWNER_DRAFT_MONTHLY_TOKEN_BUDGET,
  };
}

export type OwnerMarketingContentDraftResult = {
  status: "UNAVAILABLE" | "COMPLETED" | "FAILED" | "VALIDATION_FAILED" | "PENDING";
  message: string;
  contentId?: string;
  text?: string;
  interactionId?: string;
  publishable: false;
  published: false;
  posted: false;
  customerMessageSent: false;
  fabricatedFacts: false;
};

/**
 * OWNER-requested Marketing Studio content draft. Uses the canonical
 * runAiTask / resolveAiProvider path. Does not create a template draft,
 * publish a website, post socially, or send a customer message.
 */
export async function requestOwnerMarketingContentDraft(
  db: Db,
  access: BusinessAccess,
  input: {
    attemptId: string;
    jobId?: string | null;
    ownerNote?: string | null;
    /** Test-only. Production omits this and uses resolveAiProvider(). */
    provider?: AiProvider;
    now?: Date;
  },
): Promise<OwnerMarketingContentDraftResult> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  requireBusinessCapability(access, CAPABILITIES.USE_AI_ASSIST);
  if (!canRequestOwnerMarketingContentDraft(access.workspace.role)) {
    throw new MarketingError(OWNER_CONTENT_DRAFT_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
  if (!isAiAttemptId(input.attemptId)) {
    throw new MarketingError("Retry that request from the form.");
  }

  const closed = {
    publishable: false as const,
    published: false as const,
    posted: false as const,
    customerMessageSent: false as const,
    fabricatedFacts: false as const,
  };

  const budget = await marketingOwnerDraftBudgetUsed(db, access.businessId, input.now);
  if (budget.exhausted) {
    return {
      status: "UNAVAILABLE",
      message: MARKETING_OWNER_DRAFT_COST_BOUNDED_MESSAGE,
      ...closed,
    };
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, name: true, publicServiceAreaLabel: true },
  });
  if (!business) {
    throw new MarketingError("That business is not in this workspace.");
  }

  const settings = await db.businessSettings.findUnique({
    where: { businessId: access.businessId },
    select: { marketingBrandVoice: true },
  });

  let jobId: string | undefined;
  let workPerformed = "completed work";
  let approvedPhotoCount = 0;
  const requestedJobId = input.jobId?.trim();
  if (requestedJobId) {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: requestedJobId, ...access.scope, status: "COMPLETED" },
        select: {
          id: true,
          businessId: true,
          estimate: {
            select: {
              lineItems: {
                select: { serviceCatalogItem: { select: { name: true } } },
                take: 3,
              },
            },
          },
          photos: {
            where: { marketingPermissionStatus: "APPROVED" },
            select: { id: true },
          },
        },
      }),
    );
    jobId = job.id;
    const catalogName = job.estimate?.lineItems
      .map((item) => item.serviceCatalogItem?.name?.trim())
      .find((name) => Boolean(name));
    workPerformed = catalogName || "completed work";
    approvedPhotoCount = job.photos.length;
  }

  const facts = {
    businessName: sanitizeAiText(business.name, 80),
    city: sanitizeAiText(business.publicServiceAreaLabel ?? "", 80) || null,
    workPerformed: sanitizeAiText(workPerformed, 80),
    approvedPhotoCount,
    brandVoice: sanitizeAiText(settings?.marketingBrandVoice ?? "", 160) || null,
    ownerNote: sanitizeAiText(input.ownerNote ?? "", 400) || null,
  };
  const user = sanitizeAiText(JSON.stringify(facts), MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS);

  const actor: AiServiceActor = {
    businessId: access.businessId,
    membershipId: access.workspace.membership.id,
    userId: access.workspace.user?.id ?? null,
  };

  const result = await runAiTask(db, actor, {
    taskType: "MARKETING_DRAFT",
    system:
      "Draft one internal marketing content item from recorded TBBT facts only. Return JSON {text, stance, citedFactKeys, notes}. Never invent reviews, prices, customer names, licenses, results, audience size, or rankings. Never publish, post, or send a customer message. The result remains a DRAFT for owner review.",
    user,
    inputSummary: jobId ? `owner content draft job ${jobId}` : "owner content draft",
    idempotencyKey: `marketing:owner-content-draft:${access.businessId}:${input.attemptId}`,
    fallback: {
      text: MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE,
      stance: "RECOMMENDATION",
      citedFactKeys: [],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: [...OWNER_DRAFT_ALLOWED_FACT_KEYS],
    allowRetry: false,
    maxOutputTokens: MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS,
    ...(input.provider ? { provider: input.provider } : {}),
  });

  if (result.status === "PENDING") {
    return {
      status: "PENDING",
      message: result.message,
      interactionId: result.interactionId,
      ...closed,
    };
  }

  if (result.status !== "COMPLETED" || !result.output?.text) {
    return {
      status: result.status === "SKIPPED_NOT_CONNECTED" ? "UNAVAILABLE" : result.status === "VALIDATION_FAILED" ? "VALIDATION_FAILED" : "FAILED",
      message:
        result.status === "SKIPPED_NOT_CONNECTED"
          ? MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE
          : result.status === "VALIDATION_FAILED"
            ? result.message
            : AI_FAILURE_MESSAGE,
      interactionId: result.interactionId,
      ...closed,
    };
  }

  const text = result.output.text;
  const title = titleFromOwnerDraftText(text);
  const existing = await db.marketingContent.findFirst({
    where: {
      businessId: access.businessId,
      createdByMembershipId: access.workspace.membership.id,
      status: "DRAFT",
      body: text,
    },
    orderBy: { createdAt: "desc" },
  });
  const content =
    existing ??
    (await createMarketingContent(db, access, {
      contentType: jobId ? "COMPLETED_JOB" : "GENERAL_POST",
      title,
      body: text,
      channelIntent: "UNASSIGNED",
      jobId,
    }));

  return {
    status: "COMPLETED",
    message: MARKETING_OWNER_DRAFT_REVIEW_MESSAGE,
    contentId: content.id,
    text,
    interactionId: result.interactionId,
    ...closed,
  };
}
