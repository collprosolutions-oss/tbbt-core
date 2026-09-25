/**
 * Tenant-scoped financial intelligence loader.
 * businessId must come from requireBusinessAccess() / requireManagementPageAccess().
 */

import type { PrismaClient } from "@prisma/client";
import { getFinanceConnectionProvider } from "@/lib/finance-connections";
import { emptyLaborBurdenConfig } from "@/lib/financial-intelligence/labor-burden";
import type { FinancialSource } from "@/lib/financial-intelligence/source";
import { asNumber, asNumberOrNull, type ReportSource } from "@/lib/reports";
import { loadReportSource } from "@/lib/reports-data";

let financialSourceLoadCount = 0;

export function getFinancialSourceLoadCount() {
  return financialSourceLoadCount;
}

export function resetFinancialSourceLoadCount() {
  financialSourceLoadCount = 0;
}

export async function loadFinancialSource(
  prisma: PrismaClient,
  businessId: string,
  options?: { reportSource?: ReportSource },
): Promise<FinancialSource> {
  financialSourceLoadCount += 1;
  const scope = { businessId } as const;
  const [
    report,
    payments,
    changeOrders,
    approvedVersions,
    estimateLines,
    burden,
    patterns,
  ] = await Promise.all([
    options?.reportSource
      ? Promise.resolve(options.reportSource)
      : loadReportSource(prisma, businessId),
    prisma.payment.findMany({
      where: scope,
      select: {
        id: true,
        businessId: true,
        customerId: true,
        jobId: true,
        invoiceId: true,
        purpose: true,
        amount: true,
        method: true,
        receivedAt: true,
      },
    }),
    prisma.changeOrder.findMany({
      where: scope,
      select: { id: true, jobId: true, status: true, total: true, approvedAt: true },
    }),
    prisma.estimateVersion.findMany({
      where: { ...scope, approvedAt: { not: null } },
      select: {
        estimateId: true,
        lineItems: { select: { type: true, quantity: true, total: true, description: true } },
      },
    }),
    prisma.lineItem.findMany({
      where: { ...scope, estimateId: { not: null } },
      select: { estimateId: true, type: true, quantity: true, total: true, description: true },
    }),
    prisma.businessLaborBurdenSetting.findUnique({
      where: { businessId },
      select: { burdenRate: true, targetGrossMarginRate: true, notes: true },
    }),
    prisma.recurringExpensePattern.findMany({
      where: scope,
    }),
  ]);

  const approvedLineByEstimate = new Map<string, FinancialSource["estimateLines"]>();
  for (const version of approvedVersions) {
    approvedLineByEstimate.set(
      version.estimateId,
      version.lineItems.map((line) => ({
        estimateId: version.estimateId,
        type: line.type,
        quantity: asNumber(line.quantity),
        total: asNumber(line.total),
        description: line.description,
        fromApprovedVersion: true,
      })),
    );
  }

  const liveLines: FinancialSource["estimateLines"] = estimateLines.map((line) => ({
    estimateId: line.estimateId as string,
    type: line.type,
    quantity: asNumber(line.quantity),
    total: asNumber(line.total),
    description: line.description,
    fromApprovedVersion: false,
  }));

  const estimateLinesMerged = [
    ...[...approvedLineByEstimate.values()].flat(),
    ...liveLines.filter((line) => !approvedLineByEstimate.has(line.estimateId)),
  ];

  return {
    ...report,
    payments: payments.map((payment) => ({
      ...payment,
      amount: asNumber(payment.amount),
    })),
    changeOrders: changeOrders.map((order) => ({
      ...order,
      total: asNumber(order.total),
    })),
    estimateLines: estimateLinesMerged,
    laborBurden: burden
      ? {
          burdenRate: asNumberOrNull(burden.burdenRate),
          targetGrossMarginRate: asNumberOrNull(burden.targetGrossMarginRate),
          notes: burden.notes,
        }
      : emptyLaborBurdenConfig(),
    financeConnections: getFinanceConnectionProvider().status(),
    recurringPatterns: patterns.map((row) => ({
      id: row.id,
      patternKey: row.patternKey,
      description: row.description,
      vendor: row.vendor,
      category: row.category,
      suggestedAmount: asNumber(row.suggestedAmount),
      occurrenceCount: row.occurrenceCount,
      firstOccurredOn: row.firstOccurredOn,
      lastOccurredOn: row.lastOccurredOn,
      ownerStatus: row.ownerStatus,
    })),
  };
}
