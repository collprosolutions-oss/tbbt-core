"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
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
import { evaluateStartJob } from "@/lib/job-lifecycle";
import {
  parseDurationMinutes,
  parseScheduleStart,
} from "@/lib/job-schedule";
import {
  describeScheduleWarning,
  evaluateProposedSchedule,
  hasScheduleWarning,
} from "@/lib/availability";
import { loadAvailabilitySettings, loadOccupiedJobs } from "@/lib/availability-data";
import { formatDateTime } from "@/lib/format";
import { accessArrangementWriteData } from "@/lib/property-access";
import { prisma } from "@/lib/prisma";

export type JobActionState = {
  error?: string;
  warning?: string;
  notificationWarning?: string;
  message?: string;
};

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
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  const estimateId =
    typeof formData.get("estimateId") === "string"
      ? formData.get("estimateId")!.toString().trim()
      : "";

  if (!estimateId) {
    return { error: "That estimate could not become a job." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "APPROVED") {
    return { error: "Only an approved estimate can become a job." };
  }

  const existing = await prisma.job.findFirst({
    where: {
      ...access.scope,
      estimateId: estimate.id,
    },
    select: { id: true },
  });

  if (existing) {
    redirect(`/jobs/${existing.id}`);
  }

  let propertyId: string | null = null;
  if (estimate.propertyId) {
    const property = await prisma.property.findFirst({
      where: {
        id: estimate.propertyId,
        ...access.scope,
        ...(estimate.customerId ? { customerId: estimate.customerId } : {}),
      },
    });
    if (property) {
      access.assertOwned(property);
      propertyId = property.id;
    }
  } else if (estimate.serviceRequestId) {
    const serviceRequest = access.assertOwned(
      await prisma.serviceRequest.findFirst({
        where: { id: estimate.serviceRequestId, ...access.scope },
        select: { id: true, businessId: true, propertyId: true },
      }),
    );
    propertyId = serviceRequest.propertyId;
  }

  const job = await prisma.job.create({
    data: {
      businessId: access.businessId,
      customerId: estimate.customerId,
      propertyId,
      estimateId: estimate.id,
      // Bind the Job/Work Order to the EXACT EstimateVersion the customer
      // approved (see approveEstimate() in
      // src/app/actions/public-estimate.ts), not just the live Estimate.
      // Null only for the rare pre-versioning estimate that was approved
      // with no version on record -- resolveApprovedWorkOrderScope() in
      // src/lib/job-work-order.ts falls back safely for that case.
      approvedEstimateVersionId: estimate.approvedVersionId,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });

  revalidatePath(`/estimates/${estimate.id}`);
  revalidatePath("/jobs");
  revalidatePath("/pipeline");
  redirect(`/jobs/${job.id}`);
}

export async function scheduleJob(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await ensureAppointmentConfirmationSchema(prisma);
  const jobId = readString(formData, "jobId");
  const date = readString(formData, "date");
  const time = readString(formData, "time");
  const durationPreset = readString(formData, "durationPreset");
  const customHours = readString(formData, "customHours");
  const confirmOverlap = readString(formData, "confirmOverlap") === "1";

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

  const start = parseScheduleStart(date, time);
  if (!start) {
    return { error: "Choose a valid date and start time." };
  }

  const duration = parseDurationMinutes(durationPreset, customHours);
  if (!duration.ok) {
    return { error: duration.error };
  }

  if (!confirmOverlap) {
    const [settings, others] = await Promise.all([
      loadAvailabilitySettings(prisma, access.businessId),
      loadOccupiedJobs(prisma, access.businessId, job.id),
    ]);
    const evaluation = evaluateProposedSchedule({
      start,
      durationMinutes: duration.minutes,
      settings,
      existing: others,
    });
    if (hasScheduleWarning(evaluation)) {
      return {
        warning: describeScheduleWarning(evaluation, start, formatDateTime, settings) ?? undefined,
      };
    }
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

  await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt: start,
      scheduledDurationMinutes: duration.minutes,
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
  const access = await requireBusinessAccess();
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
  const access = await requireBusinessAccess();
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
  const access = await requireBusinessAccess();
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

  revalidatePath("/jobs");
  revalidatePath("/dashboard");
  revalidatePath(`/jobs/${job.id}`);
  return {};
}

export async function markJobComplete(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
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
 * OWNER/ADMIN-only: assign, change, or remove the ONE MEMBER assigned to
 * this Job (Phase 3 / Step 4 Employee Field Workflow). An empty
 * `membershipId` removes the assignment (Unassigned).
 *
 * SECURITY: the target Membership is re-fetched scoped by
 * `access.businessId` AND `role: "MEMBER"` in the same query used to
 * validate it -- never trusted from client input alone. A membershipId
 * belonging to a different business, or to an OWNER/ADMIN membership,
 * simply does not come back, so cross-tenant assignment and
 * self-escalation-by-assignment are both structurally impossible here, not
 * just discouraged by the UI. MEMBER never reaches this action at all: it
 * is gated the same way every other job-management mutation is, by
 * CAPABILITIES.MANAGE_JOBS, which MEMBER has zero capabilities for (see
 * src/lib/authorization.ts) -- so "MEMBER cannot assign themselves or
 * anyone else" holds regardless of what a MEMBER might submit.
 */
export async function assignJobMember(
  _prev: JobActionState,
  formData: FormData,
): Promise<JobActionState> {
  const access = await requireBusinessAccess();
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
    await prisma.job.update({
      where: { id: job.id },
      data: { assignedMembershipId: null },
    });
    revalidatePath(`/jobs/${job.id}`);
    revalidatePath("/jobs");
    return {};
  }

  const membership = await prisma.membership.findFirst({
    where: {
      id: membershipId,
      businessId: access.businessId,
      role: "MEMBER",
      active: true,
    },
  });

  if (!membership) {
    return { error: "Choose a team member from this business." };
  }

  await prisma.job.update({
    where: { id: job.id },
    data: { assignedMembershipId: membership.id },
  });

  revalidatePath(`/jobs/${job.id}`);
  revalidatePath("/jobs");
  return {};
}
