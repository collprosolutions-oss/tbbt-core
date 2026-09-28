/**
 * OWNER appointment-window change from the day-route page.
 *
 * Reuses the existing scheduleJob gates (timezone, duration, pickup,
 * buffers, conflicts, stale conflict ack). Does not send customer
 * email/SMS and does not claim travel optimization. Page load stays
 * read-only; this module is the explicit write path.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  isMaterialAppointmentChange,
  nextAppointmentProposalId,
} from "@/lib/appointment-confirmation";
import { recordAppointmentEvent } from "@/lib/appointment-data";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import {
  describeScheduleWarning,
  evaluateProposedSchedule,
  hasScheduleWarning,
} from "@/lib/availability";
import { loadAvailabilitySettings, loadOccupiedJobs } from "@/lib/availability-data";
import { formatISODateInTimeZone } from "@/lib/business-timezone";
import { formatDateTime } from "@/lib/format";
import { parseDurationMinutes, parseScheduleStart } from "@/lib/job-schedule";
import {
  OWNER_DAY_ROUTE_CHANGE_COMPLETED_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_INVALID_WINDOW_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE,
  OWNER_DAY_ROUTE_CHANGE_STALE_MESSAGE,
} from "@/lib/owner-day-route/constants";
import { computeNextOccurrenceAt, parseRecurrenceCadence, recurrenceForecastActive } from "@/lib/recurrence";
import {
  appointmentModeForPosition,
  appointmentPositionOnDay,
  parseBoundedInt,
} from "@/lib/workforce";
import { laterJobsHurtByMove } from "@/lib/workforce-capacity";
import { describeConflicts, detectScheduleConflicts } from "@/lib/workforce-conflicts";
import {
  loadCapacityJobs,
  loadSchedulingPolicy,
  loadWorkforceMembers,
  loadWorkforceTimeZone,
} from "@/lib/workforce-data";
import {
  conflictAcknowledgement,
  shouldAcceptConflictAcknowledgement,
} from "@/lib/workforce-window";

type Db = PrismaClient | Prisma.TransactionClient;

export class OwnerDayRouteChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerDayRouteChangeError";
  }
}

export type OwnerDayRouteChangeInput = {
  jobId: string;
  date: string;
  time: string;
  durationPreset?: string;
  customHours?: string;
  pickupDurationMinutes?: string | number | null;
  expectedScheduledAt: string;
  confirmOverlapAck?: string;
};

export type OwnerDayRouteChangeResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  conflictAck?: string;
  message?: string;
  jobId?: string;
  scheduledAt?: string;
};

function requireOwnerDayRouteChange(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  if (access.workspace.role !== "OWNER") {
    throw new OwnerDayRouteChangeError(OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function parseExpectedScheduledAt(value: string) {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function changeOwnerDayRouteAppointment(
  db: Db,
  access: BusinessAccess,
  input: OwnerDayRouteChangeInput,
): Promise<OwnerDayRouteChangeResult> {
  requireOwnerDayRouteChange(access);

  if (!input.jobId.trim()) {
    return { ok: false, error: "That job could not be rescheduled." };
  }

  const job = access.assertOwned(
    await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
    }),
  );

  if (job.status === "COMPLETED") {
    return { ok: false, error: OWNER_DAY_ROUTE_CHANGE_COMPLETED_MESSAGE };
  }

  const expected = parseExpectedScheduledAt(input.expectedScheduledAt);
  if (!expected || !job.scheduledAt || job.scheduledAt.getTime() !== expected.getTime()) {
    return { ok: false, error: OWNER_DAY_ROUTE_CHANGE_STALE_MESSAGE };
  }

  const timeZone = await loadWorkforceTimeZone(db as PrismaClient, access.businessId);
  const start = parseScheduleStart(input.date, input.time, timeZone);
  if (!start) {
    return { ok: false, error: OWNER_DAY_ROUTE_CHANGE_INVALID_WINDOW_MESSAGE };
  }

  const duration = input.durationPreset
    ? parseDurationMinutes(input.durationPreset, input.customHours ?? "")
    : { ok: true as const, minutes: job.scheduledDurationMinutes };
  if (!duration.ok) {
    return { ok: false, error: duration.error };
  }
  const durationMinutes = duration.minutes ?? job.scheduledDurationMinutes ?? 60;
  const pickupDurationMinutes = parseBoundedInt(
    input.pickupDurationMinutes == null ? String(job.pickupDurationMinutes ?? 0) : String(input.pickupDurationMinutes),
    job.pickupDurationMinutes ?? 0,
    0,
    24 * 60,
  );

  const [settings, others, policy, members, capacityJobs] = await Promise.all([
    loadAvailabilitySettings(db as PrismaClient, access.businessId),
    loadOccupiedJobs(db as PrismaClient, access.businessId, job.id),
    loadSchedulingPolicy(db as PrismaClient, access.businessId),
    loadWorkforceMembers(db as PrismaClient, access.businessId),
    loadCapacityJobs(db as PrismaClient, access.businessId),
  ]);
  const evaluation = evaluateProposedSchedule({
    start,
    durationMinutes,
    settings,
    existing: others,
    timeZone,
  });
  const conflicts = detectScheduleConflicts({
    jobs: capacityJobs,
    settings,
    policy,
    members,
    timeZone,
    proposed: {
      jobId: job.id,
      start,
      durationMinutes,
      pickupMinutes: pickupDurationMinutes,
      assignedMembershipId: job.assignedMembershipId,
      originalScheduledAt: job.scheduledAt,
    },
    now: new Date(),
  });
  const cascade = laterJobsHurtByMove({
    start,
    durationMinutes,
    pickupMinutes: pickupDurationMinutes,
    settings,
    policy,
    existing: capacityJobs.filter((row) => row.id !== job.id),
    membershipId: job.assignedMembershipId,
  });
  const warning =
    (hasScheduleWarning(evaluation)
      ? describeScheduleWarning(
          evaluation,
          start,
          (value) => formatDateTime(value, timeZone),
          settings,
          timeZone,
        )
      : null) ?? describeConflicts(conflicts);
  const currentAck = conflictAcknowledgement({
    jobId: job.id,
    start,
    durationMinutes,
    pickupMinutes: pickupDurationMinutes,
    assignedMembershipId: job.assignedMembershipId,
    conflicts: warning
      ? conflicts.length > 0
        ? conflicts
        : [{ kind: "AVAILABILITY", jobId: job.id, severity: "WARNING" }]
      : [],
  });
  if (
    warning &&
    shouldAcceptConflictAcknowledgement({
      submittedAck: input.confirmOverlapAck,
      currentAck,
      conflicts: warning ? [warning] : [],
    }) === "warn"
  ) {
    return {
      ok: false,
      warning: cascade.length ? `${warning} Later jobs were not moved.` : warning,
      conflictAck: currentAck,
    };
  }

  const materialChange = isMaterialAppointmentChange(job, start, durationMinutes);
  const proposalId = materialChange
    ? nextAppointmentProposalId(job.appointmentProposalId)
    : job.appointmentProposalId;
  const rescheduled = Boolean(job.scheduledAt) && materialChange;
  const position = appointmentPositionOnDay({
    start,
    jobId: job.id,
    assignedMembershipId: job.assignedMembershipId,
    jobs: capacityJobs,
    dateKey: (date) => formatISODateInTimeZone(date, timeZone),
  });
  const mode = appointmentModeForPosition(position, policy);
  const nextOccurrenceAt = recurrenceForecastActive(job)
    ? computeNextOccurrenceAt(
        start,
        parseRecurrenceCadence(job.recurrenceCadence),
        job.nextOccurrenceAt,
        timeZone,
      )
    : job.nextOccurrenceAt;

  const updated = await db.job.updateMany({
    where: {
      id: job.id,
      businessId: access.businessId,
      scheduledAt: expected,
    },
    data: {
      scheduledAt: start,
      scheduledDurationMinutes: durationMinutes,
      pickupDurationMinutes: pickupDurationMinutes || null,
      arrivalWindowMinutes: mode === "WINDOW" ? policy.defaultArrivalWindowMinutes : null,
      nextOccurrenceAt,
      ...(materialChange
        ? {
            appointmentProposalId: proposalId,
            appointmentConfirmationStatus: "AWAITING_CUSTOMER",
            appointmentConfirmedAt: null,
            appointmentConfirmationSource: null,
            appointmentConfirmedByMembershipId: null,
            appointmentChangeRequestNote: null,
            startWithoutConfirmationAt: null,
            startWithoutConfirmationReason: null,
            startWithoutConfirmationByMembershipId: null,
            appointmentNotificationStatus: null,
            appointmentNotificationError: null,
            appointmentNotifiedAt: null,
            appointmentNotifiedForProposalId: null,
          }
        : {}),
    },
  });
  if (updated.count !== 1) {
    return { ok: false, error: OWNER_DAY_ROUTE_CHANGE_STALE_MESSAGE };
  }

  if (materialChange) {
    await recordAppointmentEvent(db as PrismaClient, {
      businessId: access.businessId,
      jobId: job.id,
      eventType: rescheduled ? "APPOINTMENT_RESCHEDULED" : "APPOINTMENT_PROPOSED",
      appointmentProposalId: proposalId,
      scheduledAt: start,
      scheduledDurationMinutes: durationMinutes,
      actorKind: "OWNER",
      actorMembershipId: access.workspace.membership.id,
    });
  }

  return {
    ok: true,
    jobId: job.id,
    scheduledAt: start.toISOString(),
    message: OWNER_DAY_ROUTE_CHANGE_NO_CUSTOMER_MESSAGE,
  };
}

export function ownerDayRouteChangeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof OwnerDayRouteChangeError) return error.message;
  if (error instanceof ForbiddenError) return OWNER_DAY_ROUTE_CHANGE_OWNER_ONLY_MESSAGE;
  return fallback;
}
