/**
 * Business Protection mutations. Tenant scope always comes from
 * BusinessAccess. MEMBER never browses or mutates the vault.
 *
 * Completing a sensitive agreement requires an OWNER floor. AI helpers
 * never call these functions to authorize or sign.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import {
  AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  classifyExpiry,
  isVaultCategory,
  isVaultMimeAllowed,
  isVaultRecordStatus,
  needsRenewalAttention,
  parseOptionalCalendarDate,
  VAULT_DOCUMENT_MAX_BYTES,
  VAULT_DOCUMENT_PURPOSE,
  type ExpiryState,
  type VaultCategory,
} from "@/lib/business-protection";
import {
  awaitingActionStatuses,
  buildAgreementDraft,
  COMPLETED_AGREEMENT_STATUSES,
  isAgreementType,
  isCompletedAgreement,
  isHighRiskAgreement,
  isLockedVersion,
  parseAgreementAnswers,
  requiredQuestionsMissing,
  reviewAgreementRisk,
  type AgreementLifecycleStatus,
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
  if (asset.purpose !== VAULT_DOCUMENT_PURPOSE) {
    throw new BusinessProtectionError("Only a Business Vault file can be attached here.");
  }
  return asset.id;
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
  const current = currentVersion(agreement);
  if (!isLockedVersion(current.representationStatus as AgreementVersionStatus, current.lockedAt)) {
    return current;
  }
  const nextNumber = Math.max(...agreement.versions.map((row) => row.versionNumber)) + 1;
  const next = await db.businessAgreementVersion.create({
    data: {
      businessId: access.businessId,
      agreementId: agreement.id,
      versionNumber: nextNumber,
      representationStatus: "DRAFT",
      answersJson: current.answersJson,
      draftContent: current.draftContent,
      riskReviewJson: current.riskReviewJson,
      createdByMembershipId: membershipId(access),
    },
  });
  if (current.representationStatus === "DRAFT") {
    await db.businessAgreementVersion.update({
      where: { id: current.id },
      data: { representationStatus: "SUPERSEDED" },
    });
  }
  await db.businessAgreement.update({
    where: { id: agreement.id },
    data: { currentDraftVersionId: next.id, lifecycleStatus: "DRAFT" },
  });
  return next;
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
      effectiveOn: parseOptionalCalendarDate(answers.effectiveOn) ?? agreement.effectiveOn,
      expiresOn: parseOptionalCalendarDate(answers.expiresOn) ?? agreement.expiresOn,
      lifecycleStatus: "QUESTIONS",
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
  const risk = reviewAgreementRisk({
    type: agreement.agreementType,
    answers,
    draftContent,
  });
  await db.businessAgreementVersion.update({
    where: { id: version.id },
    data: {
      draftContent,
      riskReviewJson: JSON.stringify(risk),
    },
  });
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "RISK_REVIEW" },
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
  if (/legally (sufficient|enforceable|binding)/i.test(content)) {
    throw new BusinessProtectionError(AGREEMENT_NOT_ENFORCEABLE_MESSAGE);
  }
  const answers = parseAgreementAnswers(version.answersJson);
  const risk = isAgreementType(agreement.agreementType)
    ? reviewAgreementRisk({ type: agreement.agreementType, answers, draftContent: content })
    : { findings: [], attorneyRecommended: true };
  await db.businessAgreementVersion.update({
    where: { id: version.id },
    data: { draftContent: content, riskReviewJson: JSON.stringify(risk) },
  });
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "RISK_REVIEW" },
  });
}

export async function markAgreementOwnerReviewed(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError("A completed agreement cannot be re-reviewed into a new agreement.");
  }
  const nextStatus: AgreementLifecycleStatus = isHighRiskAgreement(
    agreement.agreementType as AgreementType,
  )
    ? "LEGAL_WARNING"
    : "READY";
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      lifecycleStatus: nextStatus,
      ownerReviewedAt: new Date(),
      ownerReviewedByMembershipId: membershipId(access),
    },
  });
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
  await db.businessProtectionAcknowledgment.create({
    data: {
      businessId: access.businessId,
      membershipId: membershipId(access),
      kind: "ATTORNEY_REVIEW_RECOMMENDATION",
      statement: AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
    },
  });
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      lifecycleStatus: "READY",
      legalReviewAcknowledgedAt: new Date(),
      legalReviewAcknowledgedByMembershipId: membershipId(access),
    },
  });
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
  if (
    isHighRiskAgreement(agreement.agreementType as AgreementType) &&
    !agreement.legalReviewAcknowledgedAt
  ) {
    throw new BusinessProtectionError(AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE);
  }
  return db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "READY" },
  });
}

export async function markAgreementSent(
  db: Db,
  access: BusinessAccess,
  input: { agreementId: string },
) {
  requireProtection(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError("A completed agreement cannot be sent again as a new agreement.");
  }
  if (agreement.lifecycleStatus !== "READY" && agreement.lifecycleStatus !== "SENT") {
    throw new BusinessProtectionError("Mark the agreement ready before recording that it was sent.");
  }
  const version = currentVersion(agreement);
  if (isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt)) {
    return db.businessAgreement.update({
      where: { id: agreement.id },
      data: { lifecycleStatus: "SENT" },
    });
  }
  const now = new Date();
  await db.businessAgreementVersion.update({
    where: { id: version.id },
    data: { representationStatus: "SENT", lockedAt: now },
  });
  const updated = await db.businessAgreement.update({
    where: { id: agreement.id },
    data: { lifecycleStatus: "SENT", currentDraftVersionId: version.id },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "agreement_sent",
    agreementId: agreement.id,
    newValue: { versionId: version.id, versionNumber: version.versionNumber },
  });
  return updated;
}

export async function completeAgreementExternally(
  db: Db,
  access: BusinessAccess,
  input: {
    agreementId: string;
    mode: string;
    notes?: string;
    storedAssetId?: string;
    now?: Date;
  },
) {
  requireOwnerForCompletion(access);
  const agreement = await requireOwnedAgreement(db, access, input.agreementId);
  if (isCompletedAgreement(agreement.lifecycleStatus as AgreementLifecycleStatus)) {
    throw new BusinessProtectionError(
      "This agreement is already complete. Later edits belong on a new agreement.",
    );
  }
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
  if (mode === "MANUAL_UPLOAD" && !input.storedAssetId?.trim()) {
    throw new BusinessProtectionError("Upload the signed file before marking this complete.");
  }
  const storedAssetId = await assertPrivateVaultAsset(db, access, input.storedAssetId);
  const version = currentVersion(agreement);
  const now = input.now ?? new Date();
  const signed = isLockedVersion(version.representationStatus as AgreementVersionStatus, version.lockedAt)
    ? await db.businessAgreementVersion.create({
        data: {
          businessId: access.businessId,
          agreementId: agreement.id,
          versionNumber: Math.max(...agreement.versions.map((row) => row.versionNumber)) + 1,
          representationStatus: "SIGNED_FINAL",
          answersJson: version.answersJson,
          draftContent: version.draftContent,
          riskReviewJson: version.riskReviewJson,
          createdByMembershipId: membershipId(access),
          lockedAt: now,
        },
      })
    : await db.businessAgreementVersion.update({
        where: { id: version.id },
        data: { representationStatus: "SIGNED_FINAL", lockedAt: now },
      });

  const vault = await db.businessVaultRecord.create({
    data: {
      businessId: access.businessId,
      title: `${agreement.title} (signed)`,
      category: vaultCategoryForAgreement(agreement.agreementType),
      counterparty: agreement.counterparty,
      effectiveOn: agreement.effectiveOn,
      expiresOn: agreement.expiresOn,
      notes: input.notes?.trim() || "Final stored agreement copy.",
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

  const lifecycleStatus: AgreementLifecycleStatus =
    mode === "MANUAL_UPLOAD" ? "COMPLETE" : "EXTERNAL_COMPLETE";
  const updated = await db.businessAgreement.update({
    where: { id: agreement.id },
    data: {
      lifecycleStatus,
      signingMode: mode,
      signedVersionId: signed.id,
      currentDraftVersionId: signed.id,
      vaultRecordId: vault.id,
      completedAt: now,
      completedByMembershipId: membershipId(access),
      completionNotes: input.notes?.trim() || null,
    },
  });
  await writeProtectionAudit(db, {
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
    },
  });
  await writeProtectionAudit(db, {
    businessId: access.businessId,
    membershipId: membershipId(access),
    action: "agreement_finalized",
    agreementId: agreement.id,
    vaultRecordId: vault.id,
    newValue: { lifecycleStatus, storedAssetId },
  });
  return { agreement: updated, vault, signedVersion: signed };
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
