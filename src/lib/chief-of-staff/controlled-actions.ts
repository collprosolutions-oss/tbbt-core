/**
 * Controlled AI Actions V1.
 *
 * TypeScript catalog → non-executable proposal → explicit OWNER
 * confirmation → re-read live records → fingerprint check → new
 * execution-attempt ID → existing canonical domain operation.
 *
 * Not a second mutation engine. Not a schema-first proposal table.
 * Specialists, synthesis, and Coach ask never call these functions.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { isAiAttemptId } from "@/lib/ai/types";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  requireBusinessRole,
  type Capability,
} from "@/lib/authorization";
import {
  createActionFromRecommendation,
  partitionRecommendations,
  recommendationEvidenceKey,
  upsertRecommendationState,
} from "@/lib/bsos-actions";
import { updateBusinessActionStatus } from "@/lib/bsos-ops";
import { isActionStatus, type BsosRecommendation } from "@/lib/bsos";
import { loadCanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import type { ApprovalClass } from "@/lib/chief-of-staff/types";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog";
import { ProductCapabilityRequiredError, requireProductCapability } from "@/lib/product-entitlements";

type Db = PrismaClient | Prisma.TransactionClient;

export const CONTROLLED_ACTION_KEYS = [
  "CREATE_RECOMMENDATION_ACTION_ITEM",
  "DISMISS_RECOMMENDATION",
  "COMPLETE_RECOMMENDATION",
  "UPDATE_ACTION_ITEM_STATUS",
] as const;
export type ControlledActionKey = (typeof CONTROLLED_ACTION_KEYS)[number];

/**
 * High-consequence operations that remain non-executable in V1.
 * Do not add these to CONTROLLED_ACTION_KEYS to make tests pass.
 */
export const EXCLUDED_ACTION_KEYS = [
  "SEND_CUSTOMER_EMAIL",
  "SEND_CUSTOMER_SMS",
  "MAKE_PHONE_CALL",
  "CHANGE_CONSENT",
  "CHARGE_CARD",
  "REFUND",
  "MARK_PAID",
  "SUPPLIER_PURCHASE",
  "COMMIT_PURCHASE_ORDER",
  "AUTHORIZE_PAYROLL",
  "CANCEL_SUBSCRIPTION",
  "OFFBOARD_EXPORT_DELETE",
  "PUBLISH_WEBSITE",
  "SIGN_AGREEMENT",
  "COMPLETE_AGREEMENT",
  "MUTATE_VAULT_LEGAL_STATE",
  "CHANGE_PERMISSIONS",
  "CHANGE_ROLE",
  "TRANSFER_OWNERSHIP",
  "CONFIRM_APPOINTMENT",
  "SCHEDULE_JOB",
  "RESCHEDULE_JOB",
  "ASSIGN_WORKER",
  "CHANGE_PRICING",
  "SEND_ESTIMATE",
  "APPROVE_ESTIMATE",
  "SEND_INVOICE",
  "CHANGE_PAYMENT_ACCOUNT",
  "APPROVE_KNOWLEDGE",
  "APPLY_LAUNCH_SETUP",
] as const;
export type ExcludedActionKey = (typeof EXCLUDED_ACTION_KEYS)[number];

export type ControlledActionTargetType = "RECOMMENDATION" | "ACTION_ITEM";

export type ControlledActionCatalogEntry = {
  key: ControlledActionKey;
  displayLabel: string;
  approvalClass: ApprovalClass;
  requiredRoleCapability: Capability;
  requiredProductCapability: ProductCapabilityCode | null;
  targetEntityType: ControlledActionTargetType;
  canonicalOperation:
    | "createActionFromRecommendation"
    | "upsertRecommendationState"
    | "updateBusinessActionStatus";
  externalEffect: false;
  freshnessRequired: true;
  purpose: string;
  whyAllowed: string;
};

