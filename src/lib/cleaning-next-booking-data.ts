/**
 * Read model for the OWNER next-booking review on a completed Cleaning job.
 * Mutation-free: never creates jobs, invoices, or messages.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { formatAddress } from "@/lib/format";
import { lineItemTitle } from "@/lib/estimate-line-scope";
import {
  cleaningNextBookingEligible,
  hasSelectedServiceScope,
  resolveCleaningJobTradeCode,
  type NextBookingScopeLine,
} from "@/lib/cleaning-next-booking";

type Db = PrismaClient | Prisma.TransactionClient;

export type CleaningNextBookingReview = {
  eligible: boolean;
  jobId: string;
  completed: boolean;
  customer: { id: string; name: string } | null;
  property: { id: string; addressSummary: string } | null;
  scopeLines: NextBookingScopeLine[];
  estimateId: string | null;
  approvedEstimateVersionId: string | null;
  hasSelectedScope: boolean;
  existingNextBooking: { id: string; scheduledAt: Date | null; status: string } | null;
  canCreate: boolean;
};

export async function loadCleaningNextBookingReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<CleaningNextBookingReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      status: true,
      customerId: true,
      propertyId: true,
      estimateId: true,
      approvedEstimateVersionId: true,
      customer: { select: { id: true, businessId: true, name: true } },
      property: {
        select: {
          id: true,
          businessId: true,
          customerId: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      estimate: {
        select: {
          id: true,
          businessId: true,
          serviceRequest: { select: { tradeCode: true } },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: {
              description: true,
              quantity: true,
              serviceCatalogItem: { select: { tradeCode: true } },
            },
          },
        },
      },
      approvedEstimateVersion: {
        select: {
          id: true,
          businessId: true,
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: { description: true, quantity: true },
          },
        },
      },
    },
  });
  if (!job) return null;
  access.assertOwned(job);

  const tradeCode = resolveCleaningJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningNextBookingEligible(tradeCode)) {
    return null;
  }

  const versionLines =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === access.businessId
      ? job.approvedEstimateVersion.lineItems
      : [];
  const estimateLines =
    versionLines.length === 0 && job.estimate && job.estimate.businessId === access.businessId
      ? job.estimate.lineItems
      : [];
  const scopeSource = versionLines.length > 0 ? versionLines : estimateLines;
  const scopeLines: NextBookingScopeLine[] = scopeSource.map((line) => ({
    title: lineItemTitle(line.description),
    quantity: line.quantity.toString(),
  }));

  const customer =
    job.customer && job.customer.businessId === access.businessId && job.customerId === job.customer.id
      ? { id: job.customer.id, name: job.customer.name }
      : null;
  const property =
    job.property &&
    job.property.businessId === access.businessId &&
    customer &&
    job.property.customerId === customer.id &&
    job.propertyId === job.property.id
      ? { id: job.property.id, addressSummary: formatAddress(job.property) }
      : null;

  const existingNextBooking = await db.job.findFirst({
    where: { businessId: access.businessId, recurrenceSourceJobId: job.id },
    select: { id: true, scheduledAt: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  const approvedEstimateVersionId =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === access.businessId
      ? job.approvedEstimateVersion.id
      : null;
  const estimateId =
    job.estimate && job.estimate.businessId === access.businessId ? job.estimate.id : null;

  const completed = job.status === "COMPLETED";
  const hasSelectedScope = hasSelectedServiceScope({
    approvedEstimateVersionId,
    estimateId,
    scopeLineCount: scopeLines.length,
  });

  return {
    eligible: true,
    jobId: job.id,
    completed,
    customer,
    property,
    scopeLines,
    estimateId,
    approvedEstimateVersionId,
    hasSelectedScope,
    existingNextBooking,
    canCreate:
      access.workspace.role === "OWNER" &&
      completed &&
      !existingNextBooking &&
      Boolean(customer && property && hasSelectedScope),
  };
}
