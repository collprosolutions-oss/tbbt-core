/**
 * Business Protection mutations. Tenant scope always comes from
 * BusinessAccess. MEMBER never browses or mutates the vault.
 *
 * Completing a sensitive agreement requires an OWNER floor. AI helpers
 * never call these functions to authorize or sign.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import { isAiAttemptId } from "@/lib/ai/types";
import { requireEsignProvider } from "@/lib/esign/provider";
import {
  EsignProviderError,
  isDefiniteEsignProviderRejection,
  type VerifiedEsignCompletionEvent,
} from "@/lib/esign/types";
import { isUsableEmail } from "@/lib/mail";
import {
  AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  AGREEMENT_NOT_READY_FOR_COMPLETION_MESSAGE,
  classifyExpiry,
  EXTERNAL_SIGNATURE_NO_FILE_NOTE,
  OWNER_REVIEW_REQUIRES_OWNER_MESSAGE,
  parseOptionalCalendarDate,
  parseOptionalRenewalLeadDays,
  PROVIDER_SIGNED_DOCUMENT_NOTE,
  READY_WITHOUT_SENT_COMPLETION_NOTE,
  UPLOADED_SIGNED_DOCUMENT_NOTE,
  isVaultCategory,
  isVaultMimeAllowed,
  isVaultRecordStatus,
  needsRenewalAttention,
  VAULT_DOCUMENT_MAX_BYTES,
  VAULT_DOCUMENT_PURPOSE,
  type ExpiryState,
  type VaultCategory,
} from "@/lib/business-protection";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  awaitingActionStatuses,
  buildAgreementDraft,
  canTransitionAgreementLifecycle,
  evaluateAgreementReadiness,
  isAgreementType,
  isCompletedAgreement,
  isHighRiskAgreement,
  isLockedVersion,
  parseAgreementAnswers,
  requiredQuestionsMissing,
  serializeRiskReview,
  type AgreementLifecycleStatus,
  type AgreementReadinessTarget,
  type AgreementType,
  type AgreementVersionStatus,
} from "@/lib/business-protection-agreements";
import {
  allowedCompletionModes,
  assertDigitalSignatureAllowed,
  ESIGN_CANCEL_STUCK_SEND_WARNING,
  ESIGN_SEND_IN_PROGRESS_MESSAGE,
  ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE,
  ESIGN_STALE_SEND_MINUTES,
  ESIGN_STALE_SEND_NOT_READY_MESSAGE,
  ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE,
  EsignBoundaryError,
  normalizeCompletionMode,
  resolveEsignProviderStatus,
} from "@/lib/business-protection-esign";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  bestEffortCleanupOwnedObject,
  claimReadyUsedBytesOnce,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";

/** Proof hook for the delete-versus-vault READY used-bytes race. */
export const vaultReleaseTestHooks: {
  afterStatusRead?: () => Promise<void>;
} = {};

/** Proof hooks for webhook ingest and completion fault injection. */
export const esignWebhookTestHooks: {
  beforeResolveStorageProvider?: () => Promise<void>;
  afterIngestBeforeCommit?: () => Promise<void>;
} = {};

type Db = PrismaClient | Prisma.TransactionClient;

export class BusinessProtectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessProtectionError";
  }
}

export function businessProtectionErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof BusinessProtectionError ||
    error instanceof EsignBoundaryError ||
    error instanceof EsignProviderError
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.message === "Use a valid YYYY-MM-DD date.") {
    return error.message;
  }
  if (error instanceof Error && error.message === "Enter a renewal lead time of 0 to 365 days.") {
    return error.message;
  }
  return fallback;
}

function membershipId(access: BusinessAccess) {
  return access.workspace.membership.id;
}

function requireProtection(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_BUSINESS_PROTECTION);
}

function requireOwnerForCompletion(access: BusinessAccess) {
  requireProtection(access);
  requireBusinessRole(access, "OWNER");
}

function requireOwnerForOwnerReview(access: BusinessAccess) {
  requireProtection(access);
  if (access.workspace.role !== "OWNER") {
    throw new BusinessProtectionError(OWNER_REVIEW_REQUIRES_OWNER_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

async function vaultClassificationClock(db: Db, businessId: string, now = new Date()) {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  return { now, timeZone: resolveBusinessTimeZone(business) };
}

function uniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function supportsTransaction(db: Db): db is PrismaClient {
  return typeof (db as PrismaClient).$transaction === "function";
}

async function runAgreementTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (supportsTransaction(db)) {
    return db.$transaction(fn);
  }
  return fn(db as Prisma.TransactionClient);
}

async function lockOwnedAgreement(tx: Prisma.TransactionClient, access: BusinessAccess, agreementId: string) {
  await tx.$executeRaw`
    SELECT 1 FROM "BusinessAgreement"
    WHERE id = ${agreementId} AND "businessId" = ${access.businessId}
    FOR UPDATE
  `;
}

async function lockOwnedAgreementVersion(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  input: { agreementId: string; versionId: string },
) {
  await tx.$executeRaw`
    SELECT 1 FROM "BusinessAgreementVersion"
    WHERE id = ${input.versionId}
      AND "agreementId" = ${input.agreementId}
      AND "businessId" = ${access.businessId}
    FOR UPDATE
  `;
}

export const ESIGN_SENDING_MODE = "SENDING";

function boundEsignRequestId(
  agreement: { esignSignatureRequestId?: string | null },
  version: { esignSignatureRequestId?: string | null },
) {
  const agreementRequestId = agreement.esignSignatureRequestId ?? null;
  const versionRequestId = version.esignSignatureRequestId ?? null;
  if (!agreementRequestId || !versionRequestId || agreementRequestId !== versionRequestId) {
    return null;
  }
  return agreementRequestId;
}

function assertLifecycleTransition(
  from: AgreementLifecycleStatus,
  to: AgreementLifecycleStatus,
) {
  if (!canTransitionAgreementLifecycle(from, to)) {
    throw new BusinessProtectionError(
      `Cannot move an agreement from ${from} to ${to}. Follow questions → draft → risk review → owner review → ready.`,
    );
  }
}

function assertAgreementReadiness(input: {
  access: BusinessAccess;
  agreement: {
    businessId: string;
    lifecycleStatus: string;
    agreementType: string;
    ownerReviewedAt: Date | null;
    legalReviewAcknowledgedAt: Date | null;
  };
  version: {
    draftContent: string;
    answersJson: string;
    riskReviewJson: string | null;
    representationStatus: string;
    lockedAt: Date | null;
  } | null;
  target: AgreementReadinessTarget;
}) {
  if (!isAgreementType(input.agreement.agreementType)) {
    throw new BusinessProtectionError("Choose an agreement type.");
  }
  const result = evaluateAgreementReadiness({
    accessBusinessId: input.access.businessId,
    agreementBusinessId: input.agreement.businessId,
    lifecycleStatus: input.agreement.lifecycleStatus as AgreementLifecycleStatus,
    agreementType: input.agreement.agreementType,
    ownerReviewedAt: input.agreement.ownerReviewedAt,
    legalReviewAcknowledgedAt: input.agreement.legalReviewAcknowledgedAt,
    currentVersion: input.version,
    target: input.target,
  });
  if (!result.ok) {
    throw new BusinessProtectionError(result.reason);
  }
}

function reviewResetData() {
  return {
    ownerReviewedAt: null,
    ownerReviewedByMembershipId: null,
    legalReviewAcknowledgedAt: null,
    legalReviewAcknowledgedByMembershipId: null,
  };
}

function normalizeCompletionAttemptKey(value?: string | null) {
  const key = value?.trim() ?? "";
  if (!isAiAttemptId(key)) {
    throw new BusinessProtectionError("Refresh and retry that completion from the form.");
  }
  return key;
}

function vaultCategoryForAgreement(type: string): VaultCategory {
  if (type === "INDEPENDENT_CONTRACTOR_AGREEMENT") return "SUBCONTRACTOR_AGREEMENT";
  if (type === "CUSTOM_AGREEMENT") return "CONTRACT";
  if (isVaultCategory(type)) return type;
  return "CONTRACT";
}

function serializeAudit(value: unknown) {
  return JSON.stringify(value);
}

async function writeProtectionAudit(
  db: Db,
  input: {
    businessId: string;
    membershipId: string;
    action: string;
    vaultRecordId?: string | null;
    agreementId?: string | null;
    previousValue?: unknown;
    newValue?: unknown;
  },
) {
  await db.businessProtectionAuditLog.create({
    data: {
      businessId: input.businessId,
      changedByMembershipId: input.membershipId,
      action: input.action,
      vaultRecordId: input.vaultRecordId ?? null,
      agreementId: input.agreementId ?? null,
      previousValue: input.previousValue === undefined ? null : serializeAudit(input.previousValue),
      newValue: input.newValue === undefined ? null : serializeAudit(input.newValue),
    },
  });
}

async function requireOwnedVaultRecord(db: Db, access: BusinessAccess, recordId: string) {
  return access.assertOwned(
    await db.businessVaultRecord.findFirst({
      where: { id: recordId, ...access.scope },
    }),
  );
}

async function requireOwnedAgreement(db: Db, access: BusinessAccess, agreementId: string) {
  return access.assertOwned(
    await db.businessAgreement.findFirst({
      where: { id: agreementId, ...access.scope },
      include: { versions: { orderBy: { versionNumber: "asc" } } },
    }),
  );
}

export async function persistExpiryState(
  db: Db,
  access: BusinessAccess,
  record: {
    id: string;
    category?: string;
    expiresOn?: string | null;
    persistedExpiryState?: string | null;
    renewalLeadDays?: number | null;
  },
  now = new Date(),
) {
  requireProtection(access);
  const existing = await requireOwnedVaultRecord(db, access, record.id);
  void record.category;
  void record.expiresOn;
  void record.persistedExpiryState;
  void record.renewalLeadDays;
  if (!isVaultCategory(existing.category)) return existing.persistedExpiryState;
  const clock = await vaultClassificationClock(db, access.businessId, now);
  const next = classifyExpiry({
    category: existing.category,
    expiresOn: existing.expiresOn,
    renewalLeadDays: existing.renewalLeadDays,
    now: clock.now,
    timeZone: clock.timeZone,
  });
  if (existing.persistedExpiryState === next) return next;
  const written = await db.businessVaultRecord.updateMany({
    where: { id: existing.id, ...access.scope },
    data: { persistedExpiryState: next },
  });
  if (written.count !== 1) {
    throw new Error("Record is not in the authorized business workspace.");
  }
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "expiry_state_change",
    vaultRecordId: existing.id,
    previousValue: existing.persistedExpiryState,
    newValue: next,
  });
  return next;
}

