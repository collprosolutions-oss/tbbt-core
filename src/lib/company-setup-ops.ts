/**
 * Build My Company proposal mutations.
 * AI never writes Core records here. Owner approval is required, and
 * forbidden kinds stay BLOCKED.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { createBusinessGoal } from "@/lib/bsos-ops";
import { completeLaunchStep } from "@/lib/business-launch-ops";
import { createOwnedQuoteService } from "@/lib/catalog-ops";
import {
  COMPANY_SETUP_FORBIDDEN_MESSAGE,
  COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE,
  isBlockedCompanySetupKind,
  isCompanySetupItemKind,
  type CompanySetupProposalDraftItem,
} from "@/lib/company-setup";
import { createKnowledgeEntry } from "@/lib/knowledge-ops";
import { saveMarketingBrandVoice } from "@/lib/marketing-ops";
import { createOperatingProcedure } from "@/lib/operating-procedures-ops";
import { updateWebsiteStoryOp } from "@/lib/settings-ops";

type Db = PrismaClient | Prisma.TransactionClient;

export class CompanySetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanySetupError";
  }
}

export function companySetupErrorMessage(error: unknown, fallback: string) {
  if (error instanceof CompanySetupError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "LaunchError") return error.message;
  if (error instanceof Error && error.name === "CatalogOpsError") return error.message;
  if (error instanceof Error && error.name === "SettingsError") return error.message;
  if (error instanceof Error && error.name === "KnowledgeError") return error.message;
  return fallback;
}

function itemStatusForKind(kind: string) {
  return isBlockedCompanySetupKind(kind) ? "BLOCKED" : "PENDING";
}

export async function createCompanySetupProposal(
  db: Db,
  access: BusinessAccess,
  input: {
    inputText: string;
    summary: string;
    items: CompanySetupProposalDraftItem[];
    interactionId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.USE_AI_ASSIST);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const inputText = input.inputText.trim();
  if (inputText.length < 12) {
    throw new CompanySetupError("Describe the business in a few sentences first.");
  }
  if (input.items.length === 0) {
    throw new CompanySetupError("The proposal did not include any reviewable items.");
  }

  return db.companySetupProposal.create({
    data: {
      businessId: access.businessId,
      createdByMembershipId: access.workspace.membership.id,
      inputText,
      proposalSummary: `${input.summary.trim()}\n\n${COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE}`,
      interactionId: input.interactionId ?? null,
      items: {
        create: input.items.map((item) => {
          const kind = isCompanySetupItemKind(item.kind) ? item.kind : "SETUP_CHOICE";
          return {
            businessId: access.businessId,
            kind,
            title: item.title.trim().slice(0, 160),
            body: item.body.trim(),
            payloadJson: JSON.stringify(item.payload ?? {}),
            status: itemStatusForKind(kind),
          };
        }),
      },
    },
    include: { items: true },
  });
}

async function requireOwnedProposal(db: Db, access: BusinessAccess, proposalId: string) {
  return access.assertOwned(
    await db.companySetupProposal.findFirst({
      where: { id: proposalId, ...access.scope },
      include: { items: true },
    }),
  );
}

async function refreshProposalStatus(db: Db, access: BusinessAccess, proposalId: string) {
  const proposal = await requireOwnedProposal(db, access, proposalId);
  const actionable = proposal.items.filter((item) => item.status !== "BLOCKED");
  const applied = actionable.filter((item) => item.status === "APPLIED").length;
  const rejected = actionable.filter((item) => item.status === "REJECTED").length;
  const pending = actionable.filter((item) => item.status === "PENDING" || item.status === "APPROVED").length;
  const status =
    applied === 0 && rejected === 0
      ? "DRAFT"
      : pending === 0 && applied === actionable.length
        ? "APPLIED"
        : pending === 0
          ? "REVIEWED"
          : applied > 0
            ? "PARTIALLY_APPLIED"
            : "REVIEWED";
  return db.companySetupProposal.update({
    where: { id: proposal.id },
    data: { status },
    include: { items: true },
  });
}

export async function reviewCompanySetupItem(
  db: Db,
  access: BusinessAccess,
  input: { itemId: string; decision: "APPROVED" | "REJECTED" },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const item = access.assertOwned(
    await db.companySetupProposalItem.findFirst({
      where: { id: input.itemId, ...access.scope },
    }),
  );
  if (item.status === "BLOCKED") {
    throw new CompanySetupError(COMPANY_SETUP_FORBIDDEN_MESSAGE);
  }
  if (item.status === "APPLIED") {
    throw new CompanySetupError("That proposal item was already applied.");
  }
  await db.companySetupProposalItem.update({
    where: { id: item.id },
    data: { status: input.decision },
  });
  return refreshProposalStatus(db, access, item.proposalId);
}

export async function applyCompanySetupItem(db: PrismaClient, access: BusinessAccess, itemId: string) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const item = access.assertOwned(
    await db.companySetupProposalItem.findFirst({
      where: { id: itemId, ...access.scope },
    }),
  );
  if (isBlockedCompanySetupKind(item.kind) || item.status === "BLOCKED") {
    throw new CompanySetupError(COMPANY_SETUP_FORBIDDEN_MESSAGE);
  }
  if (item.status !== "APPROVED") {
    throw new CompanySetupError("Approve the proposal item before applying it.");
  }
  if (item.kind === "PRICING") {
    throw new CompanySetupError(
      "AI pricing stays a proposal. Set a minimum charge or catalog price yourself after review.",
    );
  }

  let appliedRecordKind: string | null = null;
  let appliedRecordId: string | null = null;
  const payload = safeJson(item.payloadJson);

  if (item.kind === "SERVICE") {
    const created = await createOwnedQuoteService(db, access, {
      name: String(payload.name ?? item.title),
      description: String(payload.description ?? item.body),
    });
    appliedRecordKind = "SERVICE";
    appliedRecordId = created.id;
  } else if (item.kind === "DESCRIPTION") {
    await updateWebsiteStoryOp(db, access, {
      rawOwnerStory: item.body,
      approvedPublicAboutCopy: item.body,
    });
    appliedRecordKind = "WEBSITE_STORY";
    appliedRecordId = access.businessId;
  } else if (item.kind === "BRAND_VOICE") {
    await saveMarketingBrandVoice(db, access, {
      brandVoice: item.body,
      identityNotes: String(payload.identityNotes ?? ""),
    });
    appliedRecordKind = "BRAND_VOICE";
    appliedRecordId = access.businessId;
  } else if (item.kind === "GOAL") {
    const goal = await createBusinessGoal(db, access, {
      title: item.title,
      description: item.body,
      recommendationKey: "launch-ai-goal",
    });
    appliedRecordKind = "GOAL";
    appliedRecordId = goal.id;
  } else if (item.kind === "PROCEDURE") {
    const procedure = await createOperatingProcedure(db, access, {
      title: item.title,
      summary: item.body,
      steps: Array.isArray(payload.steps)
        ? payload.steps.map((step) => ({
            title: String((step as { title?: string }).title ?? "Step"),
            body: String((step as { body?: string }).body ?? ""),
          }))
        : [{ title: item.title, body: item.body }],
    });
    appliedRecordKind = "PROCEDURE";
    appliedRecordId = procedure.id;
  } else if (item.kind === "SETUP_CHOICE") {
    const stepKey = String(payload.stepKey ?? "");
    if (stepKey === "stage" || stepKey === "team" || stepKey === "payments" || stepKey === "scheduling") {
      await completeLaunchStep(db, access, {
        stepKey,
        businessStage: String(payload.businessStage ?? ""),
        teamNotes: String(payload.teamNotes ?? item.body),
        paymentNotes: String(payload.paymentNotes ?? item.body),
        schedulingNotes: String(payload.schedulingNotes ?? item.body),
      });
    } else {
      await createKnowledgeEntry(db, access, {
        title: item.title,
        body: item.body,
        category: "CUSTOMERS_POLICIES",
        sourceType: "OWNER_CREATED",
        knowledgeKind: "BUSINESS_RULE",
      });
    }
    appliedRecordKind = "SETUP_CHOICE";
    appliedRecordId = access.businessId;
  } else {
    throw new CompanySetupError(COMPANY_SETUP_FORBIDDEN_MESSAGE);
  }

  await db.companySetupProposalItem.update({
    where: { id: item.id },
    data: {
      status: "APPLIED",
      appliedAt: new Date(),
      appliedRecordKind,
      appliedRecordId,
    },
  });
  return refreshProposalStatus(db, access, item.proposalId);
}

function safeJson(raw: string) {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
