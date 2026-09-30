/**
 * OWNER mutation: change one same-business job's recorded appointment
 * start from the day-route page.
 *
 * Reuses the existing scheduling gates (business timezone, working hours,
 * buffers, material pickup). Conflicts and stale snapshots are rejected.
 * Does not notify the customer or claim travel optimization.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  isMaterialAppointmentChange,
  nextAppointmentProposalId,
} from "@/lib/appointment-confirmation";
import { recordAppointmentEvent } from "@/lib/appointment-data";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  evaluateProposedSchedule,
  hasScheduleWarning,
} from "@/lib/availability";
import { loadAvailabilitySettings, loadOccupiedJobs } from "@/lib/availability-data";
import { formatISODateInTimeZone } from "@/lib/business-timezone";
import { parseScheduleStart } from "@/lib/job-schedule";
import { sameBusinessJob } from "@/lib/owner-day-route/address";
import {
  ownerDayRouteScheduleSnapshotWhere,
  ownerDayRouteScheduleSnapshotsEqual,
  scheduleSnapshotFromJob,
} from "@/lib/owner-day-route/snapshot";
import type { OwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/types";
import {
  blockingDayRouteConflicts,
  DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE,
  DAY_ROUTE_APPOINTMENT_CONFLICT_MESSAGE,
  DAY_ROUTE_APPOINTMENT_INVALID_MESSAGE,
  DAY_ROUTE_APPOINTMENT_MISSING_JOB_MESSAGE,
  DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE,
  DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_STALE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_UNSCHEDULED_MESSAGE,
  describeRejectedDayRouteAppointment,
  parseDayRouteAppointmentSnapshot,
} from "@/lib/owner-day-route-appointment";
import {
  computeNextOccurrenceAt,
  parseRecurrenceCadence,
  recurrenceForecastActive,
} from "@/lib/recurrence";
import { lockBusinessScheduleReservation } from "@/lib/schedule-reservation";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";
import {
  appointmentModeForPosition,
  appointmentPositionOnDay,
} from "@/lib/workforce";
import { detectScheduleConflicts } from "@/lib/workforce-conflicts";
import {
  loadCapacityJobs,
  loadSchedulingPolicy,
  loadWorkforceMembers,
  loadWorkforceTimeZone,
  persistLaneArrivalWindows,
} from "@/lib/workforce-data";

type DayRouteDb = PrismaClient | Prisma.TransactionClient;

export class DayRouteAppointmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayRouteAppointmentError";
  }
}

const APPOINTMENT_SCHEMA_NAMES =
  /appointmentProposalId|appointmentConfirmationStatus|JobAppointmentEvent|appointmentNotifiedAt|appointmentConfirmedAt/i;

export function missingDayRouteAppointmentSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error);
  if (code === "P2021" || code === "P2022") {
    return APPOINTMENT_SCHEMA_NAMES.test(message) || /does not exist/i.test(message);
  }
  return APPOINTMENT_SCHEMA_NAMES.test(message) && /does not exist/i.test(message);
}

export function dayRouteAppointmentErrorMessage(error: unknown, fallback: string) {
  if (error instanceof DayRouteAppointmentError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingDayRouteAppointmentSchema(error)) {
    return DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE;
  }
  return fallback;
}

function dayRouteAppointmentLockKey(businessId: string) {
  return `day-route-appointment:${businessId}`;
}

function throwIfAppointmentSchemaMissing(error: unknown): never {
  if (missingDayRouteAppointmentSchema(error)) {
    throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE);
  }
  throw error;
}

export type ChangeOwnerDayRouteAppointmentInput = {
  jobId: string;
  date: string;
  time: string;
  snapshot: OwnerDayRouteScheduleSnapshot | string;
};

export type ChangedOwnerDayRouteAppointment = {
  jobId: string;
  businessId: string;
  scheduledAt: Date;
  scheduledDurationMinutes: number | null;
  previousScheduledAt: Date;
  pickupDurationMinutes: number | null;
  arrivalWindowMinutes: number | null;
};

const JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  pickupDurationMinutes: true,
  arrivalWindowMinutes: true,
  assignedMembershipId: true,
  appointmentProposalId: true,
  projectToken: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
} as const;

type OwnedJob = Prisma.JobGetPayload<{ select: typeof JOB_SELECT }>;

function assertOwner(access: BusinessAccess) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function readSnapshot(
  input: ChangeOwnerDayRouteAppointmentInput,
): OwnerDayRouteScheduleSnapshot {
  const snapshot =
    typeof input.snapshot === "string"
      ? parseDayRouteAppointmentSnapshot(input.snapshot, input.jobId)
      : input.snapshot.jobId === input.jobId
        ? input.snapshot
        : null;
  if (!snapshot) {
    throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_STALE_MESSAGE);
  }
  return snapshot;
}

function assertCurrentSnapshot(job: OwnedJob, snapshot: OwnerDayRouteScheduleSnapshot) {
  if (!ownerDayRouteScheduleSnapshotsEqual(snapshot, scheduleSnapshotFromJob(job))) {
    throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_STALE_MESSAGE);
  }
}

async function rejectIfScheduleBlocked(input: {
  db: DayRouteDb;
  access: BusinessAccess;
  job: OwnedJob;
  start: Date;
  timeZone: string;
}) {
  const pickupDurationMinutes = input.job.pickupDurationMinutes ?? null;
  const durationMinutes = input.job.scheduledDurationMinutes ?? null;
  const [settings, others, policy, members, capacityJobs] = await Promise.all([
    loadAvailabilitySettings(input.db, input.access.businessId),
    loadOccupiedJobs(input.db, input.access.businessId, input.job.id),
    loadSchedulingPolicy(input.db, input.access.businessId),
    loadWorkforceMembers(input.db, input.access.businessId),
    loadCapacityJobs(input.db, input.access.businessId),
  ]);
  const evaluation = evaluateProposedSchedule({
    start: input.start,
    durationMinutes,
    settings,
    existing: others,
    timeZone: input.timeZone,
  });
  const projected = capacityJobs.map((row) =>
    row.id === input.job.id
      ? {
          ...row,
          scheduledAt: input.start,
          scheduledDurationMinutes: durationMinutes,
          pickupDurationMinutes,
        }
      : row,
  );
  const blocking = blockingDayRouteConflicts(
    detectScheduleConflicts({
      jobs: projected,
      settings,
      policy,
      members,
      timeZone: input.timeZone,
    }),
    input.job.id,
  );
  if (hasScheduleWarning(evaluation) || blocking.length > 0) {
    throw new DayRouteAppointmentError(
      describeRejectedDayRouteAppointment({
        evaluation,
        conflicts: blocking,
        start: input.start,
        settings,
        timeZone: input.timeZone,
      }) || DAY_ROUTE_APPOINTMENT_CONFLICT_MESSAGE,
    );
  }
  return { policy, capacityJobs, durationMinutes, pickupDurationMinutes };
}

export async function changeOwnerDayRouteAppointment(
  db: PrismaClient,
  access: BusinessAccess,
  input: ChangeOwnerDayRouteAppointmentInput,
): Promise<ChangedOwnerDayRouteAppointment> {
  assertOwner(access);

  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_MISSING_JOB_MESSAGE);
  }
  const snapshot = readSnapshot({ ...input, jobId });

  try {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: jobId, ...access.scope },
        select: JOB_SELECT,
      }),
    );
    if (!sameBusinessJob(job, access.businessId)) {
      throw new Error("Record is not in the authorized business workspace.");
    }
    if (job.status === "COMPLETED") {
      throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE);
    }
    if (!job.scheduledAt) {
      throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_UNSCHEDULED_MESSAGE);
    }
    assertCurrentSnapshot(job, snapshot);

    const timeZone = await loadWorkforceTimeZone(db, access.businessId);
    const start = parseScheduleStart(input.date, input.time, timeZone);
    if (!start) {
      throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_INVALID_MESSAGE);
    }

    return await db.$transaction(
      async (tx) => {
        await lockBusinessScheduleReservation(tx, access.businessId);
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${dayRouteAppointmentLockKey(access.businessId)}))
        `;
        const locked = await lockTenantOwnedJob(tx, access.businessId, job.id);
        if (!locked) {
          throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_STALE_MESSAGE);
        }
        const fresh = await tx.job.findFirst({
          where: { id: job.id, businessId: access.businessId },
          select: JOB_SELECT,
        });
        if (!fresh || !fresh.scheduledAt) {
          throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_STALE_MESSAGE);
        }
        assertCurrentSnapshot(fresh, snapshot);

        const evaluation = await rejectIfScheduleBlocked({
          db: tx,
          access,
          job: fresh,
          start,
          timeZone,
        });

        const materialChange = isMaterialAppointmentChange(
          fresh,
          start,
          evaluation.durationMinutes,
        );
        const proposalId = materialChange
          ? nextAppointmentProposalId(fresh.appointmentProposalId)
          : fresh.appointmentProposalId;
        const position = appointmentPositionOnDay({
          start,
          jobId: fresh.id,
          assignedMembershipId: fresh.assignedMembershipId,
          jobs: evaluation.capacityJobs,
          dateKey: (date) => formatISODateInTimeZone(date, timeZone),
        });
        const mode = appointmentModeForPosition(position, evaluation.policy);
        const nextOccurrenceAt = recurrenceForecastActive(fresh)
          ? computeNextOccurrenceAt(
              start,
              parseRecurrenceCadence(fresh.recurrenceCadence),
              fresh.nextOccurrenceAt,
              timeZone,
            )
          : fresh.nextOccurrenceAt;
        const arrivalWindowMinutes =
          mode === "WINDOW" ? evaluation.policy.defaultArrivalWindowMinutes : null;

        const updated = await tx.job.updateMany({
          where: ownerDayRouteScheduleSnapshotWhere(access.businessId, snapshot),
          data: {
            scheduledAt: start,
            scheduledDurationMinutes: evaluation.durationMinutes,
            pickupDurationMinutes: evaluation.pickupDurationMinutes,
            arrivalWindowMinutes,
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
          throw new DayRouteAppointmentError(DAY_ROUTE_APPOINTMENT_STALE_MESSAGE);
        }

        const laneUpdates = await persistLaneArrivalWindows(tx, {
          businessId: access.businessId,
          timeZone,
          policy: evaluation.policy,
          touchedJobIds: [fresh.id],
          previousLanes: [
            {
              assignedMembershipId: fresh.assignedMembershipId,
              scheduledAt: fresh.scheduledAt,
            },
          ],
        });
        const persistedArrivalWindowMinutes =
          laneUpdates.find((row) => row.id === fresh.id)?.arrivalWindowMinutes ??
          arrivalWindowMinutes;

        if (materialChange) {
          await recordAppointmentEvent(tx, {
            businessId: access.businessId,
            jobId: fresh.id,
            eventType: "APPOINTMENT_RESCHEDULED",
            appointmentProposalId: proposalId,
            scheduledAt: start,
            scheduledDurationMinutes: evaluation.durationMinutes,
            actorKind: "OWNER",
            actorMembershipId: access.workspace.membership.id,
          });
        }

        return {
          jobId: fresh.id,
          businessId: access.businessId,
          scheduledAt: start,
          scheduledDurationMinutes: evaluation.durationMinutes,
          previousScheduledAt: fresh.scheduledAt,
          pickupDurationMinutes: evaluation.pickupDurationMinutes,
          arrivalWindowMinutes: persistedArrivalWindowMinutes,
        };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (error) {
    throwIfAppointmentSchemaMissing(error);
  }
}
