/**
 * Owner/admin Today + Needs Attention view-model.
 *
 * Reuses existing Job schedule fields, appointment confirmation helpers,
 * and Revenue Integrity completed-unbilled facts. This module does not
 * invent a second schedule, invoice-balance, or notification model.
 */
import {
  appointmentConfirmationLabel,
  appointmentAwaitingCustomerAction,
  effectiveAppointmentConfirmationStatus,
  isCurrentAppointmentConfirmed,
  notificationOwnerMessage,
  parseAppointmentChangeRequestNote,
  type AppointmentConfirmationStatus,
  type AppointmentJobFields,
} from "@/lib/appointment-confirmation";
import { directionsUrl, telHref } from "@/lib/directions";
import { formatAddress, formatTime } from "@/lib/format";
import { expectedEnd } from "@/lib/job-schedule";
import {
  completedJobBillingAttention,
  type BillingChangeOrderLike,
  type BillingInvoiceLike,
  type CompletedJobBillingAttention,
} from "@/lib/revenue-integrity";

export const OWNER_TODAY_JOBS_TAKE = 25;
export const OWNER_TODAY_HANDOFF_TAKE = 25;
export const OWNER_TODAY_APPOINTMENT_TAKE = 25;

export const OWNER_TODAY_CREATE_INVOICE_LABEL = "Create & send invoice";
export const OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL =
  "Create & send balance invoice";
export const OWNER_TODAY_FIELD_COMPLETION_COPY =
  "Field completion does not send an invoice. Creating and sending an invoice remains an owner/admin action.";

export type DateRangeLike = { start: Date; end: Date };

export const OWNER_TODAY_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  arrivalWindowMinutes: true,
  pickupDurationMinutes: true,
  assignedMembershipId: true,
  projectToken: true,
  appointmentConfirmationStatus: true,
  appointmentProposalId: true,
  appointmentConfirmedForProposalId: true,
  appointmentConfirmationSource: true,
  appointmentChangeRequestNote: true,
  appointmentNotificationStatus: true,
  appointmentNotificationError: true,
  appointmentNotifiedForProposalId: true,
  propertyAccessMethod: true,
  propertyAccessInstructions: true,
  propertyAccessContactName: true,
  propertyAccessContactInfo: true,
  propertyAccessPickupLocation: true,
  propertyAccessNote: true,
  customer: { select: { id: true, name: true, phone: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
  assignedMembership: {
    select: { id: true, user: { select: { name: true } } },
  },
} as const;

export const OWNER_TODAY_HANDOFF_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  estimateId: true,
  status: true,
  customer: { select: { name: true } },
  invoices: {
    select: { id: true, status: true, kind: true, createdAt: true, total: true },
  },
  changeOrders: {
    select: {
      id: true,
      status: true,
      total: true,
      invoiceId: true,
      approvedAt: true,
      createdAt: true,
    },
  },
  estimate: { select: { total: true } },
  approvedEstimateVersion: { select: { total: true } },
} as const;

export function ownerTodayScheduledWhere(range: DateRangeLike) {
  return {
    scheduledAt: { gte: range.start, lt: range.end },
  };
}

/**
 * Today + upcoming appointment candidates. Inclusion still goes through
 * effectiveAppointmentConfirmationStatus() so confirmed work stays off.
 */