export async function createVaultRecord(
  db: Db,
  access: BusinessAccess,
  input: {
    title: string;
    category: string;
    issuer?: string;
    counterparty?: string;
    effectiveOn?: string;
    expiresOn?: string;
    renewalLeadDays?: string | number | null;
    notes?: string;
    storedAssetId?: string;
    now?: Date;
  },
) {
  requireProtection(access);
  const title = input.title.trim();
  if (!title) throw new BusinessProtectionError("Enter a title.");
  if (!isVaultCategory(input.category)) {
    throw new BusinessProtectionError("Choose a vault category.");
  }
  const storedAssetId = await assertPrivateVaultAsset(db, access, input.storedAssetId);
  const expiresOn = parseOptionalCalendarDate(input.expiresOn);
  const effectiveOn = parseOptionalCalendarDate(input.effectiveOn);
  let renewalLeadDays: number | null;
  try {
    renewalLeadDays = parseOptionalRenewalLeadDays(input.renewalLeadDays);
  } catch (error) {
    throw new BusinessProtectionError(error instanceof Error ? error.message : "Enter a renewal lead time of 0 to 365 days.");
  }
  const clock = await vaultClassificationClock(db, access.businessId, input.now ?? new Date());
  const expiry = classifyExpiry({
    category: input.category,
    expiresOn,
    renewalLeadDays,
    now: clock.now,
    timeZone: clock.timeZone,
  });
  const record = await db.businessVaultRecord.create({
    data: {
      businessId: access.businessId,
      title,
      category: input.category,
      issuer: input.issuer?.trim() || null,
      counterparty: input.counterparty?.trim() || null,
      effectiveOn,
      expiresOn,
      renewalLeadDays,
      notes: input.notes?.trim() || null,
      storedAssetId,
      recordStatus: "ACTIVE",
      persistedExpiryState: expiry,
      createdByMembershipId: membershipId(access),
      updatedByMembershipId: membershipId(access),
    },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: storedAssetId ? "upload" : "create",
    vaultRecordId: record.id,
    newValue: { title, category: input.category, storedAssetId, expiry },
  });
  return record;
}

export async function updateVaultRecord(
  db: Db,
  access: BusinessAccess,
  input: {
    recordId: string;
    title?: string;
    category?: string;
    issuer?: string | null;
    counterparty?: string | null;
    effectiveOn?: string | null;
    expiresOn?: string | null;
    renewalLeadDays?: string | number | null;
    notes?: string | null;
    recordStatus?: string;
    storedAssetId?: string | null;
    now?: Date;
  },
) {
  requireProtection(access);
  const existing = await requireOwnedVaultRecord(db, access, input.recordId);
  const category = input.category ?? existing.category;
  if (!isVaultCategory(category)) {
    throw new BusinessProtectionError("Choose a vault category.");
  }
  const recordStatus = input.recordStatus ?? existing.recordStatus;
  if (!isVaultRecordStatus(recordStatus)) {
    throw new BusinessProtectionError("Choose an active or archived status.");
  }
  const storedAssetId =
    input.storedAssetId === undefined
      ? existing.storedAssetId
      : await assertPrivateVaultAsset(db, access, input.storedAssetId);
  const expiresOn =
    input.expiresOn === undefined
      ? existing.expiresOn
      : parseOptionalCalendarDate(input.expiresOn);
  const effectiveOn =
    input.effectiveOn === undefined
      ? existing.effectiveOn
      : parseOptionalCalendarDate(input.effectiveOn);
  let renewalLeadDays = existing.renewalLeadDays;
  if (input.renewalLeadDays !== undefined) {
    try {
      renewalLeadDays = parseOptionalRenewalLeadDays(input.renewalLeadDays);
    } catch (error) {
      throw new BusinessProtectionError(
        error instanceof Error ? error.message : "Enter a renewal lead time of 0 to 365 days.",
      );
    }
  }
  const title = input.title?.trim() || existing.title;
  if (!title) throw new BusinessProtectionError("Enter a title.");
  const clock = await vaultClassificationClock(db, access.businessId, input.now ?? new Date());
  const expiry = classifyExpiry({
    category,
    expiresOn,
    renewalLeadDays,
    now: clock.now,
    timeZone: clock.timeZone,
  });
  const updated = await db.businessVaultRecord.update({
    where: { id: existing.id },
    data: {
      title,
      category,
      issuer: input.issuer === undefined ? existing.issuer : input.issuer?.trim() || null,
      counterparty:
        input.counterparty === undefined
          ? existing.counterparty
          : input.counterparty?.trim() || null,
      effectiveOn,
      expiresOn,
      renewalLeadDays,
      notes: input.notes === undefined ? existing.notes : input.notes?.trim() || null,
      recordStatus,
      storedAssetId,
      persistedExpiryState: expiry,
      updatedByMembershipId: membershipId(access),
    },
  });
  const categoryChanged = category !== existing.category;
  const statusChanged = recordStatus !== existing.recordStatus;
  const expiryChanged = expiry !== existing.persistedExpiryState;
  if (categoryChanged || statusChanged) {
    await writeProtectionAudit(db, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: categoryChanged ? "category_change" : "status_change",
      vaultRecordId: existing.id,
      previousValue: { category: existing.category, recordStatus: existing.recordStatus },
      newValue: { category, recordStatus },
    });
  }
  if (expiryChanged) {
    await writeProtectionAudit(db, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: "expiry_state_change",
      vaultRecordId: existing.id,
      previousValue: existing.persistedExpiryState,
      newValue: expiry,
    });
  }
  if (storedAssetId && storedAssetId !== existing.storedAssetId) {
    await writeProtectionAudit(db, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: "upload",
      vaultRecordId: existing.id,
      previousValue: existing.storedAssetId,
      newValue: storedAssetId,
    });
  }
  return updated;
}

async function assertPrivateVaultAsset(
  db: Db,
  access: BusinessAccess,
  storedAssetId?: string | null,
) {
  const asset = await loadPrivateVaultAsset(db, access, storedAssetId);
  return asset?.id ?? null;
}

async function loadPrivateVaultAsset(
  db: Db,
  access: BusinessAccess,
  storedAssetId?: string | null,
) {
  const id = storedAssetId?.trim() || "";
  if (!id) return null;
  const asset = access.assertOwned(
    await db.storedAsset.findFirst({
      where: { id, ...access.scope, deletedAt: null },
    }),
  );
  if (asset.visibility !== "PRIVATE") {
    throw new BusinessProtectionError("Vault files stay private and cannot be published.");
  }
  if (asset.status !== "READY") {
    throw new BusinessProtectionError("That file is not ready to attach.");
  }
  if (asset.category !== "DOCUMENT") {
    throw new BusinessProtectionError("Only a document file can be attached here.");
  }
  if (asset.purpose !== VAULT_DOCUMENT_PURPOSE) {
    throw new BusinessProtectionError("Only a Business Vault file can be attached here.");
  }
  return asset;
}

