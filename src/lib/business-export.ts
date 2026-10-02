/**
 * Tenant-scoped business data export. Browser business IDs never authorize
 * this — callers must pass access.businessId from requireBusinessAccess().
 * Password hashes, session tokens, TOTP secrets, and setup/reset tokens
 * are never included.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  accountingExpensesCsv,
  accountingInvoicesCsv,
  accountingPaymentsCsv,
  canExportBusinessData,
  type AccountingExportSource,
} from "@/lib/accounting-export";
import { ForbiddenError } from "@/lib/authorization";
import { VAULT_DOCUMENT_PURPOSE } from "@/lib/business-protection";
import { PROJECT_DOCUMENT_PURPOSE } from "@/lib/business-storage/project-documents";
import { resolveStorageProvider } from "@/lib/business-storage/service";
import type { StorageProvider } from "@/lib/business-storage/types";
import {
  BusinessExportIncompleteError,
  asCsvRows,
  collectPagedRows,
  exportPagedCsv,
  headersOf,
  resolveBusinessExportLimits,
  type BusinessExportLimits,
} from "@/lib/business-export-paging";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import {
  ZipStoreLimitError,
  ZipStoreWriter,
  toCsv,
} from "@/lib/zip-store";

export const BUSINESS_EXPORT_AUDIT_AREA = "data-export" as const;
export const BUSINESS_EXPORT_AUDIT_KEY = "businessExport" as const;
export {
  BUSINESS_EXPORT_INCOMPLETE_PREFIX,
  BUSINESS_EXPORT_MAX_DOCUMENTS,
  BUSINESS_EXPORT_MAX_DOCUMENT_BYTES,
  BUSINESS_EXPORT_MAX_ROWS_PER_COLLECTION,
  BUSINESS_EXPORT_MAX_ZIP_BYTES,
  BUSINESS_EXPORT_PAGE_SIZE,
  BusinessExportIncompleteError,
  collectPagedRows,
  exportPagedCsv,
  resolveBusinessExportLimits,
  streamPagedRows,
} from "@/lib/business-export-paging";
export type { BusinessExportLimits } from "@/lib/business-export-paging";

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
  limits?: Partial<BusinessExportLimits>;
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

  const limits = resolveBusinessExportLimits(options?.limits);
  const page = { collection: "", limits };

  const customers = await collectPagedRows(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "customers" },
  );
  const propertiesCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "properties" },
  );
  const requestsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "requests" },
  );
  const estimatesCsv = await exportPagedCsv(
    (args) =>
      prisma.estimate.findMany({
        where: { businessId },
        select: {
          id: true,
          customerId: true,
          propertyId: true,
          serviceRequestId: true,
          status: true,
          total: true,
          campaignId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    {
      ...page,
      collection: "estimates",
      mapRow: (row) => ({
        ...row,
        total: exportEstimateTotal(row.total),
      }),
    },
  );
  const jobs = await collectPagedRows(
    (args) =>
      prisma.job.findMany({
        where: { businessId },
        select: {
          id: true,
          customerId: true,
          propertyId: true,
          estimateId: true,
          status: true,
          scheduledAt: true,
          assignedMembershipId: true,
          campaignId: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "jobs" },
  );
  const invoices = await collectPagedRows(
    (args) =>
      prisma.invoice.findMany({
        where: { businessId },
        select: {
          id: true,
          customerId: true,
          jobId: true,
          kind: true,
          status: true,
          total: true,
          paidAt: true,
          paymentMethod: true,
          paymentReference: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "invoices" },
  );
  const payments = await collectPagedRows(
    (args) =>
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
        ...args,
      }),
    { ...page, collection: "payments" },
  );
  const expenses = await collectPagedRows(
    (args) =>
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
        ...args,
      }),
    { ...page, collection: "expenses" },
  );
  const timeEntriesCsv = await exportPagedCsv(
    (args) =>
      prisma.timeEntry.findMany({
        where: { businessId },
        select: {
          id: true,
          membershipId: true,
          jobId: true,
          activityType: true,
          note: true,
          source: true,
          startedAt: true,
          endedAt: true,
          status: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "time-entries" },
  );
  const reviewsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "reviews" },
  );
  const reviewRequestsCsv = await exportPagedCsv(
    (args) =>
      prisma.reviewRequest.findMany({
        where: { businessId },
        select: {
          id: true,
          customerId: true,
          jobId: true,
          status: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "review-requests" },
  );
  const campaignsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "campaigns" },
  );
  const serviceAreasCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "service-areas" },
  );
  const settings = await prisma.businessSettings.findUnique({
    where: { businessId },
  });
  const membersCsv = await exportPagedCsv(
    (args) =>
      prisma.membership.findMany({
        where: { businessId },
        select: {
          id: true,
          role: true,
          active: true,
          createdAt: true,
          user: { select: { name: true, email: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    {
      ...page,
      collection: "members",
      headers: ["id", "name", "email", "role", "active", "createdAt"],
      mapRow: (member) => ({
        id: member.id,
        name: member.user.name,
        email: member.user.email,
        role: member.role,
        active: member.active,
        createdAt: member.createdAt,
      }),
    },
  );
  const followUpsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "follow-ups" },
  );
  const referralRequestsCsv = await exportPagedCsv(
    (args) =>
      prisma.referralRequest.findMany({
        where: { businessId },
        select: {
          id: true,
          customerId: true,
          jobId: true,
          status: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "referral-requests" },
  );
  const marketingContentsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "marketing-content" },
  );
  const settingsAuditCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ changedAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "settings-audit" },
  );
  const websitePublishes = await collectPagedRows(
    (args) =>
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
        orderBy: [{ versionNumber: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "website-publishes" },
  );
  const websiteGalleryCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "website-gallery" },
  );
  const websiteLocalDraftsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "website-local-drafts" },
  );
  const vaultRecords = await collectPagedRows(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "business-vault" },
  );
  const agreementsCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "business-agreements" },
  );
  const agreementVersions = await collectPagedRows(
    (args) =>
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
        orderBy: [{ agreementId: "asc" }, { versionNumber: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "business-agreement-versions" },
  );
  const protectionAuditCsv = await exportPagedCsv(
    (args) =>
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
        orderBy: [{ changedAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "business-protection-audit" },
  );
  const protectionAcksCsv = await exportPagedCsv(
    (args) =>
      prisma.businessProtectionAcknowledgment.findMany({
        where: { businessId },
        select: {
          id: true,
          kind: true,
          statement: true,
          acknowledgedAt: true,
          membershipId: true,
        },
        orderBy: [{ acknowledgedAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "business-protection-acknowledgments" },
  );

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
  let exportedDocumentBytes = 0;

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
      if (exportedDocumentCount >= limits.maxDocuments) {
        throw new BusinessExportIncompleteError(
          "vault-documents",
          `vault-documents has more than ${limits.maxDocuments} READY private files.`,
        );
      }
      const nextDocumentBytes = exportedDocumentBytes + object.body.byteLength;
      if (nextDocumentBytes > limits.maxDocumentBytes) {
        throw new BusinessExportIncompleteError(
          "vault-documents",
          `vault-documents would exceed ${limits.maxDocumentBytes} exported bytes.`,
        );
      }
      const exportedFilename = uniqueExportPath(
        usedDocumentNames,
        `vault-documents/${record.id}-${safeExportFilename(asset.originalFilename, "vault-document")}`,
      );
      documentFiles.push({
        name: exportedFilename,
        data: Buffer.from(object.body),
      });
      exportedDocumentBytes = nextDocumentBytes;
      exportedDocumentCount += 1;
      documentManifest.push({
        vaultRecordId: record.id,
        storedAssetId: asset.id,
        originalFilename: asset.originalFilename,
        exportedFilename,
        status: "exported",
      });
    } catch (error) {
      if (error instanceof BusinessExportIncompleteError) {
        throw error;
      }
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

  const saasSubscription = await prisma.businessSaasSubscription.findUnique({
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
  });
  const productAddons = await collectPagedRows(
    (args) =>
      prisma.businessProductAddon.findMany({
        where: { businessId },
        select: {
          id: true,
          addonCode: true,
          status: true,
          quantity: true,
          source: true,
          grantedAt: true,
          revokedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "product-addons" },
  );
  const productGrants = await collectPagedRows(
    (args) =>
      prisma.businessProductGrant.findMany({
        where: { businessId },
        select: {
          id: true,
          grantType: true,
          code: true,
          quantity: true,
          status: true,
          source: true,
          note: true,
          grantedAt: true,
          revokedAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "product-grants" },
  );
  const invoiceCredits = await collectPagedRows(
    (args) =>
      prisma.invoiceCredit.findMany({
        where: { businessId },
        select: {
          id: true,
          invoiceId: true,
          customerId: true,
          amount: true,
          reason: true,
          recordedByMembershipId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "invoice-credits" },
  );
  const projectDocuments = await collectPagedRows(
    (args) =>
      prisma.storedAsset.findMany({
        where: {
          businessId,
          category: "DOCUMENT",
          purpose: PROJECT_DOCUMENT_PURPOSE,
          visibility: "PRIVATE",
          status: "READY",
          deletedAt: null,
          publicPath: null,
        },
        select: {
          id: true,
          jobId: true,
          customerId: true,
          originalFilename: true,
          mimeType: true,
          visibility: true,
          status: true,
          fileSizeBytes: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...args,
      }),
    { ...page, collection: "project-documents" },
  );
  const accountingSource: AccountingExportSource = {
    businessId: business.id,
    businessName: business.name,
    slug: business.slug,
    invoices,
    payments,
    credits: invoiceCredits.map((row) => ({
      id: row.id,
      invoiceId: row.invoiceId,
      amount: row.amount,
    })),
    expenses,
    customers: customers.map((customer) => ({ id: customer.id, name: customer.name })),
    jobs: jobs.map((job) => ({ id: job.id })),
  };

  const zip = new ZipStoreWriter({ maxBytes: limits.maxZipBytes });
  const files: Array<{ name: string; data: string | Buffer }> = [
    {
      name: "manifest.json",
      data: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          businessId: business.id,
          businessName: business.name,
          slug: business.slug,
          note:
            "Tenant-scoped export. Password hashes, session tokens, TOTP secrets, and setup/reset tokens are omitted. invoices.csv, payments.csv, expenses.csv, and invoice-credits.csv are recorded TBBT truth for an accountant: Payment rows are never inferred from PAID invoice status, InvoiceCredit rows reduce Amount Remaining, and voided expenses are omitted. Matching rows are read in bounded pages. If this workspace is too large to export safely, the download fails instead of omitting records or writing a partial ZIP.",
          documentExport,
          documentExportError: documentExportError ?? null,
          exportedDocumentCount,
          missingDocumentCount,
          pageSize: limits.pageSize,
          maxRowsPerCollection: limits.maxRowsPerCollection,
        },
        null,
        2,
      ),
    },
    { name: "business.csv", data: toCsv(Object.keys(business), asCsvRows([business])) },
    { name: "members.csv", data: membersCsv },
    { name: "customers.csv", data: toCsv(headersOf(customers), asCsvRows(customers)) },
    { name: "properties.csv", data: propertiesCsv },
    { name: "requests.csv", data: requestsCsv },
    { name: "estimates.csv", data: estimatesCsv },
    { name: "jobs.csv", data: toCsv(headersOf(jobs), asCsvRows(jobs)) },
    {
      name: "project-documents.csv",
      data: toCsv(
        [
          "id",
          "jobId",
          "customerId",
          "originalFilename",
          "mimeType",
          "visibility",
          "status",
          "fileSizeBytes",
          "createdAt",
        ],
        asCsvRows(projectDocuments),
      ),
    },
    { name: "invoices.csv", data: accountingInvoicesCsv(accountingSource) },
    { name: "payments.csv", data: accountingPaymentsCsv(accountingSource) },
    { name: "expenses.csv", data: accountingExpensesCsv(accountingSource) },
    {
      name: "invoice-credits.csv",
      data: toCsv(
        [
          "id",
          "invoiceId",
          "customerId",
          "amount",
          "reason",
          "recordedByMembershipId",
          "createdAt",
        ],
        invoiceCredits.map((row) => ({
          id: row.id,
          invoiceId: row.invoiceId,
          customerId: row.customerId ?? "",
          amount: exportEstimateTotal(row.amount),
          reason: row.reason,
          recordedByMembershipId: row.recordedByMembershipId,
          createdAt: row.createdAt,
        })),
      ),
    },
    { name: "time-entries.csv", data: timeEntriesCsv },
    { name: "reviews.csv", data: reviewsCsv },
    { name: "review-requests.csv", data: reviewRequestsCsv },
    { name: "campaigns.csv", data: campaignsCsv },
    { name: "marketing-content.csv", data: marketingContentsCsv },
    { name: "service-areas.csv", data: serviceAreasCsv },
    { name: "follow-ups.csv", data: followUpsCsv },
    { name: "referral-requests.csv", data: referralRequestsCsv },
    {
      name: "settings.csv",
      data: toCsv(Object.keys(safeSettings), [safeSettings]),
    },
    { name: "settings-audit.csv", data: settingsAuditCsv },
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
    { name: "website-gallery.csv", data: websiteGalleryCsv },
    {
      name: "website-local-drafts.csv",
      data: websiteLocalDraftsCsv,
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
    { name: "business-agreements.csv", data: agreementsCsv },
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
      data: protectionAuditCsv,
    },
    {
      name: "business-protection-acknowledgments.csv",
      data: protectionAcksCsv,
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
          addons: productAddons.map((row) => ({
            addonCode: row.addonCode,
            status: row.status,
            quantity: row.quantity,
            source: row.source,
            grantedAt: row.grantedAt,
            revokedAt: row.revokedAt,
          })),
          grants: productGrants.map((row) => ({
            grantType: row.grantType,
            code: row.code,
            quantity: row.quantity,
            status: row.status,
            source: row.source,
            note: row.note,
            grantedAt: row.grantedAt,
            revokedAt: row.revokedAt,
          })),
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

  try {
    for (const file of files) {
      zip.add(file);
    }
  } catch (error) {
    if (error instanceof ZipStoreLimitError) {
      throw new BusinessExportIncompleteError("zip", error.message);
    }
    throw error;
  }

  return {
    filename: `tbbt-export-${business.slug}-${date}.zip`,
    bytes: zip.finalize(),
    documentExport,
    documentExportError,
    exportedDocumentCount,
    missingDocumentCount,
  };
}

function exportEstimateTotal(value: Prisma.Decimal | number | string): string {
  const amount = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return amount.toFixed(2);
}

export function businessExportAuditPayload(input: {
  filename: string;
  documentExport: BusinessExportResult["documentExport"];
  exportedDocumentCount: number;
  missingDocumentCount: number;
}) {
  return {
    filename: input.filename,
    documentExport: input.documentExport,
    exportedDocumentCount: input.exportedDocumentCount,
    missingDocumentCount: input.missingDocumentCount,
  };
}

export async function recordBusinessExportAudit(
  prisma: PrismaClient,
  access: BusinessAccess,
  exported: BusinessExportResult,
) {
  if (!canExportBusinessData(access.workspace.role)) {
    throw new ForbiddenError();
  }
  return writeSettingsAuditLog(prisma, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: BUSINESS_EXPORT_AUDIT_AREA,
    settingKey: BUSINESS_EXPORT_AUDIT_KEY,
    previousValue: null,
    newValue: businessExportAuditPayload(exported),
  });
}

export type BusinessExportDownloadResult =
  | {
      ok: true;
      status: 200;
      filename: string;
      contentType: "application/zip";
      body: Buffer;
    }
  | {
      ok: false;
      status: 403;
      error: "Forbidden";
    }
  | {
      ok: false;
      status: 413;
      error: string;
    };

export async function runBusinessExportDownload(
  prisma: PrismaClient,
  access: BusinessAccess,
  options?: BusinessExportOptions,
): Promise<BusinessExportDownloadResult> {
  if (!canExportBusinessData(access.workspace.role)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  try {
    const exported = await buildBusinessExportZip(prisma, access.businessId, options);
    await recordBusinessExportAudit(prisma, access, exported);
    return {
      ok: true,
      status: 200,
      filename: exported.filename,
      contentType: "application/zip",
      body: exported.bytes,
    };
  } catch (error) {
    if (error instanceof BusinessExportIncompleteError || error instanceof ZipStoreLimitError) {
      return { ok: false, status: 413, error: error.message };
    }
    throw error;
  }
}

function safeJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
