/**
 * Read-only Handyman maintenance follow-up loaders. Mutation-free.
 *
 * Job review is OWNER/management. Owner-queue items are due/overdue
 * OPEN MAINTENANCE rows only. Aftercare, callbacks, and warranty cases
 * stay on their existing surfaces — this is not a second queue for
 * the same event.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { formatISODateInTimeZone, resolveBusinessTimeZone } from "@/lib/business-timezone";
import { CUSTOMER_FOLLOW_UP_ORIGINS } from "@/lib/customer-follow-up-origin";
import {
  HANDYMAN_MAINTENANCE_OWNER_WORKFLOW_MESSAGE,
  handymanMaintenanceDueState,
  handymanMaintenanceJobEligible,
  handymanMaintenanceWriteAllowed,
  isHandymanMaintenanceDueOrOverdue,
} from "@/lib/handyman-maintenance-follow-up";
import { completedSameBusinessJobEligible } from "@/lib/job-callback";

type Db = PrismaClient | Prisma.TransactionClient;

const FOLLOW_UP_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  jobId: true,
  kind: true,
  status: true,
  origin: true,
  dueOn: true,
  notes: true,
  cancelledAt: true,
  sentAt: true,
  createdAt: true,
} as const;

export type OwnerMaintenanceFollowUp = {
  id: string;
  jobId: string | null;
  customerId: string;
  status: string;
  task: string;
  dueOn: Date | null;
  dueOnLabel: string | null;
  dueState: "none" | "upcoming" | "due_today" | "overdue";
  sentAt: Date | null;
  cancelledAt: Date | null;
};

export type HandymanMaintenanceFollowUpReview = {
  jobId: string;
  jobStatus: string;
  customerId: string | null;
  eligible: boolean;
  canWrite: boolean;
  reason: "ok" | "not_completed" | "not_handyman" | "no_customer";
  workflowMessage: string;
  openFollowUp: OwnerMaintenanceFollowUp | null;
  history: OwnerMaintenanceFollowUp[];
};

function asOwnerFollowUp(
  row: Prisma.CustomerFollowUpGetPayload<{ select: typeof FOLLOW_UP_SELECT }>,
  timeZone: string,
  now: Date,
): OwnerMaintenanceFollowUp {
  return {
    id: row.id,
    jobId: row.jobId,
    customerId: row.customerId,
    status: row.status,
    task: row.notes,
    dueOn: row.dueOn,
    dueOnLabel: row.dueOn ? formatISODateInTimeZone(row.dueOn, timeZone) : null,
    dueState: handymanMaintenanceDueState(row.dueOn, now, timeZone),
    sentAt: row.sentAt,
    cancelledAt: row.cancelledAt,
  };
}

export async function loadHandymanMaintenanceFollowUpReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<HandymanMaintenanceFollowUpReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      status: true,
      estimate: {
        select: {
          serviceRequest: { select: { tradeCode: true } },
          lineItems: {
            select: { serviceCatalogItem: { select: { tradeCode: true } } },
          },
        },
      },
    },
  });
  if (!job) return null;
  access.assertOwned(job);

  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);
  const now = new Date();

  const rows = await db.customerFollowUp.findMany({
    where: {
      businessId: access.businessId,
      jobId: job.id,
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE,
    },
    select: FOLLOW_UP_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const owned = rows.map((row) => access.assertOwned(row));
  const views = owned.map((row) => asOwnerFollowUp(row, timeZone, now));
  const openFollowUp = views.find((row) => row.status === "OPEN") ?? null;

  const eligible = handymanMaintenanceJobEligible({
    job,
    businessId: access.businessId,
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  const completed = completedSameBusinessJobEligible(job, access.businessId);
  let reason: HandymanMaintenanceFollowUpReview["reason"] = "ok";
  if (!completed) reason = "not_completed";
  else if (!eligible.ok) reason = "not_handyman";
  else if (!job.customerId) reason = "no_customer";

  return {
    jobId: job.id,
    jobStatus: job.status,
    customerId: job.customerId,
    eligible: eligible.ok && Boolean(job.customerId),
    canWrite: handymanMaintenanceWriteAllowed(access.workspace.role),
    reason,
    workflowMessage: HANDYMAN_MAINTENANCE_OWNER_WORKFLOW_MESSAGE,
    openFollowUp,
    history: views.filter((row) => row.id !== openFollowUp?.id),
  };
}

export async function loadMaintenanceFollowUpComposeContext(
  db: Db,
  access: { businessId: string },
  input: { followUpId?: string | null; customerId?: string | null },
) {
  const followUpId = input.followUpId?.trim() ?? "";
  const customerId = input.customerId?.trim() ?? "";
  if (!followUpId || !customerId) return null;
  const row = await db.customerFollowUp.findFirst({
    where: {
      id: followUpId,
      businessId: access.businessId,
      customerId,
      origin: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE,
    },
    select: FOLLOW_UP_SELECT,
  });
  if (!row) return null;
  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);
  return asOwnerFollowUp(row, timeZone, new Date());
}

export function maintenanceFollowUpDueWhere(input: {
  businessId: string;
  todayStart: Date;
}) {
  return {
    businessId: input.businessId,
    origin: CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE,
    status: "OPEN" as const,
    dueOn: { lte: input.todayStart },
  };
}

export { isHandymanMaintenanceDueOrOverdue };