async function assertDedicatedSignedUploadAsset(
  db: Db,
  access: BusinessAccess,
  storedAssetId?: string | null,
) {
  const asset = await loadPrivateVaultAsset(db, access, storedAssetId);
  if (!asset) {
    throw new BusinessProtectionError("Upload the signed file before marking this complete.");
  }
  const vaultRef = await db.businessVaultRecord.findFirst({
    where: { storedAssetId: asset.id, businessId: access.businessId },
    select: { id: true },
  });
  if (vaultRef) {
    throw new BusinessProtectionError(
      "That vault file is already attached to another record. Upload a dedicated signed document for this agreement.",
    );
  }
  const agreementRef = await db.businessAgreement.findFirst({
    where: {
      businessId: access.businessId,
      vaultRecord: { storedAssetId: asset.id },
    },
    select: { id: true },
  });
  if (agreementRef) {
    throw new BusinessProtectionError(
      "That file is already used as a completed agreement document. Upload a dedicated signed document.",
    );
  }
  return asset;
}

export async function releaseUnreferencedVaultAsset(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireProtection(access);
  const id = assetId.trim();
  if (!id) return { released: false as const, reason: "missing", assetId: undefined };
  const asset = await deps.db.storedAsset.findFirst({
    where: { id, ...access.scope },
    include: { storageAccount: true },
  });
  if (!asset || asset.businessId !== access.businessId) {
    throw new BusinessProtectionError("That file is not in this business workspace.");
  }
  if (asset.purpose !== VAULT_DOCUMENT_PURPOSE) {
    throw new BusinessProtectionError("Only an unreferenced Business Vault file can be cleaned up here.");
  }
  if (asset.status === "DELETED" || asset.deletedAt) {
    return { released: false as const, reason: "already_deleted", assetId: asset.id };
  }
  const vaultRef = await deps.db.businessVaultRecord.findFirst({
    where: { storedAssetId: asset.id, businessId: access.businessId },
    select: { id: true },
  });
  const agreementRef = await deps.db.businessAgreement.findFirst({
    where: {
      businessId: access.businessId,
      OR: [
        { vaultRecord: { storedAssetId: asset.id } },
        { vaultRecordId: { not: null }, vaultRecord: { storedAssetId: asset.id } },
      ],
    },
    select: { id: true },
  });
  if (vaultRef || agreementRef) {
    return { released: false as const, reason: "referenced", assetId: asset.id };
  }
  const now = deps.now?.() ?? new Date();
  if (asset.status === "PENDING") {
    await abortManagedUpload(deps, access.businessId, asset.id);
    return { released: true as const, reason: "aborted", assetId: asset.id };
  }
  await vaultReleaseTestHooks.afterStatusRead?.();
  const claimed = await deps.db.$transaction(async (tx) => {
    // LOCK_ACCOUNT_BEFORE_ASSET: vault release uses the shared READY claim.
    const result = await claimReadyUsedBytesOnce(tx, {
      businessId: access.businessId,
      assetId: asset.id,
      accountId: asset.storageAccountId,
      now,
      nextStatus: "DELETED",
    });
    return result.claimed;
  });
  if (claimed) {
    await bestEffortCleanupOwnedObject(deps, access.businessId, {
      bucket: asset.storageAccount.bucketName,
      storageKey: asset.storageKey,
    });
    return { released: true as const, reason: "deleted", assetId: asset.id };
  }
  return { released: false as const, reason: "already_deleted", assetId: asset.id };
}

export async function authorizeVaultDocumentUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  input: {
    originalFilename: string;
    mimeType: string;
    fileSizeBytes: number;
  },
) {
  requireProtection(access);
  if (!isVaultMimeAllowed(input.mimeType)) {
    throw new BusinessProtectionError("Use a PDF, image, Word document, or text file.");
  }
  if (input.fileSizeBytes <= 0 || input.fileSizeBytes > VAULT_DOCUMENT_MAX_BYTES) {
    throw new BusinessProtectionError("That file is too large for the Business Vault.");
  }
  return authorizeManagedUpload(deps, access.businessId, {
    category: "DOCUMENT",
    purpose: VAULT_DOCUMENT_PURPOSE,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    fileSizeBytes: input.fileSizeBytes,
    visibility: "PRIVATE",
  });
}

export async function finalizeVaultDocumentUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireProtection(access);
  const asset = await finalizeManagedUpload(deps, access.businessId, assetId);
  if (asset.visibility !== "PRIVATE") {
    throw new BusinessProtectionError("Vault files stay private and cannot be published.");
  }
  return asset;
}

export async function abortVaultDocumentUpload(
  deps: StorageServiceDeps,
  access: BusinessAccess,
  assetId: string,
) {
  requireProtection(access);
  return abortManagedUpload(deps, access.businessId, assetId);
}

export async function createAgreement(
  db: Db,
  access: BusinessAccess,
  input: { agreementType: string; title?: string; counterparty?: string },
) {
  requireProtection(access);
  if (!isAgreementType(input.agreementType)) {
    throw new BusinessProtectionError("Choose an agreement type.");
  }
  const title = input.title?.trim() || `${input.agreementType.replaceAll("_", " ").toLowerCase()} draft`;
  const agreement = await db.businessAgreement.create({
    data: {
      businessId: access.businessId,
      agreementType: input.agreementType,
      title,
      counterparty: input.counterparty?.trim() || null,
      lifecycleStatus: "QUESTIONS",
      signingMode: "NOT_CONNECTED",
      createdByMembershipId: membershipId(access),
    },
  });
  const version = await db.businessAgreementVersion.create({
    data: {
      businessId: access.businessId,
      agreementId: agreement.id,
      versionNumber: 1,
      representationStatus: "DRAFT",
      answersJson: "{}",
      draftContent: "",
      createdByMembershipId: membershipId(access),
    },
  });
  const created = await db.businessAgreement.update({
    where: { id: agreement.id },
    data: { currentDraftVersionId: version.id },
    include: { versions: { orderBy: { versionNumber: "asc" } } },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "agreement_created",
    agreementId: created.id,
    newValue: { agreementType: input.agreementType, title },
  });
  return created;
}

function currentVersion(agreement: {
  currentDraftVersionId: string | null;
  versions: Array<{
    id: string;
    versionNumber: number;
    representationStatus: string;
    lockedAt: Date | null;
    answersJson: string;
    draftContent: string;
    riskReviewJson: string | null;
    esignSignatureRequestId?: string | null;
  }>;
}) {
  const current =
    agreement.versions.find((row) => row.id === agreement.currentDraftVersionId) ??
    agreement.versions[agreement.versions.length - 1];
  if (!current) throw new BusinessProtectionError("That agreement has no draft version.");
  return current;
}

async function openEditableVersion(
  db: Db,
  access: BusinessAccess,
  agreement: Awaited<ReturnType<typeof requireOwnedAgreement>>,
) {
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError(
      "A completed agreement is historical. Start a new agreement instead of rewriting the signed copy.",
    );
  }
  const unlocked = currentVersion(agreement);
  if (!isLockedVersion(unlocked.representationStatus as AgreementVersionStatus, unlocked.lockedAt)) {
    return unlocked;
  }

  const createReplacement = async (tx: Prisma.TransactionClient) => {
    await lockOwnedAgreement(tx, access, agreement.id);
    const fresh = await requireOwnedAgreement(tx, access, agreement.id);
    if (isCompletedAgreement(fresh.lifecycleStatus as AgreementLifecycleStatus)) {
      throw new BusinessProtectionError(
        "A completed agreement is historical. Start a new agreement instead of rewriting the signed copy.",
      );
    }
    const current = currentVersion(fresh);
    if (!isLockedVersion(current.representationStatus as AgreementVersionStatus, current.lockedAt)) {
      return current;
    }
    const nextNumber = Math.max(...fresh.versions.map((row) => row.versionNumber)) + 1;
    try {
      const next = await tx.businessAgreementVersion.create({
        data: {
          businessId: access.businessId,
          agreementId: fresh.id,
          versionNumber: nextNumber,
          representationStatus: "DRAFT",
          answersJson: current.answersJson,
          draftContent: current.draftContent,
          riskReviewJson: current.riskReviewJson,
          createdByMembershipId: membershipId(access),
        },
      });
      await tx.businessAgreement.update({
        where: { id: fresh.id },
        data: {
          currentDraftVersionId: next.id,
          lifecycleStatus: "DRAFT",
          ...reviewResetData(),
        },
      });
      await writeProtectionAudit(tx, {
        businessId: access.businessId,
        membershipId: membershipId(access),
        action: "replacement_draft_opened",
        agreementId: fresh.id,
        previousValue: {
          lifecycleStatus: fresh.lifecycleStatus,
          lockedVersionId: current.id,
          lockedVersionNumber: current.versionNumber,
          lockedRepresentation: current.representationStatus,
        },
        newValue: {
          versionId: next.id,
          versionNumber: next.versionNumber,
          fromLockedRepresentation: current.representationStatus,
        },
      });
      return next;
    } catch (error) {
      if (!uniqueConflict(error)) throw error;
      const raced = await requireOwnedAgreement(tx, access, agreement.id);
      const winner = currentVersion(raced);
      if (!isLockedVersion(winner.representationStatus as AgreementVersionStatus, winner.lockedAt)) {
        return winner;
      }
      throw error;
    }
  };

  try {
    return await runAgreementTransaction(db, createReplacement);
  } catch (error) {
    if (!uniqueConflict(error)) throw error;
    return runAgreementTransaction(db, createReplacement);
  }
}

