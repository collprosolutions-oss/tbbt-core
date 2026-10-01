/**
 * Unguessable-token calendar feed.
 *
 * Looks up sha256(token), then rechecks membership, business, and current
 * assignment before returning ICS. A revoke or rotate that lands before
 * the final re-read denies the response so concurrent revoke/read cannot
 * publish after the token is burned.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  addZonedCalendarDays,
  resolveBusinessTimeZone,
  startOfZonedDay,
} from "@/lib/business-timezone";
import { hashToken } from "@/lib/auth-crypto";
import { scheduleWindow } from "@/lib/job-schedule";
import {
  SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT,
  SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS,
  type ScheduleCalendarExportEvent,
  type ScheduleCalendarExportScope,
} from "@/lib/schedule-calendar-export/contract";
import { boundCalendarRead } from "@/lib/schedule-calendar-export/build";
import { serializeScheduleCalendarIcs } from "@/lib/schedule-calendar-export/ics";
import { liveScheduleCalendarAccessAllowed } from "@/lib/schedule-calendar-subscription/access";
import {
  SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
  SCHEDULE_CALENDAR_FEED_STATUSES,
  SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT,
  SCHEDULE_CALENDAR_SUBSCRIPTION_VERSION,
  isScheduleCalendarFeedToken,
  isScheduleCalendarSubscriptionScope,
  type ScheduleCalendarFeedDocument,
} from "@/lib/schedule-calendar-subscription/contract";
import { ScheduleCalendarSubscriptionError } from "@/lib/schedule-calendar-subscription/ops";
import { missingScheduleCalendarSubscriptionSchema } from "@/lib/schedule-calendar-subscription/schema";

type Db = PrismaClient | Prisma.TransactionClient;

const FEED_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  assignedMembershipId: true,
} as const;

export const scheduleCalendarSubscriptionTestHooks: {
  afterLookup?: (input: { subscriptionId: string; tokenHash: string }) => Promise<void> | void;
} = {};

function feedNotFound(): never {
  throw new ScheduleCalendarSubscriptionError(
    "NOT_FOUND",
    SCHEDULE_CALENDAR_FEED_NOT_FOUND_MESSAGE,
    404,
  );
}

function subscriptionStillValid(input: {
  latest: { revokedAt: Date | null; tokenHash: string; businessId: string; membershipId: string } | null;
  tokenHash: string;
  businessId: string;
  membershipId: string;
}): boolean {
  return (
    input.latest != null &&
    input.latest.revokedAt == null &&
    input.latest.tokenHash === input.tokenHash &&
    input.latest.businessId === input.businessId &&
    input.latest.membershipId === input.membershipId
  );
}

async function loadLiveMembership(
  prisma: Db,
  membershipId: string,
  businessId: string,
) {
  return prisma.membership.findFirst({
    where: { id: membershipId, businessId },
    select: {
      id: true,
      businessId: true,
      role: true,
      active: true,
      business: { select: { id: true, timezone: true } },
    },
  });
}

export async function readScheduleCalendarFeed(
  prisma: Db,
  rawToken: string,
  input: { now?: Date } = {},
): Promise<ScheduleCalendarFeedDocument> {
  if (!isScheduleCalendarFeedToken(rawToken)) feedNotFound();
  const tokenHash = hashToken(rawToken);

  let subscription;
  try {
    subscription = await prisma.scheduleCalendarSubscription.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        businessId: true,
        membershipId: true,
        scope: true,
        tokenHash: true,
        revokedAt: true,
      },
    });
  } catch (error) {
    if (missingScheduleCalendarSubscriptionSchema(error)) feedNotFound();
    throw error;
  }

  if (!subscription || subscription.revokedAt != null) feedNotFound();
  if (!isScheduleCalendarSubscriptionScope(subscription.scope)) feedNotFound();

  await scheduleCalendarSubscriptionTestHooks.afterLookup?.({
    subscriptionId: subscription.id,
    tokenHash,
  });

  const membership = await loadLiveMembership(
    prisma,
    subscription.membershipId,
    subscription.businessId,
  );
  if (
    !membership ||
    !membership.business ||
    !liveScheduleCalendarAccessAllowed({
      role: membership.role,
      active: membership.active,
      scope: subscription.scope,
      membershipBusinessId: membership.businessId,
      subscriptionBusinessId: subscription.businessId,
    })
  ) {
    feedNotFound();
  }

  const timeZone = resolveBusinessTimeZone(membership.business);
  const generatedAt = input.now ?? new Date();
  const rangeStart = startOfZonedDay(generatedAt, timeZone);
  const rangeEnd = addZonedCalendarDays(
    rangeStart,
    SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS,
    timeZone,
  );
  const scope = subscription.scope as ScheduleCalendarExportScope;

  const rows = await prisma.job.findMany({
    where: {
      businessId: subscription.businessId,
      scheduledAt: { gte: rangeStart, lt: rangeEnd },
      status: { in: [...SCHEDULE_CALENDAR_FEED_STATUSES] },
      ...(scope === "assigned" ? { assignedMembershipId: membership.id } : {}),
    },
    select: FEED_JOB_SELECT,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT + 1,
  });

  for (const row of rows) {
    if (row.businessId !== subscription.businessId) feedNotFound();
  }

  const bounded = boundCalendarRead(rows, SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT);
  const events: ScheduleCalendarExportEvent[] = bounded.items.map((row) => {
    const start = row.scheduledAt;
    if (!start) {
      throw new Error("Recorded appointment is missing scheduledAt.");
    }
    const window = scheduleWindow(start, row.scheduledDurationMinutes);
    return {
      jobId: row.id,
      status: row.status,
      assigned: row.assignedMembershipId != null,
      start: window.start,
      end: window.end,
      timeZone,
    };
  });

  const latest = await prisma.scheduleCalendarSubscription.findUnique({
    where: { id: subscription.id },
    select: {
      revokedAt: true,
      tokenHash: true,
      businessId: true,
      membershipId: true,
    },
  });
  if (
    !subscriptionStillValid({
      latest,
      tokenHash,
      businessId: subscription.businessId,
      membershipId: subscription.membershipId,
    })
  ) {
    feedNotFound();
  }

  const membershipAgain = await loadLiveMembership(
    prisma,
    subscription.membershipId,
    subscription.businessId,
  );
  if (
    !membershipAgain ||
    !liveScheduleCalendarAccessAllowed({
      role: membershipAgain.role,
      active: membershipAgain.active,
      scope,
      membershipBusinessId: membershipAgain.businessId,
      subscriptionBusinessId: subscription.businessId,
    })
  ) {
    feedNotFound();
  }

  const ics = serializeScheduleCalendarIcs({
    timeZone,
    scope,
    generatedAt,
    truncated: bounded.truncated,
    events,
    liveFeed: true,
  });

  return {
    contract: SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT,
    version: SCHEDULE_CALENDAR_SUBSCRIPTION_VERSION,
    filename: "tbbt-schedule-subscription.ics",
    ics,
    timeZone,
    scope,
    rangeStart,
    rangeEnd,
    truncated: bounded.truncated,
    events,
    authorization: {
      role: membershipAgain.role,
      authorizedByMembershipId: membershipAgain.id,
      membershipActive: true,
      scope,
    },
    limits: {
      horizonDays: SCHEDULE_CALENDAR_EXPORT_HORIZON_DAYS,
      eventLimit: SCHEDULE_CALENDAR_EXPORT_EVENT_LIMIT,
      liveSynchronization: true,
      publicSubscription: false,
      sharedDatabase: false,
      writesScheduleFields: false,
    },
  };
}

export const SCHEDULE_CALENDAR_SUBSCRIPTION_FEED_CONTRACT = SCHEDULE_CALENDAR_SUBSCRIPTION_CONTRACT;
