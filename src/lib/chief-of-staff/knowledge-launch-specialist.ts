/**
 * Deep KNOWLEDGE_LAUNCH specialist. Same specialist identity as the PR1
 * placeholder.
 *
 * Loads one bounded read-only projection when selected. Interprets
 * existing Knowledge Hub and Business Launch truth. Does not create a
 * second Knowledge engine, second Launch engine, or new business setup
 * system. Does not write knowledge, launch, settings, providers, or
 * proposals. Does not call other specialists.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import {
  LAUNCH_NO_PUBLISH_MESSAGE,
  LAUNCH_NO_SUBSCRIPTION_MESSAGE,
  LAUNCH_STEP_KEYS,
  LAUNCH_STEP_LABELS,
  buildLaunchProgressSummary,
  type LaunchProgressStatus,
  type LaunchStepKey,
  type LaunchStepStatus,
} from "@/lib/business-launch";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import {
  recordKnowledgeLaunchProjectionLoad,
  recordKnowledgeLaunchSpecialistInterpretation,
  shouldInjectKnowledgeLaunchLoadFailure,
} from "@/lib/chief-of-staff/knowledge-launch-snapshot";
import type {
  CosEntityHints,
  SpecialistFinding,
  SpecialistResult,
  SpecialistSkipReason,
} from "@/lib/chief-of-staff/types";
import {
  COMPANY_SETUP_ITEM_STATUSES,
  COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE,
  COMPANY_SETUP_PROPOSAL_STATUSES,
} from "@/lib/company-setup";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import {
  KNOWLEDGE_APPROVAL_STATES,
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_TRUST_STATES,
  SYSTEM_DERIVED_DISABLED_MESSAGE,
  isKnowledgeApprovalState,
  isKnowledgeSourceType,
  isKnowledgeTrustState,
  needsKnowledgeReview,
  type KnowledgeApprovalState,
  type KnowledgeSourceType,
  type KnowledgeTrustState,
} from "@/lib/knowledge";
import { getBusinessPaymentStatus } from "@/lib/payments";
import { resolveProductEntitlement } from "@/lib/product-entitlements";
import type { ProductCapabilityCode } from "@/lib/product-catalog/codes";
import { isEmailDeliveryConfigured } from "@/lib/settings";

type Db = PrismaClient | Prisma.TransactionClient;

export const KNOWLEDGE_LAUNCH_OWNED_RECOMMENDATION_KEYS = [
  "finish-business-launch",
  "review-experience-learnings",
  "approve-business-knowledge",
] as const;

export type KnowledgeLaunchOwnedRecommendationKey =
  (typeof KNOWLEDGE_LAUNCH_OWNED_RECOMMENDATION_KEYS)[number];

export const KNOWLEDGE_LAUNCH_CONTEXT_CAPS = {
  entries: 8,
  candidates: 8,
  procedures: 8,
  launchSteps: LAUNCH_STEP_KEYS.length,
  proposals: 3,
  proposalItems: 5,
  proposalTitle: 80,
  explainedEntries: 3,
  explainedCandidates: 1,
  explainedUnfinishedSteps: 6,
  findings: 16,
  facts: 24,
  entityIds: 4,
  excerpt: 240,
  procedureSteps: 4,
} as const;

const FORBIDDEN_PROJECTION_KEYS = [
  "body",
  "evidenceJson",
  "createdByMembershipId",
  "approvedByMembershipId",
  "lastReviewedByMembershipId",
  "reviewedByMembershipId",
  "password",
  "secret",
  "token",
  "apiKey",
  "inputText",
  "proposalSummary",
  "payloadJson",
  "appliedRecordId",
  "stripeAccountId",
  "accountSid",
  "authToken",
];

export function isKnowledgeLaunchOwnedRecommendationKey(
  key: string,
): key is KnowledgeLaunchOwnedRecommendationKey {
  return (KNOWLEDGE_LAUNCH_OWNED_RECOMMENDATION_KEYS as readonly string[]).includes(key);
}

export function knowledgeLaunchEntitlementLimitation(
  reason: SpecialistSkipReason,
) {
  if (reason === "NOT_AUTHORIZED") {
    return "Knowledge Hub and Business Launch records were not loaded because this role cannot read those management records. Assigned field work is not business-wide Knowledge Hub or Launch data. Missing Knowledge/Launch data is not treated as empty knowledge or a finished launch.";
  }
  if (reason === "NOT_ENTITLED") {
    return "Knowledge Hub and Business Launch records were not loaded because this workspace does not have an active operating subscription. Missing Knowledge/Launch data is not treated as empty knowledge or a finished launch.";
  }
  return "Recorded Knowledge Hub and Business Launch data is unavailable. Missing Knowledge/Launch data is not treated as empty knowledge or a finished launch.";
}

export const KNOWLEDGE_NOT_AUTHORIZED_LIMITATION =
  "Knowledge Hub records were not loaded under the current role boundary. Missing Knowledge data is not empty knowledge.";

export const LAUNCH_NOT_AUTHORIZED_LIMITATION =
  "Business Launch progress, launch steps, and provider launch state were not loaded under the current role boundary. Missing Launch data is not a finished launch and is not zero remaining steps.";

export const SETUP_NOT_AUTHORIZED_LIMITATION =
  "Build-my-company setup proposals were not loaded under the current role boundary. Missing proposal data is not applied setup.";

export const KNOWLEDGE_LAUNCH_FAILURE_LIMITATION =
  "Recorded Knowledge Hub and Business Launch data could not be loaded. No substitute knowledge, invented lesson, or invented launch completion was substituted.";

export const TARGET_CONSISTENCY_LIMITATION =
  "The supplied record targets did not resolve to one consistent owned Knowledge or Launch context.";

export function unreviewedIsNotApproved(approvalState: string) {
  return approvalState !== "APPROVED";
}

export function candidateIsNotApprovedKnowledge(status: string, knowledgeEntryId?: string | null) {
  return status !== "APPROVED" || !knowledgeEntryId;
}

export function estimateIsLabeledEstimate(trustState: string) {
  return trustState === "ESTIMATE";
}

export function unknownStaysUnknown(trustState: string) {
  return trustState === "UNKNOWN";
}

export function conflictRemainsConflict(trustState: string) {
  return trustState === "CONFLICT";
}

export function supportedIsNotVerified(trustState: string) {
  return trustState === "SUPPORTED";
}

export function externalReferenceIsNotInternallyVerified(sourceType: string) {
  return sourceType === "EXTERNAL_REFERENCE";
}

export function systemDerivedIsReserved(sourceType: string) {
  return sourceType === "SYSTEM_DERIVED";
}

export function launchStatusesRemainDistinct(status: string): LaunchStepStatus | null {
  return status === "PENDING" || status === "COMPLETED" || status === "SKIPPED" || status === "DEFERRED"
    ? status
    : null;
}

export function launchCompleteDoesNotImplyWebsite(launchStatus: string, websitePublished: boolean) {
  return launchStatus === "COMPLETED" && !websitePublished;
}

export function launchCompleteDoesNotImplyProvider(
  launchStatus: string,
  providerConnected: boolean,
) {
  return launchStatus === "COMPLETED" && !providerConnected;
}

export function proposalIsNotAppliedSetup(status: string) {
  return status !== "APPLIED";
}

export function setupItemPendingIsNotApproved(status: string) {
  return status === "PENDING";
}

export function setupItemApprovedIsNotApplied(status: string) {
  return status === "APPROVED";
}

export function setupItemRejectedIsNotApplied(status: string) {
  return status === "REJECTED";
}

export function setupItemBlockedIsNotApplied(status: string) {
  return status === "BLOCKED";
}

export function setupProposalIsNotCompletedLaunch(status: string) {
  return (
    status === "DRAFT" ||
    status === "REVIEWED" ||
    status === "PARTIALLY_APPLIED" ||
    status === "DISCARDED"
  );
}

export function isKnowledgeLaunchOwnerRole(role: string) {
  return role === "OWNER";
}

export type KnowledgeEntryProjection = {
  id: string;
  businessId: string;
  title: string;
  category: string;
  knowledgeKind: string | null;
  approvalState: KnowledgeApprovalState;
  trustState: KnowledgeTrustState;
  sourceType: KnowledgeSourceType;
  sourceKind: string | null;
  sourceLabel: string | null;
  excerpt: string;
  archived: boolean;
  targeted: boolean;
};

export type KnowledgeCandidateProjection = {
  id: string;
  businessId: string;
  title: string;
  kind: string;
  status: string;
  confidence: string;
  excerpt: string;
  knowledgeEntryId: string | null;
  isApprovedKnowledge: false;
  targeted: boolean;
};

export type KnowledgeProcedureProjection = {
  id: string;
  businessId: string;
  title: string;
  summaryExcerpt: string;
  approvalState: string;
  stepCount: number;
  stepTitles: string[];
  knowledgeEntryId: string | null;
  targeted: boolean;
};

export type LaunchStepProjection = {
  stepKey: LaunchStepKey;
  label: string;
  status: LaunchStepStatus;
};

export type KnowledgeLaunchProviderState = {
  stripeStatus: string;
  stripePaymentReady: boolean;
  emailConfigured: boolean;
  smsConfigured: boolean;
  storageConfigured: boolean;
  websitePublished: boolean;
};

export type KnowledgeLaunchProjectionTotals = {
  entries: number | null;
  approved: number | null;
  unreviewed: number | null;
  rejected: number | null;
  needsReview: number | null;
  conflicts: number | null;
  estimates: number | null;
  unknown: number | null;
  supported: number | null;
  verified: number | null;
  externalReferences: number | null;
  systemDerived: number | null;
  candidates: number | null;
  candidateOpen: number | null;
  procedures: number | null;
  launchPending: number | null;
  launchCompleted: number | null;
  launchSkipped: number | null;
  launchDeferred: number | null;
  setupProposals: number | null;
  setupItems: number | null;
  setupPending: number | null;
  setupApproved: number | null;
  setupRejected: number | null;
  setupApplied: number | null;
  setupBlocked: number | null;
};

export type SetupProposalItemProjection = {
  id: string;
  kind: string;
  title: string;
  status: string;
  applied: boolean;
  blocked: boolean;
};

export type SetupProposalProjection = {
  id: string;
  status: string;
  itemCount: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  appliedCount: number;
  blockedCount: number;
  items: SetupProposalItemProjection[];
};

export type KnowledgeLaunchReadScope = {
  knowledge: boolean;
  launch: boolean;
  setup: boolean;
};

export type KnowledgeLaunchProjection = {
  totals: KnowledgeLaunchProjectionTotals;
  entries: KnowledgeEntryProjection[];
  candidates: KnowledgeCandidateProjection[];
  procedures: KnowledgeProcedureProjection[];
  launch: {
    loaded: boolean;
    status: LaunchProgressStatus | null;
    definedStepCount: number | null;
    progressPercent: number | null;
    recommendedNext: LaunchStepKey | null;
    steps: LaunchStepProjection[];
  };
  setup: {
    loaded: boolean;
    proposals: SetupProposalProjection[];
  };
  providers: KnowledgeLaunchProviderState | null;
  canReadKnowledge: boolean;
  canReadLaunch: boolean;
  canReadSetup: boolean;
  canReadDeep: boolean;
  targetedEntryUnauthorized: boolean;
  targetedCandidateUnauthorized: boolean;
  targetedProcedureUnauthorized: boolean;
  targetedEntityMismatch: boolean;
  snapshotReused: false;
};

export type KnowledgeLaunchSpecialistInput = {
  db: Db;
  access: BusinessAccess;
  catalog: CanonicalRecommendationCatalog;
  question: string;
  entityHints?: CosEntityHints;
  denyProductCapabilities?: ProductCapabilityCode[];
  denyRoleCapabilities?: Capability[];
};

let lastKnowledgeLaunchProjection: KnowledgeLaunchProjection | null = null;

export function resetLastKnowledgeLaunchProjection() {
  lastKnowledgeLaunchProjection = null;
}

export function getLastKnowledgeLaunchProjection() {
  return lastKnowledgeLaunchProjection;
}

function addFact(facts: Record<string, string>, keys: string[], key: string, value: string) {
  if (keys.includes(key) || keys.length >= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.facts) return;
  facts[key] = value;
  keys.push(key);
}

function hasRole(access: BusinessAccess, capability: Capability, deny?: Capability[]) {
  if (deny?.includes(capability)) return false;
  return roleHasCapability(access.workspace.role, capability);
}

function excerptText(value: string | null | undefined) {
  return sanitizeAiText(value ?? "", KNOWLEDGE_LAUNCH_CONTEXT_CAPS.excerpt);
}

function proposalTitle(value: string | null | undefined) {
  return sanitizeAiText(value ?? "", KNOWLEDGE_LAUNCH_CONTEXT_CAPS.proposalTitle);
}

function isOwner(access: BusinessAccess) {
  return isKnowledgeLaunchOwnerRole(access.workspace.role);
}

export function resolveKnowledgeLaunchReadScope(
  access: BusinessAccess,
  denyRoleCapabilities?: Capability[],
): KnowledgeLaunchReadScope {
  return {
    knowledge: hasRole(access, CAPABILITIES.MANAGE_KNOWLEDGE, denyRoleCapabilities),
    launch: isOwner(access) && hasRole(access, CAPABILITIES.MANAGE_SETTINGS, denyRoleCapabilities),
    setup: isOwner(access) && hasRole(access, CAPABILITIES.USE_AI_ASSIST, denyRoleCapabilities),
  };
}

function assertSafeProjection(projection: KnowledgeLaunchProjection) {
  const raw = JSON.stringify(projection);
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Knowledge/Launch projection leaked a forbidden field.");
    }
  }
}

export function knowledgeLaunchProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return FORBIDDEN_PROJECTION_KEYS.some(
    (key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw),
  );
}

function emptyTotals(): KnowledgeLaunchProjectionTotals {
  return {
    entries: 0,
    approved: 0,
    unreviewed: 0,
    rejected: 0,
    needsReview: 0,
    conflicts: 0,
    estimates: 0,
    unknown: 0,
    supported: 0,
    verified: 0,
    externalReferences: 0,
    systemDerived: 0,
    candidates: 0,
    candidateOpen: 0,
    procedures: 0,
    launchPending: 0,
    launchCompleted: 0,
    launchSkipped: 0,
    launchDeferred: 0,
    setupProposals: 0,
    setupItems: 0,
    setupPending: 0,
    setupApproved: 0,
    setupRejected: 0,
    setupApplied: 0,
    setupBlocked: 0,
  };
}

function unavailableKnowledgeTotals(
  totals: KnowledgeLaunchProjectionTotals,
): KnowledgeLaunchProjectionTotals {
  return {
    ...totals,
    entries: null,
    approved: null,
    unreviewed: null,
    rejected: null,
    needsReview: null,
    conflicts: null,
    estimates: null,
    unknown: null,
    supported: null,
    verified: null,
    externalReferences: null,
    systemDerived: null,
    candidates: null,
    candidateOpen: null,
    procedures: null,
  };
}

function unavailableLaunchTotals(
  totals: KnowledgeLaunchProjectionTotals,
): KnowledgeLaunchProjectionTotals {
  return {
    ...totals,
    launchPending: null,
    launchCompleted: null,
    launchSkipped: null,
    launchDeferred: null,
  };
}

function unavailableSetupTotals(
  totals: KnowledgeLaunchProjectionTotals,
): KnowledgeLaunchProjectionTotals {
  return {
    ...totals,
    setupProposals: null,
    setupItems: null,
    setupPending: null,
    setupApproved: null,
    setupRejected: null,
    setupApplied: null,
    setupBlocked: null,
  };
}

function unloadedLaunch(): KnowledgeLaunchProjection["launch"] {
  return {
    loaded: false,
    status: null,
    definedStepCount: null,
    progressPercent: null,
    recommendedNext: null,
    steps: [],
  };
}

function unloadedSetup(): KnowledgeLaunchProjection["setup"] {
  return {
    loaded: false,
    proposals: [],
  };
}

type GateDecision =
  | { status: "ok"; scope: KnowledgeLaunchReadScope }
  | { status: "skip"; skipReason: SpecialistSkipReason; limitation: string };

async function resolveKnowledgeLaunchGates(
  db: Db,
  access: BusinessAccess,
  denyRoleCapabilities?: Capability[],
): Promise<GateDecision> {
  const scope = resolveKnowledgeLaunchReadScope(access, denyRoleCapabilities);
  if (!scope.knowledge && !scope.launch && !scope.setup) {
    return {
      status: "skip",
      skipReason: "NOT_AUTHORIZED",
      limitation: knowledgeLaunchEntitlementLimitation("NOT_AUTHORIZED"),
    };
  }

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { id: true, slug: true },
  });
  if (!business) {
    return {
      status: "skip",
      skipReason: "UNAVAILABLE",
      limitation: knowledgeLaunchEntitlementLimitation("UNAVAILABLE"),
    };
  }

  const entitlement = await resolveProductEntitlement(db, business);
  if (!entitlement.operating.canOperate) {
    return {
      status: "skip",
      skipReason: "NOT_ENTITLED",
      limitation: knowledgeLaunchEntitlementLimitation("NOT_ENTITLED"),
    };
  }

  return { status: "ok", scope };
}

type ResolvedTargets = {
  entryId: string | null;
  candidateId: string | null;
  procedureId: string | null;
  scoped: boolean;
  targetedEntryUnauthorized: boolean;
  targetedCandidateUnauthorized: boolean;
  targetedProcedureUnauthorized: boolean;
  targetedEntityMismatch: boolean;
};

function suppliedHintCount(hints?: CosEntityHints) {
  if (!hints) return 0;
  return [hints.knowledgeEntryId, hints.experienceCandidateId, hints.procedureId].filter(Boolean)
    .length;
}

async function resolveTargets(
  db: Db,
  businessId: string,
  hints?: CosEntityHints,
): Promise<ResolvedTargets> {
  const result: ResolvedTargets = {
    entryId: null,
    candidateId: null,
    procedureId: null,
    scoped: false,
    targetedEntryUnauthorized: false,
    targetedCandidateUnauthorized: false,
    targetedProcedureUnauthorized: false,
    targetedEntityMismatch: false,
  };

  const derivedEntryIds: Array<string | null> = [];
  let authorizedCandidateId: string | null = null;
  let authorizedProcedureId: string | null = null;
  let authorizedEntryId: string | null = null;

  if (hints?.knowledgeEntryId) {
    result.scoped = true;
    const entry = await db.knowledgeEntry.findFirst({
      where: { id: hints.knowledgeEntryId, businessId, scope: "BUSINESS" },
      select: { id: true, businessId: true },
    });
    if (!entry) result.targetedEntryUnauthorized = true;
    else {
      authorizedEntryId = entry.id;
      derivedEntryIds.push(entry.id);
    }
  }

  if (hints?.experienceCandidateId) {
    result.scoped = true;
    const candidate = await db.experienceLearningCandidate.findFirst({
      where: { id: hints.experienceCandidateId, businessId },
      select: { id: true, businessId: true, knowledgeEntryId: true },
    });
    if (!candidate) result.targetedCandidateUnauthorized = true;
    else {
      authorizedCandidateId = candidate.id;
      derivedEntryIds.push(candidate.knowledgeEntryId);
    }
  }

  if (hints?.procedureId) {
    result.scoped = true;
    const procedure = await db.operatingProcedure.findFirst({
      where: { id: hints.procedureId, businessId },
      select: { id: true, businessId: true, knowledgeEntryId: true },
    });
    if (!procedure) result.targetedProcedureUnauthorized = true;
    else {
      authorizedProcedureId = procedure.id;
      derivedEntryIds.push(procedure.knowledgeEntryId);
    }
  }

  const anyUnauthorized =
    result.targetedEntryUnauthorized ||
    result.targetedCandidateUnauthorized ||
    result.targetedProcedureUnauthorized;
  const resolvedEntryIds = [...new Set(derivedEntryIds.filter((id): id is string => Boolean(id)))];
  const hasUnresolvedAuthorizedHint = derivedEntryIds.some((id) => !id);
  const mismatch =
    resolvedEntryIds.length > 1 ||
    (hasUnresolvedAuthorizedHint && (resolvedEntryIds.length > 0 || derivedEntryIds.length > 1));

  if (anyUnauthorized || mismatch) {
    result.entryId = null;
    result.candidateId = null;
    result.procedureId = null;
    result.targetedEntityMismatch = mismatch || (anyUnauthorized && suppliedHintCount(hints) > 1);
    return result;
  }

  result.entryId = authorizedEntryId ?? resolvedEntryIds[0] ?? null;
  result.candidateId = authorizedCandidateId;
  result.procedureId = authorizedProcedureId;
  return result;
}

function projectEntry(row: {
  id: string;
  businessId: string;
  title: string;
  category: string;
  knowledgeKind: string | null;
  approvalState: string;
  trustState: string;
  sourceType: string;
  sourceKind: string | null;
  sourceLabel: string | null;
  body: string;
  archived: boolean;
  targeted: boolean;
}): KnowledgeEntryProjection {
  const approvalState = isKnowledgeApprovalState(row.approvalState) ? row.approvalState : "UNREVIEWED";
  const trustState = isKnowledgeTrustState(row.trustState) ? row.trustState : "UNKNOWN";
  const sourceType = isKnowledgeSourceType(row.sourceType) ? row.sourceType : "OWNER_CREATED";
  return {
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    category: row.category,
    knowledgeKind: row.knowledgeKind,
    approvalState,
    trustState,
    sourceType,
    sourceKind: row.sourceKind,
    sourceLabel: row.sourceLabel,
    excerpt: excerptText(row.body),
    archived: row.archived,
    targeted: row.targeted,
  };
}

function projectCandidate(row: {
  id: string;
  businessId: string;
  title: string;
  kind: string;
  status: string;
  confidence: string;
  body: string;
  knowledgeEntryId: string | null;
  targeted: boolean;
}): KnowledgeCandidateProjection {
  return {
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence,
    excerpt: excerptText(row.body),
    knowledgeEntryId: row.knowledgeEntryId,
    isApprovedKnowledge: false,
    targeted: row.targeted,
  };
}

async function loadProviders(db: Db, businessId: string): Promise<KnowledgeLaunchProviderState> {
  const [payment, business] = await Promise.all([
    getBusinessPaymentStatus(db, businessId),
    db.business.findFirst({
      where: { id: businessId },
      select: { publishedWebsiteId: true },
    }),
  ]);
  return {
    stripeStatus: payment.status,
    stripePaymentReady: payment.paymentReady,
    emailConfigured: isEmailDeliveryConfigured(),
    smsConfigured: isCustomerMessagingConfigured(),
    storageConfigured: isBusinessStorageConfigured(),
    websitePublished: Boolean(business?.publishedWebsiteId),
  };
}

function projectSetupProposal(row: {
  id: string;
  status: string;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    appliedAt: Date | null;
  }>;
  _count: { items: number };
}): SetupProposalProjection {
  const items = row.items.slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.proposalItems).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: proposalTitle(item.title),
    status: item.status,
    applied: item.status === "APPLIED" || Boolean(item.appliedAt),
    blocked: item.status === "BLOCKED",
  }));
  return {
    id: row.id,
    status: row.status,
    itemCount: row._count.items,
    pendingCount: items.filter((item) => item.status === "PENDING").length,
    approvedCount: items.filter((item) => item.status === "APPROVED").length,
    rejectedCount: items.filter((item) => item.status === "REJECTED").length,
    appliedCount: items.filter((item) => item.status === "APPLIED").length,
    blockedCount: items.filter((item) => item.status === "BLOCKED").length,
    items,
  };
}

export async function loadKnowledgeLaunchProjection(input: {
  db: Db;
  access: BusinessAccess;
  entityHints?: CosEntityHints;
  denyRoleCapabilities?: Capability[];
}): Promise<KnowledgeLaunchProjection> {
  recordKnowledgeLaunchProjectionLoad();
  if (shouldInjectKnowledgeLaunchLoadFailure()) {
    throw new Error("injected knowledge-launch load failure");
  }

  const businessId = input.access.businessId;
  const scope = resolveKnowledgeLaunchReadScope(input.access, input.denyRoleCapabilities);
  const targets = await resolveTargets(input.db, businessId, input.entityHints);
  const failClosed =
    targets.targetedEntryUnauthorized ||
    targets.targetedCandidateUnauthorized ||
    targets.targetedProcedureUnauthorized ||
    targets.targetedEntityMismatch;
  const scoped = targets.scoped && !failClosed;
  const authorizedRows = !failClosed && (scoped || !targets.scoped);
  const loadKnowledge = authorizedRows && scope.knowledge;
  const loadLaunch = authorizedRows && scope.launch;
  const loadSetup = authorizedRows && scope.setup;

  const entryWhere: Prisma.KnowledgeEntryWhereInput = {
    businessId,
    archived: false,
    scope: "BUSINESS",
  };
  const candidateWhere: Prisma.ExperienceLearningCandidateWhereInput = { businessId };
  const procedureWhere: Prisma.OperatingProcedureWhereInput = { businessId, archived: false };

  if (failClosed || (targets.scoped && !scoped)) {
    entryWhere.id = "__no-such-owned-knowledge-entry__";
    candidateWhere.id = "__no-such-owned-experience-candidate__";
    procedureWhere.id = "__no-such-owned-operating-procedure__";
  } else if (scoped) {
    if (targets.entryId) entryWhere.id = targets.entryId;
    else if (targets.candidateId || targets.procedureId) {
      entryWhere.id = "__no-such-owned-knowledge-entry__";
    }
    if (targets.candidateId) candidateWhere.id = targets.candidateId;
    else if (targets.entryId) candidateWhere.knowledgeEntryId = targets.entryId;
    else candidateWhere.id = "__no-such-owned-experience-candidate__";
    if (targets.procedureId) procedureWhere.id = targets.procedureId;
    else if (targets.entryId) procedureWhere.knowledgeEntryId = targets.entryId;
    else procedureWhere.id = "__no-such-owned-operating-procedure__";
  }

  const entrySelect = {
    id: true,
    businessId: true,
    title: true,
    category: true,
    knowledgeKind: true,
    approvalState: true,
    trustState: true,
    sourceType: true,
    sourceKind: true,
    sourceLabel: true,
    body: true,
    archived: true,
    updatedAt: true,
  } as const;

  const [
    recentEntries,
    verifiedApprovedEntries,
    oldestUnreviewedEntries,
    unreviewedEntries,
    approvedEntries,
    conflictEntries,
    estimateEntries,
    unknownEntries,
    supportedEntries,
    externalEntries,
    systemDerivedEntries,
    candidates,
    procedures,
    progress,
    stepRows,
    providers,
    entryCount,
    candidateCount,
    procedureCount,
    approvedCount,
    unreviewedCount,
    rejectedCount,
    needsReviewCount,
    conflictCount,
    estimateCount,
    unknownCount,
    supportedCount,
    verifiedCount,
    externalCount,
    systemDerivedCount,
    candidateOpenCount,
    proposalRows,
    proposalCount,
    setupItemCount,
    setupPendingCount,
    setupApprovedCount,
    setupRejectedCount,
    setupAppliedCount,
    setupBlockedCount,
  ] = await Promise.all([
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: entryWhere,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entries,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, approvalState: "APPROVED", trustState: "VERIFIED" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, approvalState: "UNREVIEWED" },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, approvalState: "UNREVIEWED" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 2,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, approvalState: "APPROVED" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, trustState: "CONFLICT" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, trustState: "ESTIMATE" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, trustState: "UNKNOWN" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, trustState: "SUPPORTED" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, sourceType: "EXTERNAL_REFERENCE" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.knowledgeEntry.findMany({
          where: { ...entryWhere, sourceType: "SYSTEM_DERIVED" },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: entrySelect,
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.experienceLearningCandidate.findMany({
          where: candidateWhere,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: KNOWLEDGE_LAUNCH_CONTEXT_CAPS.candidates,
          select: {
            id: true,
            businessId: true,
            title: true,
            kind: true,
            status: true,
            confidence: true,
            body: true,
            knowledgeEntryId: true,
          },
        })
      : Promise.resolve([]),
    loadKnowledge
      ? input.db.operatingProcedure.findMany({
          where: procedureWhere,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: KNOWLEDGE_LAUNCH_CONTEXT_CAPS.procedures,
          select: {
            id: true,
            businessId: true,
            title: true,
            summary: true,
            approvalState: true,
            knowledgeEntryId: true,
            steps: {
              orderBy: { sortOrder: "asc" },
              take: KNOWLEDGE_LAUNCH_CONTEXT_CAPS.procedureSteps,
              select: { title: true },
            },
            _count: { select: { steps: true } },
          },
        })
      : Promise.resolve([]),
    loadLaunch
      ? input.db.businessLaunchProgress.findUnique({
          where: { businessId },
          select: {
            status: true,
            lastStepKey: true,
            resumeLaterAt: true,
            completedAt: true,
          },
        })
      : Promise.resolve(null),
    loadLaunch
      ? input.db.businessLaunchStep.findMany({
          where: { businessId },
          select: {
            stepKey: true,
            status: true,
            completedAt: true,
            skippedAt: true,
            deferredAt: true,
          },
        })
      : Promise.resolve([]),
    loadLaunch ? loadProviders(input.db, businessId) : Promise.resolve(null),
    loadKnowledge ? input.db.knowledgeEntry.count({ where: entryWhere }) : Promise.resolve(null),
    loadKnowledge ? input.db.experienceLearningCandidate.count({ where: candidateWhere }) : Promise.resolve(null),
    loadKnowledge ? input.db.operatingProcedure.count({ where: procedureWhere }) : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, approvalState: "APPROVED" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, approvalState: "UNREVIEWED" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, approvalState: "REJECTED" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({
          where: { ...entryWhere, trustState: { in: ["NEEDS_REVIEW", "CONFLICT"] } },
        })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, trustState: "CONFLICT" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, trustState: "ESTIMATE" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, trustState: "UNKNOWN" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, trustState: "SUPPORTED" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({ where: { ...entryWhere, trustState: "VERIFIED" } })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({
          where: { ...entryWhere, sourceType: "EXTERNAL_REFERENCE" },
        })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.knowledgeEntry.count({
          where: { ...entryWhere, sourceType: "SYSTEM_DERIVED" },
        })
      : Promise.resolve(null),
    loadKnowledge
      ? input.db.experienceLearningCandidate.count({
          where: { ...candidateWhere, status: { in: ["CANDIDATE", "REVIEWED"] } },
        })
      : Promise.resolve(null),
    loadSetup
      ? input.db.companySetupProposal.findMany({
          where: { businessId },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: KNOWLEDGE_LAUNCH_CONTEXT_CAPS.proposals,
          select: {
            id: true,
            status: true,
            items: {
              orderBy: { createdAt: "asc" },
              take: KNOWLEDGE_LAUNCH_CONTEXT_CAPS.proposalItems,
              select: {
                id: true,
                kind: true,
                title: true,
                status: true,
                appliedAt: true,
              },
            },
            _count: { select: { items: true } },
          },
        })
      : Promise.resolve([]),
    loadSetup ? input.db.companySetupProposal.count({ where: { businessId } }) : Promise.resolve(null),
    loadSetup ? input.db.companySetupProposalItem.count({ where: { businessId } }) : Promise.resolve(null),
    loadSetup
      ? input.db.companySetupProposalItem.count({ where: { businessId, status: "PENDING" } })
      : Promise.resolve(null),
    loadSetup
      ? input.db.companySetupProposalItem.count({ where: { businessId, status: "APPROVED" } })
      : Promise.resolve(null),
    loadSetup
      ? input.db.companySetupProposalItem.count({ where: { businessId, status: "REJECTED" } })
      : Promise.resolve(null),
    loadSetup
      ? input.db.companySetupProposalItem.count({ where: { businessId, status: "APPLIED" } })
      : Promise.resolve(null),
    loadSetup
      ? input.db.companySetupProposalItem.count({ where: { businessId, status: "BLOCKED" } })
      : Promise.resolve(null),
  ]);

  const entryById = new Map<string, (typeof recentEntries)[number]>();
  for (const row of [
    ...verifiedApprovedEntries,
    ...oldestUnreviewedEntries,
    ...conflictEntries,
    ...estimateEntries,
    ...unknownEntries,
    ...approvedEntries,
    ...supportedEntries,
    ...externalEntries,
    ...systemDerivedEntries,
    ...unreviewedEntries,
    ...recentEntries,
  ]) {
    if (entryById.size >= KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entries) break;
    if (!entryById.has(row.id)) entryById.set(row.id, row);
  }
  const entries = [...entryById.values()].map((row) =>
    projectEntry({
      ...row,
      targeted: Boolean(targets.entryId && row.id === targets.entryId),
    }),
  );

  const candidateRows = candidates.slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.candidates).map((row) =>
    projectCandidate({
      ...row,
      targeted: Boolean(targets.candidateId && row.id === targets.candidateId),
    }),
  );

  const procedureRows = procedures.slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.procedures).map((row) => ({
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    summaryExcerpt: excerptText(row.summary),
    approvalState: row.approvalState,
    stepCount: row._count.steps,
    stepTitles: row.steps.map((step) => step.title),
    knowledgeEntryId: row.knowledgeEntryId,
    targeted: Boolean(targets.procedureId && row.id === targets.procedureId),
  }));

  const launchSummary = loadLaunch
    ? buildLaunchProgressSummary({
        status: progress?.status,
        lastStepKey: progress?.lastStepKey,
        resumeLaterAt: progress?.resumeLaterAt,
        completedAt: progress?.completedAt,
        steps: stepRows,
      })
    : null;
  const launchSteps = (launchSummary?.steps ?? [])
    .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.launchSteps)
    .map((step) => ({
      stepKey: step.stepKey,
      label: LAUNCH_STEP_LABELS[step.stepKey],
      status: step.status,
    }));
  const setupProposals = loadSetup
    ? proposalRows.slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.proposals).map(projectSetupProposal)
    : [];

  let totals: KnowledgeLaunchProjectionTotals = {
    entries: entryCount,
    approved: approvedCount,
    unreviewed: unreviewedCount,
    rejected: rejectedCount,
    needsReview: needsReviewCount,
    conflicts: conflictCount,
    estimates: estimateCount,
    unknown: unknownCount,
    supported: supportedCount,
    verified: verifiedCount,
    externalReferences: externalCount,
    systemDerived: systemDerivedCount,
    candidates: candidateCount,
    candidateOpen: candidateOpenCount,
    procedures: procedureCount,
    launchPending: launchSummary?.pendingCount ?? null,
    launchCompleted: launchSummary?.completedCount ?? null,
    launchSkipped: launchSummary?.skippedCount ?? null,
    launchDeferred: launchSummary?.deferredCount ?? null,
    setupProposals: proposalCount,
    setupItems: setupItemCount,
    setupPending: setupPendingCount,
    setupApproved: setupApprovedCount,
    setupRejected: setupRejectedCount,
    setupApplied: setupAppliedCount,
    setupBlocked: setupBlockedCount,
  };
  if (!loadKnowledge) totals = unavailableKnowledgeTotals(totals);
  if (!loadLaunch) totals = unavailableLaunchTotals(totals);
  if (!loadSetup) totals = unavailableSetupTotals(totals);

  const projection: KnowledgeLaunchProjection = {
    totals,
    entries: loadKnowledge ? entries : [],
    candidates: loadKnowledge ? candidateRows : [],
    procedures: loadKnowledge ? procedureRows : [],
    launch: loadLaunch
      ? {
          loaded: true,
          status: launchSummary?.status ?? "IN_PROGRESS",
          definedStepCount: launchSummary?.definedStepCount ?? LAUNCH_STEP_KEYS.length,
          progressPercent: launchSummary?.progressPercent ?? 0,
          recommendedNext: launchSummary?.recommendedNext ?? null,
          steps: launchSteps,
        }
      : { ...unloadedLaunch() },
    setup: loadSetup
      ? {
          loaded: true,
          proposals: setupProposals,
        }
      : { ...unloadedSetup() },
    providers: loadLaunch ? providers : null,
    canReadKnowledge: scope.knowledge,
    canReadLaunch: scope.launch,
    canReadSetup: scope.setup,
    canReadDeep: loadKnowledge || loadLaunch || loadSetup,
    targetedEntryUnauthorized: targets.targetedEntryUnauthorized,
    targetedCandidateUnauthorized: targets.targetedCandidateUnauthorized,
    targetedProcedureUnauthorized: targets.targetedProcedureUnauthorized,
    targetedEntityMismatch: targets.targetedEntityMismatch,
    snapshotReused: false,
  };

  if (failClosed) {
    projection.totals = emptyTotals();
    projection.entries = [];
    projection.candidates = [];
    projection.procedures = [];
    projection.launch = { ...unloadedLaunch() };
    projection.setup = { ...unloadedSetup() };
    projection.providers = null;
    projection.canReadDeep = false;
  }

  assertSafeProjection(projection);
  return projection;
}

function describeEntry(row: KnowledgeEntryProjection) {
  return `"${row.title}" [${row.approvalState} / ${row.trustState} / ${row.sourceType}]: ${row.excerpt}`;
}

function describeCandidate(row: KnowledgeCandidateProjection) {
  return `"${row.title}" [${row.status}, candidate not approved knowledge]: ${row.excerpt}`;
}

function describeUnfinishedSteps(steps: LaunchStepProjection[]) {
  return steps
    .filter((step) => step.status === "PENDING" || step.status === "DEFERRED")
    .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.explainedUnfinishedSteps)
    .map((step) => `${step.label} (${step.status})`)
    .join("; ");
}

function describeSetupProposal(proposal: SetupProposalProjection) {
  const items = proposal.items
    .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.proposalItems)
    .map((item) => `${item.kind} "${item.title}" is ${item.status}${item.applied ? " and already applied" : item.blocked ? " and blocked" : ", not applied"}`)
    .join("; ");
  return `Proposal ${proposal.id} is ${proposal.status}. ${COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE}${items ? ` Items: ${items}.` : ""}`;
}

function findingsFromProjection(
  projection: KnowledgeLaunchProjection,
  catalogKeys: string[],
): Array<{ key: string; title: string; why: string; entityIds?: string[] }> {
  const findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }> = [];
  const t = projection.totals;
  const approvedRows = projection.entries
    .filter((row) => row.approvalState === "APPROVED")
    .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.explainedEntries);
  const unreviewedRows = projection.entries
    .filter((row) => row.approvalState === "UNREVIEWED")
    .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.explainedEntries);
  const candidateRows = projection.candidates.slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.explainedCandidates);
  const unfinished = describeUnfinishedSteps(projection.launch.steps);

  if (projection.canReadKnowledge && (t.approved ?? 0) > 0) {
    findings.push({
      key: "knowledge-approved-entries",
      title: "Approved knowledge is on file",
      why:
        `${t.approved} Knowledge ${t.approved === 1 ? "entry is" : "entries are"} APPROVED recorded knowledge, not an invented lesson. ` +
        (approvedRows.length > 0 ? `Recorded examples: ${approvedRows.map(describeEntry).join(" ")} ` : "") +
        "Approval is owner policy, separate from trust state.",
      entityIds: projection.entries
        .filter((row) => row.approvalState === "APPROVED")
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.canReadKnowledge && (t.unreviewed ?? 0) > 0) {
    findings.push({
      key: "knowledge-unreviewed-entries",
      title: "Knowledge still needs owner approval",
      why:
        `${t.unreviewed} Knowledge ${t.unreviewed === 1 ? "entry is" : "entries are"} UNREVIEWED. UNREVIEWED is not APPROVED and is not owner policy. ` +
        (unreviewedRows.length > 0 ? `Recorded UNREVIEWED examples: ${unreviewedRows.map(describeEntry).join(" ")}` : ""),
      entityIds: projection.entries
        .filter((row) => row.approvalState === "UNREVIEWED")
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.canReadKnowledge && ((t.needsReview ?? 0) > 0 || (t.conflicts ?? 0) > 0)) {
    findings.push({
      key: "knowledge-needs-review",
      title: "Knowledge trust still needs review",
      why: `${t.needsReview} recorded Knowledge ${t.needsReview === 1 ? "entry needs" : "entries need"} review because trust is NEEDS_REVIEW or CONFLICT. ${t.conflicts} of those ${t.conflicts === 1 ? "entry remains" : "entries remain"} CONFLICT. This is the scoped recorded total, not only the projected sample. CONFLICT remains unresolved. The Coach does not approve or edit knowledge.`,
      entityIds: projection.entries
        .filter((row) => needsKnowledgeReview(row.trustState))
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.canReadKnowledge && (t.conflicts ?? 0) > 0) {
    findings.push({
      key: "knowledge-conflict",
      title: "Recorded knowledge is in conflict",
      why: `${t.conflicts} Knowledge ${t.conflicts === 1 ? "entry remains" : "entries remain"} CONFLICT. CONFLICT is recorded trust, not a resolved fact.`,
      entityIds: projection.entries
        .filter((row) => row.trustState === "CONFLICT")
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.canReadKnowledge && (t.estimates ?? 0) > 0) {
    findings.push({
      key: "knowledge-estimate",
      title: "Some knowledge is labeled an estimate",
      why: `${t.estimates} Knowledge ${t.estimates === 1 ? "entry is" : "entries are"} ESTIMATE. ESTIMATE is not a known fact.`,
      entityIds: projection.entries
        .filter((row) => row.trustState === "ESTIMATE")
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.canReadKnowledge && (t.unknown ?? 0) > 0) {
    findings.push({
      key: "knowledge-unknown",
      title: "Some knowledge stays unknown",
      why: `${t.unknown} Knowledge ${t.unknown === 1 ? "entry is" : "entries are"} UNKNOWN. UNKNOWN is not false and is not invented as a fact.`,
      entityIds: projection.entries
        .filter((row) => row.trustState === "UNKNOWN")
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.canReadKnowledge && (t.supported ?? 0) > 0) {
    findings.push({
      key: "knowledge-supported-not-verified",
      title: "Supported knowledge is not verified",
      why: `${t.supported} Knowledge ${t.supported === 1 ? "entry is" : "entries are"} SUPPORTED. SUPPORTED is not VERIFIED.`,
    });
  }

  if (projection.canReadKnowledge && (t.externalReferences ?? 0) > 0) {
    findings.push({
      key: "knowledge-external-not-verified",
      title: "External references are not internally verified",
      why: `${t.externalReferences} Knowledge ${t.externalReferences === 1 ? "entry is" : "entries are"} EXTERNAL_REFERENCE. An external reference is not internally verified.`,
    });
  }

  if (projection.canReadKnowledge && (t.systemDerived ?? 0) > 0) {
    findings.push({
      key: "knowledge-system-derived-reserved",
      title: "System-derived knowledge is reserved",
      why: `${t.systemDerived} Knowledge ${t.systemDerived === 1 ? "entry is" : "entries are"} SYSTEM_DERIVED. ${SYSTEM_DERIVED_DISABLED_MESSAGE}`,
    });
  }

  if (projection.canReadKnowledge && ((t.candidateOpen ?? 0) > 0 || (t.candidates ?? 0) > 0)) {
    findings.push({
      key: "knowledge-candidate-not-policy",
      title: "Experience candidates are not approved knowledge",
      why:
        `${t.candidateOpen} experience ${t.candidateOpen === 1 ? "candidate remains" : "candidates remain"} a candidate or reviewed candidate. A candidate is not approved knowledge and is not promoted automatically. ` +
        (candidateRows.length > 0 ? `Recorded candidate material: ${candidateRows.map(describeCandidate).join(" ")}` : ""),
      entityIds: projection.candidates
        .filter((row) => row.status === "CANDIDATE" || row.status === "REVIEWED")
        .map((row) => row.id)
        .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  if (projection.launch.loaded && (t.launchPending ?? 0) > 0) {
    const pendingLabels = projection.launch.steps
      .filter((step) => step.status === "PENDING")
      .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.explainedUnfinishedSteps)
      .map((step) => `${step.label} (PENDING)`)
      .join("; ");
    findings.push({
      key: "launch-pending-steps",
      title: "Launch steps are still pending",
      why:
        `${t.launchPending} Business Launch ${t.launchPending === 1 ? "step is" : "steps are"} PENDING. PENDING is not COMPLETED, SKIPPED, or DEFERRED. ` +
        (pendingLabels ? `Recorded PENDING steps: ${pendingLabels}. ` : "") +
        `Recommended next recorded step: ${projection.launch.recommendedNext ?? "none"}.`,
    });
  }

  if (projection.launch.loaded && (t.launchDeferred ?? 0) > 0) {
    const deferredLabels = projection.launch.steps
      .filter((step) => step.status === "DEFERRED")
      .slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.explainedUnfinishedSteps)
      .map((step) => `${step.label} (DEFERRED)`)
      .join("; ");
    findings.push({
      key: "launch-deferred-steps",
      title: "Launch steps were deferred",
      why:
        `${t.launchDeferred} Business Launch ${t.launchDeferred === 1 ? "step is" : "steps are"} DEFERRED. DEFERRED is not COMPLETED and still blocks launch completion. ` +
        (deferredLabels ? `Recorded DEFERRED steps: ${deferredLabels}.` : ""),
    });
  }

  if (projection.launch.loaded && unfinished) {
    findings.push({
      key: "launch-unfinished-steps",
      title: "Unfinished launch setup is still recorded",
      why: `Unfinished Launch steps still need to be finished: ${unfinished}. SKIPPED stays SKIPPED. Launch completion does not publish the website or connect providers.`,
    });
  }

  if (projection.launch.loaded && projection.launch.status === "COMPLETED") {
    const providers = projection.providers;
    const providerGaps = [
      providers?.websitePublished ? null : "the website is not published",
      providers?.stripeStatus === "connected" ? null : "Stripe is not connected",
      providers?.emailConfigured ? null : "email delivery is not configured",
      providers?.smsConfigured ? null : "SMS is not connected",
      providers?.storageConfigured ? null : "file storage is not configured",
    ].filter(Boolean);
    findings.push({
      key: "launch-complete-not-operating-proof",
      title: "Recorded launch completion is not provider go-live",
      why:
        `The recorded Business Launch workflow is COMPLETED (${t.launchCompleted} of ${projection.launch.definedStepCount} defined steps marked COMPLETED; skipped steps stay SKIPPED). ` +
        `${LAUNCH_NO_PUBLISH_MESSAGE} ${LAUNCH_NO_SUBSCRIPTION_MESSAGE} ` +
        (providerGaps.length > 0
          ? `Provider/config state is separate: ${providerGaps.join("; ")}.`
          : "Provider/config state is read from the actual provider and published-site records, not from Launch step completion."),
    });
    if (!providers?.websitePublished) {
      findings.push({
        key: "launch-complete-vs-website",
        title: "Launch completion does not publish the website",
        why: `${LAUNCH_NO_PUBLISH_MESSAGE} Recorded launch status is COMPLETED and publishedWebsiteId is not set.`,
      });
    }
    if (providers?.stripeStatus !== "connected" || !providers.emailConfigured || !providers.smsConfigured) {
      findings.push({
        key: "launch-complete-vs-provider",
        title: "Launch completion does not connect providers",
        why: `Launch completion does not imply Stripe, Resend, SMS, or R2 are connected. Recorded Stripe status is ${providers?.stripeStatus ?? "unknown"}. Email configured=${providers?.emailConfigured ?? false}. SMS configured=${providers?.smsConfigured ?? false}. Storage configured=${providers?.storageConfigured ?? false}.`,
      });
    }
  }

  if (projection.setup.loaded && (t.setupProposals ?? 0) > 0) {
    const proposal = projection.setup.proposals[0];
    findings.push({
      key: "setup-proposal-not-applied",
      title: "Setup proposals are not applied setup",
      why:
        `${t.setupProposals} Build-my-company ${t.setupProposals === 1 ? "proposal is" : "proposals are"} on file. A proposal is not applied setup. PENDING is not APPROVED. APPROVED is not APPLIED. REJECTED is not APPLIED. BLOCKED is not APPLIED. DRAFT, REVIEWED, and PARTIALLY_APPLIED proposals are not completed Launch. ` +
        (proposal ? describeSetupProposal(proposal) : COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE),
      entityIds: projection.setup.proposals.map((row) => row.id).slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.entityIds),
    });
  }

  for (const key of catalogKeys) {
    if (findings.some((item) => item.key === key)) continue;
    if (
      key === "finish-business-launch" &&
      projection.launch.loaded &&
      (t.launchPending ?? 0) + (t.launchDeferred ?? 0) > 0
    ) {
      findings.push({
        key,
        title: "Finish the recorded business launch",
        why:
          `${(t.launchPending ?? 0) + (t.launchDeferred ?? 0)} recorded launch ${
            (t.launchPending ?? 0) + (t.launchDeferred ?? 0) === 1 ? "step is" : "steps are"
          } still PENDING or DEFERRED.` + (unfinished ? ` ${unfinished}.` : ""),
      });
    }
    if (key === "review-experience-learnings" && projection.canReadKnowledge && (t.candidateOpen ?? 0) > 0) {
      findings.push({
        key,
        title: "Review experience learnings",
        why: `${t.candidateOpen} experience ${t.candidateOpen === 1 ? "candidate is" : "candidates are"} still a candidate, not approved knowledge.`,
      });
    }
    if (key === "approve-business-knowledge" && projection.canReadKnowledge && (t.unreviewed ?? 0) > 0) {
      findings.push({
        key,
        title: "Approve business knowledge",
        why: `${t.unreviewed} Knowledge ${t.unreviewed === 1 ? "entry is" : "entries are"} UNREVIEWED. UNREVIEWED is not APPROVED.`,
      });
    }
  }

  return findings.slice(0, KNOWLEDGE_LAUNCH_CONTEXT_CAPS.findings);
}

export function projectKnowledgeLaunchFacts(projection: KnowledgeLaunchProjection) {
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];
  const t = projection.totals;
  const approved =
    projection.entries.find((row) => row.approvalState === "APPROVED" && row.trustState === "VERIFIED") ??
    projection.entries.find((row) => row.approvalState === "APPROVED");
  const unreviewed =
    projection.entries.find((row) => row.approvalState === "UNREVIEWED" && row.trustState === "UNKNOWN" && row.sourceType === "OWNER_CREATED") ??
    projection.entries.find((row) => row.approvalState === "UNREVIEWED");
  const candidate = projection.candidates[0];
  const unfinished = describeUnfinishedSteps(projection.launch.steps);
  const proposal = projection.setup.proposals[0];

  if (projection.canReadKnowledge && approved) {
    addFact(facts, factKeys, "knowledge-approved-excerpt", describeEntry(approved));
  }
  if (projection.canReadKnowledge && unreviewed) {
    addFact(facts, factKeys, "knowledge-unreviewed-excerpt", describeEntry(unreviewed));
  }
  if (projection.canReadKnowledge && candidate) {
    addFact(facts, factKeys, "knowledge-candidate-excerpt", describeCandidate(candidate));
  }
  if (projection.launch.loaded && unfinished) {
    addFact(facts, factKeys, "launch-unfinished-steps", unfinished);
  }
  if (projection.setup.loaded && proposal) {
    addFact(facts, factKeys, "setup-proposal-excerpt", describeSetupProposal(proposal));
  }

  if (projection.canReadKnowledge) {
    if (t.approved != null) addFact(facts, factKeys, "knowledge-approved-count", String(t.approved));
    if (t.unreviewed != null) addFact(facts, factKeys, "knowledge-unreviewed-count", String(t.unreviewed));
    if (t.rejected != null) addFact(facts, factKeys, "knowledge-rejected-count", String(t.rejected));
    if (t.needsReview != null) addFact(facts, factKeys, "knowledge-needs-review-count", String(t.needsReview));
    if (t.conflicts != null) addFact(facts, factKeys, "knowledge-conflict-count", String(t.conflicts));
    if (t.estimates != null) addFact(facts, factKeys, "knowledge-estimate-count", String(t.estimates));
    if (t.unknown != null) addFact(facts, factKeys, "knowledge-unknown-count", String(t.unknown));
    if (t.candidateOpen != null) addFact(facts, factKeys, "knowledge-candidate-count", String(t.candidateOpen));
  }
  if (projection.launch.loaded) {
    if (t.launchPending != null) addFact(facts, factKeys, "launch-pending-count", String(t.launchPending));
    if (t.launchCompleted != null) addFact(facts, factKeys, "launch-completed-step-count", String(t.launchCompleted));
    if (t.launchSkipped != null) addFact(facts, factKeys, "launch-skipped-count", String(t.launchSkipped));
    if (t.launchDeferred != null) addFact(facts, factKeys, "launch-deferred-count", String(t.launchDeferred));
    if (projection.launch.status) addFact(facts, factKeys, "launch-progress-status", projection.launch.status);
    if (projection.providers) {
      addFact(facts, factKeys, "launch-website-published", projection.providers.websitePublished ? "yes" : "no");
      addFact(facts, factKeys, "launch-payments-connected", projection.providers.stripeStatus);
      addFact(facts, factKeys, "launch-email-configured", projection.providers.emailConfigured ? "yes" : "no");
      addFact(facts, factKeys, "launch-sms-configured", projection.providers.smsConfigured ? "yes" : "no");
      addFact(facts, factKeys, "launch-storage-configured", projection.providers.storageConfigured ? "yes" : "no");
    }
  }
  if (projection.setup.loaded && t.setupProposals != null) {
    addFact(facts, factKeys, "setup-proposal-count", String(t.setupProposals));
  }
  return { facts, factKeys };
}

export async function runKnowledgeLaunchSpecialist(
  input: KnowledgeLaunchSpecialistInput,
): Promise<SpecialistResult> {
  recordKnowledgeLaunchSpecialistInterpretation();
  const catalogKeys = input.catalog.activeRecommendations
    .map((item) => item.key)
    .filter((key) => isKnowledgeLaunchOwnedRecommendationKey(key));

  void input.denyProductCapabilities;
  const gates = await resolveKnowledgeLaunchGates(
    input.db,
    input.access,
    input.denyRoleCapabilities,
  );
  if (gates.status === "skip") {
    lastKnowledgeLaunchProjection = null;
    return {
      specialistId: "KNOWLEDGE_LAUNCH",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: gates.limitation,
      skipReason: gates.skipReason,
    };
  }

  try {
    const projection = await loadKnowledgeLaunchProjection({
      db: input.db,
      access: input.access,
      entityHints: input.entityHints,
      denyRoleCapabilities: input.denyRoleCapabilities,
    });
    lastKnowledgeLaunchProjection = projection;

    const { factKeys } = projectKnowledgeLaunchFacts(projection);
    const rawFindings = findingsFromProjection(projection, catalogKeys);
    const findings: SpecialistFinding[] = rawFindings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: isKnowledgeLaunchOwnedRecommendationKey(item.key) ? [item.key] : [],
      factKeys,
      entityIds: item.entityIds,
    }));

    const limitations: string[] = [];
    if (!projection.canReadKnowledge) limitations.push(KNOWLEDGE_NOT_AUTHORIZED_LIMITATION);
    if (!projection.canReadLaunch) limitations.push(LAUNCH_NOT_AUTHORIZED_LIMITATION);
    if (!projection.canReadSetup) limitations.push(SETUP_NOT_AUTHORIZED_LIMITATION);
    if (projection.targetedEntityMismatch) {
      limitations.push(TARGET_CONSISTENCY_LIMITATION);
    } else {
      if (projection.targetedEntryUnauthorized) {
        limitations.push("That knowledge entry is not in this business workspace, so it was not targeted.");
      }
      if (projection.targetedCandidateUnauthorized) {
        limitations.push("That experience candidate is not in this business workspace, so it was not targeted.");
      }
      if (projection.targetedProcedureUnauthorized) {
        limitations.push("That operating procedure is not in this business workspace, so it was not targeted.");
      }
    }

    return {
      specialistId: "KNOWLEDGE_LAUNCH",
      status: "OK",
      findings,
      factKeys,
      recommendationKeys: catalogKeys,
      limitation: limitations.join(" ") || undefined,
    };
  } catch (error) {
    lastKnowledgeLaunchProjection = null;
    return {
      specialistId: "KNOWLEDGE_LAUNCH",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: KNOWLEDGE_LAUNCH_FAILURE_LIMITATION,
      failure: {
        specialistId: "KNOWLEDGE_LAUNCH",
        message: error instanceof Error ? error.message : "Knowledge/Launch projection could not be loaded.",
      },
    };
  }
}

export function emptyKnowledgeLaunchProjectionForTests(): KnowledgeLaunchProjection {
  return {
    totals: emptyTotals(),
    entries: [],
    candidates: [],
    procedures: [],
    launch: { ...unloadedLaunch() },
    setup: { ...unloadedSetup() },
    providers: null,
    canReadKnowledge: false,
    canReadLaunch: false,
    canReadSetup: false,
    canReadDeep: false,
    targetedEntryUnauthorized: false,
    targetedCandidateUnauthorized: false,
    targetedProcedureUnauthorized: false,
    targetedEntityMismatch: false,
    snapshotReused: false,
  };
}

export const KNOWLEDGE_STATE_CONTRACT = {
  approvalStates: KNOWLEDGE_APPROVAL_STATES,
  trustStates: KNOWLEDGE_TRUST_STATES,
  sourceTypes: KNOWLEDGE_SOURCE_TYPES,
} as const;

export const SETUP_STATE_CONTRACT = {
  proposalStatuses: COMPANY_SETUP_PROPOSAL_STATUSES,
  itemStatuses: COMPANY_SETUP_ITEM_STATUSES,
} as const;
