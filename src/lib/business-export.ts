/**
 * Tenant-scoped business data export. Browser business IDs never authorize
 * this — callers must pass access.businessId from requireBusinessAccess().
 * Password hashes, session tokens, TOTP secrets, and setup/reset tokens
 * are never included.
 */
import type { PrismaClient } from "@prisma/client";
import {
  accountingExpensesCsv,
  accountingInvoicesCsv,
  accountingPaymentsCsv,
  type AccountingExportSource,
} from "@/lib/accounting-export";
import { VAULT_DOCUMENT_PURPOSE } from "@/lib/business-protection";
import { resolveStorageProvider } from "@/lib/business-storage/service";
import type { StorageProvider } from "@/lib/business-storage/types";
import { buildZipStore, toCsv } from "@/lib/zip-store";

const SECRET_KEY_PATTERN =
  /(password|tokenhash|totpsecret|totppending|secret|apikey|credential)/i;

export function isExportableField(key: string): boolean {
  return !SECRET_KEY_PATTERN.test(key);
}

export type BusinessExportDocumentStatus = "exported" | "skipped" | "missing";

export type BusinessExportDocumentManifestRow = {
  vaultRecordId: string;
  storedAssetId: string | null;
  originalFilename: string | null;
  exportedFilename: string | null;
  status: BusinessExportDocumentStatus;
  reason?: string;
};

export type BusinessExportResult = {
  filename: string;
  bytes: Buffer;
  documentExport: "complete" | "partial" | "none";
  documentExportError?: string;
  exportedDocumentCount: number;
  missingDocumentCount: number;
};

export type BusinessExportOptions = {
  provider?: StorageProvider;
};

