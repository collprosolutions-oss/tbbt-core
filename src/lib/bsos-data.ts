/**
 * Tenant-scoped BSOS loader. Every query uses the workspace businessId.
 */

import type { PrismaClient } from "@prisma/client";
import { addDays, startOfDay } from "@/lib/schedule";
import {
  buildBsosHealthMetrics,
  coachSummary,
  type BsosFacts,
} from "@/lib/bsos";
import {
  EMPTY_FINANCIAL_SNAPSHOT,
  shouldInjectFinancialLoadFailure,
  type FinancialTurnSnapshot,
} from "@/lib/chief-of-staff/financial-snapshot";
import { buildFinancialIntelligence } from "@/lib/financial-intelligence";
import { loadFinancialSource } from "@/lib/financial-intelligence-data";
import { invoiceBalanceDue } from "@/lib/financial-intelligence/collected-revenue";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { hasProductCapability } from "@/lib/product-entitlements";
import { asNumber, buildReport, percentChange, resolveReportRange } from "@/lib/reports";
import { listCompletedUnbilledJobs } from "@/lib/revenue-integrity";
import { loadReportSource } from "@/lib/reports-data";
import { isPaidActivity } from "@/lib/time-cards";
import { partitionRecommendations } from "@/lib/bsos-actions";
import { mergeCatalogRecommendations } from "@/lib/chief-of-staff/recommendations";
import { loadWorkforceSnapshot } from "@/lib/workforce-data";
import { aiConnectionLabel, isAiProviderConnected } from "@/lib/ai/config";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import { publicTradeProjection } from "@/lib/trade-config";
import { loadGrowthSource } from "@/lib/growth-data";
import { buildReactivationCandidates, buildRecoveryQueue } from "@/lib/growth-engine";

export type BsosFactsBundle = {
  facts: BsosFacts;
  financial: FinancialTurnSnapshot;
};

export async function loadBsosFacts(
  prisma: PrismaClient,
  businessId: string,
  now: Date = new Date(),
): Promise<BsosFacts> {
  return (await loadBsosFactsBundle(prisma, businessId, now)).facts;
}

