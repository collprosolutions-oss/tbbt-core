/**
 * Deep BUSINESS_PROTECTION specialist. Same specialist identity as the
 * PR1 placeholder.
 *
 * Loads one bounded read-only metadata projection when selected.
 * Interprets existing Business Protection / Business Vault / Agreement
 * Coach recorded truth. Does not create a second Protection engine,
 * Vault system, Agreement Coach, legal engine, or e-sign system.
 * Does not write records, invoke Agreement Coach AI, or call other
 * specialists.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";
import {
  AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE,
  LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
  LEGAL_NOT_AUTHORITY_MESSAGE,
  NO_FAKE_ESIGN_MESSAGE,
  NO_STATE_CLAUSE_MESSAGE,
  classifyExpiry,
  DATED_VAULT_CATEGORIES,
  EXPIRING_SOON_DAYS,
  EXPIRY_STATES,
  needsRenewalAttention,
  PROTECTION_CHECKLIST,
  utcCalendarDate,
  utcMidnightFromCalendarDate,
  VAULT_RECORD_STATUSES,
  isVaultCategory,
  isVaultRecordStatus,
  type ExpiryState,
  type VaultCategory,
  type VaultRecordStatus,
} from "@/lib/business-protection";
import {
  AGREEMENT_LIFECYCLE_STATUSES,
  COMPLETED_AGREEMENT_STATUSES,
  awaitingActionStatuses,
  isAgreementLifecycleStatus,
  isAgreementType,
  type AgreementLifecycleStatus,
} from "@/lib/business-protection-agreements";
import {
  ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
  resolveEsignProviderStatus,
  type EsignProviderStatus,
} from "@/lib/business-protection-esign";
import type { CanonicalRecommendationCatalog } from "@/lib/chief-of-staff/recommendations";
import {
  recordBusinessProtectionProjectionLoad,
  recordBusinessProtectionSpecialistInterpretation,
  shouldInjectBusinessProtectionLoadFailure,
} from "@/lib/chief-of-staff/business-protection-snapshot";
import type {
  CosEntityHints,
  SpecialistFinding,
  SpecialistResult,
  SpecialistSkipReason,
} from "@/lib/chief-of-staff/types";
import type { ProductCapabilityCode } from "@/lib/product-catalog/codes";

type Db = PrismaClient | Prisma.TransactionClient;

export const BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS = [] as const;

export type BusinessProtectionOwnedRecommendationKey =
  (typeof BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS)[number];

export const BUSINESS_PROTECTION_CONTEXT_CAPS = {
  vaultRecords: 10,
  agreements: 8,
  findings: 16,
  facts: 24,
  entityIds: 4,
  title: 120,
} as const;

const FORBIDDEN_PROJECTION_KEYS = [
  "notes",
  "storedAssetId",
  "fileHref",
  "fileName",
  "privateAssetPath",
  "draftContent",
  "answersJson",
  "answers",
  "riskReviewJson",
  "completedByMembershipId",
  "ownerReviewedByMembershipId",
  "legalReviewAcknowledgedByMembershipId",
  "createdByMembershipId",
  "updatedByMembershipId",
  "changedByMembershipId",
  "issuer",
  "counterparty",
  "completionNotes",
  "previousValue",
  "newValue",
  "password",
  "secret",
  "token",
  "apiKey",
  "originalFilename",
  "privateAsset",
];

const RECORDED_TRUTH_CAVEAT =
  "This is recorded organizational/workflow information, not a determination of legal, licensing, insurance, or regulatory compliance.";

export function isBusinessProtectionOwnedRecommendationKey(_key: string) {
  return false;
}

export function businessProtectionEntitlementLimitation(reason: SpecialistSkipReason) {
  if (reason === "NOT_AUTHORIZED") {
    return "Business Protection records were not loaded because this role cannot manage Business Protection. Assigned field work is not business-wide Vault or Agreement data. Missing Protection data is not treated as an empty vault, an empty checklist, or as compliance.";
  }
  return "Recorded Business Protection data is unavailable. Missing Protection data is not treated as an empty vault or as legal compliance.";
}

export const BUSINESS_PROTECTION_FAILURE_LIMITATION =
  "Recorded Business Protection data could not be loaded. No empty vault, invented compliance, or invented signature was substituted.";

export const TARGET_CONSISTENCY_LIMITATION =
  "The supplied record targets did not resolve to one consistent owned Business Protection context.";

export const FOREIGN_TARGET_LIMITATION =
  "The supplied record target is not available in this business workspace.";

export function currentIsRecordedDateNotLegalValidity(state: string) {
  return state === "CURRENT";
}

export function expiringSoonUsesCanonicalWindow(state: string, daysUntil: number) {
  return state === "EXPIRING_SOON" && daysUntil >= 0 && daysUntil <= EXPIRING_SOON_DAYS;
}

export function expiredIsRecordedDatePassed(state: string) {
  return state === "EXPIRED";
}

export function missingDateIsNotExpiredOrNoncompliant(state: string) {
  return state === "MISSING_DATE";
}

export function noDateOptionalStaysDistinct(state: string) {
  return state === "NO_DATE_OPTIONAL";
}

export function checklistMetIsNotCompliant(met: boolean) {
  return met;
}

export function ownerReviewIsNotAttorneyReview(ownerReviewRecorded: boolean) {
  return ownerReviewRecorded;
}

export function legalWarningAckIsNotAttorneyApproval(legalWarningAcknowledged: boolean) {
  return legalWarningAcknowledged;
}

export function completionIsNotEnforceable(lifecycleStatus: string) {
  return (
    lifecycleStatus === "SIGNED" ||
    lifecycleStatus === "COMPLETE" ||
    lifecycleStatus === "EXTERNAL_COMPLETE"
  );
}

export function lifecycleStatusesRemainDistinct(status: string): AgreementLifecycleStatus | null {
  return isAgreementLifecycleStatus(status) ? status : null;
}

export function esignStaysNotConnected(status: string) {
  return status === "NOT_CONNECTED";
}

export type VaultRecordProjection = {
  id: string;
  businessId: string;
  title: string;
  category: VaultCategory;
  recordStatus: VaultRecordStatus;
  effectiveOn: string | null;
  expiresOn: string | null;
  expiryState: ExpiryState;
  renewalAttention: boolean;
  targeted: boolean;
};

export type AgreementProjection = {
  id: string;
  businessId: string;
  title: string;
  agreementType: string;
  lifecycleStatus: AgreementLifecycleStatus;
  signingMode: string;
  effectiveOn: string | null;
  expiresOn: string | null;
  ownerReviewRecorded: boolean;
  legalWarningAcknowledged: boolean;
  hasSignedVersion: boolean;
  completionRecorded: boolean;
  targeted: boolean;
};

export type ProtectionChecklistProjection = {
  id: string;
  label: string;
  met: boolean;
  count: number;
};

export type BusinessProtectionProjectionTotals = {
  vaultActive: number;
  vaultArchived: number;
  expired: number;
  expiringSoon: number;
  missingDate: number;
  current: number;
  noDateOptional: number;
  agreements: number;
  questions: number;
  draft: number;
  riskReview: number;
  ownerReview: number;
  legalWarning: number;
  ready: number;
  sent: number;
  signed: number;
  complete: number;
  externalComplete: number;
  awaitingAction: number;
  checklistMet: number;
  checklistMissing: number;
};

export type BusinessProtectionProjection = {
  totals: BusinessProtectionProjectionTotals;
  vaultRecords: VaultRecordProjection[];
  agreements: AgreementProjection[];
  checklist: ProtectionChecklistProjection[];
  esign: {
    providerStatus: EsignProviderStatus;
    message: string;
  };
  canReadDeep: boolean;
  targetedVaultUnauthorized: boolean;
  targetedAgreementUnauthorized: boolean;
  targetedEntityMismatch: boolean;
  snapshotReused: false;
  disclaimer: string;
  authorityDisclaimer: string;
  agreementNotLegalAdvice: string;
  agreementNotEnforceable: string;
  attorneyRecommendation: string;
  noStateClause: string;
};

export type BusinessProtectionSpecialistInput = {
  db: Db;
  access: BusinessAccess;
  catalog: CanonicalRecommendationCatalog;
  question: string;
  entityHints?: CosEntityHints;
  denyProductCapabilities?: ProductCapabilityCode[];
  denyRoleCapabilities?: Capability[];
  now?: Date;
};

let lastBusinessProtectionProjection: BusinessProtectionProjection | null = null;

export function resetLastBusinessProtectionProjection() {
  lastBusinessProtectionProjection = null;
}

export function getLastBusinessProtectionProjection() {
  return lastBusinessProtectionProjection;
}

function addFact(facts: Record<string, string>, keys: string[], key: string, value: string) {
  if (keys.includes(key) || keys.length >= BUSINESS_PROTECTION_CONTEXT_CAPS.facts) return;
  facts[key] = value;
  keys.push(key);
}

function hasRole(access: BusinessAccess, capability: Capability, deny?: Capability[]) {
  if (deny?.includes(capability)) return false;
  return roleHasCapability(access.workspace.role, capability);
}

function boundedTitle(value: string | null | undefined) {
  return sanitizeAiText(value ?? "", BUSINESS_PROTECTION_CONTEXT_CAPS.title);
}

function assertSafeProjection(projection: BusinessProtectionProjection) {
  const raw = JSON.stringify(projection);
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Business Protection projection leaked a forbidden field.");
    }
  }
}

export function businessProtectionProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return FORBIDDEN_PROJECTION_KEYS.some(
    (key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw),
  );
}

function emptyTotals(): BusinessProtectionProjectionTotals {
  return {
    vaultActive: 0,
    vaultArchived: 0,
    expired: 0,
    expiringSoon: 0,
    missingDate: 0,
    current: 0,
    noDateOptional: 0,
    agreements: 0,
    questions: 0,
    draft: 0,
    riskReview: 0,
    ownerReview: 0,
    legalWarning: 0,
    ready: 0,
    sent: 0,
    signed: 0,
    complete: 0,
    externalComplete: 0,
    awaitingAction: 0,
    checklistMet: 0,
    checklistMissing: 0,
  };
}

function addUtcDays(calendarDate: string, days: number): string {
  const date = utcMidnightFromCalendarDate(calendarDate);
  date.setUTCDate(date.getUTCDate() + days);
  return utcCalendarDate(date);
}

const DATED_CATEGORY_LIST = [...DATED_VAULT_CATEGORIES];
const OPTIONAL_CATEGORY_LIST = (
  [
    "COMPANY_LEGAL",
    "EIN_TAX",
    "OTHER",
  ] as const
).filter((category) => !DATED_VAULT_CATEGORIES.has(category));

type GateDecision =
  | { status: "ok" }
  | { status: "skip"; skipReason: SpecialistSkipReason; limitation: string };

function resolveBusinessProtectionGates(
  access: BusinessAccess,
  denyRoleCapabilities?: Capability[],
): GateDecision {
  if (!hasRole(access, CAPABILITIES.MANAGE_BUSINESS_PROTECTION, denyRoleCapabilities)) {
    return {
      status: "skip",
      skipReason: "NOT_AUTHORIZED",
      limitation: businessProtectionEntitlementLimitation("NOT_AUTHORIZED"),
    };
  }
  return { status: "ok" };
}

type ResolvedTargets = {
  vaultRecordId: string | null;
  agreementId: string | null;
  scoped: boolean;
  targetedVaultUnauthorized: boolean;
  targetedAgreementUnauthorized: boolean;
  targetedEntityMismatch: boolean;
};

function suppliedHintCount(hints?: CosEntityHints) {
  if (!hints) return 0;
  return [hints.vaultRecordId, hints.agreementId].filter(Boolean).length;
}

async function resolveTargets(
  db: Db,
  businessId: string,
  hints?: CosEntityHints,
): Promise<ResolvedTargets> {
  const result: ResolvedTargets = {
    vaultRecordId: null,
    agreementId: null,
    scoped: false,
    targetedVaultUnauthorized: false,
    targetedAgreementUnauthorized: false,
    targetedEntityMismatch: false,
  };

  let authorizedVaultId: string | null = null;
  let authorizedAgreementId: string | null = null;
  let authorizedAgreementVaultId: string | null = null;

  if (hints?.vaultRecordId) {
    result.scoped = true;
    const vault = await db.businessVaultRecord.findFirst({
      where: { id: hints.vaultRecordId, businessId },
      select: { id: true, businessId: true },
    });
    if (!vault) result.targetedVaultUnauthorized = true;
    else authorizedVaultId = vault.id;
  }

  if (hints?.agreementId) {
    result.scoped = true;
    const agreement = await db.businessAgreement.findFirst({
      where: { id: hints.agreementId, businessId },
      select: { id: true, businessId: true, vaultRecordId: true },
    });
    if (!agreement) result.targetedAgreementUnauthorized = true;
    else {
      authorizedAgreementId = agreement.id;
      authorizedAgreementVaultId = agreement.vaultRecordId;
    }
  }

  const anyUnauthorized = result.targetedVaultUnauthorized || result.targetedAgreementUnauthorized;
  const bothSupplied = Boolean(hints?.vaultRecordId && hints?.agreementId);
  const related =
    Boolean(authorizedVaultId) &&
    Boolean(authorizedAgreementId) &&
    authorizedAgreementVaultId === authorizedVaultId;
  const mismatch = bothSupplied && !anyUnauthorized && !related;

  if (anyUnauthorized || mismatch) {
    result.vaultRecordId = null;
    result.agreementId = null;
    result.targetedEntityMismatch = mismatch || (anyUnauthorized && suppliedHintCount(hints) > 1);
    return result;
  }

  result.vaultRecordId = authorizedVaultId;
  result.agreementId = authorizedAgreementId;
  return result;
}

const vaultSelect = {
  id: true,
  businessId: true,
  title: true,
  category: true,
  recordStatus: true,
  effectiveOn: true,
  expiresOn: true,
} as const;

const agreementSelect = {
  id: true,
  businessId: true,
  title: true,
  agreementType: true,
  lifecycleStatus: true,
  signingMode: true,
  effectiveOn: true,
  expiresOn: true,
  vaultRecordId: true,
  signedVersionId: true,
  completedAt: true,
  ownerReviewedAt: true,
  legalReviewAcknowledgedAt: true,
} as const;

function projectVault(
  row: {
    id: string;
    businessId: string;
    title: string;
    category: string;
    recordStatus: string;
    effectiveOn: string | null;
    expiresOn: string | null;
  },
  now: Date,
  targeted: boolean,
): VaultRecordProjection {
  const category = isVaultCategory(row.category) ? row.category : "OTHER";
  const recordStatus = isVaultRecordStatus(row.recordStatus) ? row.recordStatus : "ACTIVE";
  const expiryState = classifyExpiry({ category, expiresOn: row.expiresOn, now });
  return {
    id: row.id,
    businessId: row.businessId,
    title: boundedTitle(row.title),
    category,
    recordStatus,
    effectiveOn: row.effectiveOn,
    expiresOn: row.expiresOn,
    expiryState,
    renewalAttention: needsRenewalAttention(expiryState),
    targeted,
  };
}

function projectAgreement(
  row: {
    id: string;
    businessId: string;
    title: string;
    agreementType: string;
    lifecycleStatus: string;
    signingMode: string;
    effectiveOn: string | null;
    expiresOn: string | null;
    signedVersionId: string | null;
    completedAt: Date | null;
    ownerReviewedAt: Date | null;
    legalReviewAcknowledgedAt: Date | null;
  },
  targeted: boolean,
): AgreementProjection {
  const lifecycleStatus = isAgreementLifecycleStatus(row.lifecycleStatus)
    ? row.lifecycleStatus
    : "QUESTIONS";
  return {
    id: row.id,
    businessId: row.businessId,
    title: boundedTitle(row.title),
    agreementType: isAgreementType(row.agreementType) ? row.agreementType : "CUSTOM_AGREEMENT",
    lifecycleStatus,
    signingMode: row.signingMode,
    effectiveOn: row.effectiveOn,
    expiresOn: row.expiresOn,
    ownerReviewRecorded: Boolean(row.ownerReviewedAt),
    legalWarningAcknowledged: Boolean(row.legalReviewAcknowledgedAt),
    hasSignedVersion: Boolean(row.signedVersionId),
    completionRecorded: Boolean(row.completedAt) || COMPLETED_AGREEMENT_STATUSES.has(lifecycleStatus),
    targeted,
  };
}

function pinRows<T extends { id: string }>(rows: T[], cap: number) {
  const selected: T[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id) || selected.length >= cap) continue;
    selected.push(row);
    seen.add(row.id);
  }
  return selected;
}

export async function loadBusinessProtectionProjection(input: {
  db: Db;
  access: BusinessAccess;
  entityHints?: CosEntityHints;
  now?: Date;
}): Promise<BusinessProtectionProjection> {
  recordBusinessProtectionProjectionLoad();
  if (shouldInjectBusinessProtectionLoadFailure()) {
    throw new Error("injected business-protection load failure");
  }

  const now = input.now ?? new Date();
  const today = utcCalendarDate(now);
  const soonEnd = addUtcDays(today, EXPIRING_SOON_DAYS);
  const businessId = input.access.businessId;
  const targets = await resolveTargets(input.db, businessId, input.entityHints);

  const failClosed =
    targets.targetedVaultUnauthorized ||
    targets.targetedAgreementUnauthorized ||
    targets.targetedEntityMismatch;
  const scoped = targets.scoped && !failClosed;
  const loadRows = !failClosed && (scoped || !targets.scoped);

  const vaultWhere: Prisma.BusinessVaultRecordWhereInput = { businessId };
  const agreementWhere: Prisma.BusinessAgreementWhereInput = { businessId };
  if (failClosed || (targets.scoped && !scoped)) {
    vaultWhere.id = "__no-such-owned-vault-record__";
    agreementWhere.id = "__no-such-owned-agreement__";
  } else if (scoped) {
    if (targets.vaultRecordId && targets.agreementId) {
      vaultWhere.id = targets.vaultRecordId;
      agreementWhere.id = targets.agreementId;
    } else if (targets.vaultRecordId) {
      vaultWhere.id = targets.vaultRecordId;
      agreementWhere.id = "__no-such-owned-agreement__";
    } else if (targets.agreementId) {
      agreementWhere.id = targets.agreementId;
      vaultWhere.id = "__no-such-owned-vault-record__";
    }
  }

  const activeWhere: Prisma.BusinessVaultRecordWhereInput = {
    ...vaultWhere,
    recordStatus: "ACTIVE",
  };

  const [
    attentionVault,
    missingDateVault,
    currentVault,
    optionalVault,
    recentVault,
    awaitingAgreements,
    recentAgreements,
    vaultActiveCount,
    vaultArchivedCount,
    expiredCount,
    expiringSoonCount,
    currentCount,
    missingDateCount,
    noDateOptionalCount,
    agreementCount,
    questionsCount,
    draftCount,
    riskReviewCount,
    ownerReviewCount,
    legalWarningCount,
    readyCount,
    sentCount,
    signedCount,
    completeCount,
    externalCompleteCount,
    checklistCounts,
  ] = await Promise.all([
    loadRows
      ? input.db.businessVaultRecord.findMany({
          where: {
            ...activeWhere,
            expiresOn: { not: null, lte: soonEnd },
          },
          orderBy: [{ expiresOn: "asc" }, { id: "asc" }],
          take: BUSINESS_PROTECTION_CONTEXT_CAPS.vaultRecords,
          select: vaultSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessVaultRecord.findMany({
          where: {
            ...activeWhere,
            expiresOn: null,
            category: { in: DATED_CATEGORY_LIST },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 4,
          select: vaultSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessVaultRecord.findMany({
          where: {
            ...activeWhere,
            expiresOn: { gt: soonEnd },
          },
          orderBy: [{ expiresOn: "asc" }, { id: "asc" }],
          take: 2,
          select: vaultSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessVaultRecord.findMany({
          where: {
            ...activeWhere,
            expiresOn: null,
            category: { in: OPTIONAL_CATEGORY_LIST },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: 2,
          select: vaultSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessVaultRecord.findMany({
          where: vaultWhere,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: BUSINESS_PROTECTION_CONTEXT_CAPS.vaultRecords,
          select: vaultSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessAgreement.findMany({
          where: {
            ...agreementWhere,
            lifecycleStatus: { in: awaitingActionStatuses() },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: BUSINESS_PROTECTION_CONTEXT_CAPS.agreements,
          select: agreementSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessAgreement.findMany({
          where: agreementWhere,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: BUSINESS_PROTECTION_CONTEXT_CAPS.agreements,
          select: agreementSelect,
        })
      : Promise.resolve([]),
    loadRows
      ? input.db.businessVaultRecord.count({ where: { ...vaultWhere, recordStatus: "ACTIVE" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessVaultRecord.count({ where: { ...vaultWhere, recordStatus: "ARCHIVED" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessVaultRecord.count({
          where: { ...activeWhere, expiresOn: { not: null, lt: today } },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessVaultRecord.count({
          where: { ...activeWhere, expiresOn: { gte: today, lte: soonEnd } },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessVaultRecord.count({
          where: { ...activeWhere, expiresOn: { gt: soonEnd } },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessVaultRecord.count({
          where: {
            ...activeWhere,
            expiresOn: null,
            category: { in: DATED_CATEGORY_LIST },
          },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessVaultRecord.count({
          where: {
            ...activeWhere,
            expiresOn: null,
            category: { in: OPTIONAL_CATEGORY_LIST },
          },
        })
      : Promise.resolve(0),
    loadRows ? input.db.businessAgreement.count({ where: agreementWhere }) : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({ where: { ...agreementWhere, lifecycleStatus: "QUESTIONS" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({ where: { ...agreementWhere, lifecycleStatus: "DRAFT" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({
          where: { ...agreementWhere, lifecycleStatus: "RISK_REVIEW" },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({
          where: { ...agreementWhere, lifecycleStatus: "OWNER_REVIEW" },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({
          where: { ...agreementWhere, lifecycleStatus: "LEGAL_WARNING" },
        })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({ where: { ...agreementWhere, lifecycleStatus: "READY" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({ where: { ...agreementWhere, lifecycleStatus: "SENT" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({ where: { ...agreementWhere, lifecycleStatus: "SIGNED" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({ where: { ...agreementWhere, lifecycleStatus: "COMPLETE" } })
      : Promise.resolve(0),
    loadRows
      ? input.db.businessAgreement.count({
          where: { ...agreementWhere, lifecycleStatus: "EXTERNAL_COMPLETE" },
        })
      : Promise.resolve(0),
    loadRows
      ? Promise.all(
          PROTECTION_CHECKLIST.map((item) =>
            input.db.businessVaultRecord.count({
              where: {
                businessId,
                recordStatus: "ACTIVE",
                category: { in: [...item.categories] },
                ...(failClosed || (targets.scoped && !scoped)
                  ? { id: "__no-such-owned-vault-record__" }
                  : targets.vaultRecordId
                    ? { id: targets.vaultRecordId }
                    : {}),
              },
            }),
          ),
        )
      : Promise.resolve(PROTECTION_CHECKLIST.map(() => 0)),
  ]);

  if (targets.vaultRecordId && loadRows && !recentVault.some((row) => row.id === targets.vaultRecordId)) {
    const extra = await input.db.businessVaultRecord.findFirst({
      where: { id: targets.vaultRecordId, businessId },
      select: vaultSelect,
    });
    if (extra) recentVault.unshift(extra);
  }
  if (
    targets.agreementId &&
    loadRows &&
    !recentAgreements.some((row) => row.id === targets.agreementId) &&
    !awaitingAgreements.some((row) => row.id === targets.agreementId)
  ) {
    const extra = await input.db.businessAgreement.findFirst({
      where: { id: targets.agreementId, businessId },
      select: agreementSelect,
    });
    if (extra) recentAgreements.unshift(extra);
  }

  const vaultRows = pinRows(
    [
      ...attentionVault,
      ...missingDateVault,
      ...currentVault,
      ...optionalVault,
      ...recentVault,
    ],
    BUSINESS_PROTECTION_CONTEXT_CAPS.vaultRecords,
  );
  const agreementRows = pinRows(
    [...awaitingAgreements, ...recentAgreements],
    BUSINESS_PROTECTION_CONTEXT_CAPS.agreements,
  );

  const vaultRecords = vaultRows.map((row) =>
    projectVault(row, now, Boolean(targets.vaultRecordId && row.id === targets.vaultRecordId)),
  );
  const agreements = agreementRows.map((row) =>
    projectAgreement(row, Boolean(targets.agreementId && row.id === targets.agreementId)),
  );

  const checklist = PROTECTION_CHECKLIST.map((item, index) => {
    const count = checklistCounts[index] ?? 0;
    return {
      id: item.id,
      label: item.label,
      met: count > 0,
      count,
    };
  });

  const projection: BusinessProtectionProjection = {
    totals: {
      vaultActive: vaultActiveCount,
      vaultArchived: vaultArchivedCount,
      expired: expiredCount,
      expiringSoon: expiringSoonCount,
      missingDate: missingDateCount,
      current: currentCount,
      noDateOptional: noDateOptionalCount,
      agreements: agreementCount,
      questions: questionsCount,
      draft: draftCount,
      riskReview: riskReviewCount,
      ownerReview: ownerReviewCount,
      legalWarning: legalWarningCount,
      ready: readyCount,
      sent: sentCount,
      signed: signedCount,
      complete: completeCount,
      externalComplete: externalCompleteCount,
      awaitingAction:
        questionsCount +
        draftCount +
        riskReviewCount +
        ownerReviewCount +
        legalWarningCount +
        readyCount +
        sentCount,
      checklistMet: checklist.filter((item) => item.met).length,
      checklistMissing: checklist.filter((item) => !item.met).length,
    },
    vaultRecords,
    agreements,
    checklist,
    esign: {
      providerStatus: resolveEsignProviderStatus(),
      message: ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
    },
    canReadDeep: loadRows,
    targetedVaultUnauthorized: targets.targetedVaultUnauthorized,
    targetedAgreementUnauthorized: targets.targetedAgreementUnauthorized,
    targetedEntityMismatch: targets.targetedEntityMismatch,
    snapshotReused: false,
    disclaimer: LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
    authorityDisclaimer: LEGAL_NOT_AUTHORITY_MESSAGE,
    agreementNotLegalAdvice: AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE,
    agreementNotEnforceable: AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
    attorneyRecommendation: AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
    noStateClause: NO_STATE_CLAUSE_MESSAGE,
  };

  if (failClosed) {
    projection.totals = emptyTotals();
    projection.vaultRecords = [];
    projection.agreements = [];
    projection.checklist = PROTECTION_CHECKLIST.map((item) => ({
      id: item.id,
      label: item.label,
      met: false,
      count: 0,
    }));
    projection.canReadDeep = false;
  }

  assertSafeProjection(projection);
  return projection;
}

function describeVault(row: VaultRecordProjection) {
  return `"${row.title}" [${row.category} / ${row.recordStatus} / ${row.expiryState}${row.expiresOn ? ` / recorded date ${row.expiresOn}` : ""}]`;
}

function describeAgreement(row: AgreementProjection) {
  return `"${row.title}" [${row.agreementType} / ${row.lifecycleStatus}]`;
}

function findingsFromProjection(
  projection: BusinessProtectionProjection,
): Array<{ key: string; title: string; why: string; entityIds?: string[] }> {
  if (!projection.canReadDeep) return [];
  const findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }> = [];
  const t = projection.totals;

  if (t.expired > 0) {
    const examples = projection.vaultRecords
      .filter((row) => row.expiryState === "EXPIRED")
      .slice(0, 2)
      .map(describeVault)
      .join("; ");
    findings.push({
      key: "protection-expired-recorded-date",
      title: "A recorded expiration date has passed",
      why:
        `${t.expired} active Business Vault ${t.expired === 1 ? "record has" : "records have"} an owner-recorded expiration date that has passed. ` +
        `TBBT classifies ${t.expired === 1 ? "this record" : "these records"} as EXPIRED based on the recorded date. ` +
        `EXPIRED is a recorded-date fact, not a legal or regulatory determination. ` +
        (examples ? `Recorded examples: ${examples}. ` : "") +
        RECORDED_TRUTH_CAVEAT,
      entityIds: projection.vaultRecords
        .filter((row) => row.expiryState === "EXPIRED")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.expiringSoon > 0) {
    const examples = projection.vaultRecords
      .filter((row) => row.expiryState === "EXPIRING_SOON")
      .slice(0, 2)
      .map(describeVault)
      .join("; ");
    findings.push({
      key: "protection-expiring-soon",
      title: "A recorded expiration date is within 30 days",
      why:
        `${t.expiringSoon} active Business Vault ${t.expiringSoon === 1 ? "record has" : "records have"} an owner-recorded expiration date within the canonical ${EXPIRING_SOON_DAYS}-day warning window. ` +
        `TBBT classifies ${t.expiringSoon === 1 ? "this record" : "these records"} as EXPIRING_SOON based on the recorded date. ` +
        `EXPIRING_SOON is not a regulatory determination. ` +
        (examples ? `Recorded examples: ${examples}. ` : "") +
        RECORDED_TRUTH_CAVEAT,
      entityIds: projection.vaultRecords
        .filter((row) => row.expiryState === "EXPIRING_SOON")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.missingDate > 0) {
    const examples = projection.vaultRecords
      .filter((row) => row.expiryState === "MISSING_DATE")
      .slice(0, 2)
      .map(describeVault)
      .join("; ");
    findings.push({
      key: "protection-missing-date",
      title: "An expected renewal date is missing",
      why:
        `${t.missingDate} active ${t.missingDate === 1 ? "record is" : "records are"} MISSING_DATE. ` +
        `MISSING_DATE means a category where TBBT expects a date has no recorded expiration date. It does not prove expiration or noncompliance. ` +
        (examples ? `Recorded examples: ${examples}. ` : "") +
        RECORDED_TRUTH_CAVEAT,
      entityIds: projection.vaultRecords
        .filter((row) => row.expiryState === "MISSING_DATE")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.current > 0) {
    findings.push({
      key: "protection-current-recorded-date",
      title: "Some recorded dates are outside the warning window",
      why:
        `${t.current} active ${t.current === 1 ? "record is" : "records are"} CURRENT. ` +
        `CURRENT means the owner-recorded expiration date is currently outside the warning window. ` +
        `It is a recorded-date classifier only, not a determination of legal, licensing, insurance, or regulatory status. ` +
        RECORDED_TRUTH_CAVEAT,
    });
  }

  if (t.noDateOptional > 0) {
    findings.push({
      key: "protection-no-date-optional",
      title: "Some categories do not require a recorded date",
      why:
        `${t.noDateOptional} active ${t.noDateOptional === 1 ? "record is" : "records are"} NO_DATE_OPTIONAL. ` +
        `That category does not require an expiration date in TBBT's organizational model. It does not prove legal validity.`,
    });
  }

  if (projection.checklist.length > 0) {
    const present = projection.checklist.filter((item) => item.met);
    const absent = projection.checklist.filter((item) => !item.met);
    findings.push({
      key: "protection-checklist-organization",
      title: "Business Protection checklist is an organization checklist",
      why:
        `${LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE} ${LEGAL_NOT_AUTHORITY_MESSAGE} ` +
        (present.length > 0
          ? `Recorded categories on file: ${present.map((item) => `${item.label} (${item.count})`).join("; ")}. A checklist item being met means the corresponding recorded category exists in TBBT. It does not mean compliant, licensed, insured, legally protected, government verified, or attorney reviewed. `
          : "") +
        (absent.length > 0
          ? `Checklist categories with no recorded match: ${absent.map((item) => item.label).join("; ")}. Absence is missing recorded organization, not a regulatory finding. `
          : "") +
        RECORDED_TRUTH_CAVEAT,
    });
  }

  const lifecycleCounts: Array<{ status: AgreementLifecycleStatus; count: number }> = [
    { status: "QUESTIONS", count: t.questions },
    { status: "DRAFT", count: t.draft },
    { status: "RISK_REVIEW", count: t.riskReview },
    { status: "OWNER_REVIEW", count: t.ownerReview },
    { status: "LEGAL_WARNING", count: t.legalWarning },
    { status: "READY", count: t.ready },
    { status: "SENT", count: t.sent },
    { status: "SIGNED", count: t.signed },
    { status: "COMPLETE", count: t.complete },
    { status: "EXTERNAL_COMPLETE", count: t.externalComplete },
  ];
  const presentLifecycles = lifecycleCounts.filter((row) => row.count > 0);
  if (presentLifecycles.length > 0) {
    const examples = projection.agreements.slice(0, 3).map(describeAgreement).join("; ");
    findings.push({
      key: "protection-agreement-lifecycle",
      title: "Agreement lifecycle states stay distinct recorded workflow states",
      why:
        `Recorded agreement workflow counts: ${presentLifecycles
          .map((row) => `${row.count} ${row.status}`)
          .join(", ")}. ` +
        `QUESTIONS is not DRAFT. DRAFT is not READY. RISK_REVIEW is not attorney review. ` +
        `OWNER_REVIEW is a recorded owner review workflow state, not attorney approval. ` +
        `LEGAL_WARNING is a TBBT workflow/legal-warning state, not proof a lawyer reviewed it. ` +
        `READY is internally ready under TBBT's recorded workflow, not legally sufficient or enforceable. ` +
        `SENT means a sent version was recorded, not received, accepted, or signed. ` +
        `SIGNED, COMPLETE, and EXTERNAL_COMPLETE are recorded completion/signing workflow facts, not legal validity, enforceability, attorney approval, or government approval. ` +
        (examples ? `Recorded examples: ${examples}. ` : "") +
        `${AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE} ${AGREEMENT_NOT_ENFORCEABLE_MESSAGE} ${AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE} ${NO_STATE_CLAUSE_MESSAGE}`,
      entityIds: projection.agreements.map((row) => row.id).slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  const ownerReviewed = projection.agreements.filter((row) => row.ownerReviewRecorded);
  const ownerNotReviewed = projection.agreements.filter((row) => !row.ownerReviewRecorded);
  if (ownerReviewed.length > 0 || t.ownerReview > 0) {
    findings.push({
      key: "protection-owner-review-recorded",
      title: "Owner review is a recorded workflow fact",
      why:
        (ownerReviewed.length > 0
          ? `Owner review is recorded for ${ownerReviewed.length} projected agreement${ownerReviewed.length === 1 ? "" : "s"}. `
          : `${t.ownerReview} agreement${t.ownerReview === 1 ? " is" : "s are"} in OWNER_REVIEW. `) +
        `That is recorded owner review, not attorney approval, attorney review, legal approval, or legal sufficiency.`,
      entityIds: ownerReviewed.map((row) => row.id).slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }
  if (ownerNotReviewed.length > 0 && t.ownerReview > 0) {
    findings.push({
      key: "protection-owner-review-not-recorded",
      title: "Some agreements do not have recorded owner review",
      why: "Owner review is not recorded on some projected agreements. Missing owner review is not attorney review either.",
    });
  }

  const legalAck = projection.agreements.filter((row) => row.legalWarningAcknowledged);
  if (legalAck.length > 0 || t.legalWarning > 0) {
    findings.push({
      key: "protection-legal-warning-acknowledged",
      title: "Legal-review warning acknowledgment is not attorney approval",
      why:
        (legalAck.length > 0
          ? `The legal-review recommendation/warning was acknowledged on ${legalAck.length} projected agreement${legalAck.length === 1 ? "" : "s"}. `
          : `${t.legalWarning} agreement${t.legalWarning === 1 ? " is" : "s are"} in LEGAL_WARNING. `) +
        `Acknowledgment does not mean an attorney reviewed it, legal advice was received, or the agreement is safe or enforceable.`,
      entityIds: legalAck.map((row) => row.id).slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.signed + t.complete + t.externalComplete > 0) {
    findings.push({
      key: "protection-agreement-complete-not-enforceable",
      title: "Recorded completion is not legal enforceability",
      why:
        `${t.signed} SIGNED, ${t.complete} COMPLETE, and ${t.externalComplete} EXTERNAL_COMPLETE agreement${
          t.signed + t.complete + t.externalComplete === 1 ? " is" : "s are"
        } on file. ` +
        `Those are recorded agreement completion/signing workflow facts. They are not legal validity, enforceability, attorney approval, or government approval. ` +
        `${AGREEMENT_NOT_ENFORCEABLE_MESSAGE}`,
    });
  }

  if (projection.esign.providerStatus === "NOT_CONNECTED") {
    findings.push({
      key: "protection-esign-not-connected",
      title: "No e-sign provider is connected",
      why:
        `${NO_FAKE_ESIGN_MESSAGE} ${projection.esign.message} ` +
        `Provider status is NOT_CONNECTED. A signed version, completion status, uploaded file, or external signature does not connect a provider and does not invent a digital signature.`,
    });
  }

  return findings.slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.findings);
}

export function projectBusinessProtectionFacts(projection: BusinessProtectionProjection) {
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];
  if (!projection.canReadDeep) return { facts, factKeys };
  const t = projection.totals;
  const expiring = projection.vaultRecords.find((row) => row.expiryState === "EXPIRING_SOON");
  const expired = projection.vaultRecords.find((row) => row.expiryState === "EXPIRED");
  const missing = projection.vaultRecords.find((row) => row.expiryState === "MISSING_DATE");
  const ownerReview = projection.agreements.find((row) => row.lifecycleStatus === "OWNER_REVIEW");
  const draft = projection.agreements.find((row) => row.lifecycleStatus === "DRAFT");

  if (expiring) addFact(facts, factKeys, "protection-expiring-example", describeVault(expiring));
  if (expired) addFact(facts, factKeys, "protection-expired-example", describeVault(expired));
  if (missing) addFact(facts, factKeys, "protection-missing-date-example", describeVault(missing));
  if (ownerReview) addFact(facts, factKeys, "protection-owner-review-example", describeAgreement(ownerReview));
  if (draft) addFact(facts, factKeys, "protection-draft-example", describeAgreement(draft));

  addFact(facts, factKeys, "protection-expired-count", String(t.expired));
  addFact(facts, factKeys, "protection-expiring-soon-count", String(t.expiringSoon));
  addFact(facts, factKeys, "protection-missing-date-count", String(t.missingDate));
  addFact(facts, factKeys, "protection-current-count", String(t.current));
  addFact(facts, factKeys, "protection-no-date-optional-count", String(t.noDateOptional));
  addFact(facts, factKeys, "protection-vault-active-count", String(t.vaultActive));
  addFact(facts, factKeys, "protection-agreement-count", String(t.agreements));
  addFact(facts, factKeys, "protection-owner-review-count", String(t.ownerReview));
  addFact(facts, factKeys, "protection-draft-count", String(t.draft));
  addFact(facts, factKeys, "protection-questions-count", String(t.questions));
  addFact(facts, factKeys, "protection-ready-count", String(t.ready));
  addFact(facts, factKeys, "protection-complete-count", String(t.complete + t.signed + t.externalComplete));
  addFact(facts, factKeys, "protection-checklist-met-count", String(t.checklistMet));
  addFact(facts, factKeys, "protection-esign-status", projection.esign.providerStatus);
  return { facts, factKeys };
}

export async function runBusinessProtectionSpecialist(
  input: BusinessProtectionSpecialistInput,
): Promise<SpecialistResult> {
  recordBusinessProtectionSpecialistInterpretation();
  void input.denyProductCapabilities;
  void input.catalog;

  const gates = resolveBusinessProtectionGates(input.access, input.denyRoleCapabilities);
  if (gates.status === "skip") {
    lastBusinessProtectionProjection = null;
    return {
      specialistId: "BUSINESS_PROTECTION",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: gates.limitation,
      skipReason: gates.skipReason,
    };
  }

  try {
    const projection = await loadBusinessProtectionProjection({
      db: input.db,
      access: input.access,
      entityHints: input.entityHints,
      now: input.now,
    });
    lastBusinessProtectionProjection = projection;

    const { factKeys } = projectBusinessProtectionFacts(projection);
    const rawFindings = findingsFromProjection(projection);
    const findings: SpecialistFinding[] = rawFindings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: [],
      factKeys,
      entityIds: item.entityIds,
    }));

    const limitations: string[] = [];
    if (projection.targetedEntityMismatch || projection.targetedVaultUnauthorized || projection.targetedAgreementUnauthorized) {
      limitations.push(
        projection.targetedEntityMismatch ? TARGET_CONSISTENCY_LIMITATION : FOREIGN_TARGET_LIMITATION,
      );
    }

    return {
      specialistId: "BUSINESS_PROTECTION",
      status: "OK",
      findings,
      factKeys,
      recommendationKeys: [],
      limitation: limitations.join(" ") || undefined,
    };
  } catch (error) {
    lastBusinessProtectionProjection = null;
    return {
      specialistId: "BUSINESS_PROTECTION",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: BUSINESS_PROTECTION_FAILURE_LIMITATION,
      failure: {
        specialistId: "BUSINESS_PROTECTION",
        message:
          error instanceof Error ? error.message : "Business Protection projection could not be loaded.",
      },
    };
  }
}

export function emptyBusinessProtectionProjectionForTests(): BusinessProtectionProjection {
  return {
    totals: emptyTotals(),
    vaultRecords: [],
    agreements: [],
    checklist: PROTECTION_CHECKLIST.map((item) => ({
      id: item.id,
      label: item.label,
      met: false,
      count: 0,
    })),
    esign: {
      providerStatus: "NOT_CONNECTED",
      message: ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
    },
    canReadDeep: false,
    targetedVaultUnauthorized: false,
    targetedAgreementUnauthorized: false,
    targetedEntityMismatch: false,
    snapshotReused: false,
    disclaimer: LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
    authorityDisclaimer: LEGAL_NOT_AUTHORITY_MESSAGE,
    agreementNotLegalAdvice: AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE,
    agreementNotEnforceable: AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
    attorneyRecommendation: AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
    noStateClause: NO_STATE_CLAUSE_MESSAGE,
  };
}

export const PROTECTION_STATE_CONTRACT = {
  vaultStatuses: VAULT_RECORD_STATUSES,
  expiryStates: EXPIRY_STATES,
  lifecycleStatuses: AGREEMENT_LIFECYCLE_STATUSES,
  expiringSoonDays: EXPIRING_SOON_DAYS,
} as const;