export async function saveAgreementAnswers(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string; answers: Record<string, string>; title?: string; counterparty?: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  const version = await openEditableVersion(db, access, agreement);
  const answers = Object.fromEntries(
    Object.entries(input.answers).map(([key, value]) => [key, value.trim()]),
  );
  const updated = await db.businessAgreementVersion.update({
    where: { id: version.id },
    data: { answersJson: JSON.stringify(answers) },
  });
  await db.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      title: input.title?.trim() || agreement.title,
      counterparty: input.counterparty?.trim() || answers.counterparty || agreement.counterparty,
      effectiveOn:
        "effectiveOn" in input.answers
          ? parseOptionalCalendarDate(input.answers.effectiveOn)
          : agreement.effectiveOn,
      expiresOn:
        "expiresOn" in input.answers
          ? parseOptionalCalendarDate(input.answers.expiresOn)
          : agreement.expiresOn,
      lifecycleStatus: "QUESTIONS",
      ...reviewResetData(),
    },
  });
  return updated;
}

export async function generateAgreementDraft(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string; businessName: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (!isAgreementType(agreement.agreementType)) {
    throw new BusinessProtectionError("Choose an agreement type.");
  }
  const version = await openEditableVersion(db, access, agreement);
  const answers = parseAgreementAnswers(version.answersJson);
  const missing = requiredQuestionsMissing(agreement.agreementType, answers);
  if (missing.length > 0) {
    throw new BusinessProtectionError(`Answer required questions first: ${missing.map((row) => row.label).join(", ")}.`);
  }
  const draftContent = buildAgreementDraft({
    type: agreement.agreementType,
    title: agreement.title,
    businessName: input.businessName,
    answers,
  });
  const fromStatus = (await requireOwnedAgreement(db, access, agreement.id)).lifecycleStatus as AgreementLifecycleStatus;
  assertLifecycleTransition(fromStatus, "RISK_REVIEW");
  await db.businessAgreementVersion.update({
    where: { id: version.id },
    data: {
      draftContent,
      riskReviewJson: serializeRiskReview({
        type: agreement.agreementType,
        answers,
        draftContent,
      }),
    },
  });
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "RISK_REVIEW", ...reviewResetData() },
    include: { versions: { orderBy: { versionNumber: "asc" } } },
  });
}

export async function saveAgreementDraftContent(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string; draftContent: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  const version = await openEditableVersion(db, access, agreement);
  const content = input.draftContent.trim();
  if (!content) throw new BusinessProtectionError("Draft content cannot be empty.");
  if (/\b(this (draft|agreement) is legally (sufficient|enforceable|binding))\b/i.test(content)) {
    throw new BusinessProtectionError(AGREEMENT_NOT_ENFORCEABLE_MESSAGE);
  }
  const answers = parseAgreementAnswers(version.answersJson);
  if (!isAgreementType(agreement.agreementType)) {
    throw new BusinessProtectionError("Choose an agreement type.");
  }
  const fromStatus = (await requireOwnedAgreement(db, access, agreement.id)).lifecycleStatus as AgreementLifecycleStatus;
  assertLifecycleTransition(fromStatus, "RISK_REVIEW");
  await db.businessAgreementVersion.update({
    where: { id: version.id },
    data: {
      draftContent: content,
      riskReviewJson: serializeRiskReview({
        type: agreement.agreementType,
        answers,
        draftContent: content,
      }),
    },
  });
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "RISK_REVIEW", ...reviewResetData() },
  });
}

export async function markAgreementOwnerReviewed(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string },
) {
  requireOwnerForOwnerReview(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError("A completed agreement cannot be re-reviewed into a new agreement.");
  }
  const version = currentVersion(agreement);
  if (isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt)) {
    throw new BusinessProtectionError("Open a new draft before reviewing a locked historical version.");
  }
  const nextStatus: AgreementLifecycleStatus = isHighRiskAgreement(
    agreement.agreementType as AgreementType,
  )
    ? "LEGAL_WARNING"
    : "OWNER_REVIEW";
  assertLifecycleTransition(agreement.lifecycleStatus as AgreementLifecycleStatus, nextStatus);
  assertAgreementReadiness({
    access,
    agreement,
    version,
    target: nextStatus === "LEGAL_WARNING" ? "LEGAL_WARNING" : "OWNER_REVIEW",
  });
  const updated = await db.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      lifecycleStatus: nextStatus,
      ownerReviewedAt: new Date(),
      ownerReviewedByMembershipId: membershipId(access),
    },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "owner_review_recorded",
    agreementId: agreement.id,
    previousValue: { lifecycleStatus: agreement.lifecycleStatus },
    newValue: {
      lifecycleStatus: nextStatus,
      ownerReviewedByMembershipId: membershipId(access),
    },
  });
  return updated;
}

export async function acknowledgeAgreementLegalReview(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string; acknowledged: boolean },
) {
  requireOwnerForCompletion(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (!input.acknowledged) {
    throw new BusinessProtectionError(AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE);
  }
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError("A completed agreement is already historical.");
  }
  const version = currentVersion(agreement);
  if (isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt)) {
    throw new BusinessProtectionError("A locked historical version cannot receive a new legal acknowledgment.");
  }
  if (!agreement.ownerReviewedAt) {
    throw new BusinessProtectionError("The owner must record owner review before acknowledging attorney review.");
  }
  assertLifecycleTransition(agreement.lifecycleStatus as AgreementLifecycleStatus, "READY");
  assertAgreementReadiness({
    access,
    agreement,
    version,
    target: "LEGAL_WARNING",
  });
  await db.businessProtectionAcknowledgment.create({
    data: {
      businessId: access.businessId,
      membershipId: membershipId(access),
      kind: "ATTORNEY_REVIEW_RECOMMENDATION",
      statement: AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
    },
  });
  const updated = await db.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      lifecycleStatus: "READY",
      legalReviewAcknowledgedAt: new Date(),
      legalReviewAcknowledgedByMembershipId: membershipId(access),
    },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "attorney_recommendation_acknowledged",
    agreementId: agreement.id,
    previousValue: { lifecycleStatus: agreement.lifecycleStatus },
    newValue: { lifecycleStatus: "READY" },
  });
  return updated;
}

export async function markAgreementReady(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError("A completed agreement is already historical.");
  }
  const version = currentVersion(agreement);
  if (isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt)) {
    throw new BusinessProtectionError("A locked historical version cannot be marked ready.");
  }
  assertLifecycleTransition(agreement.lifecycleStatus as AgreementLifecycleStatus, "READY");
  assertAgreementReadiness({
    access,
    agreement,
    version,
    target: "READY",
  });
  const updated = await db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "READY" },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "agreement_marked_ready",
    agreementId: agreement.id,
    previousValue: { lifecycleStatus: agreement.lifecycleStatus },
    newValue: { lifecycleStatus: "READY" },
  });
  return updated;
}

export async function markAgreementSent(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string },
) {
  requireProtection(access);
  const write = async (tx: Prisma.TransactionClient) => {
    await lockOwnedAgreement(tx, access, input.agreementId);
    const agreement = await requireOwnedAgreement(tx, access, input.agreementId);
    if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
      throw new BusinessProtectionError("A completed agreement cannot be sent again as a new agreement.");
    }
    const version = currentVersion(agreement);
    assertLifecycleTransition(agreement.lifecycleStatus as AgreementLifecycleStatus, "SENT");
    assertAgreementReadiness({
      access,
      agreement,
      version,
      target: "SENT",
    });
    if (isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt)) {
      if (version.representationStatus === "SIGNED_FINAL") {
        throw new BusinessProtectionError("A signed historical version cannot be re-sent.");
      }
      return tx.businessAgreement.update({
        where: { id: agreement.id },
        data: { lifecycleStatus: "SENT" },
      });
    }
    const now = new Date();
    await tx.businessAgreementVersion.update({
      where: { id: version.id },
      data: { representationStatus: "SENT", lockedAt: now },
    });
    const updated = await tx.businessAgreement.update({
      where: { id: agreement.id },
      data: { lifecycleStatus: "SENT", currentDraftVersionId: version.id },
    });
    await writeProtectionAudit(tx, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: "agreement_sent",
      agreementId: agreement.id,
      newValue: { versionId: version.id, versionNumber: version.versionNumber },
    });
    return updated;
  };
  return runAgreementTransaction(db, write);
}

