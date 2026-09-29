/**
 * Tenant-scoped Request source report loader.
 *
 * Every query is keyed by the authenticated workspace businessId and
 * bounded with take. Callers must obtain that id from
 * requireBusinessAccess() / requireManagementPageAccess(). MEMBER is
 * denied here even if a page-level gate is skipped.
 */

import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  buildRequestSourceProgression,
  REQUEST_SOURCE_REPORT_CHILD_TAKE,
  REQUEST_SOURCE_REPORT_REQUEST_TAKE,
  type RequestSourceProgression,
} from "@/lib/request-source-report";

export type RequestSourceReportAccess = Pick<BusinessAccess, "businessId" | "workspace">;

export type RequestSourceReportRange = {
  start: Date | null;
  end: Date | null;
};

export function requireRequestSourceReportAccess(access: RequestSourceReportAccess): void {
  if (!access.businessId) {
    throw new ForbiddenError();
  }
  requireBusinessRole(access as BusinessAccess, ["OWNER", "ADMIN"]);
}

function requestCreatedAtWhere(range?: RequestSourceReportRange) {
  if (!range?.start && !range?.end) return {};
  return {
    createdAt: {
      ...(range.start ? { gte: range.start } : {}),
      ...(range.end ? { lt: range.end } : {}),
    },
  };
}

export async function loadRequestSourceReport(
  prisma: PrismaClient,
  access: RequestSourceReportAccess,
  range?: RequestSourceReportRange,
): Promise<RequestSourceProgression> {
  requireRequestSourceReportAccess(access);
  const businessId = access.businessId;
  const scope = { businessId } as const;

  const requestRows = await prisma.serviceRequest.findMany({
    where: { ...scope, ...requestCreatedAtWhere(range) },
    select: {
      id: true,
      leadSource: true,
      originalLeadSource: true,
    },
    orderBy: { createdAt: "desc" },
    take: REQUEST_SOURCE_REPORT_REQUEST_TAKE + 1,
  });

  const truncated = requestRows.length > REQUEST_SOURCE_REPORT_REQUEST_TAKE;
  const requests = truncated
    ? requestRows.slice(0, REQUEST_SOURCE_REPORT_REQUEST_TAKE)
    : requestRows;
  const requestIds = requests.map((request) => request.id);

  const estimateRows =
    requestIds.length === 0
      ? []
      : await prisma.estimate.findMany({
          where: { ...scope, serviceRequestId: { in: requestIds } },
          select: { id: true, serviceRequestId: true },
          take: REQUEST_SOURCE_REPORT_CHILD_TAKE + 1,
        });

  const estimateTruncated = estimateRows.length > REQUEST_SOURCE_REPORT_CHILD_TAKE;
  const estimates = estimateTruncated
    ? estimateRows.slice(0, REQUEST_SOURCE_REPORT_CHILD_TAKE)
    : estimateRows;
  const estimateIds = estimates.map((estimate) => estimate.id);

  const jobRows =
    estimateIds.length === 0
      ? []
      : await prisma.job.findMany({
          where: { ...scope, estimateId: { in: estimateIds } },
          select: { id: true, estimateId: true },
          take: REQUEST_SOURCE_REPORT_CHILD_TAKE + 1,
        });

  const jobTruncated = jobRows.length > REQUEST_SOURCE_REPORT_CHILD_TAKE;
  const jobs = jobTruncated ? jobRows.slice(0, REQUEST_SOURCE_REPORT_CHILD_TAKE) : jobRows;

  return buildRequestSourceProgression({
    requests,
    estimates,
    jobs,
    truncated,
    childTruncated: estimateTruncated || jobTruncated,
  });
}
