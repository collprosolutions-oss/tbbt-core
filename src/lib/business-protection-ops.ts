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
import {
  AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  AGREEMENT_NOT_READY_FOR_COMPLETION_MESSAGE,
  classifyExpiry,
  EXTERNAL_SIGNATURE_NO_FILE_NOTE,
  OWNER_REVIEW_REQUIRES_OWNER_MESSAGE,
  parseOptionalCalendarDate,
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
  EsignBoundaryError,
  normalizeCompletionMode,
  resolveEsignProviderStatus,
} from "@/lib/business-protection-esign";
import {
  abortManagedUpload,
  authorizeManagedUpload,
  finalizeManagedUpload,
  resolveStorageProvider,
  type StorageServiceDeps,
} from "@/lib/business-storage/service";

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
    error instanceof EsignBoundaryError
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.message === "Use a valid YYYY-MM-DD date.") {
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
  record: { id: string; category: string; expiresOn: string | null; persistedExpiryState: string | null },
  now = new Date(),
) {
  requireProtection(access);
  if (!isVaultCategory(record.category)) return record.persistedExpiryState;
  const next = classifyExpiry({
    category: record.category,
    expiresOn: record.expiresOn,
    now,
  });
  if (record.persistedExpiryState === next) return next;
  await db.businessVaultRecord.update({
    where: { id: record.id },
    data: { persistedExpiryState: next },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "expiry_state_change",
    vaultRecordId: record.id,
    previousValue: record.persistedExpiryState,
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
  const expiry = classifyExpiry({
    category: input.category,
    expiresOn,
    now: input.now ?? new Date(),
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
  const title = input.title?.trim() || existing.title;
  if (!title) throw new BusinessProtectionError("Enter a title.");
  const expiry = classifyExpiry({
    category,
    expiresOn,
    now: input.now ?? new Date(),
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
  try {
    const provider = await resolveStorageProvider(deps);
    await provider.deleteObject({
      bucket: asset.storageAccount.bucketName,
      key: asset.storageKey,
    }).catch(() => undefined);
  } catch {
    // Provider absence still allows the tenant-scoped DB cleanup below.
  }
  await deps.db.$transaction(async (tx) => {
    await tx.storedAsset.update({
      where: { id: asset.id },
      data: { status: "DELETED", deletedAt: now, publicPath: null },
    });
    if (asset.status === "READY" && asset.fileSizeBytes > 0) {
      await tx.businessStorageAccount.update({
        where: { id: asset.storageAccountId },
        data: { storageUsedBytes: { decrement: asset.fileSizeBytes } },
      });
    }
  });
  return { released: true as const, reason: "deleted", assetId: asset.id };
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
  }
  const mode = normalizeCompletionMode(input.mode, resolveEsignProviderStatus());
  if (mode === "PROVIDER_READY") {
    throw new BusinessProtectionError(
      "No e-sign provider is connected. TBBT will not invent a digital signature.",
    );
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
          now,
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
