/**
 * Founder/owner pre-launch cleanup of operational test records.
 *
 * Deletes customer/job transactional history for ONE business. Never
 * deletes tenant, catalog, website, Stripe, storage, or other production
 * configuration. Never runs from public routes or deploy.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import {
  CLEAR_TEST_DATA_CONFIRMATION,
  TEST_DATA_CLEANUP_PRESERVE,
  type TestDataCleanupPreview,
} from "@/lib/test-data-cleanup-constants";

export {
  CLEAR_TEST_DATA_CONFIRMATION,
  TEST_DATA_CLEANUP_PRESERVE,
  type TestDataCleanupCounts,
  type TestDataCleanupPreview,
} from "@/lib/test-data-cleanup-constants";

const OPERATIONAL_STORED_ASSET_CATEGORIES = [
  "CUSTOMER_PHOTO",
  "JOB_PHOTO",
  "BEFORE_PHOTO",
  "AFTER_PHOTO",
  "DOCUMENT",
  "INVOICE_ASSET",
  "ATTACHMENT",
] as const;

export class TestDataCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDataCleanupError";
  }
}

type CleanupClient = PrismaClient | Prisma.TransactionClient;

async function countOperationalStoredAssets(db: CleanupClient, businessId: string) {
  const websiteLinked = await db.publicSiteImage.findMany({
    where: { businessId, storedAssetId: { not: null } },
    select: { storedAssetId: true },
  });
  const keepIds = websiteLinked
    .map((row) => row.storedAssetId)
    .filter((id): id is string => Boolean(id));
  return db.storedAsset.count({
    where: {
      businessId,
      category: { in: [...OPERATIONAL_STORED_ASSET_CATEGORIES] },
      ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
    },
  });
}

export async function previewOperationalTestData(
  db: CleanupClient,
  businessId: string,
): Promise<TestDataCleanupPreview> {
  const [
    customers,
    properties,
    serviceRequests,
    serviceRequestItems,
    serviceRequestPhotos,
    serviceRequestMeasurements,
    estimates,
    estimateVersions,
    jobs,
    jobPhotos,
    invoices,
    payments,
    lineItems,
    changeOrders,
    additionalWorkRequests,
    jobProblemReports,
    timeEntries,
    timesheetWeeks,
    payrollRuns,
    expenses,
    pipelineOpportunities,
    reviews,
    reviewRequests,
    marketingContents,
    operationalStoredAssets,
  ] = await Promise.all([
    db.customer.count({ where: { businessId } }),
    db.property.count({ where: { businessId } }),
    db.serviceRequest.count({ where: { businessId } }),
    db.serviceRequestItem.count({ where: { businessId } }),
    db.serviceRequestPhoto.count({ where: { businessId } }),
    db.serviceRequestMeasurement.count({ where: { businessId } }),
    db.estimate.count({ where: { businessId } }),
    db.estimateVersion.count({ where: { businessId } }),
    db.job.count({ where: { businessId } }),
    db.jobPhoto.count({ where: { businessId } }),
    db.invoice.count({ where: { businessId } }),
    db.payment.count({ where: { businessId } }),
    db.lineItem.count({ where: { businessId } }),
    db.changeOrder.count({ where: { businessId } }),
    db.additionalWorkRequest.count({ where: { businessId } }),
    db.jobProblemReport.count({ where: { businessId } }),
    db.timeEntry.count({ where: { businessId } }),
    db.timesheetWeek.count({ where: { businessId } }),
    db.payrollRun.count({ where: { businessId } }),
    db.expense.count({ where: { businessId } }),
    db.pipelineOpportunity.count({ where: { businessId } }),
    db.review.count({ where: { businessId } }),
    db.reviewRequest.count({ where: { businessId } }),
    db.marketingContent.count({ where: { businessId } }),
    countOperationalStoredAssets(db, businessId),
  ]);

  return {
    businessId,
    confirmationPhrase: CLEAR_TEST_DATA_CONFIRMATION,
    willDelete: {
      customers,
      properties,
      serviceRequests,
      serviceRequestItems,
      serviceRequestPhotos,
      serviceRequestMeasurements,
      estimates,
      estimateVersions,
      jobs,
      jobPhotos,
      invoices,
      payments,
      lineItems,
      changeOrders,
      additionalWorkRequests,
      jobProblemReports,
      timeEntries,
      timesheetWeeks,
      payrollRuns,
      expenses,
      pipelineOpportunities,
      reviews,
      reviewRequests,
      marketingContents,
      operationalStoredAssets,
    },
    willPreserve: [...TEST_DATA_CLEANUP_PRESERVE],
  };
}

function storedAssetWhere(businessId: string, keepIds: string[]) {
  return {
    businessId,
    category: { in: [...OPERATIONAL_STORED_ASSET_CATEGORIES] },
    ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
  };
}

export async function executeOperationalTestDataCleanup(
  db: PrismaClient,
  input: {
    businessId: string;
    confirmation: string;
    changedByMembershipId: string;
  },
): Promise<TestDataCleanupPreview> {
  if (input.confirmation !== CLEAR_TEST_DATA_CONFIRMATION) {
    throw new TestDataCleanupError(
      `Type ${CLEAR_TEST_DATA_CONFIRMATION} to confirm this cannot be undone.`,
    );
  }

  const preview = await previewOperationalTestData(db, input.businessId);

  await db.$transaction(
    async (tx) => {
      const businessId = input.businessId;

      await tx.estimate.updateMany({
        where: { businessId },
        data: { approvedVersionId: null },
      });
      await tx.job.updateMany({
        where: { businessId },
        data: { approvedEstimateVersionId: null },
      });

      await tx.payrollRunEvent.deleteMany({ where: { businessId } });
      await tx.payrollRunItem.deleteMany({ where: { businessId } });
      await tx.payrollRun.deleteMany({ where: { businessId } });

      await tx.timeEntryAdjustment.deleteMany({ where: { businessId } });
      await tx.timeEntry.deleteMany({ where: { businessId } });
      await tx.timesheetWeek.deleteMany({ where: { businessId } });

      await tx.reviewResponse.deleteMany({ where: { businessId } });
      await tx.marketingContentPhoto.deleteMany({ where: { businessId } });
      await tx.marketingContent.deleteMany({ where: { businessId } });
      await tx.review.deleteMany({ where: { businessId } });
      await tx.reviewRequest.deleteMany({ where: { businessId } });

      await tx.payment.deleteMany({ where: { businessId } });
      await tx.lineItem.deleteMany({ where: { businessId } });
      await tx.invoice.deleteMany({ where: { businessId } });

      await tx.additionalWorkRequestItem.deleteMany({ where: { businessId } });
      await tx.additionalWorkRequest.deleteMany({ where: { businessId } });
      await tx.changeOrder.deleteMany({ where: { businessId } });
      await tx.jobProblemReport.deleteMany({ where: { businessId } });
      await tx.jobPhoto.deleteMany({ where: { businessId } });
      await tx.expense.deleteMany({ where: { businessId } });
      await tx.job.deleteMany({ where: { businessId } });

      await tx.estimateVersionLineItem.deleteMany({ where: { businessId } });
      await tx.estimateVersion.deleteMany({ where: { businessId } });
      await tx.pipelineOpportunity.deleteMany({ where: { businessId } });
      await tx.estimate.deleteMany({ where: { businessId } });

      await tx.serviceRequestMeasurement.deleteMany({ where: { businessId } });
      await tx.serviceRequestPhoto.deleteMany({ where: { businessId } });
      await tx.serviceRequestItem.deleteMany({ where: { businessId } });
      await tx.serviceRequest.deleteMany({ where: { businessId } });
      await tx.property.deleteMany({ where: { businessId } });
      await tx.customer.deleteMany({ where: { businessId } });

      const websiteLinked = await tx.publicSiteImage.findMany({
        where: { businessId, storedAssetId: { not: null } },
        select: { storedAssetId: true },
      });
      const keepIds = websiteLinked
        .map((row) => row.storedAssetId)
        .filter((id): id is string => Boolean(id));
      await tx.storedAsset.deleteMany({
        where: storedAssetWhere(businessId, keepIds),
      });

      await writeSettingsAuditLog(tx, {
        businessId,
        changedByMembershipId: input.changedByMembershipId,
        settingArea: "data-export",
        settingKey: "clear_test_data",
        previousValue: preview.willDelete,
        newValue: { confirmed: true },
      });
    },
    { timeout: 60_000 },
  );

  return preview;
}

export function testDataCleanupErrorMessage(error: unknown, fallback: string) {
  if (error instanceof TestDataCleanupError) {
    return error.message;
  }
  return fallback;
}