async function loadCompletionWinner(
  db: Db,
  access: BusinessAccess,
  agreementId: string,
) {
  const agreement = await requireOwnedAgreement(db, access, agreementId);
  const signed = agreement.signedVersionId
    ? agreement.versions.find((row) => row.id === agreement.signedVersionId)
    : null;
  const vault = agreement.vaultRecordId
    ? await db.businessVaultRecord.findFirst({
        where: { id: agreement.vaultRecordId, businessId: access.businessId },
      })
    : null;
  if (!signed || !vault) {
    throw new BusinessProtectionError("This agreement is already complete. Later edits belong on a new agreement.");
  }
  return { agreement, vault, signedVersion: signed };
}

export async function completeAgreementExternally(
  db: Db,
  access: BusinessAccess,
  input: {
    agreementId: string;
    mode: string;
    notes?: string;
    storedAssetId?: string;
    completionAttemptKey?: string;
    now?: Date;
  },
) {
  requireOwnerForCompletion(access);
  const attemptKey = normalizeCompletionAttemptKey(input.completionAttemptKey);

  if (input.mode === "PROVIDER_READY" || input.mode === "digital" || input.mode === "esign") {
    assertDigitalSignatureAllowed(resolveEsignProviderStatus());
    throw new EsignBoundaryError(ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE);
  }
  const mode = normalizeCompletionMode(input.mode, resolveEsignProviderStatus());
  if (mode === "PROVIDER_READY") {
    throw new EsignBoundaryError(ESIGN_WEBHOOK_ONLY_COMPLETION_MESSAGE);
  }
  if (!allowedCompletionModes().includes(mode)) {
    throw new BusinessProtectionError(
      "No e-sign provider is connected. Record an external signature or upload a signed file.",
    );
  }

  const write = async (tx: Prisma.TransactionClient) => {
    await lockOwnedAgreement(tx, access, input.agreementId);
    const agreement = await requireOwnedAgreement(tx, access, input.agreementId);
    const existingClaim = await tx.businessAgreementCompletionClaim.findUnique({
      where: { agreementId: agreement.id },
    });
    if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus) || existingClaim) {
      if (
        (existingClaim?.attemptKey ?? agreement.completionAttemptKey) === attemptKey
      ) {
        return loadCompletionWinner(tx, access, agreement.id);
      }
      throw new BusinessProtectionError(
        "This agreement is already complete. Later edits belong on a new agreement.",
      );
    }

    const lifecycleStatus: AgreementLifecycleStatus =
      mode === "MANUAL_UPLOAD" ? "COMPLETE" : "EXTERNAL_COMPLETE";
    assertLifecycleTransition(agreement.lifecycleStatus as AgreementLifecycleStatus, lifecycleStatus);
    const version = currentVersion(agreement);
    if (version.representationStatus === "SIGNED_FINAL") {
      throw new BusinessProtectionError("A locked historical version cannot be mutated.");
    }
    assertAgreementReadiness({
      access,
      agreement,
      version,
      target: lifecycleStatus,
    });
    if (!version.draftContent.trim()) {
      throw new BusinessProtectionError(AGREEMENT_NOT_READY_FOR_COMPLETION_MESSAGE);
    }

    let storedAssetId: string | null = null;
    if (mode === "MANUAL_UPLOAD") {
      const asset = await assertDedicatedSignedUploadAsset(tx, access, input.storedAssetId);
      storedAssetId = asset.id;
    } else if (input.storedAssetId?.trim()) {
      throw new BusinessProtectionError(
        "External signature completion does not attach a file. Use manual upload to store a signed document.",
      );
    }

    const now = input.now ?? new Date();
    const sentLocked =
      version.representationStatus === "SENT" ||
      (agreement.lifecycleStatus === "SENT" &&
        isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt));
    let signed;
    if (sentLocked) {
      const nextNumber = Math.max(...agreement.versions.map((row) => row.versionNumber)) + 1;
      signed = await tx.businessAgreementVersion.create({
        data: {
          businessId: access.businessId,
          agreementId: agreement.id,
          versionNumber: nextNumber,
          representationStatus: "SIGNED_FINAL",
          answersJson: version.answersJson,
          draftContent: version.draftContent,
          riskReviewJson: version.riskReviewJson,
          createdByMembershipId: membershipId(access),
          lockedAt: now,
        },
      });
    } else {
      signed = await tx.businessAgreementVersion.update({
        where: { id: version.id },
        data: { representationStatus: "SIGNED_FINAL", lockedAt: now },
      });
    }

    const ownerNote = input.notes?.trim() || "";
    const vaultNotes =
      mode === "MANUAL_UPLOAD"
        ? [UPLOADED_SIGNED_DOCUMENT_NOTE, ownerNote, `uploadedSignedAssetId=${storedAssetId}`]
            .filter(Boolean)
            .join(" ")
        : [EXTERNAL_SIGNATURE_NO_FILE_NOTE, READY_WITHOUT_SENT_COMPLETION_NOTE, ownerNote]
            .filter(Boolean)
            .join(" ");
    const vaultTitle =
      mode === "MANUAL_UPLOAD"
        ? `${agreement.title} (uploaded signed document)`
        : `${agreement.title} (external signature recorded)`;

    const clock = await vaultClassificationClock(tx, access.businessId, now);
    const vault = await tx.businessVaultRecord.create({
      data: {
        businessId: access.businessId,
        title: vaultTitle,
        category: vaultCategoryForAgreement(agreement.agreementType),
        counterparty: agreement.counterparty,
        effectiveOn: agreement.effectiveOn,
        expiresOn: agreement.expiresOn,
        notes: vaultNotes,
        storedAssetId,
        recordStatus: "ACTIVE",
        persistedExpiryState: classifyExpiry({
          category: vaultCategoryForAgreement(agreement.agreementType),
          expiresOn: agreement.expiresOn,
          now: clock.now,
          timeZone: clock.timeZone,
        }),
        createdByMembershipId: membershipId(access),
        updatedByMembershipId: membershipId(access),
      },
    });

    const updated = await tx.businessAgreement.update({
      where: { id: agreement.id },
      data: {
        lifecycleStatus,
        signingMode: mode,
        signedVersionId: signed.id,
        currentDraftVersionId: signed.id,
        vaultRecordId: vault.id,
        completedAt: now,
        completedByMembershipId: membershipId(access),
        completionNotes: ownerNote || null,
        completionAttemptKey: attemptKey,
      },
    });

    await tx.businessAgreementCompletionClaim.create({
      data: {
        businessId: access.businessId,
        agreementId: agreement.id,
        attemptKey,
        signedVersionId: signed.id,
        vaultRecordId: vault.id,
      },
    });

    await writeProtectionAudit(tx, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: "marked_signed",
      agreementId: agreement.id,
      vaultRecordId: vault.id,
      newValue: {
        mode,
        versionId: signed.id,
        completedByMembershipId: membershipId(access),
        completedAt: now.toISOString(),
        completionAttemptKey: attemptKey,
        storedSignedDocument: Boolean(storedAssetId),
      },
    });
    await writeProtectionAudit(tx, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: "agreement_finalized",
      agreementId: agreement.id,
      vaultRecordId: vault.id,
      newValue: {
        lifecycleStatus,
        storedAssetId,
        signedDocumentFileUploaded: Boolean(storedAssetId),
      },
    });
    return { agreement: updated, vault, signedVersion: signed };
  };

  try {
    return await runAgreementTransaction(db, write);
  } catch (error) {
    if (!uniqueConflict(error)) throw error;
    const winner = await requireOwnedAgreement(db, access, input.agreementId);
    if (
      isCompletedAgreement(winner.lifecycleStatus as AgreementLifecycleStatus) &&
      winner.completionAttemptKey === attemptKey
    ) {
      return loadCompletionWinner(db, access, input.agreementId);
    }
    const claim = await db.businessAgreementCompletionClaim.findFirst({
      where: { businessId: access.businessId, attemptKey },
    });
    if (claim?.agreementId === input.agreementId) {
      return loadCompletionWinner(db, access, input.agreementId);
    }
    throw new BusinessProtectionError(
      "This agreement is already complete. Later edits belong on a new agreement.",
    );
  }
}