export async function loadBsosFactsBundle(
  prisma: PrismaClient,
  businessId: string,
  now: Date = new Date(),
): Promise<BsosFactsBundle> {
  const scope = { businessId } as const;
  const today = startOfDay(now);
  const weekEnd = addDays(today, 7);

  const [
    unpaid,
    sentEstimates,
    draftEstimates,
    unscheduledJobs,
    completedJobs,
    reviewRequests,
    marketingContents,
    approvedTime,
    memberships,
    scheduledJobs,
    settings,
    paidInvoices,
    expenses,
    reportSource,
    outsideArea,
    customers,
    jobs,
    invoices,
    growthSource,
    launchSteps,
    knowledgeUnreviewed,
    experienceCandidates,
    launchGoals,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...scope, status: "SENT" },
      select: { id: true, total: true },
    }),
    prisma.estimate.count({ where: { ...scope, status: "SENT" } }),
    prisma.estimate.count({ where: { ...scope, status: "DRAFT" } }),
    prisma.job.count({ where: { ...scope, status: "UNSCHEDULED" } }),
    prisma.job.findMany({
      where: { ...scope, status: "COMPLETED" },
      select: {
        id: true,
        photos: { select: { marketingPermissionStatus: true } },
      },
    }),
    prisma.reviewRequest.findMany({
      where: { ...scope, status: { in: ["DRAFT", "READY", "FAILED", "SENT", "COMPLETED"] } },
      select: { jobId: true },
    }),
    prisma.marketingContent.findMany({
      where: { ...scope, status: "APPROVED" },
      select: { jobId: true },
    }),
    prisma.timeEntry.findMany({
      where: { ...scope, status: "APPROVED" },
      select: { activityType: true, approvedLaborCost: true },
    }),
    prisma.membership.findMany({
      where: { ...scope, active: true },
      select: { hourlyWage: true },
    }),
    prisma.job.findMany({
      where: {
        ...scope,
        scheduledAt: { gte: today, lt: weekEnd },
      },
      select: { scheduledAt: true },
    }),
    prisma.businessSettings.findUnique({
      where: { businessId },
      select: { workingWeekdays: true },
    }),
    prisma.invoice.aggregate({
      where: { ...scope, status: "PAID" },
      _sum: { total: true },
    }),
    prisma.expense.aggregate({
      where: { ...scope, voidedAt: null },
      _sum: { amount: true },
    }),
    loadReportSource(prisma, businessId),
    prisma.serviceRequest.count({
      where: { ...scope, serviceAreaQualification: "OUTSIDE_PREFERRED" },
    }),
    prisma.customer.findMany({
      where: scope,
      select: { id: true },
    }),
    prisma.job.findMany({
      where: scope,
      select: { customerId: true, status: true },
    }),
    prisma.invoice.findMany({
      where: { ...scope, status: "PAID" },
      select: { customerId: true },
    }),
    loadGrowthSource(prisma, businessId, now),
    prisma.businessLaunchStep.count({
      where: { ...scope, status: { in: ["PENDING", "DEFERRED"] } },
    }),
    prisma.knowledgeEntry.count({
      where: { ...scope, archived: false, approvalState: "UNREVIEWED" },
    }),
    prisma.experienceLearningCandidate.count({
      where: { ...scope, status: { in: ["CANDIDATE", "REVIEWED"] } },
    }),
    prisma.businessGoal.count({
      where: { ...scope, status: "ACTIVE", recommendationKey: { in: ["launch-goal", "launch-ai-goal"] } },
    }),
  ]);

  const reviewJobIds = new Set(reviewRequests.map((row) => row.jobId).filter(Boolean));
  const marketedJobIds = new Set(marketingContents.map((row) => row.jobId).filter(Boolean));
  const completedJobsWithoutReview = completedJobs.filter((job) => !reviewJobIds.has(job.id)).length;
  const completedJobsReadyForMarketing = completedJobs.filter((job) => {
    const approved = job.photos.some((photo) => photo.marketingPermissionStatus === "APPROVED");
    return approved && !marketedJobIds.has(job.id);
  }).length;

  const missingWageEntries = approvedTime.filter(
    (entry) => isPaidActivity(entry.activityType) && entry.approvedLaborCost == null,
  ).length;

  const working = new Set(
    (settings?.workingWeekdays ?? "1,2,3,4,5")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value)),
  );
  const scheduledDays = new Set(
    scheduledJobs
      .map((job) => (job.scheduledAt ? startOfDay(job.scheduledAt).toISOString() : null))
      .filter(Boolean),
  );
  let availableCapacityDays = 0;
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(today, i);
    if (!working.has(day.getDay())) continue;
    if (!scheduledDays.has(startOfDay(day).toISOString())) availableCapacityDays += 1;
  }

  const completedByCustomer = new Map<string, number>();
  for (const job of jobs) {
    if (job.status !== "COMPLETED" || !job.customerId) continue;
    completedByCustomer.set(job.customerId, (completedByCustomer.get(job.customerId) ?? 0) + 1);
  }
  const paidByCustomer = new Map<string, number>();
  for (const invoice of invoices) {
    if (!invoice.customerId) continue;
    paidByCustomer.set(invoice.customerId, (paidByCustomer.get(invoice.customerId) ?? 0) + 1);
  }
  const repeatCustomers = customers.filter((customer) => {
    return (completedByCustomer.get(customer.id) ?? 0) > 1 || (paidByCustomer.get(customer.id) ?? 0) > 1;
  }).length;

  const payments = await prisma.payment.findMany({
    where: scope,
    select: { id: true, amount: true, invoiceId: true, jobId: true, customerId: true, receivedAt: true },
  });
  const paymentRows = payments.map((payment) => ({
    ...payment,
    amount: asNumber(payment.amount),
  }));
  const unpaidRemaining = unpaid
    .map((invoice) => invoiceBalanceDue({ id: invoice.id, total: asNumber(invoice.total) }, paymentRows))
    .filter((amount) => amount > 0);
  const hasInsights = await hasProductCapability(prisma, businessId, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);

  const baseFacts = {
    unpaidInvoices: {
      count: unpaidRemaining.length,
      amount: unpaidRemaining.reduce((sum, amount) => sum + amount, 0),
    },
    sentEstimates: { count: sentEstimates },
    draftEstimates: { count: draftEstimates },
    unscheduledJobs: { count: unscheduledJobs },
    completedJobsWithoutReview: { count: completedJobsWithoutReview },
    completedJobsReadyForMarketing: { count: completedJobsReadyForMarketing },
    lowMarginJobs: { count: 0 },
    missingWageEntries: { count: missingWageEntries + memberships.filter((row) => row.hourlyWage == null).length },
    availableCapacityDays: { count: availableCapacityDays },
    repeatCustomers: { count: repeatCustomers },
    outsideAreaRequests: { count: outsideArea },
    recurringExpenses: { count: 0, amount: 0 },
    paidRevenue: { amount: asNumber(paidInvoices._sum.total) },
    recordedExpenses: { amount: asNumber(expenses._sum.amount) },
    growthRecoveryOpen: { count: buildRecoveryQueue(growthSource).length },
    growthReactivationEligible: {
      count: buildReactivationCandidates(growthSource).filter((row) => row.anyOutreachEligible).length,
    },
    unbilledCompletedJobs: {
      count: listCompletedUnbilledJobs({
        jobs: reportSource.jobs,
        invoices: reportSource.invoices,
        changeOrders: reportSource.changeOrders ?? [],
        estimates: reportSource.estimates,
      }).length,
    },
    launchIncompleteSteps: { count: launchSteps },
    knowledgeNeedsApproval: { count: knowledgeUnreviewed },
    experienceCandidates: { count: experienceCandidates },
    launchGoals: { count: launchGoals },
  };

  if (!hasInsights) {
    return { facts: baseFacts, financial: EMPTY_FINANCIAL_SNAPSHOT };
  }

  try {
    if (shouldInjectFinancialLoadFailure()) {
      throw new Error("injected financial load failure");
    }
    const range = resolveReportRange("all", undefined, undefined, now);
    const report = buildReport({ ...reportSource, payments: paymentRows }, range);
    const financialSource = await loadFinancialSource(prisma, businessId, { reportSource });
    const intel = buildFinancialIntelligence(financialSource, report, now);
    const lowMarginJobs = intel.jobProfitability.filter(
      (job) => job.grossProfit != null && job.grossProfit < 0,
    ).length;
    const recurring = {
      count: intel.recurringExpenses.length,
      amount: intel.recurringExpenses.reduce((sum, row) => sum + row.amount, 0),
    };
    const aged = intel.receivables.rows.filter((row) => row.ageDays > 30);
    const collected = intel.cashFlow.collectedCustomerPayments;
    const topCustomer = intel.customerProfitability[0];
    return {
      facts: {
        ...baseFacts,
        paidRevenue: { amount: collected },
        lowMarginJobs: { count: lowMarginJobs },
        recurringExpenses: { count: recurring.count, amount: recurring.amount },
        collectedRevenue: { amount: collected },
        agedReceivables: {
          count: aged.length,
          amount: aged.reduce((sum, row) => sum + row.balanceDue, 0),
        },
        lowMarginServices: {
          count: intel.serviceProfitability.filter((row) => row.attributed && row.grossProfit != null && row.grossProfit < 0).length,
        },
        estimateLaborOverruns: {
          count: intel.jobProfitability.filter(
            (job) =>
              job.estimateActual.estimatedLaborHours != null &&
              job.estimateActual.estimatedLaborHoursProvenance !== "none" &&
              job.estimateActual.laborHoursVariance != null &&
              job.estimateActual.laborHoursVariance > 0,
          ).length,
        },
        expenseGrowthPercent: percentChange(report.recordedExpenses.current, report.recordedExpenses.prior ?? 0),
        customerConcentration: {
          share: topCustomer && collected > 0 ? topCustomer.collected / collected : null,
          customerName: topCustomer?.name ?? null,
        },
      },
      financial: { entitled: true, intelligence: intel, failed: false },
    };
  } catch (error) {
    return {
      facts: baseFacts,
      financial: {
        entitled: true,
        intelligence: null,
        failed: true,
        failureMessage: error instanceof Error ? error.message : "Financial Intelligence could not be loaded.",
      },
    };
  }
}

