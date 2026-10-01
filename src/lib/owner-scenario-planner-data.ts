/**
 * Bounded, tenant-scoped loader for the OWNER scenario planner.
 * businessId must come from requireManagementPageAccess().
 * Read-only: no invoice, payment, expense, time, price, or assumption-set writes.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ACTIVE_EXPENSE_WHERE } from "@/lib/expenses";
import { asNumber, asNumberOrNull } from "@/lib/reports";
import {
  ASSUMPTION_SET_NOT_FOUND_MESSAGE,
  COMPARE_NEEDS_TWO_SETS_MESSAGE,
  PLANNER_READ_BOUND,
  PLANNER_SET_READ_BOUND,
  assertCanReadOwnerScenarioPlanner,
  assumptionsFromSavedSet,
  buildOwnerScenarioComparison,
  buildOwnerScenarioPlan,
  hasPlannerKnobParams,
  isolateSameBusinessAssumptionSets,
  parseOwnerScenarioAssumptions,
  toSavedOwnerScenarioAssumptionSet,
  trimPlannerId,
  type OwnerScenarioAssumptions,
  type OwnerScenarioComparison,
  type OwnerScenarioPlan,
  type OwnerScenarioPlannerQuery,
  type PlannerRecordSource,
  type SavedOwnerScenarioAssumptionSet,
} from "@/lib/owner-scenario-planner";

export type OwnerScenarioPlannerWorkspaceData = {
  plan: OwnerScenarioPlan;
  savedSets: SavedOwnerScenarioAssumptionSet[];
  setsTruncated: boolean;
  setsAvailable: boolean;
  openedSet: SavedOwnerScenarioAssumptionSet | null;
  comparison: OwnerScenarioComparison | null;
  comparisonError: string | null;
};

function missingAssumptionSetSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /OwnerScenarioAssumptionSet|ownerScenarioAssumptionSet|does not exist/i.test(message)
  );
}

function hitBound(count: number): boolean {
  return count >= PLANNER_READ_BOUND;
}

export async function loadOwnerScenarioPlannerSource(
  prisma: PrismaClient,
  access: BusinessAccess,
): Promise<{ source: PlannerRecordSource; readsTruncated: boolean }> {
  assertCanReadOwnerScenarioPlanner(access);
  const businessId = access.businessId;
  const scope = { businessId } as const;

  const [jobs, invoices, payments, invoiceCredits, expenses, timeEntries, customers, estimates, changeOrders] =
    await Promise.all([
      prisma.job.findMany({
        where: scope,
        select: {
          id: true,
          businessId: true,
          status: true,
          createdAt: true,
          customerId: true,
          estimateId: true,
          scheduledDurationMinutes: true,
        },
        take: PLANNER_READ_BOUND,
        orderBy: { createdAt: "desc" },
      }),
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
          kind: true,
        },
        take: PLANNER_READ_BOUND,
        orderBy: { createdAt: "desc" },
      }),
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
        take: PLANNER_READ_BOUND,
        orderBy: { receivedAt: "desc" },
      }),
      prisma.invoiceCredit.findMany({
        where: scope,
        select: { id: true, invoiceId: true, amount: true },
        take: PLANNER_READ_BOUND,
        orderBy: { createdAt: "desc" },
      }),
      prisma.expense.findMany({
        where: { ...scope, ...ACTIVE_EXPENSE_WHERE },
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
        take: PLANNER_READ_BOUND,
        orderBy: { occurredOn: "desc" },
      }),
      prisma.timeEntry.findMany({
        where: { ...scope, status: "APPROVED" },
        select: {
          id: true,
          businessId: true,
          membershipId: true,
          jobId: true,
          activityType: true,
          startedAt: true,
          approvedHours: true,
          approvedLaborCost: true,
        },
        take: PLANNER_READ_BOUND,
        orderBy: { startedAt: "desc" },
      }),
      prisma.customer.findMany({
        where: scope,
        select: { id: true, businessId: true, name: true, createdAt: true },
        take: PLANNER_READ_BOUND,
        orderBy: { createdAt: "desc" },
      }),
      prisma.estimate.findMany({
        where: scope,
        select: {
          id: true,
          businessId: true,
          status: true,
          total: true,
          createdAt: true,
          customerId: true,
          serviceRequestId: true,
        },
        take: PLANNER_READ_BOUND,
        orderBy: { createdAt: "desc" },
      }),
      prisma.changeOrder.findMany({
        where: scope,
        select: { id: true, jobId: true, status: true, total: true, approvedAt: true },
        take: PLANNER_READ_BOUND,
        orderBy: { createdAt: "desc" },
      }),
    ]);

  const estimateIds = estimates.map((estimate) => estimate.id);
  const estimateLines =
    estimateIds.length === 0
      ? []
      : await prisma.lineItem.findMany({
          where: { businessId, estimateId: { in: estimateIds } },
          select: { estimateId: true, type: true, quantity: true, total: true, description: true },
          take: PLANNER_READ_BOUND,
        });

  const readsTruncated =
    hitBound(jobs.length) ||
    hitBound(invoices.length) ||
    hitBound(payments.length) ||
    hitBound(expenses.length) ||
    hitBound(timeEntries.length) ||
    hitBound(customers.length) ||
    hitBound(estimates.length) ||
    hitBound(changeOrders.length) ||
    hitBound(estimateLines.length);

  return {
    readsTruncated,
    source: {
      businessId,
      jobs,
      invoices: invoices.map((invoice) => ({
        ...invoice,
        total: asNumber(invoice.total),
      })),
      payments: payments.map((payment) => ({
        ...payment,
        amount: asNumber(payment.amount),
      })),
      invoiceCredits: invoiceCredits.map((credit) => ({
        id: credit.id,
        invoiceId: credit.invoiceId,
        amount: asNumber(credit.amount),
      })),
      expenses: expenses.map((expense) => ({
        ...expense,
        amount: asNumber(expense.amount),
      })),
      approvedTimeEntries: timeEntries.map((entry) => ({
        ...entry,
        approvedHours: asNumberOrNull(entry.approvedHours),
        approvedLaborCost: asNumberOrNull(entry.approvedLaborCost),
      })),
      customers,
      estimates: estimates.map((estimate) => ({
        ...estimate,
        total: asNumber(estimate.total),
      })),
      estimateLines: estimateLines.map((line) => ({
        estimateId: line.estimateId as string,
        type: line.type,
        quantity: asNumber(line.quantity),
        total: asNumber(line.total),
        description: line.description,
        fromApprovedVersion: false,
      })),
      changeOrders: changeOrders.map((order) => ({
        ...order,
        total: asNumber(order.total),
      })),
    },
  };
}

export async function loadOwnerScenarioPlan(
  prisma: PrismaClient,
  access: BusinessAccess,
  assumptions: OwnerScenarioAssumptions,
): Promise<OwnerScenarioPlan> {
  const { source, readsTruncated } = await loadOwnerScenarioPlannerSource(prisma, access);
  return buildOwnerScenarioPlan(source, assumptions, { readsTruncated });
}

export async function listOwnerScenarioAssumptionSets(
  prisma: PrismaClient,
  access: BusinessAccess,
): Promise<{ sets: SavedOwnerScenarioAssumptionSet[]; truncated: boolean; available: boolean }> {
  assertCanReadOwnerScenarioPlanner(access);
  try {
    const rows = await prisma.ownerScenarioAssumptionSet.findMany({
      where: { businessId: access.businessId },
      take: PLANNER_SET_READ_BOUND,
      orderBy: { updatedAt: "desc" },
    });
    const isolated = isolateSameBusinessAssumptionSets(rows, access.businessId).map(
      toSavedOwnerScenarioAssumptionSet,
    );
    return {
      sets: isolated,
      truncated: rows.length >= PLANNER_SET_READ_BOUND,
      available: true,
    };
  } catch (error) {
    if (missingAssumptionSetSchema(error)) {
      return { sets: [], truncated: false, available: false };
    }
    throw error;
  }
}

export async function loadOwnerScenarioAssumptionSet(
  prisma: PrismaClient,
  access: BusinessAccess,
  setId: string,
): Promise<SavedOwnerScenarioAssumptionSet | null> {
  assertCanReadOwnerScenarioPlanner(access);
  const id = trimPlannerId(setId);
  if (!id) return null;
  try {
    const row = await prisma.ownerScenarioAssumptionSet.findFirst({
      where: { id, businessId: access.businessId },
    });
    if (!row || row.businessId !== access.businessId) return null;
    return toSavedOwnerScenarioAssumptionSet(row);
  } catch (error) {
    if (missingAssumptionSetSchema(error)) return null;
    throw error;
  }
}

export async function loadOwnerScenarioPlannerWorkspace(
  prisma: PrismaClient,
  access: BusinessAccess,
  query: OwnerScenarioPlannerQuery,
): Promise<OwnerScenarioPlannerWorkspaceData> {
  assertCanReadOwnerScenarioPlanner(access);
  const [{ source, readsTruncated }, listed] = await Promise.all([
    loadOwnerScenarioPlannerSource(prisma, access),
    listOwnerScenarioAssumptionSets(prisma, access),
  ]);

  const setId = trimPlannerId(query.set);
  const leftId = trimPlannerId(query.left);
  const rightId = trimPlannerId(query.right);
  const openedSet = setId ? await loadOwnerScenarioAssumptionSet(prisma, access, setId) : null;

  let assumptions = parseOwnerScenarioAssumptions(query);
  if (openedSet && !hasPlannerKnobParams(query)) {
    assumptions = assumptionsFromSavedSet(openedSet);
  }

  const plan = buildOwnerScenarioPlan(source, assumptions, { readsTruncated });

  let comparison: OwnerScenarioComparison | null = null;
  let comparisonError: string | null = null;
  if (leftId || rightId) {
    if (!leftId || !rightId) {
      comparisonError = COMPARE_NEEDS_TWO_SETS_MESSAGE;
    } else {
      const [leftSet, rightSet] = await Promise.all([
        loadOwnerScenarioAssumptionSet(prisma, access, leftId),
        loadOwnerScenarioAssumptionSet(prisma, access, rightId),
      ]);
      if (!leftSet || !rightSet) {
        comparisonError = ASSUMPTION_SET_NOT_FOUND_MESSAGE;
      } else {
        comparison = buildOwnerScenarioComparison(source, leftSet, rightSet, { readsTruncated });
        if (!comparison) comparisonError = ASSUMPTION_SET_NOT_FOUND_MESSAGE;
      }
    }
  }

  return {
    plan,
    savedSets: listed.sets,
    setsTruncated: listed.truncated,
    setsAvailable: listed.available,
    openedSet,
    comparison,
    comparisonError,
  };
}
