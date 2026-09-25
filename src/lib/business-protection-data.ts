/**
 * Business Protection loaders. Every query is scoped by the authenticated
 * workspace businessId. MEMBER never reaches these pages.
 */

import type { PrismaClient } from "@prisma/client";
import { privateAssetPath } from "@/lib/business-storage/keys";
import {
  classifyExpiry,
  LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
  LEGAL_NOT_AUTHORITY_MESSAGE,
  needsRenewalAttention,
  PROTECTION_CHECKLIST,
  VAULT_CATEGORY_LABELS,
  VAULT_PRIVATE_MESSAGE,
  isVaultCategory,
  type ExpiryState,
  type ProtectionArea,
  type VaultCategory,
} from "@/lib/business-protection";
import {
  AGREEMENT_LIFECYCLE_LABELS,
  AGREEMENT_TYPE_LABELS,
  awaitingActionStatuses,
  isAgreementLifecycleStatus,
  isAgreementType,
  parseAgreementAnswers,
  reviewAgreementRisk,
  type AgreementLifecycleStatus,
} from "@/lib/business-protection-agreements";
import {
  ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
  resolveEsignProviderStatus,
} from "@/lib/business-protection-esign";

type Db = PrismaClient;

export type VaultRecordView = {
  id: string;
  title: string;
  category: VaultCategory;
  categoryLabel: string;
  issuer: string | null;
  counterparty: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  recordStatus: string;
  expiryState: ExpiryState;
  renewalAttention: boolean;
  notes: string | null;
  storedAssetId: string | null;
  fileName: string | null;
  fileHref: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgreementView = {
  id: string;
  title: string;
  agreementType: string;
  typeLabel: string;
  counterparty: string | null;
  lifecycleStatus: AgreementLifecycleStatus;
  lifecycleLabel: string;
  signingMode: string;
  effectiveOn: string | null;
  expiresOn: string | null;
  currentDraftVersionId: string | null;
  signedVersionId: string | null;
  vaultRecordId: string | null;
  completedAt: string | null;
  completedByMembershipId: string | null;
  ownerReviewedAt: string | null;
  legalReviewAcknowledgedAt: string | null;
  versions: Array<{
    id: string;
    versionNumber: number;
    representationStatus: string;
    lockedAt: string | null;
    draftContent: string;
    answers: Record<string, string>;
    riskReviewJson: string | null;
    createdAt: string;
  }>;
};

export type ProtectionDashboard = {
  insuranceOnFile: number;
  licensesCertsOnFile: number;
  agreementsAwaitingAction: number;
  expiringSoon: number;
  expired: number;
  missingDates: number;
  completeness: Array<{ id: string; label: string; met: boolean; count: number }>;
  disclaimer: string;
  authorityDisclaimer: string;
};

export type ProtectionWorkspace = {
  area: ProtectionArea;
  query: { area: ProtectionArea; selected?: string; q: string };
  records: VaultRecordView[];
  agreements: AgreementView[];
  selectedRecord: VaultRecordView | null;
  selectedAgreement: AgreementView | null;
  dashboard: ProtectionDashboard;
  audit: Array<{
    id: string;
    action: string;
    changedAt: string;
    vaultRecordId: string | null;
    agreementId: string | null;
  }>;
  esign: {
    providerStatus: "NOT_CONNECTED" | "PROVIDER_READY";
    message: string;
  };
  vaultPrivateMessage: string;
};

function toView(
  row: {
    id: string;
    title: string;
    category: string;
    issuer: string | null;
    counterparty: string | null;
    effectiveOn: string | null;
    expiresOn: string | null;
    recordStatus: string;
    notes: string | null;
    storedAssetId: string | null;
    createdAt: Date;
    updatedAt: Date;
    storedAsset: { originalFilename: string; visibility: string } | null;
  },
  now: Date,
): VaultRecordView {
  const category = isVaultCategory(row.category) ? row.category : "OTHER";
  const expiryState = classifyExpiry({ category, expiresOn: row.expiresOn, now });
  return {
    id: row.id,
    title: row.title,
    category,
    categoryLabel: VAULT_CATEGORY_LABELS[category],
    issuer: row.issuer,
    counterparty: row.counterparty,
    effectiveOn: row.effectiveOn,
    expiresOn: row.expiresOn,
    recordStatus: row.recordStatus,
    expiryState,
    renewalAttention: needsRenewalAttention(expiryState),
    notes: row.notes,
    storedAssetId: row.storedAssetId,
    fileName: row.storedAsset?.originalFilename ?? null,
    fileHref:
      row.storedAssetId && row.storedAsset?.visibility === "PRIVATE"
        ? privateAssetPath(row.storedAssetId)
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadProtectionWorkspace(
  db: Db,
  businessId: string,
  query: { area?: string; selected?: string; q?: string },
  now = new Date(),
): Promise<ProtectionWorkspace> {
  const area = (query.area === "vault" || query.area === "agreements" ? query.area : "dashboard") as ProtectionArea;
  const q = query.q?.trim() ?? "";
  const [records, agreements, audit] = await Promise.all([
    db.businessVaultRecord.findMany({
      where: { businessId },
      include: { storedAsset: { select: { originalFilename: true, visibility: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    db.businessAgreement.findMany({
      where: { businessId },
      include: { versions: { orderBy: { versionNumber: "asc" } } },
      orderBy: { updatedAt: "desc" },
    }),
    db.businessProtectionAuditLog.findMany({
      where: { businessId },
      orderBy: { changedAt: "desc" },
      take: 25,
      select: {
        id: true,
        action: true,
        changedAt: true,
        vaultRecordId: true,
        agreementId: true,
      },
    }),
  ]);

  const recordViews = records
    .map((row) => toView(row, now))
    .filter((row) => {
      if (!q) return true;
      const hay = [row.title, row.issuer, row.counterparty, row.categoryLabel, row.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q.toLowerCase());
    });

  const agreementViews: AgreementView[] = agreements.map((row) => {
    const type = isAgreementType(row.agreementType) ? row.agreementType : "CUSTOM_AGREEMENT";
    const lifecycle = isAgreementLifecycleStatus(row.lifecycleStatus)
      ? row.lifecycleStatus
      : "QUESTIONS";
    return {
      id: row.id,
      title: row.title,
      agreementType: type,
      typeLabel: AGREEMENT_TYPE_LABELS[type],
      counterparty: row.counterparty,
      lifecycleStatus: lifecycle,
      lifecycleLabel: AGREEMENT_LIFECYCLE_LABELS[lifecycle],
      signingMode: row.signingMode,
      effectiveOn: row.effectiveOn,
      expiresOn: row.expiresOn,
      currentDraftVersionId: row.currentDraftVersionId,
      signedVersionId: row.signedVersionId,
      vaultRecordId: row.vaultRecordId,
      completedAt: row.completedAt?.toISOString() ?? null,
      completedByMembershipId: row.completedByMembershipId,
      ownerReviewedAt: row.ownerReviewedAt?.toISOString() ?? null,
      legalReviewAcknowledgedAt: row.legalReviewAcknowledgedAt?.toISOString() ?? null,
      versions: row.versions.map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        representationStatus: version.representationStatus,
        lockedAt: version.lockedAt?.toISOString() ?? null,
        draftContent: version.draftContent,
        answers: parseAgreementAnswers(version.answersJson),
        riskReviewJson: version.riskReviewJson,
        createdAt: version.createdAt.toISOString(),
      })),
    };
  });

  const active = recordViews.filter((row) => row.recordStatus === "ACTIVE");
  const completeness = PROTECTION_CHECKLIST.map((item) => {
    const count = active.filter((row) => (item.categories as readonly string[]).includes(row.category)).length;
    return { id: item.id, label: item.label, met: count > 0, count };
  });

  const awaiting = new Set(awaitingActionStatuses());
  const dashboard: ProtectionDashboard = {
    insuranceOnFile: active.filter((row) => row.category === "INSURANCE").length,
    licensesCertsOnFile: active.filter((row) => row.category === "LICENSE" || row.category === "CERTIFICATION")
      .length,
    agreementsAwaitingAction: agreementViews.filter((row) => awaiting.has(row.lifecycleStatus)).length,
    expiringSoon: active.filter((row) => row.expiryState === "EXPIRING_SOON").length,
    expired: active.filter((row) => row.expiryState === "EXPIRED").length,
    missingDates: active.filter((row) => row.expiryState === "MISSING_DATE").length,
    completeness,
    disclaimer: LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE,
    authorityDisclaimer: LEGAL_NOT_AUTHORITY_MESSAGE,
  };

  const selectedRecord = recordViews.find((row) => row.id === query.selected) ?? null;
  const selectedAgreement = agreementViews.find((row) => row.id === query.selected) ?? null;

  return {
    area,
    query: { area, selected: query.selected, q },
    records: recordViews,
    agreements: agreementViews,
    selectedRecord,
    selectedAgreement,
    dashboard,
    audit: audit.map((row) => ({
      id: row.id,
      action: row.action,
      changedAt: row.changedAt.toISOString(),
      vaultRecordId: row.vaultRecordId,
      agreementId: row.agreementId,
    })),
    esign: {
      providerStatus: resolveEsignProviderStatus(),
      message: ESIGN_PROVIDER_NOT_CONNECTED_MESSAGE,
    },
    vaultPrivateMessage: VAULT_PRIVATE_MESSAGE,
  };
}

export function selectedAgreementRisk(agreement: AgreementView | null) {
  if (!agreement) return null;
  const current =
    agreement.versions.find((row) => row.id === agreement.currentDraftVersionId) ??
    agreement.versions[agreement.versions.length - 1];
  if (!current || !isAgreementType(agreement.agreementType)) return null;
  if (current.riskReviewJson) {
    try {
      return JSON.parse(current.riskReviewJson) as ReturnType<typeof reviewAgreementRisk>;
    } catch {
      /* fall through */
    }
  }
  return reviewAgreementRisk({
    type: agreement.agreementType,
    answers: current.answers,
    draftContent: current.draftContent,
  });
}