export function safeExportFilename(original: string | null | undefined, fallback: string): string {
  const cleaned = (original ?? "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || fallback;
  return base.slice(0, 120);
}

export function uniqueExportPath(used: Set<string>, desired: string): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  const lastDot = desired.lastIndexOf(".");
  const stem = lastDot > 0 ? desired.slice(0, lastDot) : desired;
  const ext = lastDot > 0 ? desired.slice(lastDot) : "";
  let index = 2;
  let candidate = `${stem}-${index}${ext}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

async function resolveExportStorageProvider(
  options?: BusinessExportOptions,
): Promise<{ provider: StorageProvider | null; error?: string }> {
  if (options?.provider) return { provider: options.provider };
  try {
    return { provider: await resolveStorageProvider() };
  } catch (error) {
    return {
      provider: null,
      error:
        error instanceof Error
          ? error.message
          : "Private document storage is not available for this export.",
    };
  }
}

export async function buildBusinessExportZip(
  prisma: PrismaClient,
  businessId: string,
  options?: BusinessExportOptions,
): Promise<BusinessExportResult> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      slug: true,
      tradeCode: true,
      publicPhone: true,
      publicEmail: true,
      publicWebsite: true,
      publicServiceAreaLabel: true,
      timezone: true,
      laborMinimumEnabled: true,
      laborMinimumAmount: true,
      firstRunSetupCompletedAt: true,
      starterServicesSetupCompletedAt: true,
      websiteSetupCompletedAt: true,
      offboardingRequestedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!business) {
    throw new Error("Business not found.");
  }

  const [
    customers,
    properties,
    requests,
    estimates,
    jobs,
    invoices,
    payments,
    expenses,
    timeEntries,
    reviews,
    reviewRequests,
    campaigns,
    serviceAreas,
    settings,
    members,
    followUps,
    referralRequests,
    marketingContents,
    settingsAudit,
    websitePublishes,
    websiteGallery,
    websiteLocalDrafts,
    vaultRecords,
    agreements,
    agreementVersions,
    protectionAudit,
    protectionAcks,
  ] = await Promise.all([
    prisma.customer.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        smsConsentStatus: true,
        firstLeadSource: true,
        firstCampaignId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.property.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        label: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        propertyId: true,
        status: true,
        summary: true,
        leadSource: true,
        campaignId: true,
        matchedServiceAreaId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.estimate.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        propertyId: true,
        serviceRequestId: true,
        status: true,
        campaignId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.job.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        estimateId: true,
        status: true,
        scheduledAt: true,
        assignedMembershipId: true,
        campaignId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invoice.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        total: true,
        paidAt: true,
        paymentMethod: true,
        paymentReference: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.payment.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        invoiceId: true,
        jobId: true,
        purpose: true,
        amount: true,
        method: true,
        receivedAt: true,
        note: true,
        createdAt: true,
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    }),
    prisma.expense.findMany({
      where: { businessId },
      select: {
        id: true,
        vendor: true,
        description: true,
        amount: true,
        category: true,
        occurredOn: true,
        jobId: true,
        customerId: true,
        paymentMethod: true,
        taxCategory: true,
        reimbursementStatus: true,
        reviewStatus: true,
        voidedAt: true,
        createdAt: true,
      },
      orderBy: [{ occurredOn: "asc" }, { id: "asc" }],
    }),
    prisma.timeEntry.findMany({
      where: { businessId },
      select: {
        id: true,
        membershipId: true,
        jobId: true,
        startedAt: true,
        endedAt: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.review.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        rating: true,
        platform: true,
        reviewText: true,
        websiteSelected: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.reviewRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.marketingCampaign.findMany({
      where: { businessId },
      select: {
        id: true,
        name: true,
        sourceKey: true,
        status: true,
        notes: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.serviceArea.findMany({
      where: { businessId },
      select: {
        id: true,
        kind: true,
        label: true,
        city: true,
        region: true,
        postalCode: true,
        enabled: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.businessSettings.findUnique({
      where: { businessId },
    }),
    prisma.membership.findMany({
      where: { businessId },
      select: {
        id: true,
        role: true,
        active: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customerFollowUp.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        sentAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.referralRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        jobId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.marketingContent.findMany({
      where: { businessId },
      select: {
        id: true,
        campaignId: true,
        title: true,
        status: true,
        channelIntent: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.settingsAuditLog.findMany({
      where: { businessId },
      select: {
        id: true,
        settingArea: true,
        settingKey: true,
        previousValue: true,
        newValue: true,
        changedAt: true,
      },
      orderBy: { changedAt: "asc" },
    }),
    prisma.websitePublish.findMany({
      where: { businessId },
      select: {
        id: true,
        versionNumber: true,
        status: true,
        schemaVersion: true,
        snapshotJson: true,
        summary: true,
        publishedAt: true,
        sourcePublishId: true,
      },
      orderBy: { versionNumber: "asc" },
    }),
    prisma.websiteGalleryItem.findMany({
      where: { businessId },
      select: {
        id: true,
        storedAssetId: true,
        title: true,
        caption: true,
        sortOrder: true,
        catalogItemId: true,
        createdAt: true,
      },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.websiteLocalPageDraft.findMany({
      where: { businessId },
      select: {
        id: true,
        serviceAreaId: true,
        catalogItemId: true,
        draftCopy: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.businessVaultRecord.findMany({
      where: { businessId },
      select: {
        id: true,
        title: true,
        category: true,
        issuer: true,
        counterparty: true,
        effectiveOn: true,
        expiresOn: true,
        recordStatus: true,
        persistedExpiryState: true,
        notes: true,
        storedAssetId: true,
        createdAt: true,
        updatedAt: true,
        storedAsset: {
          select: {
            id: true,
            businessId: true,
            originalFilename: true,
            mimeType: true,
            visibility: true,
            status: true,
            fileSizeBytes: true,
            purpose: true,
            category: true,
            storageKey: true,
            deletedAt: true,
            storageAccount: {
              select: { bucketName: true },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.businessAgreement.findMany({
      where: { businessId },
      select: {
        id: true,
        agreementType: true,
        title: true,
        counterparty: true,
        lifecycleStatus: true,
        signingMode: true,
        effectiveOn: true,
        expiresOn: true,
        signedVersionId: true,
        vaultRecordId: true,
        completedAt: true,
        completedByMembershipId: true,
        completionNotes: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.businessAgreementVersion.findMany({
      where: { businessId },
      select: {
        id: true,
        agreementId: true,
        versionNumber: true,
        representationStatus: true,
        answersJson: true,
        draftContent: true,
        riskReviewJson: true,
        lockedAt: true,
        createdAt: true,
      },
      orderBy: [{ agreementId: "asc" }, { versionNumber: "asc" }],
    }),
    prisma.businessProtectionAuditLog.findMany({
      where: { businessId },
      select: {
        id: true,
        action: true,
        vaultRecordId: true,
        agreementId: true,
        previousValue: true,
        newValue: true,
        changedAt: true,
      },
      orderBy: { changedAt: "asc" },
    }),
    prisma.businessProtectionAcknowledgment.findMany({
      where: { businessId },
      select: {
        id: true,
        kind: true,
        statement: true,
        acknowledgedAt: true,
        membershipId: true,
      },
      orderBy: { acknowledgedAt: "asc" },
    }),
  ]);

  const safeSettings = settings
    ? Object.fromEntries(
        Object.entries(settings).filter(([key]) => isExportableField(key)),
      )
    : {};

  const date = new Date().toISOString().slice(0, 10);
  const usedDocumentNames = new Set<string>();
  const documentManifest: BusinessExportDocumentManifestRow[] = [];
  const documentFiles: Array<{ name: string; data: Buffer }> = [];
  const storage = await resolveExportStorageProvider(options);
  let documentExportError = storage.error;
  let exportedDocumentCount = 0;
  let missingDocumentCount = 0;

  for (const record of vaultRecords) {
    const asset = record.storedAsset;
    if (!record.storedAssetId && !asset) continue;
    if (
      !asset ||
      asset.businessId !== businessId ||
      asset.deletedAt ||
      asset.status !== "READY" ||
      asset.visibility !== "PRIVATE" ||
      asset.purpose !== VAULT_DOCUMENT_PURPOSE ||
      asset.category !== "DOCUMENT"
    ) {
      if (record.storedAssetId) {
        missingDocumentCount += 1;
        documentManifest.push({
          vaultRecordId: record.id,
          storedAssetId: record.storedAssetId,
          originalFilename: asset?.originalFilename ?? null,
          exportedFilename: null,
          status: "skipped",
          reason: "Asset is not a READY private Business Vault document belonging to this tenant.",
        });
      }
      continue;
    }
    if (!storage.provider) {
      missingDocumentCount += 1;
      documentManifest.push({
        vaultRecordId: record.id,
        storedAssetId: asset.id,
        originalFilename: asset.originalFilename,
        exportedFilename: null,
        status: "missing",
        reason: documentExportError || "Private document storage is not available for this export.",
      });
      continue;
    }
    try {
      const object = await storage.provider.getObject({
        bucket: asset.storageAccount.bucketName,
        key: asset.storageKey,
      });
      if (!object?.body?.byteLength) {
        throw new Error("The stored vault document could not be read from the storage provider.");
      }
      const exportedFilename = uniqueExportPath(
        usedDocumentNames,
        `vault-documents/${record.id}-${safeExportFilename(asset.originalFilename, "vault-document")}`,
      );
      documentFiles.push({
        name: exportedFilename,
        data: Buffer.from(object.body),
      });
      exportedDocumentCount += 1;
      documentManifest.push({
        vaultRecordId: record.id,
        storedAssetId: asset.id,
        originalFilename: asset.originalFilename,
        exportedFilename,
        status: "exported",
      });
    } catch (error) {
      missingDocumentCount += 1;
      const reason =
        error instanceof Error
          ? error.message
          : "The stored vault document could not be read from the storage provider.";
      documentExportError = documentExportError || reason;
      documentManifest.push({
        vaultRecordId: record.id,
        storedAssetId: asset.id,
        originalFilename: asset.originalFilename,
        exportedFilename: null,
        status: "missing",
        reason,
      });
    }
  }

  const documentExport =
    documentManifest.length === 0
      ? "none"
      : missingDocumentCount === 0
        ? "complete"
        : "partial";

  const [saasSubscription, productAddons, productGrants] = await Promise.all([
    prisma.businessSaasSubscription.findUnique({
      where: { businessId },
      select: {
        planCode: true,
        status: true,
        founderEligible: true,
        founderConvertedAt: true,
        founderEligibilityEndedAt: true,
        trialStartedAt: true,
        trialEndsAt: true,
        legacyExempt: true,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: true,
      },
    }),
    prisma.businessProductAddon.findMany({
      where: { businessId },
      select: {
        addonCode: true,
        status: true,
        quantity: true,
        source: true,
        grantedAt: true,
        revokedAt: true,
      },
    }),
    prisma.businessProductGrant.findMany({
      where: { businessId },
      select: {
        grantType: true,
        code: true,
        quantity: true,
        status: true,
        source: true,
        note: true,
        grantedAt: true,
        revokedAt: true,
      },
    }),
  ]);
  const accountingSource: AccountingExportSource = {
    businessId: business.id,
    businessName: business.name,
    slug: business.slug,
    invoices,
    payments,
    expenses,
    customers: customers.map((customer) => ({ id: customer.id, name: customer.name })),
    jobs: jobs.map((job) => ({ id: job.id })),
  };

  const files = [
    {
      name: "manifest.json",
      data: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          businessId: business.id,
          businessName: business.name,
          slug: business.slug,
          note:
            "Tenant-scoped export. Password hashes, session tokens, TOTP secrets, and setup/reset tokens are omitted. invoices.csv, payments.csv, and expenses.csv are recorded TBBT truth for an accountant: Payment rows are never inferred from PAID invoice status, and voided expenses are omitted.",
          documentExport,
          documentExportError: documentExportError ?? null,
          exportedDocumentCount,
          missingDocumentCount,
        },
        null,
        2,
      ),
    },
    { name: "business.csv", data: toCsv(Object.keys(business), [business]) },
    {
      name: "members.csv",
      data: toCsv(
        ["id", "name", "email", "role", "active", "createdAt"],
        members.map((member) => ({
          id: member.id,
          name: member.user.name,
          email: member.user.email,
          role: member.role,
          active: member.active,
          createdAt: member.createdAt,
        })),
      ),
    },
    { name: "customers.csv", data: toCsv(headersOf(customers), customers) },
    { name: "properties.csv", data: toCsv(headersOf(properties), properties) },
    { name: "requests.csv", data: toCsv(headersOf(requests), requests) },
    { name: "estimates.csv", data: toCsv(headersOf(estimates), estimates) },
    { name: "jobs.csv", data: toCsv(headersOf(jobs), jobs) },
    { name: "invoices.csv", data: accountingInvoicesCsv(accountingSource) },
    { name: "payments.csv", data: accountingPaymentsCsv(accountingSource) },
    { name: "expenses.csv", data: accountingExpensesCsv(accountingSource) },
    { name: "time-entries.csv", data: toCsv(headersOf(timeEntries), timeEntries) },
    { name: "reviews.csv", data: toCsv(headersOf(reviews), reviews) },
    { name: "review-requests.csv", data: toCsv(headersOf(reviewRequests), reviewRequests) },
    { name: "campaigns.csv", data: toCsv(headersOf(campaigns), campaigns) },
    { name: "marketing-content.csv", data: toCsv(headersOf(marketingContents), marketingContents) },
    { name: "service-areas.csv", data: toCsv(headersOf(serviceAreas), serviceAreas) },
    { name: "follow-ups.csv", data: toCsv(headersOf(followUps), followUps) },
    { name: "referral-requests.csv", data: toCsv(headersOf(referralRequests), referralRequests) },
    {
      name: "settings.csv",
      data: toCsv(Object.keys(safeSettings), [safeSettings]),
    },
    { name: "settings-audit.csv", data: toCsv(headersOf(settingsAudit), settingsAudit) },
    {
      name: "website-publishes.json",
      data: JSON.stringify(
        websitePublishes.map((row) => ({
          id: row.id,
          versionNumber: row.versionNumber,
          status: row.status,
          schemaVersion: row.schemaVersion,
          summary: row.summary,
          publishedAt: row.publishedAt,
          sourcePublishId: row.sourcePublishId,
          snapshot: JSON.parse(row.snapshotJson),
        })),
        null,
        2,
      ),
    },
    { name: "website-gallery.csv", data: toCsv(headersOf(websiteGallery), websiteGallery) },
    {
      name: "website-local-drafts.csv",
      data: toCsv(headersOf(websiteLocalDrafts), websiteLocalDrafts),
    },
    {
      name: "business-vault.csv",
      data: toCsv(
        [
          "id",
          "title",
          "category",
          "issuer",
          "counterparty",
          "effectiveOn",
          "expiresOn",
          "recordStatus",
          "persistedExpiryState",
          "notes",
          "storedAssetId",
          "originalFilename",
          "mimeType",
          "visibility",
          "fileStatus",
          "fileSizeBytes",
          "createdAt",
          "updatedAt",
        ],
        vaultRecords.map((row) => ({
          id: row.id,
          title: row.title,
          category: row.category,
          issuer: row.issuer,
          counterparty: row.counterparty,
          effectiveOn: row.effectiveOn,
          expiresOn: row.expiresOn,
          recordStatus: row.recordStatus,
          persistedExpiryState: row.persistedExpiryState,
          notes: row.notes,
          storedAssetId: row.storedAssetId,
          originalFilename: row.storedAsset?.originalFilename ?? "",
          mimeType: row.storedAsset?.mimeType ?? "",
          visibility: row.storedAsset?.visibility ?? "",
          fileStatus: row.storedAsset?.status ?? "",
          fileSizeBytes: row.storedAsset?.fileSizeBytes ?? "",
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ),
    },
    { name: "business-agreements.csv", data: toCsv(headersOf(agreements), agreements) },
    {
      name: "business-agreement-versions.json",
      data: JSON.stringify(
        agreementVersions.map((row) => ({
          ...row,
          answers: safeJson(row.answersJson),
          riskReview: safeJson(row.riskReviewJson),
        })),
        null,
        2,
      ),
    },
    {
      name: "business-protection-audit.csv",
      data: toCsv(headersOf(protectionAudit), protectionAudit),
    },
    {
      name: "business-protection-acknowledgments.csv",
      data: toCsv(headersOf(protectionAcks), protectionAcks),
    },
    {
      name: "commercial-entitlement.json",
      data: JSON.stringify(
        {
          planCode: saasSubscription?.planCode ?? null,
          subscriptionStatus: saasSubscription?.status ?? null,
          founderEligible: saasSubscription?.founderEligible ?? null,
          founderConvertedAt: saasSubscription?.founderConvertedAt ?? null,
          founderEligibilityEndedAt: saasSubscription?.founderEligibilityEndedAt ?? null,
          trialStartedAt: saasSubscription?.trialStartedAt ?? null,
          trialEndsAt: saasSubscription?.trialEndsAt ?? null,
          legacyExempt: saasSubscription?.legacyExempt ?? null,
          cancelAtPeriodEnd: saasSubscription?.cancelAtPeriodEnd ?? null,
          currentPeriodEnd: saasSubscription?.currentPeriodEnd ?? null,
          addons: productAddons,
          grants: productGrants,
          omitted:
            "Stripe secret keys, webhook secrets, provider credentials, and internal price configuration are not exported.",
        },
        null,
        2,
      ),
    },
    {
      name: "business-vault-documents-manifest.json",
      data: JSON.stringify(
        {
          documentExport,
          documentExportError: documentExportError ?? null,
          exportedDocumentCount,
          missingDocumentCount,
          note:
            documentExport === "complete"
              ? "READY private Business Vault documents belonging to this tenant are included as files."
              : documentExport === "none"
                ? "This tenant had no READY private Business Vault documents to export."
                : "This export is a partial document export. Missing vault files are listed below and were not silently treated as complete.",
          documents: documentManifest,
        },
        null,
        2,
      ),
    },
    ...documentFiles,
  ];

  return {
    filename: `tbbt-export-${business.slug}-${date}.zip`,
    bytes: buildZipStore(files),
    documentExport,
    documentExportError,
    exportedDocumentCount,
    missingDocumentCount,
  };
}

function headersOf(rows: Array<Record<string, unknown>>): string[] {
  return rows[0] ? Object.keys(rows[0]) : ["id"];
}

function safeJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