export const CONTROLLED_ACTION_CATALOG: readonly ControlledActionCatalogEntry[] = [
  {
    key: "CREATE_RECOMMENDATION_ACTION_ITEM",
    displayLabel: "Create owner action-plan item",
    approvalClass: "OWNER_CONFIRMED_RECORD",
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    targetEntityType: "RECOMMENDATION",
    canonicalOperation: "createActionFromRecommendation",
    externalEffect: false,
    freshnessRequired: true,
    purpose: "Create an owner plan row from a live catalog recommendation.",
    whyAllowed:
      "Creates a BusinessActionItem only. TBBT does not execute the work, send messages, or move money. Reversible via action-item status.",
  },
  {
    key: "DISMISS_RECOMMENDATION",
    displayLabel: "Dismiss recommendation",
    approvalClass: "OWNER_CONFIRMED_RECORD",
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    targetEntityType: "RECOMMENDATION",
    canonicalOperation: "upsertRecommendationState",
    externalEffect: false,
    freshnessRequired: true,
    purpose: "Dismiss a live catalog recommendation for the current evidence.",
    whyAllowed:
      "Owner plan state only. Uses the existing evidence fingerprint. No customer contact, spend, or publish.",
  },
  {
    key: "COMPLETE_RECOMMENDATION",
    displayLabel: "Mark recommendation complete",
    approvalClass: "OWNER_CONFIRMED_RECORD",
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    targetEntityType: "RECOMMENDATION",
    canonicalOperation: "upsertRecommendationState",
    externalEffect: false,
    freshnessRequired: true,
    purpose: "Mark a live catalog recommendation complete for the current evidence.",
    whyAllowed:
      "Owner plan state only. Does not collect money, send messages, or change domain records.",
  },
  {
    key: "UPDATE_ACTION_ITEM_STATUS",
    displayLabel: "Update action-item status",
    approvalClass: "OWNER_CONFIRMED_RECORD",
    requiredRoleCapability: CAPABILITIES.VIEW_REPORTS,
    requiredProductCapability: PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
    targetEntityType: "ACTION_ITEM",
    canonicalOperation: "updateBusinessActionStatus",
    externalEffect: false,
    freshnessRequired: true,
    purpose: "Update an existing owner action-item status.",
    whyAllowed: "Owner plan CRUD on an existing BusinessActionItem. No domain execution.",
  },
] as const;

export const CONTROLLED_ACTION_PROPOSAL_VERSION = 1;

export type ControlledActionProposal = {
  proposalVersion: typeof CONTROLLED_ACTION_PROPOSAL_VERSION;
  actionKey: ControlledActionKey;
  displayLabel: string;
  approvalClass: ApprovalClass;
  requiredRoleCapability: Capability;
  requiredProductCapability: ProductCapabilityCode | null;
  targetEntityType: ControlledActionTargetType;
  targetEntityId: string;
  businessId: string;
  summary: string;
  parameters: Record<string, string>;
  fingerprint: string;
  freshnessInputs: Record<string, string>;
  canonicalOperation: ControlledActionCatalogEntry["canonicalOperation"];
  externalEffect: false;
  freshnessRequired: true;
  confirmed: false;
  executionResult: null;
};

export type ControlledActionExecutionResult = {
  status: "SUCCEEDED" | "REPLAYED";
  recordId: string | null;
  recordType: "BusinessActionItem" | "BsosRecommendationState";
  message: string;
};

export type ControlledActionConfirmation = Omit<ControlledActionProposal, "confirmed" | "executionResult"> & {
  confirmed: true;
  executionAttemptId: string;
  executionResult: ControlledActionExecutionResult;
};

export class ControlledActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlledActionError";
  }
}

export function isControlledActionKey(value: string): value is ControlledActionKey {
  return (CONTROLLED_ACTION_KEYS as readonly string[]).includes(value);
}

export function isExcludedActionKey(value: string): value is ExcludedActionKey {
  return (EXCLUDED_ACTION_KEYS as readonly string[]).includes(value);
}

export function getControlledActionEntry(key: string) {
  return CONTROLLED_ACTION_CATALOG.find((row) => row.key === key) ?? null;
}

export function executableControlledActionKeys() {
  return CONTROLLED_ACTION_CATALOG.map((row) => row.key);
}

const executionAttempts = new Map<string, ControlledActionConfirmation>();
const inflightAttempts = new Map<string, Promise<ControlledActionConfirmation>>();