async function loadCompletionWinnerByIds(
  db: Db,
  businessId: string,
  agreementId: string,
) {
  const agreement = await db.businessAgreement.findFirst({
    where: { id: agreementId, businessId },
    include: { versions: { orderBy: { versionNumber: "asc" } } },
  });
  if (!agreement) {
    throw new BusinessProtectionError("That agreement is not in this business workspace.");
  }
  const signed = agreement.signedVersionId
    ? agreement.versions.find((row) => row.id === agreement.signedVersionId)
    : null;
  const vault = agreement.vaultRecordId
    ? await db.businessVaultRecord.findFirst({
        where: { id: agreement.vaultRecordId, businessId },
      })
    : null;
  if (!signed || !vault) {
    throw new BusinessProtectionError("This agreement is already complete. Later edits belong on a new agreement.");
  }
  return { agreement, vault, signedVersion: signed };
}

async function ingestProviderSignedPdf(
  deps: StorageServiceDeps,
  businessId: string,
  input: { filename: string; body: Buffer },
) {
  if (input.body.byteLength <= 0 || input.body.byteLength > VAULT_DOCUMENT_MAX_BYTES) {
    throw new BusinessProtectionError("The signed document from the provider is too large for the Business Vault.");
  }
  const authorized = await authorizeManagedUpload(deps, businessId, {
    category: "DOCUMENT",
    purpose: VAULT_DOCUMENT_PURPOSE,
    originalFilename: input.filename,
    mimeType: "application/pdf",
    fileSizeBytes: input.body.byteLength,
    visibility: "PRIVATE",
  });
  try {
    await esignWebhookTestHooks.beforeResolveStorageProvider?.();
    const provider = await resolveStorageProvider(deps);
    await provider.putObject({
      bucket: authorized.account.bucketName,
      key: authorized.asset.storageKey,
      body: input.body,
      contentType: "application/pdf",
    });
    return finalizeManagedUpload(deps, businessId, authorized.asset.id);
  } catch (error) {
    await abortManagedUpload(deps, businessId, authorized.asset.id);
    throw error;
  }
}

async function releaseOrphanedProviderSignedAsset(
  deps: StorageServiceDeps,
  businessId: string,
  assetId: string | null | undefined,
) {
  const id = assetId?.trim() ?? "";
  if (!id) return;
  const asset = await deps.db.storedAsset.findFirst({
    where: { id, businessId },
    include: { storageAccount: true },
  });
  if (!asset || asset.status === "DELETED" || asset.deletedAt) return;
  const vaultRef = await deps.db.businessVaultRecord.findFirst({
    where: { storedAssetId: asset.id, businessId },
    select: { id: true },
  });
  if (vaultRef) return;
  if (asset.status === "PENDING") {
    await abortManagedUpload(deps, businessId, asset.id);
    return;
  }
  const now = deps.now?.() ?? new Date();
  const claimed = await deps.db.$transaction(async (tx) => {
    // LOCK_ACCOUNT_BEFORE_ASSET: orphan provider PDFs use the shared READY claim.
    const result = await claimReadyUsedBytesOnce(tx, {
      businessId,
      assetId: asset.id,
      accountId: asset.storageAccountId,
      now,
      nextStatus: "DELETED",
    });
    return result.claimed;
  });
  if (claimed) {
    await bestEffortCleanupOwnedObject(deps, businessId, {
      bucket: asset.storageAccount.bucketName,
      storageKey: asset.storageKey,
    });
  }
}

export async function sendAgreementForEsign(
  db: Db,
  access: BusinessAccess,
  input: {
    agreementId: string;
    signerName: string;
    signerEmail: string;
    sendAttemptKey?: string;
  },
) {
  requireOwnerForCompletion(access);
  assertDigitalSignatureAllowed(resolveEsignProviderStatus());
  const attemptKey = normalizeCompletionAttemptKey(input.sendAttemptKey);
  const signerName = input.signerName.trim();
  const signerEmail = input.signerEmail.trim();
  if (!signerName) throw new BusinessProtectionError("Enter the signer name.");
  if (!isUsableEmail(signerEmail)) {
    throw new BusinessProtectionError("Enter a valid signer email.");
  }

  const adapter = requireEsignProvider();
  type SendClaim = {
    agreement: Awaited<ReturnType<typeof requireOwnedAgreement>>;
    version: ReturnType<typeof currentVersion>;
    requestId: string | null;
    reused: boolean;
    claimed: boolean;
    previousSigningMode: string;
    previousLifecycle: string;
    unlockedVersion: boolean;
  };

  const claim = await runAgreementTransaction(db, async (tx): Promise<SendClaim> => {
    await lockOwnedAgreement(tx, access, input.agreementId);
    const agreement = await requireOwnedAgreement(tx, access, input.agreementId);
    const version = currentVersion(agreement);
    await lockOwnedAgreementVersion(tx, access, {
      agreementId: agreement.id,
      versionId: version.id,
    });
    const locked = await requireOwnedAgreement(tx, access, input.agreementId);
    const current = currentVersion(locked);

    if (isCompletedAgreement(locked.lifecycleStatus as AgreementLifecycleStatus)) {
      throw new BusinessProtectionError("A completed agreement cannot be sent again as a new agreement.");
    }
    if (current.representationStatus === "SIGNED_FINAL") {
      throw new BusinessProtectionError("A signed historical version cannot be re-sent.");
    }

    const storedRequestId = boundEsignRequestId(locked, current);
    if (locked.signingMode === ESIGN_SENDING_MODE && locked.completionAttemptKey) {
      if (locked.completionAttemptKey === attemptKey && storedRequestId) {
        return {
          agreement: locked,
          version: current,
          requestId: storedRequestId,
          reused: true,
          claimed: false,
          previousSigningMode: locked.signingMode,
          previousLifecycle: locked.lifecycleStatus,
          unlockedVersion: false,
        };
      }
      if (locked.completionAttemptKey === attemptKey) {
        throw new BusinessProtectionError(ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE);
      }
      throw new BusinessProtectionError(ESIGN_SEND_IN_PROGRESS_MESSAGE);
    }
    if (locked.signingMode === "PROVIDER_READY" && locked.completionAttemptKey) {
      if (locked.completionAttemptKey === attemptKey) {
        return {
          agreement: locked,
          version: current,
          requestId: storedRequestId,
          reused: true,
          claimed: false,
          previousSigningMode: locked.signingMode,
          previousLifecycle: locked.lifecycleStatus,
          unlockedVersion: false,
        };
      }
      throw new BusinessProtectionError("This locked version already has an e-sign request.");
    }

    const alreadyLockedSent =
      current.representationStatus === "SENT" ||
      (locked.lifecycleStatus === "SENT" &&
        isLockedVersion(current.representationStatus as AgreementVersionStatus, current.lockedAt));
    if (!alreadyLockedSent) {
      assertLifecycleTransition(locked.lifecycleStatus as AgreementLifecycleStatus, "SENT");
      assertAgreementReadiness({
        access,
        agreement: locked,
        version: current,
        target: "SENT",
      });
      if (isLockedVersion(current.representationStatus as AgreementVersionStatus, current.lockedAt)) {
        throw new BusinessProtectionError("Open the locked sent version before sending it for e-sign.");
      }
    } else if (!current.draftContent.trim()) {
      throw new BusinessProtectionError(AGREEMENT_NOT_READY_FOR_COMPLETION_MESSAGE);
    }

    const now = new Date();
    const unlockedVersion =
      !isLockedVersion(current.representationStatus as AgreementVersionStatus, current.lockedAt) ||
      current.representationStatus !== "SENT";
    if (unlockedVersion) {
      await tx.businessAgreementVersion.update({
        where: { id: current.id },
        data: { representationStatus: "SENT", lockedAt: now },
      });
    }
    const updated = await tx.businessAgreement.update({
      where: { id: locked.id },
      data: {
        lifecycleStatus: "SENT",
        signingMode: ESIGN_SENDING_MODE,
        currentDraftVersionId: current.id,
        completionAttemptKey: attemptKey,
        esignSendingClaimedAt: now,
      },
      include: { versions: { orderBy: { versionNumber: "asc" } } },
    });
    return {
      agreement: updated,
      version: {
        ...current,
        representationStatus: "SENT" as const,
        lockedAt: current.lockedAt ?? now,
      },
      requestId: null,
      reused: false,
      claimed: true,
      previousSigningMode: locked.signingMode,
      previousLifecycle: locked.lifecycleStatus,
      unlockedVersion,
    };
  });

  if (!claim.claimed) {
    return {
      agreement: claim.agreement,
      version: claim.version,
      requestId: claim.requestId,
      reused: true as const,
    };
  }

  const releaseClaim = async () => {
    await runAgreementTransaction(db, async (tx) => {
      await lockOwnedAgreement(tx, access, input.agreementId);
      await lockOwnedAgreementVersion(tx, access, {
        agreementId: input.agreementId,
        versionId: claim.version.id,
      });
      const fresh = await requireOwnedAgreement(tx, access, input.agreementId);
      if (
        fresh.signingMode !== ESIGN_SENDING_MODE ||
        fresh.completionAttemptKey !== attemptKey ||
        fresh.esignSignatureRequestId
      ) {
        return;
      }
      if (claim.unlockedVersion) {
        await tx.businessAgreementVersion.update({
          where: { id: claim.version.id },
          data: { representationStatus: "DRAFT", lockedAt: null },
        });
      }
      await tx.businessAgreement.update({
        where: { id: fresh.id },
        data: {
          lifecycleStatus: claim.previousLifecycle,
          signingMode: claim.previousSigningMode,
          completionAttemptKey: null,
          esignSendingClaimedAt: null,
        },
      });
    });
  };

  let created;
  try {
    created = await adapter.createSignatureRequest({
      businessId: access.businessId,
      agreementId: claim.agreement.id,
      versionId: claim.version.id,
      versionNumber: claim.version.versionNumber,
      title: claim.agreement.title,
      draftContent: claim.version.draftContent,
      signerName,
      signerEmail,
      attemptKey,
      actorMembershipId: membershipId(access),
    });
  } catch (error) {
    if (isDefiniteEsignProviderRejection(error)) {
      await releaseClaim();
      throw new BusinessProtectionError(error.message);
    }
    throw new BusinessProtectionError(ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE);
  }

  try {
    return await runAgreementTransaction(db, async (tx) => {
      await lockOwnedAgreement(tx, access, input.agreementId);
      await lockOwnedAgreementVersion(tx, access, {
        agreementId: input.agreementId,
        versionId: claim.version.id,
      });
      const fresh = await requireOwnedAgreement(tx, access, input.agreementId);
      const current = fresh.versions.find((row) => row.id === claim.version.id);
      if (!current) {
        throw new BusinessProtectionError(
          "The agreement version changed before e-sign send finished. The provider request was not bound.",
        );
      }
      if (isCompletedAgreement(fresh.lifecycleStatus as AgreementLifecycleStatus)) {
        throw new BusinessProtectionError("A completed agreement cannot be sent again as a new agreement.");
      }
      const existingRequestId = boundEsignRequestId(fresh, current);
      if (existingRequestId) {
        if (fresh.completionAttemptKey === attemptKey && existingRequestId === created.requestId) {
          return {
            agreement: fresh,
            version: current,
            requestId: existingRequestId,
            reused: true as const,
          };
        }
        throw new BusinessProtectionError("This locked version already has an e-sign request.");
      }
      if (fresh.signingMode !== ESIGN_SENDING_MODE || fresh.completionAttemptKey !== attemptKey) {
        throw new BusinessProtectionError("This locked version already has an e-sign request.");
      }
      await tx.businessAgreementVersion.update({
        where: { id: current.id },
        data: { esignSignatureRequestId: created.requestId },
      });
      const updated = await tx.businessAgreement.update({
        where: { id: fresh.id },
        data: {
          lifecycleStatus: "SENT",
          signingMode: "PROVIDER_READY",
          currentDraftVersionId: current.id,
          completionAttemptKey: attemptKey,
          esignSignatureRequestId: created.requestId,
          esignSendingClaimedAt: null,
        },
      });
      await writeProtectionAudit(tx, {
        businessId: access.businessId,
        membershipId: membershipId(access),
        action: "esign_request_created",
        agreementId: fresh.id,
        newValue: {
          versionId: current.id,
          versionNumber: current.versionNumber,
          requestId: created.requestId,
          provider: adapter.id,
          attemptKey,
        },
      });
      return {
        agreement: updated,
        version: {
          ...current,
          representationStatus: "SENT" as const,
          lockedAt: current.lockedAt ?? new Date(),
          esignSignatureRequestId: created.requestId,
        },
        requestId: created.requestId,
        reused: false as const,
      };
    });
  } catch (error) {
    if (error instanceof BusinessProtectionError || error instanceof EsignBoundaryError) {
      throw error;
    }
    throw new BusinessProtectionError(ESIGN_SEND_OUTCOME_UNKNOWN_MESSAGE);
  }
}

