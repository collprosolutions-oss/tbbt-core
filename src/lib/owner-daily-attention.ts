/**
 * Owner morning attention projections over existing Core records.
 *
 * Reuses AdditionalWorkRequest, ChangeOrder, JobCallback, TimeEntry,
 * material-deposit, unpaid SENT invoices, unscheduled approved Jobs, and
 * detectScheduleConflicts(). Does not invent a second dashboard, AI
 * advice, or fake metrics. Inclusion always fails closed on businessId.
 */
import { Prisma } from "@prisma/client";
import { conflictingJobHref } from "@/lib/availability";
import { JOB_CALLBACK_OPEN_STATUSES, recordedCallbackStatusLabel } from "@/lib/job-callback";
import { formatMoney, formatTime } from "@/lib/format";
import { unpaidMaterialDepositWarning } from "@/lib/project-payments";
import { resolveMaterialDeposit } from "@/lib/material-deposit";
import { requestedWorkLabels, requestedWorkSummary } from "@/lib/service-request-work";
import {
  isTimeActivityType,
  TIME_ACTIVITY_LABELS,
} from "@/lib/time-cards";
import type { ScheduleConflict } from "@/lib/workforce-conflicts";

export const OWNER_DAILY_ATTENTION_TAKE = 25;

export const OWNER_DAILY_UNPAID_INVOICE_STATUSES = ["SENT"] as const;
export const OWNER_DAILY_CHANGE_ORDER_ATTENTION_STATUSES = ["DRAFT", "SENT"] as const;
export const OWNER_DAILY_ADDITIONAL_WORK_STATUS = "OPEN" as const;
export const OWNER_DAILY_RUNNING_TIME_STATUS = "RUNNING" as const;

export const OWNER_DAILY_GROUP_TITLES = {
  additionalWork: "Additional-work requests",
  changeOrders: "Change orders needing action",
  callbacks: "Customer-reported callbacks",
  runningTime: "Running time",
  materialDeposits: "Unpaid material deposits",
  scheduleConflicts: "Scheduling conflicts",
  unscheduledApproved: "Unscheduled jobs",
  unpaidInvoices: "Unpaid invoices",
  fieldProblems: "Field reports needing attention",
  firstAwaiting: "Unconfirmed appointments",
} as const;

export type OwnerDailyAttentionItem = {
  key: string;
  name: string;
  meta?: string;
  href: string;
  action: string;
};

export function ownerDailyUnpaidInvoiceWhere() {
  return { status: "SENT" as const };
}

export function ownerDailyUnscheduledApprovedWhere() {
  return {
    status: "UNSCHEDULED" as const,
    OR: [
      { estimateId: { not: null } },
      { approvedEstimateVersionId: { not: null } },
      { approvedEstimateOptionId: { not: null } },
    ],
  };
}

export function isUnscheduledApprovedWork(job: {
  status: string;
  estimateId?: string | null;
  approvedEstimateVersionId?: string | null;
  approvedEstimateOptionId?: string | null;
}) {
  if (job.status !== "UNSCHEDULED") return false;
  return Boolean(
    job.estimateId || job.approvedEstimateVersionId || job.approvedEstimateOptionId,
  );
}

