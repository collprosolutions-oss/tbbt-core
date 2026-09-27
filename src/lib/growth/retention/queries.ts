import type { Prisma, PrismaClient } from "@prisma/client";

type RetentionDb = PrismaClient | Prisma.TransactionClient;

/**
 * Exact same-business absence: a ReviewRequest row for this job in this
 * business. A foreign-tenant row with the same jobId does not count.
 */
export async function hasSameBusinessReviewRequestForJob(
  db: RetentionDb,
  businessId: string,
  jobId: string,
): Promise<boolean> {
  const row = await db.reviewRequest.findFirst({
    where: { businessId, jobId },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Exact same-business absence: a ReferralRequest row for this job in this
 * business. Foreign-tenant rows do not count.
 */
export async function hasSameBusinessReferralRequestForJob(
  db: RetentionDb,
  businessId: string,
  jobId: string,
): Promise<boolean> {
  const row = await db.referralRequest.findFirst({
    where: { businessId, jobId },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Exact same-business later-job proof. A later Job on another business
 * does not change local truth, even if it reuses the same customerId.
 */
export async function hasLaterSameBusinessJob(
  db: RetentionDb,
  businessId: string,
  customerId: string,
  afterCreatedAt: Date,
  excludeJobId: string,
): Promise<boolean> {
  const row = await db.job.findFirst({
    where: {
      businessId,
      customerId,
      id: { not: excludeJobId },
      createdAt: { gt: afterCreatedAt },
    },
    select: { id: true },
  });
  return Boolean(row);
}

export async function resolveOwnedRetentionCustomer(
  db: RetentionDb,
  businessId: string,
  customerId: string,
): Promise<{ id: string; name: string; businessId: string } | null> {
  const row = await db.customer.findFirst({
    where: { id: customerId, businessId },
    select: { id: true, name: true, businessId: true },
  });
  return row;
}

export async function countCompletedJobsForCustomer(
  db: RetentionDb,
  businessId: string,
  customerId: string,
): Promise<number> {
  return db.job.count({
    where: { businessId, customerId, status: "COMPLETED" },
  });
}

export async function findLastCompletedJobForCustomer(
  db: RetentionDb,
  businessId: string,
  customerId: string,
) {
  return db.job.findFirst({
    where: { businessId, customerId, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      createdAt: true,
      updatedAt: true,
      status: true,
    },
  });
}