export function ownerTodayAppointmentCandidateWhere(start: Date) {
  return {
    scheduledAt: { gte: start },
    status: { not: "COMPLETED" as const },
    OR: [
      { appointmentConfirmationStatus: "AWAITING_CUSTOMER" },
      { appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED" },
      { appointmentChangeRequestNote: { not: null } },
    ],
  };
}

export function isJobScheduledOnDay(
  scheduledAt: Date | null | undefined,
  range: DateRangeLike,
) {
  if (!scheduledAt) return false;
  return scheduledAt >= range.start && scheduledAt < range.end;
}

export function ownerTodayTimeWindowLabel(
  job: {
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
    arrivalWindowMinutes?: number | null;
  },
  timeZone?: string,
) {
  if (!job.scheduledAt) return null;
  const start = formatTime(job.scheduledAt, timeZone);
  if (job.scheduledDurationMinutes && job.scheduledDurationMinutes > 0) {
    return `${start} – ${formatTime(
      expectedEnd(job.scheduledAt, job.scheduledDurationMinutes),
      timeZone,
    )}`;
  }
  if (job.arrivalWindowMinutes && job.arrivalWindowMinutes > 0) {
    return `${start} · ${job.arrivalWindowMinutes}-min window`;
  }
  return start;
}

export function ownerTodayMaterialPickupRecorded(
  pickupDurationMinutes: number | null | undefined,
) {
  return pickupDurationMinutes != null && pickupDurationMinutes > 0;
}

export function ownerTodayAssignmentState(job: {
  assignedMembershipId: string | null;
  assignedMembership?: { user?: { name: string | null } | null } | null;
}) {
  if (!job.assignedMembershipId) {
    return {
      kind: "UNASSIGNED" as const,
      label: "Unassigned",
      assignedMembershipId: null,
      assigneeName: null,
    };
  }
  const assigneeName = job.assignedMembership?.user?.name?.trim() || "Assigned";
  return {
    kind: "ASSIGNED" as const,
    label: assigneeName,
    assignedMembershipId: job.assignedMembershipId,
    assigneeName,
  };
}

export type OwnerTodayAppointmentState = {
  status: AppointmentConfirmationStatus;
  label: string;
  awaitingCustomer: boolean;
  differentTimeRequested: boolean;
  customerNote: string | null;
  notificationMessage: string | null;
  confirmed: boolean;
};

export function ownerTodayAppointmentState(
  job: AppointmentJobFields & {
    appointmentNotificationStatus?: string | null;
    appointmentNotificationError?: string | null;
  },
): OwnerTodayAppointmentState {
  const status = effectiveAppointmentConfirmationStatus(job);
  return {
    status,
    label: appointmentConfirmationLabel(status),
    awaitingCustomer: status === "AWAITING_CUSTOMER",
    differentTimeRequested: status === "DIFFERENT_TIME_REQUESTED",
    customerNote:
      status === "DIFFERENT_TIME_REQUESTED"
        ? parseAppointmentChangeRequestNote(job.appointmentChangeRequestNote ?? "")
        : null,
    notificationMessage: notificationOwnerMessage({
      appointmentNotificationStatus: job.appointmentNotificationStatus ?? null,
      appointmentNotificationError: job.appointmentNotificationError ?? null,
    }),
    confirmed: isCurrentAppointmentConfirmed(job),
  };
}

export type OwnerTodayJobRecord = AppointmentJobFields & {
  id: string;
  businessId: string;
  customerId?: string | null;
  status: string;
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  arrivalWindowMinutes?: number | null;
  pickupDurationMinutes?: number | null;
  assignedMembershipId: string | null;
  projectToken: string;
  appointmentNotificationStatus?: string | null;
  appointmentNotificationError?: string | null;
  customer?: { id?: string | null; name: string | null; phone?: string | null } | null;
  property?: {
    addressLine1: string;
    addressLine2?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
  } | null;
  assignedMembership?: { user?: { name: string | null } | null } | null;
};

export type OwnerTodayJobView = {
  jobId: string;
  businessId: string;
  status: string;
  customerId: string | null;
  customerName: string;
  address: string | null;
  timeWindowLabel: string | null;
  assignment: ReturnType<typeof ownerTodayAssignmentState>;
  appointment: OwnerTodayAppointmentState;
  materialPickupRecorded: boolean;
  jobHref: string;
  customerHref: string | null;
  fieldHref: string | null;
  projectToken: string;
  directionsHref: string | null;
  callHref: string | null;
  canStart: boolean;
  appointmentConfirmed: boolean;
};

/**
 * Owned action refs only. A cross-tenant job returns null so copy/open
 * controls cannot be built from a foreign record.
 */
export function ownerTodayOwnedActionRefs(
  job: Pick<
    OwnerTodayJobRecord,
    "id" | "businessId" | "customerId" | "projectToken" | "property" | "assignedMembershipId" | "customer"
  >,
  businessId: string,
  viewerMembershipId?: string | null,
) {
  if (job.businessId !== businessId) return null;
  return {
    jobHref: `/jobs/${job.id}`,
    customerHref: job.customerId ? `/customers/${job.customerId}` : null,
    projectToken: job.projectToken,
    directionsHref: directionsUrl(job.property ?? null),
    callHref: telHref(job.customer?.phone ?? null),
    fieldHref:
      viewerMembershipId && job.assignedMembershipId === viewerMembershipId
        ? `/field/jobs/${job.id}`
        : null,
  };
}

export function buildOwnerTodayJobView(
  job: OwnerTodayJobRecord,
  options: {
    businessId: string;
    range: DateRangeLike;
    timeZone?: string;
    viewerMembershipId?: string | null;
  },
): OwnerTodayJobView | null {
  if (!isJobScheduledOnDay(job.scheduledAt, options.range)) return null;
  const actions = ownerTodayOwnedActionRefs(
    job,
    options.businessId,
    options.viewerMembershipId,
  );
  if (!actions) return null;

  const appointment = ownerTodayAppointmentState(job);
  return {
    jobId: job.id,
    businessId: job.businessId,
    status: job.status,
    customerId: job.customerId ?? job.customer?.id ?? null,
    customerName: job.customer?.name?.trim() || "Customer",
    address: job.property ? formatAddress(job.property) : null,
    timeWindowLabel: ownerTodayTimeWindowLabel(job, options.timeZone),
    assignment: ownerTodayAssignmentState(job),
    appointment,
    materialPickupRecorded: ownerTodayMaterialPickupRecorded(job.pickupDurationMinutes),
    jobHref: actions.jobHref,
    customerHref: actions.customerHref,
    fieldHref: actions.fieldHref,
    projectToken: actions.projectToken,
    directionsHref: actions.directionsHref,
    callHref: actions.callHref,
    canStart: job.status !== "COMPLETED" && job.status !== "IN_PROGRESS",
    appointmentConfirmed: appointment.confirmed,
  };
}

export function buildOwnerTodayJobs(
  jobs: readonly OwnerTodayJobRecord[],
  options: {
    businessId: string;
    range: DateRangeLike;
    timeZone?: string;
    viewerMembershipId?: string | null;
  },
): OwnerTodayJobView[] {
  const items: OwnerTodayJobView[] = [];
  for (const job of jobs) {
    const view = buildOwnerTodayJobView(job, options);
    if (view) items.push(view);
  }
  items.sort((left, right) => {
    const leftTime = jobs.find((job) => job.id === left.jobId)?.scheduledAt?.getTime() ?? 0;
    const rightTime = jobs.find((job) => job.id === right.jobId)?.scheduledAt?.getTime() ?? 0;
    return leftTime - rightTime;
  });
  return items;
}

export type OwnerTodayAppointmentAttentionItem = {
  jobId: string;
  kind: "AWAITING_CUSTOMER" | "DIFFERENT_TIME_REQUESTED";
  title: string;
  customerName: string;
  whenLabel: string | null;
  customerNote: string | null;
  notificationMessage: string | null;
  href: string;
};

export function buildOwnerTodayAppointmentAttention(
  jobs: readonly OwnerTodayJobRecord[],
  options: { businessId: string; start: Date; timeZone?: string },
): OwnerTodayAppointmentAttentionItem[] {
  const items: OwnerTodayAppointmentAttentionItem[] = [];
  for (const job of jobs) {
    if (job.businessId !== options.businessId) continue;
    if (!job.scheduledAt || job.scheduledAt < options.start) continue;
    if (job.status === "COMPLETED") continue;
    if (!appointmentAwaitingCustomerAction(job)) continue;
    const appointment = ownerTodayAppointmentState(job);
    const kind = appointment.differentTimeRequested
      ? "DIFFERENT_TIME_REQUESTED"
      : "AWAITING_CUSTOMER";
    items.push({
      jobId: job.id,
      kind,
      title:
        kind === "DIFFERENT_TIME_REQUESTED"
          ? "Customer requested a different time"
          : "Unconfirmed appointment",
      customerName: job.customer?.name?.trim() || "Customer",
      whenLabel: ownerTodayTimeWindowLabel(job, options.timeZone),
      customerNote: appointment.customerNote,
      notificationMessage: appointment.notificationMessage,
      href: `/jobs/${job.id}`,
    });
  }
  return items;
}

export function ownerTodayInvoiceActionLabel(
  attention: CompletedJobBillingAttention,
) {
  if (!attention.unbilled) return null;
  if (attention.reason === "unbilled-change-orders") {
    return OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL;
  }
  return OWNER_TODAY_CREATE_INVOICE_LABEL;
}

export type OwnerTodayHandoffRecord = {
  id: string;
  businessId: string;
  status: string;
  customerId?: string | null;
  estimateId?: string | null;
  customer?: { name: string | null } | null;
  invoices: readonly BillingInvoiceLike[];
  changeOrders: readonly BillingChangeOrderLike[];
  estimate?: { total: BillingInvoiceLike["total"] } | null;
  approvedEstimateVersion?: { total: BillingInvoiceLike["total"] } | null;
};

export type OwnerTodayHandoffItem = {
  jobId: string;
  customerName: string;
  href: string;
  invoiceActionLabel: typeof OWNER_TODAY_CREATE_INVOICE_LABEL | typeof OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL;
  reason: Extract<CompletedJobBillingAttention, { unbilled: true }>["reason"];
  detail: string;
};

/**
 * Field→office handoff. Uses completedJobBillingAttention() from #114.
 * Does not recreate invoice-balance math and does not send invoices.
 */
export function buildOwnerTodayHandoffItems(
  jobs: readonly OwnerTodayHandoffRecord[],
  businessId: string,
): OwnerTodayHandoffItem[] {
  const items: OwnerTodayHandoffItem[] = [];
  for (const job of jobs) {
    if (job.businessId !== businessId) continue;
    const attention = completedJobBillingAttention({
      jobStatus: job.status,
      originalApprovedTotal:
        job.approvedEstimateVersion?.total ?? job.estimate?.total ?? null,
      invoices: job.invoices,
      changeOrders: job.changeOrders,
    });
    const invoiceActionLabel = ownerTodayInvoiceActionLabel(attention);
    if (!attention.unbilled || !invoiceActionLabel) continue;
    items.push({
      jobId: job.id,
      customerName: job.customer?.name?.trim() || "Customer",
      href: `/jobs/${job.id}`,
      invoiceActionLabel,
      reason: attention.reason,
      detail: attention.detail,
    });
  }
  return items;
}

export function ownerTodayViewerHasAssignedFieldJob(
  jobs: readonly Pick<OwnerTodayJobRecord, "assignedMembershipId">[],
  viewerMembershipId: string | null | undefined,
) {
  if (!viewerMembershipId) return false;
  return jobs.some((job) => job.assignedMembershipId === viewerMembershipId);
}