export const OWNER_DAILY_ADDITIONAL_WORK_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  status: true,
  source: true,
  description: true,
  job: {
    select: {
      id: true,
      businessId: true,
      customer: { select: { name: true } },
    },
  },
  items: {
    select: {
      quantity: true,
      customDescription: true,
      serviceCatalogItem: { select: { name: true } },
    },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

export type OwnerDailyAdditionalWorkRecord = {
  id: string;
  businessId: string;
  jobId: string;
  status: string;
  source: string;
  description: string;
  job?: {
    id: string;
    businessId: string;
    customer?: { name: string | null } | null;
  } | null;
  items?: Array<{
    quantity: number;
    customDescription: string | null;
    serviceCatalogItem: { name: string } | null;
  }>;
};

export function buildOwnerDailyAdditionalWorkItem(
  row: OwnerDailyAdditionalWorkRecord,
  businessId: string,
): OwnerDailyAttentionItem | null {
  if (row.businessId !== businessId) return null;
  if (row.status !== OWNER_DAILY_ADDITIONAL_WORK_STATUS) return null;
  const job = row.job;
  if (!job || job.businessId !== businessId || job.id !== row.jobId) return null;
  const labels = requestedWorkLabels({
    items: row.items,
    description: row.description,
  });
  const summary = requestedWorkSummary(labels) || row.description.trim() || "Additional work requested";
  const source =
    row.source === "EMPLOYEE" ? "Field employee" : "Customer";
  return {
    key: row.id,
    name: job.customer?.name?.trim() || "Customer",
    meta: `${source} · ${summary}`,
    href: `/jobs/${job.id}`,
    action: "Review",
  };
}

export function buildOwnerDailyAdditionalWorkAttention(
  rows: readonly OwnerDailyAdditionalWorkRecord[],
  businessId: string,
): OwnerDailyAttentionItem[] {
  const items: OwnerDailyAttentionItem[] = [];
  for (const row of rows) {
    const item = buildOwnerDailyAdditionalWorkItem(row, businessId);
    if (item) items.push(item);
  }
  return items;
}

export const OWNER_DAILY_CHANGE_ORDER_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  status: true,
  title: true,
  total: true,
  job: {
    select: {
      id: true,
      businessId: true,
      customer: { select: { name: true } },
    },
  },
} as const;

export type OwnerDailyChangeOrderRecord = {
  id: string;
  businessId: string;
  jobId: string;
  status: string;
  title: string;
  total: Prisma.Decimal | number | string;
  job?: {
    id: string;
    businessId: string;
    customer?: { name: string | null } | null;
  } | null;
};

export function changeOrderNeedsOwnerAttention(status: string) {
  return (OWNER_DAILY_CHANGE_ORDER_ATTENTION_STATUSES as readonly string[]).includes(
    status,
  );
}

export function buildOwnerDailyChangeOrderItem(
  row: OwnerDailyChangeOrderRecord,
  businessId: string,
): OwnerDailyAttentionItem | null {
  if (row.businessId !== businessId) return null;
  if (!changeOrderNeedsOwnerAttention(row.status)) return null;
  const job = row.job;
  if (!job || job.businessId !== businessId || job.id !== row.jobId) return null;
  const statusLabel = row.status === "SENT" ? "Awaiting customer" : "Draft";
  return {
    key: row.id,
    name: job.customer?.name?.trim() || "Customer",
    meta: `${statusLabel} · ${row.title.trim() || "Change order"} · ${formatMoney(row.total)}`,
    href: `/jobs/${job.id}/change-orders/${row.id}`,
    action: "Open",
  };
}

export function buildOwnerDailyChangeOrderAttention(
  rows: readonly OwnerDailyChangeOrderRecord[],
  businessId: string,
): OwnerDailyAttentionItem[] {
  const items: OwnerDailyAttentionItem[] = [];
  for (const row of rows) {
    const item = buildOwnerDailyChangeOrderItem(row, businessId);
    if (item) items.push(item);
  }
  return items;
}

export const OWNER_DAILY_CALLBACK_SELECT = {
  id: true,
  businessId: true,
  jobId: true,
  status: true,
  description: true,
  job: {
    select: {
      id: true,
      businessId: true,
      customer: { select: { name: true } },
    },
  },
} as const;

export type OwnerDailyCallbackRecord = {
  id: string;
  businessId: string;
  jobId: string;
  status: string;
  description: string;
  job?: {
    id: string;
    businessId: string;
    customer?: { name: string | null } | null;
  } | null;
};

export function buildOwnerDailyCallbackItem(
  row: OwnerDailyCallbackRecord,
  businessId: string,
): OwnerDailyAttentionItem | null {
  if (row.businessId !== businessId) return null;
  if (!(JOB_CALLBACK_OPEN_STATUSES as readonly string[]).includes(row.status)) {
    return null;
  }
  const job = row.job;
  if (!job || job.businessId !== businessId || job.id !== row.jobId) return null;
  const note = row.description.trim();
  return {
    key: row.id,
    name: job.customer?.name?.trim() || "Customer",
    meta: `${recordedCallbackStatusLabel(row.status)}${note ? ` · ${note}` : ""}`,
    href: `/jobs/${job.id}`,
    action: "Review",
  };
}

