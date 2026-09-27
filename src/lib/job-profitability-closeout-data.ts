/**
 * Bounded, tenant-scoped loader for the Job Profitability closeout view.
 * businessId must come from requireManagementPageAccess().
 * Read-only: no invoice, payment, expense, time, or material writes.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { ACTIVE_EXPENSE_WHERE } from "@/lib/expenses";
import { emptyLaborBurdenConfig } from "@/lib/financial-intelligence";
import { asNumber, asNumberOrNull } from "@/lib/reports";
import {
  CLOSEOUT_READ_BOUND,
  assertCanReadJobProfitabilityCloseout,
  buildJobProfitabilityCloseout,
  type CloseoutMaterialItem,
  type JobProfitabilityCloseout,
} from "@/lib/job-profitability-closeout";

export async function loadJobProfitabilityCloseout(
  prisma: PrismaClient,
  access: BusinessAccess,
  jobId: string,
): Promise<JobProfitabilityCloseout | null> {
  assertCanReadJobProfitabilityCloseout(access);
  const businessId = access.businessId;
  const timeZone = resolveBusinessTimeZone(access.workspace.business);

  const job = await prisma.job.findFirst({
    where: { id: jobId, businessId },
    select: {
      id: true,
      businessId: true,
      status: true,
      customerId: true,
      estimateId: true,
      createdAt: true,
      scheduledDurationMinutes: true,
      customer: { select: { name: true } },
      approvedEstimateVersion: {
        select: {
          id: true,
          total: true,
          versionNumber: true,
          approvedAt: true,
          lineItems: {
            select: { type: true, quantity: true, total: true, description: true },
            take: CLOSEOUT_READ_BOUND,
          },
        },
      },
    },
  });
  if (!job) return null;
  access.assertOwned(job);

  const estimateId = job.estimateId;
  const [
    estimates,
    liveLines,
    invoices,
    payments,
    timeEntries,
    expenses,
    changeOrders,
    purchaseLists,
    burden,
  ] = await Promise.all([
    estimateId
      ? prisma.estimate.findMany({
          where: { id: estimateId, businessId },
          select: {
            id: true,
            businessId: true,
            status: true,
            total: true,
            createdAt: true,
            customerId: true,
            serviceRequestId: true,
          },
          take: CLOSEOUT_READ_BOUND,
        })
      : Promise.resolve([]),
    estimateId
      ? prisma.lineItem.findMany({
          where: { estimateId, businessId },
          select: { estimateId: true, type: true, quantity: true, total: true, description: true },
          take: CLOSEOUT_READ_BOUND,
        })
      : Promise.resolve([]),
    prisma.invoice.findMany({
      where: { businessId, jobId: job.id },
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
        kind: true,
      },
      take: CLOSEOUT_READ_BOUND,
      orderBy: { createdAt: "asc" },
    }),
    prisma.payment.findMany({
      where: {
        businessId,
        OR: [{ jobId: job.id }, { invoice: { is: { businessId, jobId: job.id } } }],
      },
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
      take: CLOSEOUT_READ_BOUND,
      orderBy: { receivedAt: "asc" },
    }),
    prisma.timeEntry.findMany({
      where: { businessId, jobId: job.id },
      select: {
        id: true,
        businessId: true,
        jobId: true,
        activityType: true,
        status: true,
        startedAt: true,
        approvedHours: true,
        approvedLaborCost: true,
      },
      take: CLOSEOUT_READ_BOUND,
      orderBy: { startedAt: "asc" },
    }),
    prisma.expense.findMany({
      where: { businessId, jobId: job.id, ...ACTIVE_EXPENSE_WHERE },
      select: {
        id: true,
        businessId: true,
        occurredOn: true,
        description: true,
        amount: true,
        category: true,
        vendor: true,
        jobId: true,
        recurring: true,
      },
      take: CLOSEOUT_READ_BOUND,
      orderBy: { occurredOn: "asc" },
    }),
    prisma.changeOrder.findMany({
      where: { businessId, jobId: job.id },
      select: { id: true, businessId: true, jobId: true, status: true, total: true, approvedAt: true },
      take: CLOSEOUT_READ_BOUND,
    }),
    prisma.materialPurchaseList.findMany({
      where: { businessId, jobId: job.id },
      select: {
        jobId: true,
        items: {
          select: {
            id: true,
            businessId: true,
            status: true,
            actualCost: true,
            expenseId: true,
            expense: {
              select: {
                id: true,
                businessId: true,
                jobId: true,
                amount: true,
                voidedAt: true,
                category: true,
              },
            },
          },
          take: CLOSEOUT_READ_BOUND,
        },
      },
      take: CLOSEOUT_READ_BOUND,
    }),
    prisma.businessLaborBurdenSetting.findUnique({
      where: { businessId },
      select: { burdenRate: true, targetGrossMarginRate: true, notes: true },
    }),
  ]);

  type JobCloseoutInputLines = {
    estimateId: string;
    type: string;
    quantity: number;
    total: number;
    description?: string | null;
    fromApprovedVersion: boolean;
    estimateVersionId?: string | null;
  };

  // Canonical Actual-vs-Estimate baseline is the Job's exact approved
  // EstimateVersion. Do not scan every historical approvedAt version.
  const pinnedVersion = job.approvedEstimateVersion;
  const approvedVersionLines: JobCloseoutInputLines[] =
    pinnedVersion && estimateId
      ? pinnedVersion.lineItems.map((line) => ({
          estimateId,
          type: line.type,
          quantity: asNumber(line.quantity),
          total: asNumber(line.total),
          description: line.description,
          fromApprovedVersion: true,
          estimateVersionId: pinnedVersion.id,
        }))
      : [];

  const liveMapped: JobCloseoutInputLines[] = liveLines
    .filter((line) => line.estimateId)
    .map((line) => ({
      estimateId: line.estimateId as string,
      type: line.type,
      quantity: asNumber(line.quantity),
      total: asNumber(line.total),
      description: line.description,
      fromApprovedVersion: false,
    }));

  const estimateLines = pinnedVersion ? approvedVersionLines : liveMapped;

  const materialItems: CloseoutMaterialItem[] = purchaseLists.flatMap((list) =>
    list.items.map((item) => ({
      id: item.id,
      businessId: item.businessId,
      jobId: list.jobId,
      status: item.status,
      actualCost: asNumberOrNull(item.actualCost),
      expenseId: item.expenseId,
      expense: item.expense
        ? {
            id: item.expense.id,
            businessId: item.expense.businessId,
            jobId: item.expense.jobId,
            amount: asNumber(item.expense.amount),
            voidedAt: item.expense.voidedAt,
            category: item.expense.category,
          }
        : null,
    })),
  );

  const readsTruncated =
    invoices.length >= CLOSEOUT_READ_BOUND ||
    payments.length >= CLOSEOUT_READ_BOUND ||
    timeEntries.length >= CLOSEOUT_READ_BOUND ||
    expenses.length >= CLOSEOUT_READ_BOUND ||
    materialItems.length >= CLOSEOUT_READ_BOUND ||
    liveLines.length >= CLOSEOUT_READ_BOUND;

  return buildJobProfitabilityCloseout({
    businessId,
    jobId: job.id,
    timeZone,
    job: {
      id: job.id,
      businessId: job.businessId,
      status: job.status,
      customerId: job.customerId,
      customerName: job.customer?.name ?? null,
      estimateId: job.estimateId,
      createdAt: job.createdAt,
      scheduledDurationMinutes: job.scheduledDurationMinutes,
      approvedEstimateVersionId: job.approvedEstimateVersion?.id ?? null,
      approvedEstimateVersionTotal: job.approvedEstimateVersion
        ? asNumber(job.approvedEstimateVersion.total)
        : null,
      approvedEstimateVersionNumber: job.approvedEstimateVersion?.versionNumber ?? null,
    },
    estimates: estimates.map((estimate) => ({
      ...estimate,
      total: asNumber(estimate.total),
    })),
    estimateLines,
    invoices: invoices.map((invoice) => ({
      ...invoice,
      total: asNumber(invoice.total),
    })),
    payments: payments.map((payment) => ({
      ...payment,
      amount: asNumber(payment.amount),
    })),
    timeEntries: timeEntries.map((entry) => ({
      ...entry,
      approvedHours: asNumberOrNull(entry.approvedHours),
      approvedLaborCost: asNumberOrNull(entry.approvedLaborCost),
    })),
    expenses: expenses.map((expense) => ({
      ...expense,
      amount: asNumber(expense.amount),
    })),
    materialItems,
    changeOrders: changeOrders.map((order) => ({
      ...order,
      total: asNumber(order.total),
    })),
    laborBurden: burden
      ? {
          burdenRate: asNumberOrNull(burden.burdenRate),
          targetGrossMarginRate: asNumberOrNull(burden.targetGrossMarginRate),
          notes: burden.notes,
        }
      : emptyLaborBurdenConfig(),
    readsTruncated,
  });
}
