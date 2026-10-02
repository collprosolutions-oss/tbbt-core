"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import { readAccessArrangementFromFormData } from "@/lib/access-arrangement-form";
import {
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  isMaterialAppointmentChange,
  isOwnerConfirmationSource,
  nextAppointmentProposalId,
  parseStartWithoutConfirmationReason,
  startJobRequiresCustomerConfirmation,
} from "@/lib/appointment-confirmation";
import { withoutMisfiledChangeRequestAccess } from "@/lib/appointment-change-request";
import {
  ensureAppointmentConfirmationSchema,
  recordAppointmentEvent,
} from "@/lib/appointment-data";
import { notifyCustomerAppointmentProposed } from "@/lib/appointment-notify";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { completeJobAndSendInvoice } from "@/lib/complete-job-invoice";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";
import {
  evaluateStartJob,
  jobAssignmentRefusalMessage,
  jobScheduleRefusalMessage,
} from "@/lib/job-lifecycle";
import {
  parseDurationMinutes,
  parseScheduleStart,
} from "@/lib/job-schedule";
import {
  describeScheduleWarning,
  evaluateProposedSchedule,
  hasScheduleWarning,
  scheduleConflictFacts,
  type OccupiedJob,
  type RecordedConflictJob,
  type ScheduleConflictFact,
} from "@/lib/availability";
import { loadAvailabilitySettings, loadOccupiedJobs } from "@/lib/availability-data";
import { formatAddress, formatDateTime } from "@/lib/format";
import { accessArrangementWriteData } from "@/lib/property-access";
import { prisma } from "@/lib/prisma";
import {
  computeNextOccurrenceAt,
  parseRecurrenceCadence,
  recurrenceForecastActive,
} from "@/lib/recurrence";
import { formatISODateInTimeZone } from "@/lib/business-timezone";
import { OWNER_DAY_ROUTE_PATH } from "@/lib/owner-day-route/constants";
import { lockBusinessScheduleReservation } from "@/lib/schedule-reservation";
import {
  appointmentModeForPosition,
  appointmentPositionOnDay,
  arrivalWindowMinutesForMode,
  parseBoundedInt,
  parseSkillList,
  pickupMinutesForJob,
  requireOptionalWorkforceProgression,
  requireWorkforceSkillKey,
  serializeSkillList,
  WorkforceValidationError,
} from "@/lib/workforce";
import { laterJobsHurtByMove } from "@/lib/workforce-capacity";
import { describeConflicts, detectScheduleConflicts } from "@/lib/workforce-conflicts";
import {
  loadCapacityJobs,
  loadSchedulingPolicy,
  loadWorkforceMembers,
  loadWorkforceTimeZone,
  persistLaneArrivalWindows,
} from "@/lib/workforce-data";
import {
  conflictAcknowledgement,
  shouldAcceptConflictAcknowledgement,
} from "@/lib/workforce-window";
import { createJobFromApprovedEstimate } from "@/lib/job-from-estimate";
import { jobWriteTestHooks } from "@/lib/job-write-test-hooks";
import { writeAssignedMembershipAndLaneWindows } from "@/lib/job-assignment-ops";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export type JobActionState = {
  error?: string;
  warning?: string;
  conflictAck?: string;
  conflicts?: ScheduleConflictFact[];
  notificationWarning?: string;
  message?: string;
};