export function buildOwnerDailyCallbackAttention(
  rows: readonly OwnerDailyCallbackRecord[],
  businessId: string,
): OwnerDailyAttentionItem[] {
  const items: OwnerDailyAttentionItem[] = [];
  for (const row of rows) {
    const item = buildOwnerDailyCallbackItem(row, businessId);
    if (item) items.push(item);
  }
  return items;
}

export const OWNER_DAILY_RUNNING_TIME_SELECT = {
  id: true,
  businessId: true,
  membershipId: true,
  jobId: true,
  status: true,
  endedAt: true,
  startedAt: true,
  activityType: true,
  membership: { select: { user: { select: { name: true } } } },
  job: {
    select: {
      id: true,
      businessId: true,
      customer: { select: { name: true } },
    },
  },
} as const;

export type OwnerDailyRunningTimeRecord = {
  id: string;
  businessId: string;
  membershipId: string;
  jobId: string | null;
  status: string;
  endedAt: Date | null;
  startedAt: Date;
  activityType: string;
  membership?: { user?: { name: string | null } | null } | null;
  job?: {
    id: string;
    businessId: string;
    customer?: { name: string | null } | null;
  } | null;
};

export function isRunningUnfinishedTime(row: {
  status: string;
  endedAt: Date | null;
}) {
  return row.status === OWNER_DAILY_RUNNING_TIME_STATUS && row.endedAt == null;
}

export function buildOwnerDailyRunningTimeItem(
  row: OwnerDailyRunningTimeRecord,
  businessId: string,
  timeZone?: string,
): OwnerDailyAttentionItem | null {
  if (row.businessId !== businessId) return null;
  if (!isRunningUnfinishedTime(row)) return null;
  if (row.job && row.job.businessId !== businessId) return null;
  const activity = isTimeActivityType(row.activityType)
    ? TIME_ACTIVITY_LABELS[row.activityType]
    : row.activityType;
  const worker = row.membership?.user?.name?.trim() || "Team member";
  const customer = row.job?.customer?.name?.trim();
  return {
    key: row.id,
    name: worker,
    meta: `${activity} since ${formatTime(row.startedAt, timeZone)}${
      customer ? ` · ${customer}` : ""
    }`,
    href: row.job ? `/jobs/${row.job.id}` : "/time-cards",
    action: "Open",
  };
}

export function buildOwnerDailyRunningTimeAttention(
  rows: readonly OwnerDailyRunningTimeRecord[],
  businessId: string,
  timeZone?: string,
): OwnerDailyAttentionItem[] {
  const items: OwnerDailyAttentionItem[] = [];
  for (const row of rows) {
    const item = buildOwnerDailyRunningTimeItem(row, businessId, timeZone);
    if (item) items.push(item);
  }
  return items;
}

export type OwnerDailyDepositEstimateRecord = {
  id: string;
  businessId: string;
  status: string;
  total: Prisma.Decimal | number | string;
  customer?: { name: string | null } | null;
  lineItems: Array<{
    type: string;
    total: Prisma.Decimal | number | string;
    description: string;
  }>;
};

export function buildOwnerDailyMaterialDepositItem(
  estimate: OwnerDailyDepositEstimateRecord,
  paidTowardDeposit: Prisma.Decimal | number | string,
  businessId: string,
): OwnerDailyAttentionItem | null {
  if (estimate.businessId !== businessId) return null;
  if (estimate.status !== "APPROVED") return null;
  const deposit = resolveMaterialDeposit({
    lines: estimate.lineItems,
    total: estimate.total,
  });
  if (deposit.amount.lte(0)) return null;
  const paid = paidTowardDeposit instanceof Prisma.Decimal
    ? paidTowardDeposit
    : new Prisma.Decimal(paidTowardDeposit);
  const remaining = deposit.amount.sub(paid);
  const warning = unpaidMaterialDepositWarning(remaining);
  if (!warning) return null;
  return {
    key: estimate.id,
    name: estimate.customer?.name?.trim() || "Customer",
    meta: warning,
    href: `/estimates/${estimate.id}`,
    action: "Open",
  };
}