export function resetControlledActionAttempts() {
  executionAttempts.clear();
  inflightAttempts.clear();
}

export function controlledActionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ControlledActionError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof ProductCapabilityRequiredError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "ProductCapabilityRequiredError") return error.message;
  if (error instanceof Error && error.name === "BsosError") return error.message;
  return fallback;
}

function voidBrowserBusinessId(browserBusinessId?: string) {
  void browserBusinessId;
}

function assertExecutableKey(actionKey: string): ControlledActionCatalogEntry {
  if (isExcludedActionKey(actionKey) || !isControlledActionKey(actionKey)) {
    throw new ControlledActionError("That action is not executable.");
  }
  const entry = getControlledActionEntry(actionKey);
  if (!entry) throw new ControlledActionError("That action is not executable.");
  return entry;
}

function attemptKey(businessId: string, actionKey: string, executionAttemptId: string) {
  return `${businessId}:${actionKey}:${executionAttemptId}`;
}

export function serializeControlledActionProposal(proposal: ControlledActionProposal) {
  return JSON.stringify(proposal);
}

export function parseControlledActionProposal(raw: string): ControlledActionProposal | null {
  try {
    const value = JSON.parse(raw) as Partial<ControlledActionProposal>;
    if (!value || typeof value !== "object") return null;
    if (!isControlledActionKey(String(value.actionKey))) return null;
    const entry = getControlledActionEntry(String(value.actionKey));
    if (!entry) return null;
    if (value.confirmed !== false || value.executionResult !== null) return null;
    if (value.proposalVersion !== CONTROLLED_ACTION_PROPOSAL_VERSION) return null;
    if (typeof value.businessId !== "string" || !value.businessId) return null;
    if (typeof value.targetEntityId !== "string" || !value.targetEntityId) return null;
    if (typeof value.fingerprint !== "string" || !value.fingerprint) return null;
    if (typeof value.summary !== "string" || !value.summary) return null;
    if (value.targetEntityType !== entry.targetEntityType) return null;
    if (value.canonicalOperation !== entry.canonicalOperation) return null;
    if (value.externalEffect !== false) return null;
    return {
      proposalVersion: CONTROLLED_ACTION_PROPOSAL_VERSION,
      actionKey: entry.key,
      displayLabel: entry.displayLabel,
      approvalClass: entry.approvalClass,
      requiredRoleCapability: entry.requiredRoleCapability,
      requiredProductCapability: entry.requiredProductCapability,
      targetEntityType: entry.targetEntityType,
      targetEntityId: value.targetEntityId,
      businessId: value.businessId,
      summary: value.summary,
      parameters:
        value.parameters && typeof value.parameters === "object" && !Array.isArray(value.parameters)
          ? Object.fromEntries(
              Object.entries(value.parameters).filter(
                (pair): pair is [string, string] => typeof pair[1] === "string",
              ),
            )
          : {},
      fingerprint: value.fingerprint,
      freshnessInputs:
        value.freshnessInputs &&
        typeof value.freshnessInputs === "object" &&
        !Array.isArray(value.freshnessInputs)
          ? Object.fromEntries(
              Object.entries(value.freshnessInputs).filter(
                (pair): pair is [string, string] => typeof pair[1] === "string",
              ),
            )
          : {},
      canonicalOperation: entry.canonicalOperation,
      externalEffect: false,
      freshnessRequired: true,
      confirmed: false,
      executionResult: null,
    };
  } catch {
    return null;
  }
}

async function liveRecommendation(db: Db, businessId: string, recommendationKey: string) {
  const catalog = await loadCanonicalRecommendationCatalog(db, businessId);
  const recommendation = catalog.recommendations.find((item) => item.key === recommendationKey);
  if (!recommendation) {
    throw new ControlledActionError("That recommendation is not active from recorded facts.");
  }
  const states = await db.bsosRecommendationState.findMany({
    where: { businessId },
    select: { recommendationKey: true, status: true, evidenceKey: true },
  });
  const { active } = partitionRecommendations(catalog.recommendations, states);
  if (!active.some((item) => item.key === recommendation.key)) {
    throw new ControlledActionError("That recommendation is not active from recorded facts.");
  }
  const evidenceKey = recommendationEvidenceKey(recommendation);
  return {
    recommendation,
    evidenceKey,
    fingerprint: `recommendation:${recommendation.key}:${evidenceKey}`,
    freshnessInputs: {
      recommendationKey: recommendation.key,
      evidenceKey,
      title: recommendation.title,
      why: recommendation.why,
    },
  };
}