async function ownedScheduleConflictFacts(
  overlaps: OccupiedJob[],
  businessId: string,
  timeZone: string,
): Promise<ScheduleConflictFact[]> {
  const overlapIds = [
    ...new Set(
      overlaps
        .map((job) => job.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (overlapIds.length === 0) {
    return [];
  }

  const rows = await prisma.job.findMany({
    where: {
      id: { in: overlapIds },
      businessId,
    },
    select: {
      id: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      assignedMembershipId: true,
      customer: { select: { name: true } },
      assignedMembership: { select: { user: { select: { name: true } } } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
    },
  });

  const ownedById = new Map<string, RecordedConflictJob>();
  for (const row of rows) {
    if (!row.scheduledAt) {
      continue;
    }
    ownedById.set(row.id, {
      id: row.id,
      scheduledAt: row.scheduledAt,
      scheduledDurationMinutes: row.scheduledDurationMinutes,
      customerName: row.customer?.name ?? null,
      assignedMembershipId: row.assignedMembershipId,
      assignedWorkerName: row.assignedMembership?.user?.name ?? null,
      addressSummary: row.property?.addressLine1
        ? formatAddress(row.property)
        : null,
      assignmentKnown: true,
    });
  }

  return scheduleConflictFacts(overlaps, timeZone, ownedById);
}

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateJobSurfaces(job: { id: string; projectToken: string }) {
  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath("/today");
  revalidatePath(OWNER_DAY_ROUTE_PATH);
  revalidatePath("/field");
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath(`/field/jobs/${job.id}`);
  revalidatePath(`/p/${job.projectToken}`);
}

type ScheduleProposalJob = {
  id: string;
  assignedMembershipId: string | null;
  scheduledAt: Date | null;
};

async function evaluateOwnedScheduleProposal(
  db: Parameters<typeof loadOccupiedJobs>[0],
  input: {
    businessId: string;
    job: ScheduleProposalJob;
    start: Date;
    durationMinutes: number | null;
    pickupDurationMinutes: number;
    timeZone: string;
  },
) {
  const [settings, others, policy, members, capacityJobs] = await Promise.all([
    loadAvailabilitySettings(db, input.businessId),
    loadOccupiedJobs(db, input.businessId, input.job.id),
    loadSchedulingPolicy(db, input.businessId),
    loadWorkforceMembers(db, input.businessId),
    loadCapacityJobs(db, input.businessId),
  ]);
  const evaluation = evaluateProposedSchedule({
    start: input.start,
    durationMinutes: input.durationMinutes,
    pickupMinutes: pickupMinutesForJob(input.pickupDurationMinutes, policy).minutes,
    settings,
    existing: others.map((row) => ({
      ...row,
      pickupDurationMinutes: pickupMinutesForJob(row.pickupDurationMinutes, policy)
        .minutes,
    })),
    timeZone: input.timeZone,
  });
  const conflicts = detectScheduleConflicts({
    jobs: capacityJobs,
    settings,
    policy,
    members,
    timeZone: input.timeZone,
    proposed: {
      jobId: input.job.id,
      start: input.start,
      durationMinutes: input.durationMinutes,
      pickupMinutes: input.pickupDurationMinutes,
      assignedMembershipId: input.job.assignedMembershipId,
      originalScheduledAt: input.job.scheduledAt,
    },
    now: new Date(),
  });
  const cascade = laterJobsHurtByMove({
    start: input.start,
    durationMinutes: input.durationMinutes,
    pickupMinutes: input.pickupDurationMinutes,
    settings,
    policy,
    existing: capacityJobs.filter((row) => row.id !== input.job.id),
    membershipId: input.job.assignedMembershipId,
  });
  const warning =
    (hasScheduleWarning(evaluation)
      ? describeScheduleWarning(
          evaluation,
          input.start,
          (value) => formatDateTime(value, input.timeZone),
          settings,
          input.timeZone,
        )
      : null) ?? describeConflicts(conflicts);
  const currentAck = conflictAcknowledgement({
    jobId: input.job.id,
    start: input.start,
    durationMinutes: input.durationMinutes,
    pickupMinutes: input.pickupDurationMinutes,
    assignedMembershipId: input.job.assignedMembershipId,
    conflicts: warning
      ? conflicts.length > 0
        ? conflicts
        : [{ kind: "AVAILABILITY", jobId: input.job.id, severity: "WARNING" }]
      : [],
  });
  return {
    evaluation,
    warning,
    currentAck,
    cascade,
    policy,
    capacityJobs,
  };
}

export async function createJobFromEstimate(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  const estimateId =
    typeof formData.get("estimateId") === "string"
      ? formData.get("estimateId")!.toString().trim()
      : "";

  if (!estimateId) {
    return { error: "That estimate could not become a job." };
  }

  const converted = await createJobFromApprovedEstimate(prisma, access, estimateId);
  if (!converted.ok) {
    return { error: converted.error };
  }

  revalidatePath(`/estimates/${estimateId}`);
  revalidatePath("/jobs");
  revalidatePath("/pipeline");
  redirect(`/jobs/${converted.jobId}`);
}

export async function scheduleJob(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await ensureAppointmentConfirmationSchema(prisma);
  const jobId = readString(formData, "jobId");
  const date = readString(formData, "date");
  const time = readString(formData, "time");
  const durationPreset = readString(formData, "durationPreset");
  const customHours = readString(formData, "customHours");
  const submittedAck = readString(formData, "confirmOverlapAck");
  const pickupDurationMinutes = parseBoundedInt(
    readString(formData, "pickupDurationMinutes"),
    0,
    0,
    24 * 60,
  );
  let requiredSkills: string;
  let requiredProgression: string;
  try {
    requiredSkills = serializeSkillList(
      parseSkillList(
        formData
          .getAll("requiredSkill")
          .filter((value): value is string => typeof value === "string")
          .join(","),
      ).map((skill) => requireWorkforceSkillKey(skill)),
    );
    requiredProgression = requireOptionalWorkforceProgression(
      readString(formData, "requiredProgression"),
    );
  } catch (error) {
    if (error instanceof WorkforceValidationError) {
      return { error: error.message };
    }
    throw error;
  }

  if (!jobId) {
    return { error: "That job could not be scheduled." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  const prelockRefusal = jobScheduleRefusalMessage(job.status);
  if (prelockRefusal) {
    return { error: prelockRefusal };
  }

  const timeZone = await loadWorkforceTimeZone(prisma, access.businessId);
  const start = parseScheduleStart(date, time, timeZone);
  if (!start) {
    return { error: "Choose a valid date and start time." };
  }

  const duration = parseDurationMinutes(durationPreset, customHours);
  if (!duration.ok) {
    return { error: duration.error };
  }

  const preview = await evaluateOwnedScheduleProposal(prisma, {
    businessId: access.businessId,
    job,
    start,
    durationMinutes: duration.minutes,
    pickupDurationMinutes,
    timeZone,
  });
  if (
    preview.warning &&
    shouldAcceptConflictAcknowledgement({
      submittedAck,
      currentAck: preview.currentAck,
      conflicts: preview.warning ? [preview.warning] : [],
    }) === "warn"
  ) {
    const conflicts = await ownedScheduleConflictFacts(
      preview.evaluation.overlaps,
      access.businessId,
      timeZone,
    );
    return {
      warning: preview.cascade.length
        ? `${preview.warning} Later jobs were not moved.`
        : preview.warning,
      conflictAck: preview.currentAck,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
  }

  await jobWriteTestHooks.afterScheduleJobRead?.(job.id);

  let scheduleRefusal: string | null = null;
  let lockedWarning: {
    warning: string;
    conflictAck: string;
    overlaps: OccupiedJob[];
  } | null = null;
  let persistedProposalId = job.appointmentProposalId;
  let persistedMaterialChange = false;
  let persistedRescheduled = false;

  await prisma.$transaction(
    async (tx) => {
      await lockBusinessScheduleReservation(tx, access.businessId);
      const current = await lockTenantOwnedJob(tx, access.businessId, job.id);
      if (!current) {
        scheduleRefusal = "That job could not be scheduled.";
        return;
      }
      const fresh = await tx.job.findFirst({
        where: { id: job.id, businessId: access.businessId },
      });
      if (!fresh) {
        scheduleRefusal = "That job could not be scheduled.";
        return;
      }
      const lockedRefusal = jobScheduleRefusalMessage(fresh.status);
      if (lockedRefusal) {
        scheduleRefusal = lockedRefusal;
        return;
      }

      const locked = await evaluateOwnedScheduleProposal(tx, {
        businessId: access.businessId,
        job: fresh,
        start,
        durationMinutes: duration.minutes,
        pickupDurationMinutes,
        timeZone,
      });
      if (
        locked.warning &&
        shouldAcceptConflictAcknowledgement({
          submittedAck,
          currentAck: locked.currentAck,
          conflicts: locked.warning ? [locked.warning] : [],
        }) === "warn"
      ) {
        lockedWarning = {
          warning: locked.cascade.length
            ? `${locked.warning} Later jobs were not moved.`
            : locked.warning,
          conflictAck: locked.currentAck,
          overlaps: locked.evaluation.overlaps,
        };
        return;
      }

      const materialChange = isMaterialAppointmentChange(
        fresh,
        start,
        duration.minutes,
      );
      const proposalId = materialChange
        ? nextAppointmentProposalId(fresh.appointmentProposalId)
        : fresh.appointmentProposalId;
      persistedProposalId = proposalId;
      persistedMaterialChange = materialChange;
      persistedRescheduled = Boolean(fresh.scheduledAt) && materialChange;

      const position = appointmentPositionOnDay({
        start,
        jobId: fresh.id,
        assignedMembershipId: fresh.assignedMembershipId,
        jobs: locked.capacityJobs,
        dateKey: (date) => formatISODateInTimeZone(date, timeZone),
      });
      const mode = appointmentModeForPosition(position, locked.policy);
      const nextOccurrenceAt = recurrenceForecastActive(fresh)
        ? computeNextOccurrenceAt(
            start,
            parseRecurrenceCadence(fresh.recurrenceCadence),
            fresh.nextOccurrenceAt,
            timeZone,
          )
        : fresh.nextOccurrenceAt;

      await tx.job.update({
        where: { id: job.id },
        data: {
          scheduledAt: start,
          scheduledDurationMinutes: duration.minutes,
          pickupDurationMinutes: pickupDurationMinutes || null,
          requiredSkills,
          requiredProgression,
          arrivalWindowMinutes: arrivalWindowMinutesForMode(mode, locked.policy),
          nextOccurrenceAt,
          ...(fresh.status === "UNSCHEDULED" ? { status: "SCHEDULED" } : {}),
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
      await persistLaneArrivalWindows(tx, {
        businessId: access.businessId,
        timeZone,
        policy: locked.policy,
        touchedJobIds: [job.id],
        previousLanes: [
          {
            assignedMembershipId: fresh.assignedMembershipId,
            scheduledAt: fresh.scheduledAt,
          },
        ],
      });
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

  if (scheduleRefusal) {
    return { error: scheduleRefusal };
  }
  if (lockedWarning) {
    const conflicts = await ownedScheduleConflictFacts(
      lockedWarning.overlaps,
      access.businessId,
      timeZone,
    );
    return {
      warning: lockedWarning.warning,
      conflictAck: lockedWarning.conflictAck,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
  }

  const proposalId = persistedProposalId;
  const materialChange = persistedMaterialChange;
  const rescheduled = persistedRescheduled;

  await emitAndProcessBusinessEvent(prisma, {
    businessId: access.businessId,
    type: rescheduled ? "APPOINTMENT_CHANGED" : "APPOINTMENT_SCHEDULED",
    subjectType: "JOB",
    subjectId: job.id,
    payload: {
      customerId: job.customerId,
      businessName: access.workspace.business.name,
      proposalId,
      projectToken: job.projectToken,
      scheduledAt: start.toISOString(),
      scheduledDurationMinutes: duration.minutes,
    },
    idempotencyKey: `${rescheduled ? "APPOINTMENT_CHANGED" : "APPOINTMENT_SCHEDULED"}:${job.id}:${proposalId}`,
  });

  if (materialChange) {
    await recordAppointmentEvent(prisma, {
      businessId: access.businessId,
      jobId: job.id,
      eventType: rescheduled ? "APPOINTMENT_RESCHEDULED" : "APPOINTMENT_PROPOSED",
      appointmentProposalId: proposalId,
      scheduledAt: start,
      scheduledDurationMinutes: duration.minutes,
      actorKind: "OWNER",
      actorMembershipId: access.workspace.membership.id,
    });

    const notified = await notifyCustomerAppointmentProposed(prisma, {
      businessId: access.businessId,
      jobId: job.id,
      businessName: access.workspace.business.name,
      proposalId,
      scheduledAt: start,
      scheduledDurationMinutes: duration.minutes,
      rescheduled,
      sendAttemptId: "auto",
      actorMembershipId: access.workspace.membership.id,
    });

    revalidateJobSurfaces(job);
    return notified.warning ? { notificationWarning: notified.warning } : {};
  }

  revalidateJobSurfaces(job);
  return {};
}

export async function retryAppointmentNotification(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await ensureAppointmentConfirmationSchema(prisma);
  const jobId = readString(formData, "jobId");
  const sendAttemptId = readString(formData, "sendAttemptId");

  if (!jobId || !/^[0-9a-f-]{36}$/i.test(sendAttemptId)) {
    return { error: "That appointment notification could not be sent." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  if (!job.scheduledAt) {
    return { error: "Schedule the appointment before notifying the customer." };
  }

  const notified = await notifyCustomerAppointmentProposed(prisma, {
    businessId: access.businessId,
    jobId: job.id,
    businessName: access.workspace.business.name,
    proposalId: job.appointmentProposalId,
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    rescheduled: job.appointmentProposalId > 1,
    sendAttemptId,
    actorMembershipId: access.workspace.membership.id,
  });

  revalidateJobSurfaces(job);
  if (notified.warning) {
    return { notificationWarning: notified.warning };
  }
  return { message: "Appointment notification sent." };
}

export async function recordOwnerAppointmentConfirmation(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await ensureAppointmentConfirmationSchema(prisma);
  const jobId = readString(formData, "jobId");
  const method = readString(formData, "confirmationMethod");

  if (!jobId) {
    return { error: "That appointment could not be confirmed." };
  }
  if (!isOwnerConfirmationSource(method)) {
    return { error: "Choose how the customer confirmed." };
  }

  const accessArrangement = readAccessArrangementFromFormData(formData);
  if (!accessArrangement.ok) {
    return { error: accessArrangement.error };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  if (!job.scheduledAt) {
    return { error: "Schedule the appointment before recording confirmation." };
  }

  if (
    job.appointmentConfirmationStatus === "CONFIRMED" &&
    job.appointmentConfirmedForProposalId === job.appointmentProposalId
  ) {
    revalidateJobSurfaces(job);
    return { message: "Appointment is already confirmed." };
  }

  await jobWriteTestHooks.afterOwnerConfirmRead?.(job.id);

  const updated = await prisma.job.updateMany({
    where: {
      id: job.id,
      businessId: access.businessId,
      appointmentProposalId: job.appointmentProposalId,
    },
    data: {
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedAt: new Date(),
      appointmentConfirmedForProposalId: job.appointmentProposalId,
      appointmentConfirmationSource: method,
      appointmentConfirmedByMembershipId: access.workspace.membership.id,
      appointmentChangeRequestNote: null,
      ...accessArrangementWriteData(
        withoutMisfiledChangeRequestAccess(accessArrangement.value, job),
      ),
    },
  });
  if (updated.count !== 1) {
    const latest = access.assertOwned(
      await prisma.job.findFirst({
        where: { id: job.id, ...access.scope },
      }),
    );
    if (
      latest.appointmentConfirmationStatus === "CONFIRMED" &&
      latest.appointmentConfirmedForProposalId === latest.appointmentProposalId
    ) {
      revalidateJobSurfaces(latest);
      return { message: "Appointment is already confirmed." };
    }
    return { error: "The appointment time has changed. Confirm the current time." };
  }
  await recordAppointmentEvent(prisma, {
    businessId: access.businessId,
    jobId: job.id,
    eventType: "APPOINTMENT_CONFIRMED",
    appointmentProposalId: job.appointmentProposalId,
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    actorKind: "OWNER",
    actorMembershipId: access.workspace.membership.id,
    payload: {
      confirmationSource: method,
      accessMethod: accessArrangement.value.method,
    },
  });

  revalidateJobSurfaces(job);
  return { message: "Owner recorded confirmation." };
}

export async function startJob(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  await ensureAppointmentConfirmationSchema(prisma);
  const jobId = readString(formData, "jobId");

  if (!jobId) {
    return { error: "That job could not be started." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  const result = evaluateStartJob(job.status);
  if (!result.ok) {
    return { error: result.error };
  }

  if (!result.nextStatus) {
    return {};
  }
  const nextStatus = result.nextStatus;

  await jobWriteTestHooks.afterStartJobRead?.(job.id);

  const writeStart = async (extra: Record<string, unknown> = {}) => {
    const updated = await prisma.job.updateMany({
      where: {
        id: job.id,
        businessId: access.businessId,
        status: job.status,
      },
      data: {
        status: nextStatus,
        ...extra,
      },
    });
    if (updated.count === 1) {
      return null;
    }
    const current = await prisma.job.findFirst({
      where: { id: job.id, ...access.scope },
      select: { status: true },
    });
    const latest = evaluateStartJob(current?.status ?? "");
    if (!latest.ok) {
      return { error: latest.error };
    }
    if (!latest.nextStatus) {
      return {};
    }
    return { error: "That job could not be started." };
  };

  if (startJobRequiresCustomerConfirmation(job)) {
    const override = readString(formData, "startWithoutConfirmation") === "1";
    if (!override) {
      return { error: CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT };
    }
    const reason = parseStartWithoutConfirmationReason(
      readString(formData, "overrideReason"),
    );
    if (!reason) {
      return { error: "Choose why you are starting without customer confirmation." };
    }
    let reasonLabel: string = reason.label;
    if (reason.id === "OTHER") {
      const other = readString(formData, "overrideOther");
      if (!other) {
        return { error: "Enter a reason." };
      }
      reasonLabel = `Other: ${other}`;
    }

    const writeError = await writeStart({
      startWithoutConfirmationAt: new Date(),
      startWithoutConfirmationReason: reasonLabel,
      startWithoutConfirmationByMembershipId: access.workspace.membership.id,
    });
    if (writeError) {
      return writeError;
    }
    await recordAppointmentEvent(prisma, {
      businessId: access.businessId,
      jobId: job.id,
      eventType: "APPOINTMENT_CONFIRMATION_OVERRIDE",
      appointmentProposalId: job.appointmentProposalId,
      scheduledAt: job.scheduledAt,
      scheduledDurationMinutes: job.scheduledDurationMinutes,
      actorKind: "OWNER",
      actorMembershipId: access.workspace.membership.id,
      payload: { overrideReason: reasonLabel },
    });
  } else {
    const writeError = await writeStart();
    if (writeError) {
      return writeError;
    }
  }

  await emitAndProcessBusinessEvent(prisma, {
    businessId: access.businessId,
    type: "JOB_STARTED",
    subjectType: "JOB",
    subjectId: job.id,
    payload: { customerId: job.customerId },
    idempotencyKey: `JOB_STARTED:${job.id}`,
  });

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function markJobComplete(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  const jobId = readString(formData, "jobId");

  if (!jobId) {
    return { error: "That job could not be completed." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  const result = await completeJobAndSendInvoice(prisma, {
    businessId: access.businessId,
    jobId: job.id,
    businessName: access.workspace.business.name,
    actorMembershipId: access.workspace.membership.id,
  });

  if (!result.ok) {
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    revalidatePath(`/jobs/${job.id}`);
    if (result.invoiceId) {
      revalidatePath(`/invoices/${result.invoiceId}`);
    }
    return { error: result.error };
  }

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath("/invoices");
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath(`/invoices/${result.invoiceId}`);
  return result.warning ? { warning: result.warning } : {};
}

/**
 * OWNER/ADMIN-only: assign, change, or remove the one worker assigned to
 * this Job (Phase 3 / Step 4 Employee Field Workflow). An empty
 * `membershipId` removes the assignment (Unassigned).
 *
 * A selected target is valid only when:
 *   A. membershipId is empty → unassign
 *   B. the membership belongs to access.businessId, is active, and
 *      role === MEMBER
 *   C. SELF ASSIGNMENT: the membership is the caller's own active
 *      membership in this business AND the actor role is OWNER or ADMIN
 *
 * OWNER/ADMIN self-assignment does NOT allow assigning some other
 * OWNER or ADMIN. Browser-supplied businessId/role are never trusted;
 * tenant and actor identity come from the authenticated workspace.
 *
 * SECURITY: the target Membership is re-fetched scoped by
 * `access.businessId` AND `active: true` in the same query used to
 * validate it. Role is then checked against that persisted row plus the
 * authenticated workspace. MEMBER never reaches this action at all: it
 * is gated the same way every other job-management mutation is, by
 * CAPABILITIES.MANAGE_JOBS, which MEMBER has zero capabilities for (see
 * src/lib/authorization.ts).
 */
export async function assignJobMember(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.JOBS_TASKS);
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  const jobId = readString(formData, "jobId");
  const membershipId = readString(formData, "membershipId");

  if (!jobId) {
    return { error: "That job could not be found." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  const assignmentRefusal = jobAssignmentRefusalMessage(job.status);
  if (assignmentRefusal) {
    return { error: assignmentRefusal };
  }

  if (!membershipId) {
    const unassigned = await writeAssignedMembershipAndLaneWindows(prisma, {
      businessId: access.businessId,
      job,
      nextAssignedMembershipId: null,
      actorMembershipId: access.workspace.membership.id,
    });
    if (unassigned?.error) {
      return unassigned;
    }
    revalidateJobSurfaces(job);
    return {};
  }

  const membership = await prisma.membership.findFirst({
    where: {
      id: membershipId,
      businessId: access.businessId,
      active: true,
    },
  });

  const actorRole = access.workspace.role;
  const actorMembershipId = access.workspace.membership.id;
  const isActiveMember = membership?.role === "MEMBER";
  const isSelfAssignment =
    membership != null &&
    membership.id === actorMembershipId &&
    (actorRole === "OWNER" || actorRole === "ADMIN");

  if (!membership || (!isActiveMember && !isSelfAssignment)) {
    return { error: "Choose a team member from this business." };
  }

  const assigned = await writeAssignedMembershipAndLaneWindows(prisma, {
    businessId: access.businessId,
    job,
    nextAssignedMembershipId: membership.id,
    actorMembershipId: access.workspace.membership.id,
  });
  if (assigned?.error) {
    return assigned;
  }

  revalidateJobSurfaces(job);
  return {};
}