export function buildOwnerDailyMaterialDepositAttention(
  estimates: readonly OwnerDailyDepositEstimateRecord[],
  paidByEstimateId: ReadonlyMap<string, Prisma.Decimal | number | string>,
  businessId: string,
): OwnerDailyAttentionItem[] {
  const items: OwnerDailyAttentionItem[] = [];
  for (const estimate of estimates) {
    const item = buildOwnerDailyMaterialDepositItem(
      estimate,
      paidByEstimateId.get(estimate.id) ?? 0,
      businessId,
    );
    if (item) items.push(item);
  }
  return items;
}

export type OwnerDailyConflictJob = {
  id: string;
  businessId?: string;
  customerName?: string | null;
};

export function scheduleConflictNeedsOwnerAttention(conflict: ScheduleConflict) {
  return (
    conflict.severity === "ERROR" ||
    conflict.kind === "DOUBLE_BOOKING" ||
    conflict.kind === "OVERLAP"
  );
}

export function buildOwnerDailyScheduleConflictItem(
  conflict: ScheduleConflict,
  jobsById: ReadonlyMap<string, OwnerDailyConflictJob>,
  businessId: string,
): OwnerDailyAttentionItem | null {
  if (!scheduleConflictNeedsOwnerAttention(conflict)) return null;
  const job = jobsById.get(conflict.jobId);
  if (!job) return null;
  if (job.businessId != null && job.businessId !== businessId) return null;
  const other = conflict.otherJobId ? jobsById.get(conflict.otherJobId) : null;
  if (other?.businessId != null && other.businessId !== businessId) return null;
  const otherName = other?.customerName?.trim();
  return {
    key: `${conflict.kind}:${conflict.jobId}:${conflict.otherJobId ?? ""}`,
    name: job.customerName?.trim() || "Customer",
    meta: otherName
      ? `${conflict.explanation} · ${otherName}`
      : conflict.explanation,
    href: conflictingJobHref(job.id),
    action: "Open",
  };
}

export function buildOwnerDailyScheduleConflictAttention(
  conflicts: readonly ScheduleConflict[],
  jobsById: ReadonlyMap<string, OwnerDailyConflictJob>,
  businessId: string,
): OwnerDailyAttentionItem[] {
  const items: OwnerDailyAttentionItem[] = [];
  const seen = new Set<string>();
  for (const conflict of conflicts) {
    const item = buildOwnerDailyScheduleConflictItem(conflict, jobsById, businessId);
    if (!item) continue;
    const pair = [conflict.jobId, conflict.otherJobId ?? ""]
      .sort()
      .join(":");
    const dedupe = `${conflict.kind}:${pair}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    items.push(item);
  }
  return items;
}

export type OwnerDailyAttentionGroup = {
  title: string;
  count: number;
  items: OwnerDailyAttentionItem[];
};

export function ownerDailyAttentionGroup(
  title: string,
  items: readonly OwnerDailyAttentionItem[],
  count = items.length,
): OwnerDailyAttentionGroup | null {
  if (count <= 0 && items.length === 0) return null;
  return {
    title,
    count,
    items: items.slice(0, OWNER_DAILY_ATTENTION_TAKE),
  };
}

/**
 * Behavioral invariant used by mutation tests. A projected item may only
 * exist when the recorded row is same-tenant and in an actionable state.
 */
export function ownerDailyAttentionItemHolds(input: {
  viewerBusinessId: string;
  recordBusinessId: string;
  actionable: boolean;
  item: OwnerDailyAttentionItem | null;
  expectedHrefPrefix?: string;
}): boolean {
  const allowed =
    input.recordBusinessId === input.viewerBusinessId && input.actionable;
  if (!allowed) return input.item == null;
  if (!input.item) return false;
  if (!input.item.href.startsWith("/") || input.item.href.startsWith("//")) {
    return false;
  }
  if (
    input.expectedHrefPrefix &&
    !input.item.href.startsWith(input.expectedHrefPrefix)
  ) {
    return false;
  }
  return true;
}
