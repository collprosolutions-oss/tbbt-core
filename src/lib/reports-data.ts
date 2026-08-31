/**
 * Tenant-scoped Reports loader. Every query is keyed by the
 * authenticated workspace businessId passed in -- never a client-supplied
 * business id. Callers must obtain that id from requireBusinessAccess() /
 * requireManagementPageAccess().
 */

import type { PrismaClient } from "@prisma/client";
import { asNumber, asNumberOrNull, type ReportSource } from "@/lib/reports";

export async function loadReportSource(
  prisma: PrismaClient,
  businessId: string,
): Promise<ReportSource> {
  const scope = { businessId } as const;

  const [
    invoices,
    customers,
    jobs,
    estimates,
    serviceRequests,
    catalogItems,
    estimateLineItems,
    approvedTimeEntries,
    payrollRuns,
    memberships,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: scope,
      select: {
        id: true,
        businessId: true,
        status: true,
        total: true,
        paidAt: true,
        createdAt: true,
        customerId: true,
        jobId: true,
        paymentMethod: true,
        paymentReference: true,
      },
    }),
    prisma.customer.findMany({
      where: scope,
      select: { id: true, name: true, createdAt: true },
    }),
    prisma.job.findMany({
      where: scope,
      select: { id: true, status: true, createdAt: true, customerId: true, estimateId: true },
    }),
    prisma.estimate.findMany({
      where: scope,
      select: {
        id: true,
        status: true,
        total: true,
        createdAt: true,
        customerId: true,
        serviceRequestId: true,
      },
    }),
    prisma.serviceRequest.findMany({
      where: scope,
      select: { id: true, serviceCatalogItemId: true, createdAt: true, status: true },
    }),
    prisma.serviceCatalogItem.findMany({
      where: scope,
      select: { id: true, name: true },
    }),
    prisma.lineItem.findMany({
      where: { ...scope, estimateId: { not: null } },
      select: { estimateId: true, serviceCatalogItemId: true, total: true },
    }),
    prisma.timeEntry.findMany({
      where: { ...scope, status: "APPROVED" },
      select: {
        id: true,
        membershipId: true,
        jobId: true,
        activityType: true,
        startedAt: true,
        approvedHours: true,
        approvedLaborCost: true,
      },
    }),
    prisma.payrollRun.findMany({
      where: { ...scope, status: { in: ["AUTHORIZED", "PROCESSED"] } },
      select: {
        id: true,
        status: true,
        payPeriodStart: true,
        payPeriodEnd: true,
        authorizedApprovedHours: true,
        authorizedGrossLaborAmount: true,
        authorizedWorkerCount: true,
        authorizedAt: true,
        processedAt: true,
      },
    }),
    prisma.membership.findMany({
      where: scope,
      select: { id: true, role: true, active: true, user: { select: { name: true } } },
    }),
  ]);

  return {
    businessId,
    invoices: invoices.map((invoice) => ({
      ...invoice,
      total: asNumber(invoice.total),
    })),
    customers,
    jobs,
    estimates: estimates.map((estimate) => ({
      ...estimate,
      total: asNumber(estimate.total),
    })),
    serviceRequests,
    catalogItems,
    estimateLineItems: estimateLineItems.map((item) => ({
      estimateId: item.estimateId as string,
      serviceCatalogItemId: item.serviceCatalogItemId,
      total: asNumber(item.total),
    })),
    approvedTimeEntries: approvedTimeEntries.map((entry) => ({
      ...entry,
      approvedHours: asNumberOrNull(entry.approvedHours),
      approvedLaborCost: asNumberOrNull(entry.approvedLaborCost),
    })),
    payrollRuns: payrollRuns.map((run) => ({
      ...run,
      authorizedApprovedHours: asNumberOrNull(run.authorizedApprovedHours),
      authorizedGrossLaborAmount: asNumberOrNull(run.authorizedGrossLaborAmount),
    })),
    memberships: memberships.map((membership) => ({
      id: membership.id,
      role: membership.role,
      active: membership.active,
      userName: membership.user.name,
    })),
  };
}