async function liveActionItem(db: Db, access: BusinessAccess, actionItemId: string) {
  const item = access.assertOwned(
    await db.businessActionItem.findFirst({
      where: { id: actionItemId, ...access.scope },
    }),
  );
  return {
    item,
    fingerprint: `action-item:${item.id}:${item.status}:${item.recommendationKey}:${item.updatedAt.toISOString()}`,
    freshnessInputs: {
      actionItemId: item.id,
      status: item.status,
      recommendationKey: item.recommendationKey,
      updatedAt: item.updatedAt.toISOString(),
    },
  };
}

export async function proposeControlledAction(
  db: Db,
  access: BusinessAccess,
  input: {
    actionKey: string;
    targetEntityId: string;
    parameters?: Record<string, string>;
    /** Ignored. Browser businessId is never write authority. */
    browserBusinessId?: string;
  },
): Promise<ControlledActionProposal> {
  voidBrowserBusinessId(input.browserBusinessId);
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const entry = assertExecutableKey(input.actionKey);
  requireBusinessCapability(access, entry.requiredRoleCapability);
  const targetEntityId = input.targetEntityId.trim();
  if (!targetEntityId) throw new ControlledActionError("Choose a live record.");

  if (entry.targetEntityType === "RECOMMENDATION") {
    const live = await liveRecommendation(db, access.businessId, targetEntityId);
    const verb =
      entry.key === "CREATE_RECOMMENDATION_ACTION_ITEM"
        ? "Create an internal action-plan item"
        : entry.key === "DISMISS_RECOMMENDATION"
          ? "Dismiss this recommendation"
          : "Mark this recommendation complete";
    return {
      proposalVersion: CONTROLLED_ACTION_PROPOSAL_VERSION,
      actionKey: entry.key,
      displayLabel: entry.displayLabel,
      approvalClass: entry.approvalClass,
      requiredRoleCapability: entry.requiredRoleCapability,
      requiredProductCapability: entry.requiredProductCapability,
      targetEntityType: entry.targetEntityType,
      targetEntityId: live.recommendation.key,
      businessId: access.businessId,
      summary: `${verb} for “${live.recommendation.title}”. Why: ${live.recommendation.why} This will not contact the customer, charge money, change the schedule, or perform the work.`,
      parameters: { recommendationKey: live.recommendation.key },
      fingerprint: live.fingerprint,
      freshnessInputs: live.freshnessInputs,
      canonicalOperation: entry.canonicalOperation,
      externalEffect: false,
      freshnessRequired: true,
      confirmed: false,
      executionResult: null,
    };
  }

  const nextStatus = input.parameters?.nextStatus?.trim() ?? "";
  if (!isActionStatus(nextStatus)) throw new ControlledActionError("Choose a valid action status.");
  const live = await liveActionItem(db, access, targetEntityId);
  return {
    proposalVersion: CONTROLLED_ACTION_PROPOSAL_VERSION,
    actionKey: entry.key,
    displayLabel: entry.displayLabel,
    approvalClass: entry.approvalClass,
    requiredRoleCapability: entry.requiredRoleCapability,
    requiredProductCapability: entry.requiredProductCapability,
    targetEntityType: entry.targetEntityType,
    targetEntityId: live.item.id,
    businessId: access.businessId,
    summary: `Update action “${live.item.title}” from ${live.item.status} to ${nextStatus}. This will not contact the customer, charge money, change the schedule, or perform the work.`,
    parameters: { actionItemId: live.item.id, nextStatus },
    fingerprint: live.fingerprint,
    freshnessInputs: live.freshnessInputs,
    canonicalOperation: entry.canonicalOperation,
    externalEffect: false,
    freshnessRequired: true,
    confirmed: false,
    executionResult: null,
  };
}