export async function loadBsosWorkspace(
  prisma: PrismaClient,
  businessId: string,
  membershipId?: string,
) {
  const [facts, goals, actionItems, recommendationStates, conversation, activeTrades, workforce] = await Promise.all([
    loadBsosFacts(prisma, businessId),
    prisma.businessGoal.findMany({
      where: { businessId },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.businessActionItem.findMany({
      where: { businessId },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.bsosRecommendationState.findMany({
      where: { businessId },
    }),
    membershipId
      ? prisma.aiConversation.findFirst({
          where: { businessId, membershipId, area: "COACH" },
          orderBy: { updatedAt: "desc" },
          include: { messages: { orderBy: { createdAt: "asc" }, take: 40 } },
        })
      : Promise.resolve(null),
    listActiveBusinessTrades(prisma, businessId),
    loadWorkforceSnapshot(prisma, businessId),
  ]);

  const recommendations = mergeCatalogRecommendations(facts, workforce.recommendations);
  const { active, history } = partitionRecommendations(recommendations, recommendationStates);
  return {
    businessId,
    facts,
    metrics: buildBsosHealthMetrics(facts),
    recommendations: active,
    recommendationHistory: history,
    recommendationStates,
    coach: coachSummary(active),
    goals,
    actionItems,
    conversation,
    aiConnected: isAiProviderConnected(),
    aiLabel: aiConnectionLabel(),
    activeTrades: activeTrades.map((row) => publicTradeProjection(row.config)),
  };
}

export type BsosWorkspace = Awaited<ReturnType<typeof loadBsosWorkspace>>;
