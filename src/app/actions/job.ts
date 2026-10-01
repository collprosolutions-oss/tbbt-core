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
import { evaluateStartJob } from "@/lib/job-lifecycle";
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
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath(`/p/${job.projectToken}`);
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

  if (job.status === "COMPLETED") {
    return { error: "A completed job cannot be rescheduled." };
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

  const [settings, others, policy, members, capacityJobs] = await Promise.all([
    loadAvailabilitySettings(prisma, access.businessId),
    loadOccupiedJobs(prisma, access.businessId, job.id),
    loadSchedulingPolicy(prisma, access.businessId),
    loadWorkforceMembers(prisma, access.businessId),
    loadCapacityJobs(prisma, access.businessId),
  ]);
  const evaluation = evaluateProposedSchedule({
    start,
    durationMinutes: duration.minutes,
    pickupMinutes: pickupMinutesForJob(pickupDurationMinutes, policy).minutes,
    settings,
    existing: others.map((row) => ({
      ...row,
      pickupDurationMinutes: pickupMinutesForJob(row.pickupDurationMinutes, policy)
        .minutes,
    })),
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
      durationMinutes: duration.minutes,
      pickupMinutes: pickupDurationMinutes,
      assignedMembershipId: job.assignedMembershipId,
      originalScheduledAt: job.scheduledAt,
    },
    now: new Date(),
  });
  const cascade = laterJobsHurtByMove({
    start,
    durationMinutes: duration.minutes,
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
    durationMinutes: duration.minutes,
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
      submittedAck,
      currentAck,
      conflicts: warning ? [warning] : [],
    }) === "warn"
  ) {
    const conflicts = await ownedScheduleConflictFacts(
      evaluation.overlaps,
      access.businessId,
      timeZone,
    );
    return {
      warning: cascade.length ? `${warning} Later jobs were not moved.` : warning,
      conflictAck: currentAck,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
  }

  const materialChange = isMaterialAppointmentChange(
    job,
    start,
    duration.minutes,
  );
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

  await prisma.$transaction(
    async (tx) => {
      await lockBusinessScheduleReservation(tx, access.businessId);
      await tx.job.update({
        where: { id: job.id },
        data: {
          scheduledAt: start,
          scheduledDurationMinutes: duration.minutes,
          pickupDurationMinutes: pickupDurationMinutes || null,
          requiredSkills,
          requiredProgression,
          arrivalWindowMinutes: arrivalWindowMinutesForMode(mode, policy),
          nextOccurrenceAt,
          ...(job.status === "UNSCHEDULED" ? { status: "SCHEDULED" } : {}),
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
        policy,
        touchedJobIds: [job.id],
        previousLanes: [
          {
            assignedMembershipId: job.assignedMembershipId,
            scheduledAt: job.scheduledAt,
          },
        ],
      });
    },
    { maxWait: 10_000, timeout: 20_000 },
  );

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

  await prisma.job.update({
    where: { id: job.id },
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

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: result.nextStatus,
        startWithoutConfirmationAt: new Date(),
        startWithoutConfirmationReason: reasonLabel,
        startWithoutConfirmationByMembershipId: access.workspace.membership.id,
      },
    });
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
    await prisma.job.update({
      where: { id: job.id },
      data: { status: result.nextStatus },
    });
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
  if (result.invoiceId) {
    revalidatePath(`/invoices/${result.invoiceId}`);
  }
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

  if (!membershipId) {
    await writeAssignedMembershipAndLaneWindows(access.businessId, job, null);
    revalidatePath(`/jobs/${job.id}`);
    revalidatePath("/jobs");
    revalidatePath("/field");
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

  await writeAssignedMembershipAndLaneWindows(access.businessId, job, membership.id);

  revalidatePath(`/jobs/${job.id}`);
  revalidatePath("/jobs");
  revalidatePath("/field");
  revalidatePath(`/field/jobs/${job.id}`);
  return {};
}

async function writeAssignedMembershipAndLaneWindows(
  businessId: string,
  job: {
    id: string;
    scheduledAt: Date | null;
    assignedMembershipId: string | null;
    status: string;
  },
  nextAssignedMembershipId: string | null,
) {
  await prisma.$transaction(
    async (tx) => {
      await lockBusinessScheduleReservation(tx, businessId);
      await tx.job.update({
        where: { id: job.id },
        data: { assignedMembershipId: nextAssignedMembershipId },
      });
      await syncAssignedJobArrivalWindows(tx, businessId, job);
    },
    { maxWait: 10_000, timeout: 20_000 },
  );
}

async function syncAssignedJobArrivalWindows(
  db: Parameters<typeof persistLaneArrivalWindows>[0],
  businessId: string,
  previous: {
    id: string;
    scheduledAt: Date | null;
    assignedMembershipId: string | null;
  },
) {
  if (!previous.scheduledAt) {
    return;
  }
  const [policy, timeZone] = await Promise.all([
    loadSchedulingPolicy(db, businessId),
    loadWorkforceTimeZone(db, businessId),
  ]);
  await persistLaneArrivalWindows(db, {
    businessId,
    timeZone,
    policy,
    touchedJobIds: [previous.id],
    previousLanes: [
      {
        assignedMembershipId: previous.assignedMembershipId,
        scheduledAt: previous.scheduledAt,
      },
    ],
  });
}
