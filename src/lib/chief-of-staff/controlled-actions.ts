/**
 * Controlled AI Actions V1.
 *
 * TypeScript catalog → non-executable proposal → explicit OWNER
 * confirmation → re-read live records → fingerprint check →
 * existing canonical domain operation.
 *
 * Not a second mutation engine. Not a schema-first proposal table.
 * Specialists, synthesis, and Coach ask never call these functions.
 */
import { randomUUID } from "node:crypto";
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
import type { BsosRecommendation } from "@/lib/bsos";
import { loadCanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import type { ApprovalClass } from "@/lib/chief-of-staff/types";
import { PRODUCT_CAPABILITIES, type ProductCapabilityCode } from "@/lib/product-catalog";
import { ProductCapabilityRequiredError, requireProductCapability } from "@/lib/product-entitlements";

type Db = PrismaClient | Prisma.TransactionClient;

export const CONTROLLED_ACTION_KEYS = [
  "CREATE_RECOMMENDATION_ACTION_ITEM",
  "DISMISS_RECOMMENDATION",
  "COMPLETE_RECOMMENDATION",
] as const;
export type ControlledActionKey = (typeof CONTROLLED_ACTION_KEYS)[number];

/**
 * High-consequence operations that remain non-executable in V1.
 * Do not add these to CONTROLLED_ACTION_KEYS to make tests pass.
 */
export const EXCLUDED_ACTION_KEYS = [
  "UPDATE_ACTION_ITEM_STATUS",
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

export type ControlledActionTargetType = "RECOMMENDATION";

export type ControlledActionCatalogEntry = {
  key: ControlledActionKey;
  displayLabel: string;
  approvalClass: ApprovalClass;
  requiredRoleCapability: Capability;
  requiredProductCapability: ProductCapabilityCode | null;
  targetEntityType: ControlledActionTargetType;
  canonicalOperation: "createActionFromRecommendation" | "upsertRecommendationState";
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
] as const;

export const CONTROLLED_ACTION_PROPOSAL_VERSION = 1;
const MAX_PROPOSAL_JSON_CHARS = 8192;
const MAX_TARGET_ID_CHARS = 200;
const MAX_FINGERPRINT_CHARS = 2000;

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

export function canConfirmControlledActions(access: { workspace?: { role?: string } }) {
  return access.workspace?.role === "OWNER";
}

export function trustedControlledActionRecord(result: ControlledActionConfirmation) {
  return `Owner confirmed: ${result.summary} ${result.executionResult.message}`;
}

const inflightAttempts = new Map<string, Promise<ControlledActionConfirmation>>();

export function resetControlledActionAttempts() {
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

function attemptKey(
  proposal: Pick<ControlledActionProposal, "businessId" | "actionKey" | "targetEntityId" | "fingerprint">,
  executionAttemptId: string,
) {
  return `${proposal.businessId}:${proposal.actionKey}:${proposal.targetEntityId}:${proposal.fingerprint}:${executionAttemptId}`;
}

export type ControlledActionAuthTest = {
  denyProductCapabilities?: ProductCapabilityCode[];
  denyRoleCapabilities?: Capability[];
};

async function authorizeCatalogAccess(
  db: Db,
  access: BusinessAccess,
  entry: ControlledActionCatalogEntry,
  test?: ControlledActionAuthTest,
  options?: { ownerOnly?: boolean },
) {
  if (options?.ownerOnly) requireBusinessRole(access, "OWNER");
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
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

export function serializeControlledActionProposal(proposal: ControlledActionProposal) {
  return JSON.stringify(proposal);
}

function boundedString(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export function parseControlledActionProposal(raw: string): ControlledActionProposal | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PROPOSAL_JSON_CHARS) return null;
  try {
    const value = JSON.parse(raw) as Partial<ControlledActionProposal>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!isControlledActionKey(String(value.actionKey))) return null;
    const entry = getControlledActionEntry(String(value.actionKey));
    if (!entry) return null;
    const targetEntityId = boundedString(value.targetEntityId, MAX_TARGET_ID_CHARS);
    const fingerprint = boundedString(value.fingerprint, MAX_FINGERPRINT_CHARS);
    const businessId = boundedString(value.businessId, MAX_TARGET_ID_CHARS);
    if (!targetEntityId || !fingerprint || !businessId) return null;
    if (value.proposalVersion !== CONTROLLED_ACTION_PROPOSAL_VERSION) return null;
    return {
      proposalVersion: CONTROLLED_ACTION_PROPOSAL_VERSION,
      actionKey: entry.key,
      displayLabel: entry.displayLabel,
      approvalClass: entry.approvalClass,
      requiredRoleCapability: entry.requiredRoleCapability,
      requiredProductCapability: entry.requiredProductCapability,
      targetEntityType: entry.targetEntityType,
      targetEntityId,
      businessId,
      summary: "",
      parameters: {},
      fingerprint,
      freshnessInputs: {},
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

async function canonicalRecommendation(db: Db, businessId: string, recommendationKey: string) {
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
  return {
    recommendation,
    evidenceKey: recommendationEvidenceKey(recommendation),
    active: active.some((item) => item.key === recommendation.key),
  };
}

async function liveRecommendation(db: Db, businessId: string, recommendationKey: string) {
  const live = await canonicalRecommendation(db, businessId, recommendationKey);
  if (!live.active) {
    throw new ControlledActionError("That recommendation is not active from recorded facts.");
  }
  return live;
}

function serverProposalFromLive(
  access: BusinessAccess,
  entry: ControlledActionCatalogEntry,
  live: { recommendation: BsosRecommendation; evidenceKey: string },
): ControlledActionProposal {
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
    fingerprint: `recommendation:${entry.key}:${live.recommendation.key}:${live.evidenceKey}`,
    freshnessInputs: {
      recommendationKey: live.recommendation.key,
      evidenceKey: live.evidenceKey,
      title: live.recommendation.title,
      why: live.recommendation.why,
    },
    canonicalOperation: entry.canonicalOperation,
    externalEffect: false,
    freshnessRequired: true,
    confirmed: false,
    executionResult: null,
  };
}

export async function proposeControlledAction(
  db: Db,
  access: BusinessAccess,
  input: {
    actionKey: string;
    targetEntityId: string;
    /** Ignored. Browser businessId is never write authority. */
    browserBusinessId?: string;
    test?: ControlledActionAuthTest;
  },
): Promise<ControlledActionProposal> {
  voidBrowserBusinessId(input.browserBusinessId);
  const entry = assertExecutableKey(input.actionKey);
  await authorizeCatalogAccess(db, access, entry, input.test);
  const targetEntityId = input.targetEntityId.trim();
  if (!targetEntityId || targetEntityId.length > MAX_TARGET_ID_CHARS) {
    throw new ControlledActionError("Choose a live record.");
  }
  const live = await liveRecommendation(db, access.businessId, targetEntityId);
  return serverProposalFromLive(access, entry, live);
}

export type ConfirmControlledActionInput = {
  proposal: ControlledActionProposal;
  executionAttemptId: string;
  confirm: string;
  /** Ignored. Browser businessId is never write authority. */
  browserBusinessId?: string;
  test?: ControlledActionAuthTest;
};

async function recommendationStateFor(
  db: Db,
  businessId: string,
  recommendationKey: string,
) {
  return db.bsosRecommendationState.findUnique({
    where: {
      businessId_recommendationKey: {
        businessId,
        recommendationKey,
      },
    },
  });
}

async function ownedActionItemOrFail(
  db: Db,
  access: BusinessAccess,
  actionItemId: string,
) {
  const item = await db.businessActionItem.findFirst({
    where: { id: actionItemId, ...access.scope },
  });
  if (!item) {
    throw new ControlledActionError("That recorded action item is no longer available. TBBT did not change anything.");
  }
  return access.assertOwned(item);
}

function missingActionItemError() {
  return new ControlledActionError(
    "That recorded action item is no longer available. TBBT did not change anything.",
  );
}

async function existingActionForEvidence(
  db: Db,
  access: BusinessAccess,
  recommendationKey: string,
  evidenceKey: string,
) {
  const state = await recommendationStateFor(db, access.businessId, recommendationKey);
  if (!state || state.evidenceKey !== evidenceKey) return null;
  if (!state.actionItemId) throw missingActionItemError();
  return ownedActionItemOrFail(db, access, state.actionItemId);
}

function changedStateError() {
  return new ControlledActionError(
    "That proposal is stale. Live records changed. TBBT did not change anything.",
  );
}

async function alreadyAppliedResult(
  db: Db,
  access: BusinessAccess,
  entry: ControlledActionCatalogEntry,
  live: { recommendation: BsosRecommendation; evidenceKey: string },
): Promise<ControlledActionExecutionResult | null> {
  const state = await recommendationStateFor(db, access.businessId, live.recommendation.key);
  if (!state || state.evidenceKey !== live.evidenceKey) return null;

  if (entry.key === "CREATE_RECOMMENDATION_ACTION_ITEM") {
    if (!state.actionItemId) throw missingActionItemError();
    const item = await ownedActionItemOrFail(db, access, state.actionItemId);
    return {
      status: "REPLAYED",
      recordId: item.id,
      recordType: "BusinessActionItem",
      message: "Action already on the owner plan. TBBT did not execute the work.",
    };
  }
  if (entry.key === "DISMISS_RECOMMENDATION") {
    if (state.status === "DISMISSED") {
      return {
        status: "REPLAYED",
        recordId: state.id,
        recordType: "BsosRecommendationState",
        message: "Recommendation dismissed. It will stay in history until facts change.",
      };
    }
    if (state.status === "COMPLETED") throw changedStateError();
    return null;
  }
  if (state.status === "COMPLETED") {
    return {
      status: "REPLAYED",
      recordId: state.id,
      recordType: "BsosRecommendationState",
      message: "Recommendation marked complete for this business.",
    };
  }
  if (state.status === "DISMISSED") throw changedStateError();
  return null;
}

async function createRecommendationActionItemOnce(
  db: Db,
  access: BusinessAccess,
  live: { recommendation: BsosRecommendation; evidenceKey: string },
): Promise<ControlledActionExecutionResult> {
  const run = async (tx: Db) => {
    await tx.$executeRaw(
      Prisma.sql`
        INSERT INTO "BsosRecommendationState" (
          "id", "businessId", "recommendationKey", "status", "evidenceKey",
          "updatedByMembershipId", "createdAt", "updatedAt"
        )
        VALUES (
          ${`c${randomUUID().replace(/-/g, "")}`},
          ${access.businessId},
          ${live.recommendation.key},
          'OPEN',
          '',
          ${access.workspace.membership.id},
          NOW(),
          NOW()
        )
        ON CONFLICT ("businessId", "recommendationKey") DO NOTHING
      `,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "BsosRecommendationState" WHERE "businessId" = ${access.businessId} AND "recommendationKey" = ${live.recommendation.key} FOR UPDATE`,
    );
    const already = await existingActionForEvidence(tx, access, live.recommendation.key, live.evidenceKey);
    if (already) {
      return {
        status: "REPLAYED" as const,
        recordId: already.id,
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
  live: { recommendation: BsosRecommendation; evidenceKey: string },
): Promise<ControlledActionExecutionResult> {
  if (entry.canonicalOperation === "createActionFromRecommendation") {
    return createRecommendationActionItemOnce(db, access, live);
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
  if (input.proposal.businessId !== access.businessId) {
    throw new ControlledActionError("That proposal is not for this workspace.");
  }
  await authorizeCatalogAccess(db, access, entry, input.test, { ownerOnly: true });

  const live = await canonicalRecommendation(db, access.businessId, input.proposal.targetEntityId);
  const serverProposal = serverProposalFromLive(access, entry, live);
  if (serverProposal.fingerprint !== input.proposal.fingerprint) {
    throw changedStateError();
  }

  const already = await alreadyAppliedResult(db, access, entry, live);
  if (already) {
    return {
      ...serverProposal,
      confirmed: true,
      executionAttemptId: input.executionAttemptId,
      executionResult: already,
    };
  }
  if (!live.active) {
    throw new ControlledActionError("That recommendation is not active from recorded facts.");
  }

  const key = attemptKey(serverProposal, input.executionAttemptId);
  const pending = inflightAttempts.get(key);
  if (pending) {
    const first = await pending;
    return {
      ...serverProposal,
      confirmed: true,
      executionAttemptId: input.executionAttemptId,
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
    const result = await invokeCanonicalOperation(db, access, entry, live);
    const confirmation: ControlledActionConfirmation = {
      ...serverProposal,
      confirmed: true,
      executionAttemptId: input.executionAttemptId,
      executionResult: result,
    };
    resolveWork(confirmation);
    return confirmation;
  } catch (error) {
    rejectWork(error);
    throw error;
  } finally {
    inflightAttempts.delete(key);
  }
}