export async function cancelStuckEsignSend(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string; now?: Date },
) {
  requireOwnerForCompletion(access);
  const now = input.now ?? new Date();
  return runAgreementTransaction(db, async (tx) => {
    await lockOwnedAgreement(tx, access, input.agreementId);
    const agreement = await requireOwnedAgreement(tx, access, input.agreementId);
    const version = currentVersion(agreement);
    await lockOwnedAgreementVersion(tx, access, {
      agreementId: agreement.id,
      versionId: version.id,
    });
    const locked = await requireOwnedAgreement(tx, access, input.agreementId);
    if (locked.signingMode !== ESIGN_SENDING_MODE || locked.esignSignatureRequestId) {
      throw new BusinessProtectionError("That agreement does not have a stuck e-sign send claim.");
    }
    const claimedAt = locked.esignSendingClaimedAt;
    if (!claimedAt || now.getTime() - claimedAt.getTime() < ESIGN_STALE_SEND_MINUTES * 60_000) {
      throw new BusinessProtectionError(ESIGN_STALE_SEND_NOT_READY_MESSAGE);
    }
    const updated = await tx.businessAgreement.update({
      where: { id: locked.id },
      data: {
        signingMode: "NOT_CONNECTED",
        completionAttemptKey: null,
        esignSendingClaimedAt: null,
      },
    });
    await writeProtectionAudit(tx, {
      businessId: access.businessId,
      membershipId: membershipId(access),
      action: "esign_send_claim_cancelled",
      agreementId: locked.id,
      previousValue: {
        signingMode: locked.signingMode,
        completionAttemptKey: locked.completionAttemptKey,
        esignSendingClaimedAt: claimedAt.toISOString(),
      },
      newValue: {
        warning: ESIGN_CANCEL_STUCK_SEND_WARNING,
        signingMode: "NOT_CONNECTED",
      },
    });
    return { agreement: updated, version: currentVersion(locked) };
  });
}

async function resolveEsignWebhookActor(
  db: Db,
  metadata: { businessId: string; actorMembershipId: string },
) {
  const recorded = await db.membership.findFirst({
    where: { id: metadata.actorMembershipId, businessId: metadata.businessId },
    select: { id: true },
  });
  if (recorded) return recorded;
  const owner = await db.membership.findFirst({
    where: { businessId: metadata.businessId, role: "OWNER" },
    select: { id: true },
  });
  if (owner) return owner;
  throw new BusinessProtectionError("E-sign webhook actor is not available in that business.");
}

function esignRequestBinding(
  agreement: {
    signingMode: string;
    completionAttemptKey: string | null;
    esignSignatureRequestId?: string | null;
  },
  version: { esignSignatureRequestId?: string | null },
  requestId: string,
  attemptKey: string,
) {
  const stored = boundEsignRequestId(agreement, version);
  if (stored === requestId) return { ok: true as const, bind: false };
  if (
    !stored &&
    agreement.signingMode === ESIGN_SENDING_MODE &&
    agreement.completionAttemptKey === attemptKey
  ) {
    return { ok: true as const, bind: true };
  }
  return { ok: false as const, bind: false };
}