export type ConfirmControlledActionInput = {
  proposal: ControlledActionProposal;
  executionAttemptId: string;
  confirm: string;
  /** Ignored. Browser businessId is never write authority. */
  browserBusinessId?: string;
  test?: {
    denyProductCapabilities?: ProductCapabilityCode[];
    denyRoleCapabilities?: Capability[];
  };
};

async function authorizeConfirm(
  db: Db,
  access: BusinessAccess,
  entry: ControlledActionCatalogEntry,
  test?: ConfirmControlledActionInput["test"],
) {
  requireBusinessRole(access, "OWNER");
  if (test?.denyRoleCapabilities?.includes(entry.requiredRoleCapability)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, entry.requiredRoleCapability);
  if (entry.requiredProductCapability) {
    if (test?.denyProductCapabilities?.includes(entry.requiredProductCapability)) {
      throw new ProductCapabilityRequiredError(entry.requiredProductCapability);
    }
    await requireProductCapability(db, access.businessId, entry.requiredProductCapability);
  }
}

async function existingActionForEvidence(
  db: Db,
  access: BusinessAccess,
  recommendationKey: string,
  evidenceKey: string,
) {
  const state = await db.bsosRecommendationState.findUnique({
    where: {
      businessId_recommendationKey: {
        businessId: access.businessId,
        recommendationKey,
      },
    },
  });
  if (!state?.actionItemId || state.evidenceKey !== evidenceKey) return null;
  return access.assertOwned(
    await db.businessActionItem.findFirst({
      where: { id: state.actionItemId, ...access.scope },
    }),
  );
}

