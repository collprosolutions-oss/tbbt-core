/**
 * Read-only owner day-route loader.
 *
 * Queries same-business Job rows for one business-timezone day. Does not
 * create, update, or delete schedule fields.
 */
import type { MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { requireOwnerDayRouteAccess } from "@/lib/owner-day-route/access";
import { buildOwnerDayRouteView } from "@/lib/owner-day-route/build";
import { OWNER_DAY_ROUTE_JOBS_TAKE, OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD } from "@/lib/owner-day-route/constants";
import type { OwnerDayRouteScheduleSnapshot, OwnerDayRouteView } from "@/lib/owner-day-route/types";
import { dayRange, parseScheduleDate } from "@/lib/schedule";

type DayRouteDb = PrismaClient | Prisma.TransactionClient;

export const OWNER_DAY_ROUTE_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  arrivalWindowMinutes: true,
  pickupDurationMinutes: true,
  assignedMembershipId: true,
  customer: { select: { id: true, name: true } },
  property: {
    select: {
      id: true,
      businessId: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
} as const;

export type LoadOwnerDayRouteInput = {
  businessId: string;
  role: MembershipRole;
  date?: string | null;
  timeZone?: string | null;
};

export async function loadOwnerDayRoute(
  db: DayRouteDb,
  input: LoadOwnerDayRouteInput,
): Promise<OwnerDayRouteView> {
  requireOwnerDayRouteAccess(input);
  // mutationsOnLoad stays false. This loader only reads Job and Business.
  if (OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD) {
    throw new Error("Owner day-route load must stay read-only.");
  }

  const business = await db.business.findFirst({
    where: { id: input.businessId },
    select: { id: true, timezone: true },
  });
  if (!business || business.id !== input.businessId) {
    throw new Error("Record is not in the authorized business workspace.");
  }

  const timeZone = input.timeZone || resolveBusinessTimeZone(business);
  const day = parseScheduleDate(input.date ?? undefined, timeZone);
  const range = dayRange(day, timeZone);

  const jobs = await db.job.findMany({
    where: {
      businessId: input.businessId,
      scheduledAt: { gte: range.start, lt: range.end },
    },
    select: OWNER_DAY_ROUTE_JOB_SELECT,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: OWNER_DAY_ROUTE_JOBS_TAKE,
  });

  return buildOwnerDayRouteView(jobs, {
    businessId: input.businessId,
    range,
    timeZone,
  });
}

export function scheduleSnapshotFromJob(job: {
  id: string;
  scheduledAt: Date | null;
  status: string;
  pickupDurationMinutes: number | null;
  arrivalWindowMinutes: number | null;
  assignedMembershipId: string | null;
}): OwnerDayRouteScheduleSnapshot {
  return {
    jobId: job.id,
    scheduledAt: job.scheduledAt ? job.scheduledAt.toISOString() : null,
    status: job.status,
    pickupDurationMinutes: job.pickupDurationMinutes,
    arrivalWindowMinutes: job.arrivalWindowMinutes,
    assignedMembershipId: job.assignedMembershipId,
  };
}

export async function readOwnerDayRouteScheduleSnapshots(
  db: DayRouteDb,
  businessId: string,
  jobIds: readonly string[],
): Promise<OwnerDayRouteScheduleSnapshot[]> {
  if (jobIds.length === 0) return [];
  const jobs = await db.job.findMany({
    where: { businessId, id: { in: [...jobIds] } },
    select: {
      id: true,
      scheduledAt: true,
      status: true,
      pickupDurationMinutes: true,
      arrivalWindowMinutes: true,
      assignedMembershipId: true,
    },
    orderBy: { id: "asc" },
  });
  return jobs.map(scheduleSnapshotFromJob);
}