export async function completeAgreementFromEsignWebhook(
  db: Db,
  input: {
    event: VerifiedEsignCompletionEvent;
    signedPdf: Buffer;
    storage: StorageServiceDeps;
    now?: Date;
  },
) {
  const { metadata, requestId } = input.event;
  if (
    !metadata.businessId ||
    !metadata.agreementId ||
    !metadata.versionId ||
    !metadata.attemptKey ||
    !metadata.actorMembershipId
  ) {
    throw new BusinessProtectionError("E-sign webhook is missing the bound business, agreement, and version.");
  }

  const actor = await resolveEsignWebhookActor(db, metadata);

  const preview = await db.businessAgreement.findFirst({
    where: { id: metadata.agreementId, businessId: metadata.businessId },
    include: {
      versions: { orderBy: { versionNumber: "asc" } },
      completionClaim: true,
    },
  });
  if (!preview) {
    throw new BusinessProtectionError("That agreement is not in this business workspace.");
  }
  const previewVersion = preview.versions.find((row) => row.id === metadata.versionId);
  if (
    !previewVersion ||
    previewVersion.businessId !== metadata.businessId ||
    previewVersion.agreementId !== metadata.agreementId
  ) {
    throw new BusinessProtectionError(
      "E-sign webhook is not bound to this exact business, agreement, and version.",
    );
  }
  const previewBinding = esignRequestBinding(preview, previewVersion, requestId, metadata.attemptKey);
  if (!previewBinding.ok) {
    throw new BusinessProtectionError(
      "That agreement was not sent through the connected e-sign adapter for this request.",
    );
  }
  if (isCompletedAgreement(preview.lifecycleStatus as AgreementLifecycleStatus) || preview.completionClaim) {
    if (
      (preview.completionClaim?.attemptKey ?? preview.completionAttemptKey) === metadata.attemptKey &&
      preview.signedVersionId === previewVersion.id
    ) {
      return {
        ...(await loadCompletionWinnerByIds(db, metadata.businessId, preview.id)),
        reused: true as const,
      };
    }
    throw new BusinessProtectionError(
      "This agreement is already complete. Later edits belong on a new agreement.",
    );
  }

  const asset = await ingestProviderSignedPdf(input.storage, metadata.businessId, {
    filename: `signed-${metadata.agreementId}-${metadata.versionId}.pdf`,
    body: input.signedPdf,
  });
  const write = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`
      SELECT 1 FROM "BusinessAgreement"
      WHERE id = ${metadata.agreementId} AND "businessId" = ${metadata.businessId}
      FOR UPDATE
    `;
    await tx.$executeRaw`
      SELECT 1 FROM "BusinessAgreementVersion"
      WHERE id = ${metadata.versionId}
        AND "agreementId" = ${metadata.agreementId}
        AND "businessId" = ${metadata.businessId}
      FOR UPDATE
    `;
    const agreement = await tx.businessAgreement.findFirst({
      where: { id: metadata.agreementId, businessId: metadata.businessId },
      include: { versions: { orderBy: { versionNumber: "asc" } } },
    });
    if (!agreement) {
      throw new BusinessProtectionError("That agreement is not in this business workspace.");
    }
    const version = agreement.versions.find((row) => row.id === metadata.versionId);
    if (
      !version ||
      version.businessId !== metadata.businessId ||
      version.agreementId !== metadata.agreementId
    ) {
      throw new BusinessProtectionError(
        "E-sign webhook is not bound to this exact business, agreement, and version.",
      );
    }
    const binding = esignRequestBinding(agreement, version, requestId, metadata.attemptKey);
    if (!binding.ok) {
      throw new BusinessProtectionError(
        "That agreement was not sent through the connected e-sign adapter for this request.",
      );
    }
    if (binding.bind) {
      await tx.businessAgreementVersion.update({
        where: { id: version.id },
        data: { esignSignatureRequestId: requestId },
      });
      await tx.businessAgreement.update({
        where: { id: agreement.id },
        data: {
          esignSignatureRequestId: requestId,
          signingMode: "PROVIDER_READY",
          esignSendingClaimedAt: null,
        },
      });
      agreement.esignSignatureRequestId = requestId;
      agreement.signingMode = "PROVIDER_READY";
      version.esignSignatureRequestId = requestId;
    }

    const existingClaim = await tx.businessAgreementCompletionClaim.findUnique({
      where: { agreementId: agreement.id },
    });
    if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus) || existingClaim) {
      if (
        (existingClaim?.attemptKey ?? agreement.completionAttemptKey) === metadata.attemptKey &&
        agreement.signedVersionId === version.id
      ) {
        return {
          ...(await loadCompletionWinnerByIds(tx, metadata.businessId, agreement.id)),
          reused: true as const,
        };
      }
      throw new BusinessProtectionError(
        "This agreement is already complete. Later edits belong on a new agreement.",
      );
    }

    if (
      (agreement.signingMode !== "PROVIDER_READY" && agreement.signingMode !== ESIGN_SENDING_MODE) ||
      agreement.completionAttemptKey !== metadata.attemptKey
    ) {
      throw new BusinessProtectionError(
        "That agreement was not sent through the connected e-sign adapter for this request.",
      );
    }
    if (
      version.representationStatus !== "SENT" &&
      version.representationStatus !== "SIGNED_FINAL"
    ) {
      throw new BusinessProtectionError("The bound version is not the locked sent copy.");
    }

    const now = input.now ?? new Date();
    const originalContent = version.draftContent;
    const signed = await tx.businessAgreementVersion.update({
      where: { id: version.id },
      data: { representationStatus: "SIGNED_FINAL", lockedAt: version.lockedAt ?? now },
    });
    if (signed.draftContent !== originalContent) {
      throw new BusinessProtectionError("The signed version content must not be rewritten.");
    }

    const clock = await vaultClassificationClock(tx, metadata.businessId, now);
    const vault = await tx.businessVaultRecord.create({
      data: {
        businessId: metadata.businessId,
        title: `${agreement.title} (provider signed document)`,
        category: vaultCategoryForAgreement(agreement.agreementType),
        counterparty: agreement.counterparty,
        effectiveOn: agreement.effectiveOn,
        expiresOn: agreement.expiresOn,
        notes: [
          PROVIDER_SIGNED_DOCUMENT_NOTE,
          `providerRequestId=${requestId}`,
          `boundVersionId=${version.id}`,
          `uploadedSignedAssetId=${asset.id}`,
        ].join(" "),
        storedAssetId: asset.id,
        recordStatus: "ACTIVE",
        persistedExpiryState: classifyExpiry({
          category: vaultCategoryForAgreement(agreement.agreementType),
          expiresOn: agreement.expiresOn,
          now: clock.now,
          timeZone: clock.timeZone,
        }),
        createdByMembershipId: actor.id,
        updatedByMembershipId: actor.id,
      },
    });

    const updated = await tx.businessAgreement.update({
      where: { id: agreement.id },
      data: {
        lifecycleStatus: "COMPLETE",
        signingMode: "PROVIDER_READY",
        signedVersionId: signed.id,
        currentDraftVersionId: signed.id,
        vaultRecordId: vault.id,
        completedAt: now,
        completedByMembershipId: actor.id,
        completionNotes: `providerRequestId=${requestId}`,
        completionAttemptKey: metadata.attemptKey,
        esignSignatureRequestId: requestId,
      },
    });

    await tx.businessAgreementCompletionClaim.create({
      data: {
        businessId: metadata.businessId,
        agreementId: agreement.id,
        attemptKey: metadata.attemptKey,
        signedVersionId: signed.id,
        vaultRecordId: vault.id,
      },
    });

    await writeProtectionAudit(tx, {
      businessId: metadata.businessId,
      membershipId: actor.id,
      action: "esign_webhook_completed",
      agreementId: agreement.id,
      vaultRecordId: vault.id,
      newValue: {
        mode: "PROVIDER_READY",
        versionId: signed.id,
        requestId,
        eventId: input.event.eventId,
        storedSignedDocument: true,
        completionAttemptKey: metadata.attemptKey,
      },
    });
    await writeProtectionAudit(tx, {
      businessId: metadata.businessId,
      membershipId: actor.id,
      action: "agreement_finalized",
      agreementId: agreement.id,
      vaultRecordId: vault.id,
      newValue: {
        lifecycleStatus: "COMPLETE",
        storedAssetId: asset.id,
        signedDocumentFileUploaded: true,
        boundVersionId: signed.id,
      },
    });
    return { agreement: updated, vault, signedVersion: signed, reused: false as const };
  };

  try {
    await esignWebhookTestHooks.afterIngestBeforeCommit?.();
    const result = await runAgreementTransaction(db, write);
    if (result.reused && asset) {
      await releaseOrphanedProviderSignedAsset(input.storage, metadata.businessId, asset.id);
    }
    return result;
  } catch (error) {
    if (asset) {
      await releaseOrphanedProviderSignedAsset(input.storage, metadata.businessId, asset.id);
    }
    if (!uniqueConflict(error)) throw error;
    const winner = await db.businessAgreement.findFirst({
      where: { id: metadata.agreementId, businessId: metadata.businessId },
    });
    if (
      winner &&
      isCompletedAgreement(winner.lifecycleStatus as AgreementLifecycleStatus) &&
      winner.completionAttemptKey === metadata.attemptKey &&
      winner.signedVersionId === metadata.versionId
    ) {
      return {
        ...(await loadCompletionWinnerByIds(db, metadata.businessId, metadata.agreementId)),
        reused: true as const,
      };
    }
    const claim = await db.businessAgreementCompletionClaim.findFirst({
      where: { businessId: metadata.businessId, attemptKey: metadata.attemptKey },
    });
    if (claim?.agreementId === metadata.agreementId && claim.signedVersionId === metadata.versionId) {
      return {
        ...(await loadCompletionWinnerByIds(db, metadata.businessId, metadata.agreementId)),
        reused: true as const,
      };
    }
    throw new BusinessProtectionError(
      "This agreement is already complete. Later edits belong on a new agreement.",
    );
  }
}

export async function mutateCompletedAgreementContent(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string; draftContent: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (!agreement.signedVersionId) {
    throw new BusinessProtectionError("That agreement is not a signed historical copy.");
  }
  const signed = agreement.versions.find((row) => row.id === agreement.signedVersionId);
  if (!signed) throw new BusinessProtectionError("Signed version is missing.");
  throw new BusinessProtectionError(
    "The signed version is immutable. Start a new agreement if you need different terms.",
  );
}

export function protectionGapFromExpiry(state: ExpiryState) {
  return needsRenewalAttention(state);
}

export { awaitingActionStatuses };