async function createRecommendationActionItemOnce(
  db: Db,
  access: BusinessAccess,
  live: { recommendation: BsosRecommendation; evidenceKey: string },
): Promise<ControlledActionExecutionResult> {
  const already = await existingActionForEvidence(db, access, live.recommendation.key, live.evidenceKey);
  if (already) {
    return {
      status: "REPLAYED",
      recordId: already.id,
      recordType: "BusinessActionItem",
      message: "Action already on the owner plan. TBBT did not execute the work.",
    };
  }

  const run = async (tx: Db) => {
    let state = await tx.bsosRecommendationState.findUnique({
      where: {
        businessId_recommendationKey: {
          businessId: access.businessId,
          recommendationKey: live.recommendation.key,
        },
      },
    });
    if (!state) {
      state = await tx.bsosRecommendationState.create({
        data: {
          businessId: access.businessId,
          recommendationKey: live.recommendation.key,
          status: "OPEN",
          evidenceKey: "",
          updatedByMembershipId: access.workspace.membership.id,
        },
      });
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "BsosRecommendationState" WHERE id = ${state.id} FOR UPDATE`);
    const locked = await existingActionForEvidence(tx, access, live.recommendation.key, live.evidenceKey);
    if (locked) {
      return {
        status: "REPLAYED" as const,
        recordId: locked.id,
        recordType: "BusinessActionItem" as const,
        message: "Action already on the owner plan. TBBT did not execute the work.",
      };
    }
    const created = await createActionFromRecommendation(tx, access, live.recommendation);
    return {
      status: "SUCCEEDED" as const,
      recordId: created.id,
      recordType: "BusinessActionItem" as const,
      message: "Action added to the owner plan. TBBT did not execute the work.",
    };
  };

  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction((tx) => run(tx));
  }
  return run(db);
}

async function invokeCanonicalOperation(
  db: Db,
  access: BusinessAccess,
  entry: ControlledActionCatalogEntry,
  proposal: ControlledActionProposal,
): Promise<ControlledActionExecutionResult> {
  if (entry.canonicalOperation === "createActionFromRecommendation") {
    const live = await liveRecommendation(db, access.businessId, proposal.targetEntityId);
    if (live.fingerprint !== proposal.fingerprint) {
      throw new ControlledActionError(
        "That proposal is stale. Live records changed. TBBT did not change anything.",
      );
    }
    return createRecommendationActionItemOnce(db, access, live);
  }

  if (entry.canonicalOperation === "upsertRecommendationState") {
    const live = await liveRecommendation(db, access.businessId, proposal.targetEntityId);
    if (live.fingerprint !== proposal.fingerprint) {
      throw new ControlledActionError(
        "That proposal is stale. Live records changed. TBBT did not change anything.",
      );
    }
    const status = entry.key === "DISMISS_RECOMMENDATION" ? "DISMISSED" : "COMPLETED";
    const state = await upsertRecommendationState(db, access, {
      recommendationKey: live.recommendation.key,
      status,
      evidenceKey: live.evidenceKey,
    });
    return {
      status: "SUCCEEDED",
      recordId: state.id,
      recordType: "BsosRecommendationState",
      message:
        status === "DISMISSED"
          ? "Recommendation dismissed. It will stay in history until facts change."
          : "Recommendation marked complete for this business.",
    };
  }

  const nextStatus = proposal.parameters.nextStatus ?? "";
  if (!isActionStatus(nextStatus)) throw new ControlledActionError("Choose a valid action status.");
  const live = await liveActionItem(db, access, proposal.targetEntityId);
  if (live.fingerprint !== proposal.fingerprint) {
    throw new ControlledActionError(
      "That proposal is stale. Live records changed. TBBT did not change anything.",
    );
  }
  const updated = await updateBusinessActionStatus(db, access, {
    actionId: live.item.id,
    status: nextStatus,
  });
  return {
    status: "SUCCEEDED",
    recordId: updated.id,
    recordType: "BusinessActionItem",
    message: "Action item updated.",
  };
}

async function executeConfirmedAction(
  db: Db,
  access: BusinessAccess,
  input: ConfirmControlledActionInput,
  entry: ControlledActionCatalogEntry,
): Promise<ControlledActionConfirmation> {
  if (input.proposal.businessId !== access.businessId) {
    throw new ControlledActionError("That proposal is not for this workspace.");
  }
  if (input.proposal.actionKey !== entry.key) {
    throw new ControlledActionError("That action is not executable.");
  }
  const result = await invokeCanonicalOperation(db, access, entry, input.proposal);
  return {
    ...input.proposal,
    confirmed: true,
    executionAttemptId: input.executionAttemptId,
    executionResult: result,
  };
}

export async function confirmControlledAction(
  db: Db,
  access: BusinessAccess,
  input: ConfirmControlledActionInput,
): Promise<ControlledActionConfirmation> {
  voidBrowserBusinessId(input.browserBusinessId);
  if (input.confirm !== "confirm") {
    throw new ControlledActionError("Confirm this action explicitly.");
  }
  if (!isAiAttemptId(input.executionAttemptId)) {
    throw new ControlledActionError("Retry that confirmation from the form.");
  }
  const entry = assertExecutableKey(input.proposal.actionKey);
  const key = attemptKey(access.businessId, entry.key, input.executionAttemptId);
  const replayed = executionAttempts.get(key);
  if (replayed) {
    return {
      ...replayed,
      executionResult: { ...replayed.executionResult, status: "REPLAYED" },
    };
  }
  const pending = inflightAttempts.get(key);
  if (pending) {
    const first = await pending;
    return {
      ...first,
      executionResult: { ...first.executionResult, status: "REPLAYED" },
    };
  }

  let resolveWork: (value: ControlledActionConfirmation) => void = () => undefined;
  let rejectWork: (error: unknown) => void = () => undefined;
  const work = new Promise<ControlledActionConfirmation>((resolve, reject) => {
    resolveWork = resolve;
    rejectWork = reject;
  });
  work.catch(() => undefined);
  inflightAttempts.set(key, work);

  try {
    await authorizeConfirm(db, access, entry, input.test);
    const confirmation = await executeConfirmedAction(db, access, input, entry);
    executionAttempts.set(key, confirmation);
    resolveWork(confirmation);
    return confirmation;
  } catch (error) {
    rejectWork(error);
    throw error;
  } finally {
    inflightAttempts.delete(key);
  }
}
