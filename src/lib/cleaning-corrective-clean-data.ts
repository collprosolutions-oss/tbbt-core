/**
 * Read model for the OWNER corrective-clean review after RE_CLEAN_REQUESTED.
 * Mutation-free: never creates jobs, invoices, charges, or messages.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { formatAddress } from "@/lib/format";
import { lineItemTitle } from "@/lib/estimate-line-scope";
import {
  cleaningCorrectiveCleanEligible,
  hasSelectedServiceScope,
  resolveCleaningJobTradeCode,
  visitRequestedReClean,
  type CorrectiveCleanScopeLine,
} from "@/lib/cleaning-corrective-clean";
import { visitOutcomeLabel } from "@/lib/cleaning-visit-workflow";

type Db = PrismaClient | Prisma.TransactionClient;

export type CleaningCorrectiveCleanReview = {
  eligible: boolean;
  jobId: string;
  visitOutcomeStatus: string;
  visitOutcomeLabel: string;
  customer: { id: string; name: string } | null;
  property: { id: string; addressSummary: string } | null;
  scopeLines: CorrectiveCleanScopeLine[];
  estimateId: string | null;
  approvedEstimateVersionId: string | null;
  hasSelectedScope: boolean;
  existingCorrectiveClean: { id: string; scheduledAt: Date | null; status: string } | null;
  canCreate: boolean;
};

export async function loadCleaningCorrectiveCleanReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<CleaningCorrectiveCleanReview | null> {
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
      approvedEstimateOptionId: true,
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
              optionId: true,
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
            select: { description: true, quantity: true, optionId: true },
          },
        },
      },
      crewVisit: { select: { businessId: true, outcomeStatus: true } },
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
  if (!cleaningCorrectiveCleanEligible(tradeCode)) {
    return null;
  }

  const visit = job.crewVisit && job.crewVisit.businessId === access.businessId ? job.crewVisit : null;
  if (!visitRequestedReClean(visit?.outcomeStatus)) {
    return null;
  }

  const optionId = job.approvedEstimateOptionId ?? null;
  const versionLines =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === access.businessId
      ? job.approvedEstimateVersion.lineItems
      : [];
  const estimateLines =
    versionLines.length === 0 && job.estimate && job.estimate.businessId === access.businessId
      ? job.estimate.lineItems
      : [];
  const scopeSource = (versionLines.length > 0 ? versionLines : estimateLines).filter(
    (line) => !optionId || line.optionId === optionId,
  );
  const scopeLines: CorrectiveCleanScopeLine[] = scopeSource.map((line) => ({
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

  const existingCorrectiveClean = await db.job.findFirst({
    where: { businessId: access.businessId, correctiveCleanSourceJobId: job.id },
    select: { id: true, scheduledAt: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  const approvedEstimateVersionId =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === access.businessId
      ? job.approvedEstimateVersion.id
      : null;
  const estimateId =
    job.estimate && job.estimate.businessId === access.businessId ? job.estimate.id : null;

  const hasSelectedScope = hasSelectedServiceScope({
    approvedEstimateVersionId,
    estimateId,
    scopeLineCount: scopeLines.length,
  });

  return {
    eligible: true,
    jobId: job.id,
    visitOutcomeStatus: visit?.outcomeStatus ?? "RE_CLEAN_REQUESTED",
    visitOutcomeLabel: visitOutcomeLabel(visit?.outcomeStatus ?? "RE_CLEAN_REQUESTED"),
    customer,
    property,
    scopeLines,
    estimateId,
    approvedEstimateVersionId,
    hasSelectedScope,
    existingCorrectiveClean,
    canCreate:
      access.workspace.role === "OWNER" &&
      !existingCorrectiveClean &&
      Boolean(customer && property && hasSelectedScope),
  };
}
