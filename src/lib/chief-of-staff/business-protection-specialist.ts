/**
 * Deep BUSINESS_PROTECTION specialist. Same specialist identity as the
 * PR1 placeholder.
 *
 * Loads one bounded read-only projection when selected. Explains
 * recorded Vault / checklist / agreement / e-sign metadata. Does not
 * build another legal engine and does not redesign Business Protection.
 * Does not write vault records, upload, archive, renew, sign, generate
 * or edit agreements, mutate lifecycle, owner review, or legal
 * acknowledgment, send reminders, or propose owner actions. Does not
 * call other specialists.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, roleHasCapability, type Capability } from "@/lib/authorization";
import {
  LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
  LEGAL_NOT_AUTHORITY_MESSAGE,
  PROTECTION_CHECKLIST,
  classifyExpiry,
  isVaultCategory,
  isVaultRecordStatus,
  type ExpiryState,
  type VaultCategory,
  type VaultRecordStatus,
} from "@/lib/business-protection";
import {
  AGREEMENT_LIFECYCLE_STATUSES,
  COMPLETED_AGREEMENT_STATUSES,
  isAgreementLifecycleStatus,
  isAgreementType,
  type AgreementLifecycleStatus,
  type AgreementType,
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
import { resolveProductEntitlement } from "@/lib/product-entitlements";
import type { ProductCapabilityCode } from "@/lib/product-catalog/codes";

type Db = PrismaClient | Prisma.TransactionClient;

export const BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS = [
  "protection-expired-record",
  "protection-expiring-soon",
  "protection-missing-date",
  "protection-checklist-gap",
  "protection-agreement-draft",
  "protection-agreement-ready",
  "protection-agreement-sent",
  "protection-agreement-complete",
  "protection-esign-disconnected",
] as const;

export type BusinessProtectionOwnedRecommendationKey =
  (typeof BUSINESS_PROTECTION_OWNED_RECOMMENDATION_KEYS)[number];

export const BUSINESS_PROTECTION_CONTEXT_CAPS = {
  records: 12,
  agreements: 8,
  checklist: PROTECTION_CHECKLIST.length,
  findings: 16,
  facts: 24,
  entityIds: 4,
} as const;

const FORBIDDEN_PROJECTION_KEYS = [
  "notes",
  "draftContent",
  "answersJson",
  "answers",
  "riskReviewJson",
  "completionNotes",
  "storageKey",
  "fileHref",
  "storedAssetId",
  "password",
  "secret",
  "token",
  "apiKey",
  "authToken",
  "signature",
  "providerSecret",
  "previousValue",
  "newValue",
];

const LEGAL_CONCLUSION_RE =
  /\blegally compliant\b|\blegally protected\b|\binsured\b|\blicensed\b|\benforceable\b|\blegally sufficient\b|\bagreement is valid\b|\battorney approved\b/i;

export function isBusinessProtectionOwnedRecommendationKey(
  key: string,
): key is BusinessProtectionOwnedRecommendationKey {
  return key.startsWith("protection-");
}

export function businessProtectionEntitlementLimitation(
  reason: SpecialistSkipReason,
) {
  if (reason === "NOT_AUTHORIZED") {
    return "Business Protection vault and agreement records were not loaded because this role cannot manage Business Protection. Assigned field work is not business-wide Vault or agreement data. Missing Protection data is not treated as an empty vault or as legal compliance.";
  }
  if (reason === "NOT_ENTITLED") {
    return "Business Protection records were not loaded because this workspace does not have an active operating subscription. Missing Protection data is not treated as an empty vault or as legal compliance.";
  }
  return "Recorded Business Protection data is unavailable. Missing Protection data is not treated as an empty vault or as legal compliance.";
}

export const BUSINESS_PROTECTION_FAILURE_LIMITATION =
  "Recorded Business Protection data could not be loaded. No substitute vault state, invented compliance, or invented signature was substituted.";

export const TARGET_CONSISTENCY_LIMITATION =
  "The supplied record targets did not resolve to one consistent owned Vault or agreement context.";

export function missingDateIsNotCurrent(state: ExpiryState) {
  return state === "MISSING_DATE";
}

export function missingDateIsNotCompliant(state: ExpiryState) {
  return state === "MISSING_DATE";
}

export function noDateOptionalIsNotCurrent(state: ExpiryState) {
  return state === "NO_DATE_OPTIONAL";
}

export function checklistMetIsNotCompliance(met: boolean) {
  return met === true;
}

export function draftIsNotReady(status: string) {
  return status === "DRAFT";
}

export function draftIsNotComplete(status: string) {
  return status === "DRAFT";
}

export function readyIsNotSent(status: string) {
  return status === "READY";
}

export function sentIsNotComplete(status: string) {
  return status === "SENT";
}

export function completeDoesNotMeanEnforceable(status: string) {
  return (
    status === "COMPLETE" ||
    status === "SIGNED" ||
    status === "EXTERNAL_COMPLETE"
  );
}

export function esignDisconnectedIsNotSigned(providerStatus: string) {
  return providerStatus === "NOT_CONNECTED";
}

export function ownerReviewIsRecordedOnly(recorded: boolean) {
  return recorded;
}

export function legalAckIsNotAttorneyApproval(recorded: boolean) {
  return recorded;
}

export function archivedIsNotActive(status: string) {
  return status === "ARCHIVED";
}

export function currentIsNotInsured(state: ExpiryState) {
  return state === "CURRENT";
}

export type VaultRecordProjection = {
  id: string;
  businessId: string;
  title: string;
  category: VaultCategory;
  recordStatus: VaultRecordStatus;
  expiresOn: string | null;
  expiryState: ExpiryState;
  issuer: string | null;
  counterparty: string | null;
  hasStoredFile: boolean;
  targeted: boolean;
};

export type AgreementProjection = {
  id: string;
  businessId: string;
  title: string;
  agreementType: AgreementType;
  lifecycleStatus: AgreementLifecycleStatus;
  ownerReviewRecorded: boolean;
  legalReviewAcknowledged: boolean;
  signedFileRecorded: boolean;
  completedRecorded: boolean;
  signingMode: string;
  targeted: boolean;
};

export type ProtectionChecklistProjection = {
  id: string;
  label: string;
  met: boolean;
  count: number;
};

export type BusinessProtectionProjectionTotals = {
  records: number;
  activeRecords: number;
  archivedRecords: number;
  current: number;
  expiringSoon: number;
  expired: number;
  missingDate: number;
  noDateOptional: number;
  agreements: number;
  draft: number;
  ready: number;
  sent: number;
  complete: number;
  ownerReviewRecorded: number;
  legalReviewAcknowledged: number;
  signedFileRecorded: number;
  checklistMet: number;
  checklistOpen: number;
};

export type BusinessProtectionProjection = {
  totals: BusinessProtectionProjectionTotals;
  records: VaultRecordProjection[];
  agreements: AgreementProjection[];
  checklist: ProtectionChecklistProjection[];
  esign: {
    providerStatus: EsignProviderStatus;
    connected: boolean;
    message: string;
  };
  disclaimers: {
    checklist: string;
    authority: string;
  };
  canReadDeep: boolean;
  targetedVaultUnauthorized: boolean;
  targetedAgreementUnauthorized: boolean;
  targetedEntityMismatch: boolean;
  snapshotReused: false;
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

function assertSafeProjection(projection: BusinessProtectionProjection) {
  const raw = JSON.stringify(projection);
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    if (raw.includes(`"${key}"`)) {
      throw new Error("Business Protection projection leaked a forbidden field.");
    }
  }
  if (LEGAL_CONCLUSION_RE.test(raw)) {
    throw new Error("Business Protection projection used legal-sufficiency language.");
  }
}

export function businessProtectionProjectionHasForbiddenFields(value: unknown) {
  const raw = JSON.stringify(value);
  return FORBIDDEN_PROJECTION_KEYS.some(
    (key) => raw.includes(`"${key}"`) || new RegExp(`"${key}":`, "i").test(raw),
  );
}

export function businessProtectionTextHasLegalSufficiency(value: unknown) {
  return LEGAL_CONCLUSION_RE.test(JSON.stringify(value));
}

function emptyTotals(): BusinessProtectionProjectionTotals {
  return {
    records: 0,
    activeRecords: 0,
    archivedRecords: 0,
    current: 0,
    expiringSoon: 0,
    expired: 0,
    missingDate: 0,
    noDateOptional: 0,
    agreements: 0,
    draft: 0,
    ready: 0,
    sent: 0,
    complete: 0,
    ownerReviewRecorded: 0,
    legalReviewAcknowledged: 0,
    signedFileRecorded: 0,
    checklistMet: 0,
    checklistOpen: 0,
  };
}

type GateDecision =
  | { status: "ok" }
  | { status: "skip"; skipReason: SpecialistSkipReason; limitation: string };

async function resolveBusinessProtectionGates(
  db: Db,
  access: BusinessAccess,
  denyRoleCapabilities?: Capability[],
): Promise<GateDecision> {
  const canManageProtection = hasRole(
    access,
    CAPABILITIES.MANAGE_BUSINESS_PROTECTION,
    denyRoleCapabilities,
  );
  if (!canManageProtection) {
    return {
      status: "skip",
      skipReason: "NOT_AUTHORIZED",
      limitation: businessProtectionEntitlementLimitation("NOT_AUTHORIZED"),
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
      limitation: businessProtectionEntitlementLimitation("UNAVAILABLE"),
    };
  }

  const entitlement = await resolveProductEntitlement(db, business);
  if (!entitlement.operating.canOperate) {
    return {
      status: "skip",
      skipReason: "NOT_ENTITLED",
      limitation: businessProtectionEntitlementLimitation("NOT_ENTITLED"),
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
  let agreementVaultId: string | null = null;

  if (hints?.vaultRecordId) {
    result.scoped = true;
    const record = await db.businessVaultRecord.findFirst({
      where: { id: hints.vaultRecordId, businessId },
      select: { id: true, businessId: true },
    });
    if (!record) result.targetedVaultUnauthorized = true;
    else authorizedVaultId = record.id;
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
      agreementVaultId = agreement.vaultRecordId;
    }
  }

  const anyUnauthorized =
    result.targetedVaultUnauthorized || result.targetedAgreementUnauthorized;
  const mismatch =
    Boolean(authorizedVaultId) &&
    Boolean(authorizedAgreementId) &&
    Boolean(agreementVaultId) &&
    agreementVaultId !== authorizedVaultId;

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

function projectVaultRecord(
  row: {
    id: string;
    businessId: string;
    title: string;
    category: string;
    issuer: string | null;
    counterparty: string | null;
    expiresOn: string | null;
    recordStatus: string;
    storedAssetId: string | null;
  },
  now: Date,
  targeted: boolean,
): VaultRecordProjection {
  const category = isVaultCategory(row.category) ? row.category : "OTHER";
  const recordStatus = isVaultRecordStatus(row.recordStatus) ? row.recordStatus : "ACTIVE";
  return {
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    category,
    recordStatus,
    expiresOn: row.expiresOn,
    expiryState: classifyExpiry({ category, expiresOn: row.expiresOn, now }),
    issuer: row.issuer,
    counterparty: row.counterparty,
    hasStoredFile: Boolean(row.storedAssetId),
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
    vaultRecordId: string | null;
    signedVersionId: string | null;
    completedAt: Date | null;
    ownerReviewedAt: Date | null;
    legalReviewAcknowledgedAt: Date | null;
  },
  targeted: boolean,
): AgreementProjection {
  const agreementType = isAgreementType(row.agreementType)
    ? row.agreementType
    : "CUSTOM_AGREEMENT";
  const lifecycleStatus = isAgreementLifecycleStatus(row.lifecycleStatus)
    ? row.lifecycleStatus
    : "QUESTIONS";
  return {
    id: row.id,
    businessId: row.businessId,
    title: row.title,
    agreementType,
    lifecycleStatus,
    ownerReviewRecorded: Boolean(row.ownerReviewedAt),
    legalReviewAcknowledged: Boolean(row.legalReviewAcknowledgedAt),
    signedFileRecorded: Boolean(row.signedVersionId || row.vaultRecordId),
    completedRecorded:
      Boolean(row.completedAt) || COMPLETED_AGREEMENT_STATUSES.has(lifecycleStatus),
    signingMode: row.signingMode,
    targeted,
  };
}

export async function loadBusinessProtectionProjection(input: {
  db: Db;
  access: BusinessAccess;
  entityHints?: CosEntityHints;
  now?: Date;
}): Promise<BusinessProtectionProjection> {
  recordBusinessProtectionProjectionLoad();
  if (shouldInjectBusinessProtectionLoadFailure()) {
    throw new Error("injected business protection load failure");
  }

  const businessId = input.access.businessId;
  const now = input.now ?? new Date();
  const targets = await resolveTargets(input.db, businessId, input.entityHints);
  const failClosed =
    targets.targetedVaultUnauthorized ||
    targets.targetedAgreementUnauthorized ||
    targets.targetedEntityMismatch;

  const recordWhere: Prisma.BusinessVaultRecordWhereInput = { businessId };
  const agreementWhere: Prisma.BusinessAgreementWhereInput = { businessId };
  if (failClosed || (targets.scoped && !targets.vaultRecordId && !targets.agreementId)) {
    recordWhere.id = "__no-such-owned-vault-record__";
    agreementWhere.id = "__no-such-owned-agreement__";
  } else {
    if (targets.vaultRecordId) recordWhere.id = targets.vaultRecordId;
    if (targets.agreementId) agreementWhere.id = targets.agreementId;
  }

  const loadRows = !failClosed && (!targets.scoped || Boolean(targets.vaultRecordId) || Boolean(targets.agreementId));

  const [recordRows, agreementRows] = loadRows
    ? await Promise.all([
        targets.scoped && !targets.vaultRecordId && targets.agreementId
          ? Promise.resolve([])
          : input.db.businessVaultRecord.findMany({
              where: recordWhere,
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: BUSINESS_PROTECTION_CONTEXT_CAPS.records,
              select: {
                id: true,
                businessId: true,
                title: true,
                category: true,
                issuer: true,
                counterparty: true,
                expiresOn: true,
                recordStatus: true,
                storedAssetId: true,
              },
            }),
        targets.scoped && !targets.agreementId && targets.vaultRecordId
          ? Promise.resolve([])
          : input.db.businessAgreement.findMany({
              where: agreementWhere,
              orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              take: BUSINESS_PROTECTION_CONTEXT_CAPS.agreements,
              select: {
                id: true,
                businessId: true,
                title: true,
                agreementType: true,
                lifecycleStatus: true,
                signingMode: true,
                vaultRecordId: true,
                signedVersionId: true,
                completedAt: true,
                ownerReviewedAt: true,
                legalReviewAcknowledgedAt: true,
              },
            }),
      ])
    : [[], []];

  const records = recordRows.map((row) =>
    projectVaultRecord(row, now, Boolean(targets.vaultRecordId && row.id === targets.vaultRecordId)),
  );
  const agreements = agreementRows.map((row) =>
    projectAgreement(row, Boolean(targets.agreementId && row.id === targets.agreementId)),
  );

  const active = records.filter((row) => row.recordStatus === "ACTIVE");
  const checklist = PROTECTION_CHECKLIST.map((item) => {
    const count = active.filter((row) =>
      (item.categories as readonly string[]).includes(row.category),
    ).length;
    return { id: item.id, label: item.label, met: count > 0, count };
  }).slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.checklist);

  const providerStatus = resolveEsignProviderStatus();
  const projection: BusinessProtectionProjection = {
    totals: {
      records: records.length,
      activeRecords: active.length,
      archivedRecords: records.filter((row) => row.recordStatus === "ARCHIVED").length,
      current: active.filter((row) => row.expiryState === "CURRENT").length,
      expiringSoon: active.filter((row) => row.expiryState === "EXPIRING_SOON").length,
      expired: active.filter((row) => row.expiryState === "EXPIRED").length,
      missingDate: active.filter((row) => row.expiryState === "MISSING_DATE").length,
      noDateOptional: active.filter((row) => row.expiryState === "NO_DATE_OPTIONAL").length,
      agreements: agreements.length,
      draft: agreements.filter((row) => row.lifecycleStatus === "DRAFT").length,
      ready: agreements.filter((row) => row.lifecycleStatus === "READY").length,
      sent: agreements.filter((row) => row.lifecycleStatus === "SENT").length,
      complete: agreements.filter((row) =>
        COMPLETED_AGREEMENT_STATUSES.has(row.lifecycleStatus),
      ).length,
      ownerReviewRecorded: agreements.filter((row) => row.ownerReviewRecorded).length,
      legalReviewAcknowledged: agreements.filter((row) => row.legalReviewAcknowledged).length,
      signedFileRecorded: agreements.filter((row) => row.signedFileRecorded).length,
      checklistMet: checklist.filter((row) => row.met).length,
      checklistOpen: checklist.filter((row) => !row.met).length,
    },
    records,
    agreements,
    checklist,
    esign: {
      providerStatus,
      connected: providerStatus === "PROVIDER_READY",
      message: ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
    },
    disclaimers: {
      checklist: LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
      authority: LEGAL_NOT_AUTHORITY_MESSAGE,
    },
    canReadDeep: !failClosed,
    targetedVaultUnauthorized: targets.targetedVaultUnauthorized,
    targetedAgreementUnauthorized: targets.targetedAgreementUnauthorized,
    targetedEntityMismatch: targets.targetedEntityMismatch,
    snapshotReused: false,
  };

  assertSafeProjection(projection);
  return projection;
}

function findingsFromProjection(
  projection: BusinessProtectionProjection,
  catalogKeys: string[],
): Array<{ key: string; title: string; why: string; entityIds?: string[] }> {
  const findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }> = [];
  const t = projection.totals;

  if (t.expired > 0) {
    findings.push({
      key: "protection-expired-record",
      title: "A recorded vault date is EXPIRED",
      why: `${t.expired} ACTIVE vault ${t.expired === 1 ? "record has" : "records have"} expiryState EXPIRED. That is recorded calendar-date state, not a regulatory finding and not a statement about coverage or authority.`,
      entityIds: projection.records
        .filter((row) => row.recordStatus === "ACTIVE" && row.expiryState === "EXPIRED")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.expiringSoon > 0) {
    findings.push({
      key: "protection-expiring-soon",
      title: "A recorded vault date is EXPIRING_SOON",
      why: `${t.expiringSoon} ACTIVE vault ${t.expiringSoon === 1 ? "record has" : "records have"} expiryState EXPIRING_SOON. That is recorded calendar-date state, not a state-specific legal deadline and not a compliance finding.`,
      entityIds: projection.records
        .filter((row) => row.recordStatus === "ACTIVE" && row.expiryState === "EXPIRING_SOON")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.missingDate > 0) {
    findings.push({
      key: "protection-missing-date",
      title: "A dated vault category is MISSING_DATE",
      why: `${t.missingDate} ACTIVE vault ${t.missingDate === 1 ? "record has" : "records have"} expiryState MISSING_DATE. MISSING_DATE is not CURRENT and is not a finding of legal compliance.`,
      entityIds: projection.records
        .filter((row) => row.recordStatus === "ACTIVE" && row.expiryState === "MISSING_DATE")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.noDateOptional > 0) {
    findings.push({
      key: "protection-no-date-optional",
      title: "A vault category is NO_DATE_OPTIONAL",
      why: `${t.noDateOptional} ACTIVE vault ${t.noDateOptional === 1 ? "record has" : "records have"} expiryState NO_DATE_OPTIONAL. That means a date is not required for the recorded category. It is not CURRENT and not a compliance finding.`,
      entityIds: projection.records
        .filter((row) => row.recordStatus === "ACTIVE" && row.expiryState === "NO_DATE_OPTIONAL")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.current > 0) {
    findings.push({
      key: "protection-current-date",
      title: "A recorded vault date is CURRENT",
      why: `${t.current} ACTIVE vault ${t.current === 1 ? "record has" : "records have"} expiryState CURRENT. CURRENT is recorded date state only. It is not coverage, authority, legal protection, or regulatory compliance.`,
      entityIds: projection.records
        .filter((row) => row.recordStatus === "ACTIVE" && row.expiryState === "CURRENT")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.checklistOpen > 0 || t.checklistMet > 0) {
    const open = projection.checklist.filter((row) => !row.met);
    const met = projection.checklist.filter((row) => row.met);
    findings.push({
      key: "protection-checklist-gap",
      title: "Protection checklist is organizational record truth",
      why: `${met.length} checklist ${met.length === 1 ? "item is" : "items are"} met because matching ACTIVE records are on file${
        open.length > 0
          ? `, and ${open.length} ${open.length === 1 ? "item is" : "items are"} missing from recorded files`
          : ""
      }. Checklist state is organizational record truth, not regulatory or legal compliance. ${projection.disclaimers.checklist}`,
    });
  }

  if (t.draft > 0) {
    findings.push({
      key: "protection-agreement-draft",
      title: "An agreement is recorded as DRAFT",
      why: `${t.draft} agreement${t.draft === 1 ? " has" : "s have"} lifecycleStatus DRAFT. DRAFT is not READY, SENT, or COMPLETE. A recorded draft is organizational draft state only, not legal sufficiency, validity, or enforceability.`,
      entityIds: projection.agreements
        .filter((row) => row.lifecycleStatus === "DRAFT")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.ready > 0) {
    findings.push({
      key: "protection-agreement-ready",
      title: "An agreement is recorded as READY",
      why: `${t.ready} agreement${t.ready === 1 ? " has" : "s have"} lifecycleStatus READY. READY is not SENT and not COMPLETE. Owner-review recorded is a recorded workspace fact, not attorney approval.`,
      entityIds: projection.agreements
        .filter((row) => row.lifecycleStatus === "READY")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.sent > 0) {
    findings.push({
      key: "protection-agreement-sent",
      title: "An agreement is recorded as SENT",
      why: `${t.sent} agreement${t.sent === 1 ? " has" : "s have"} lifecycleStatus SENT. SENT is not COMPLETE. Recorded send state is not validity or enforceability.`,
      entityIds: projection.agreements
        .filter((row) => row.lifecycleStatus === "SENT")
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (t.complete > 0) {
    findings.push({
      key: "protection-agreement-complete",
      title: "An agreement has a recorded completion state",
      why: `${t.complete} agreement${t.complete === 1 ? " has" : "s have"} a recorded completion lifecycle (SIGNED, COMPLETE, or EXTERNAL_COMPLETE). Recorded completion is organizational record truth. It is not legal sufficiency, validity, or enforceability, and a recorded legal-review acknowledgment is not attorney approval.`,
      entityIds: projection.agreements
        .filter((row) => COMPLETED_AGREEMENT_STATUSES.has(row.lifecycleStatus))
        .map((row) => row.id)
        .slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.entityIds),
    });
  }

  if (!projection.esign.connected) {
    findings.push({
      key: "protection-esign-disconnected",
      title: "E-sign provider is not connected",
      why: `${projection.esign.message} Recorded completion or a signed-file flag does not connect a provider and does not invent a digital signature.`,
    });
  }

  for (const key of catalogKeys) {
    if (findings.some((row) => row.key === key)) continue;
    if (isBusinessProtectionOwnedRecommendationKey(key)) {
      findings.push({
        key,
        title: "Review recorded Business Protection attention",
        why: "An active Business Protection recommendation is already on the Business Health list. Open the existing Business Protection workspace to review recorded metadata.",
      });
    }
  }

  return findings.slice(0, BUSINESS_PROTECTION_CONTEXT_CAPS.findings);
}

export function projectBusinessProtectionFacts(projection: BusinessProtectionProjection) {
  const facts: Record<string, string> = {};
  const factKeys: string[] = [];
  const t = projection.totals;
  addFact(facts, factKeys, "protection-expired-count", String(t.expired));
  addFact(facts, factKeys, "protection-expiring-soon-count", String(t.expiringSoon));
  addFact(facts, factKeys, "protection-missing-date-count", String(t.missingDate));
  addFact(facts, factKeys, "protection-current-count", String(t.current));
  addFact(facts, factKeys, "protection-no-date-optional-count", String(t.noDateOptional));
  addFact(facts, factKeys, "protection-active-record-count", String(t.activeRecords));
  addFact(facts, factKeys, "protection-archived-record-count", String(t.archivedRecords));
  addFact(facts, factKeys, "protection-draft-count", String(t.draft));
  addFact(facts, factKeys, "protection-ready-count", String(t.ready));
  addFact(facts, factKeys, "protection-sent-count", String(t.sent));
  addFact(facts, factKeys, "protection-complete-count", String(t.complete));
  addFact(facts, factKeys, "protection-owner-review-count", String(t.ownerReviewRecorded));
  addFact(facts, factKeys, "protection-legal-ack-count", String(t.legalReviewAcknowledged));
  addFact(facts, factKeys, "protection-signed-file-count", String(t.signedFileRecorded));
  addFact(facts, factKeys, "protection-checklist-met-count", String(t.checklistMet));
  addFact(facts, factKeys, "protection-checklist-open-count", String(t.checklistOpen));
  addFact(
    facts,
    factKeys,
    "protection-esign-connected",
    projection.esign.connected ? "yes" : "no",
  );
  addFact(facts, factKeys, "protection-esign-status", projection.esign.providerStatus);
  return { facts, factKeys };
}

export async function runBusinessProtectionSpecialist(
  input: BusinessProtectionSpecialistInput,
): Promise<SpecialistResult> {
  recordBusinessProtectionSpecialistInterpretation();
  const catalogKeys = input.catalog.activeRecommendations
    .map((item) => item.key)
    .filter((key) => isBusinessProtectionOwnedRecommendationKey(key));

  void input.denyProductCapabilities;
  const gates = await resolveBusinessProtectionGates(
    input.db,
    input.access,
    input.denyRoleCapabilities,
  );
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
    const rawFindings = findingsFromProjection(projection, catalogKeys);
    const findings: SpecialistFinding[] = rawFindings.map((item) => ({
      key: item.key,
      title: item.title,
      summary: item.why,
      recommendationKeys: isBusinessProtectionOwnedRecommendationKey(item.key) ? [item.key] : [],
      factKeys,
      entityIds: item.entityIds,
    }));

    const limitations: string[] = [];
    limitations.push(projection.disclaimers.authority);
    if (projection.targetedEntityMismatch) {
      limitations.push(TARGET_CONSISTENCY_LIMITATION);
    } else {
      if (projection.targetedVaultUnauthorized) {
        limitations.push("That vault record is not in this business workspace, so it was not targeted.");
      }
      if (projection.targetedAgreementUnauthorized) {
        limitations.push("That agreement is not in this business workspace, so it was not targeted.");
      }
    }
    if (!projection.esign.connected) {
      limitations.push(projection.esign.message);
    }

    const result: SpecialistResult = {
      specialistId: "BUSINESS_PROTECTION",
      status: "OK",
      findings,
      factKeys,
      recommendationKeys: catalogKeys,
      limitation: limitations.join(" ") || undefined,
    };
    if (businessProtectionTextHasLegalSufficiency(result)) {
      throw new Error("Business Protection specialist used legal-sufficiency language.");
    }
    return result;
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
          error instanceof Error
            ? error.message
            : "Business Protection projection could not be loaded.",
      },
    };
  }
}

export function emptyBusinessProtectionProjectionForTests(): BusinessProtectionProjection {
  return {
    totals: emptyTotals(),
    records: [],
    agreements: [],
    checklist: [],
    esign: {
      providerStatus: "NOT_CONNECTED",
      connected: false,
      message: ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
    },
    disclaimers: {
      checklist: LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
      authority: LEGAL_NOT_AUTHORITY_MESSAGE,
    },
    canReadDeep: false,
    targetedVaultUnauthorized: false,
    targetedAgreementUnauthorized: false,
    targetedEntityMismatch: false,
    snapshotReused: false,
  };
}

export const PROTECTION_STATE_CONTRACT = {
  expiryStates: ["CURRENT", "EXPIRING_SOON", "EXPIRED", "MISSING_DATE", "NO_DATE_OPTIONAL"],
  recordStatuses: ["ACTIVE", "ARCHIVED"],
  lifecycleStatuses: AGREEMENT_LIFECYCLE_STATUSES,
} as const;
