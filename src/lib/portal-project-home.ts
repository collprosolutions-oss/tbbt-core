/**
 * Customer Project Portal — Project Home presentation.
 *
 * Read-only helpers for /p/[token]. Token lookup only. No mutations.
 * Does not use the owner communications timeline loader.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  customerAppointmentStatusLabel,
  effectiveAppointmentConfirmationStatus,
  isCurrentAppointmentConfirmed,
  type AppointmentJobFields,
} from "@/lib/appointment-confirmation";
import { customerFacingChangeOrderStatusLabel } from "@/lib/change-order";
import { isPublicEstimateDocumentVisible } from "@/lib/estimate-document";
import { formatDateTime, formatTime } from "@/lib/format";
import { customerFacingJobStatusLabel } from "@/lib/project-progress";
import { requestedWorkLabels, requestedWorkSummary } from "@/lib/service-request-work";

type PortalDb = PrismaClient | Prisma.TransactionClient;

export const PORTAL_CUSTOMER_VISIBLE_MESSAGE_STATUSES = [
  "SENT",
  "DELIVERED",
] as const;

export type PortalCustomerVisibleMessageStatus =
  (typeof PORTAL_CUSTOMER_VISIBLE_MESSAGE_STATUSES)[number];

export const PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS = [
  "EMAIL",
  "SMS",
  "PORTAL",
] as const;

export type PortalCustomerVisibleMessageChannel =
  (typeof PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS)[number];

export const PORTAL_FORBIDDEN_CUSTOMER_CLAIMS = [
  "Technician is on the way",
  "Your message was read",
] as const;

export function isPortalCustomerVisibleMessageStatus(
  status: string,
): status is PortalCustomerVisibleMessageStatus {
  return (
    PORTAL_CUSTOMER_VISIBLE_MESSAGE_STATUSES as readonly string[]
  ).includes(status);
}

export function isPortalCustomerVisibleMessageChannel(
  channel: string,
): channel is PortalCustomerVisibleMessageChannel {
  return (
    PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS as readonly string[]
  ).includes(channel);
}

/** SENT is never labeled Delivered. No read-receipt language exists here. */
export function customerFacingPortalMessageStatus(status: string): string | null {
  if (status === "DELIVERED") return "Delivered";
  if (status === "SENT") return "Sent";
  return null;
}

export function customerFacingPortalMessagePurpose(purpose: string): string {
  switch (purpose) {
    case "ESTIMATE_READY":
      return "Estimate";
    case "APPOINTMENT_CONFIRMATION":
    case "APPOINTMENT_REMINDER":
    case "SCHEDULE_CHANGE":
      return "Appointment";
    case "INVOICE_READY":
    case "PAYMENT_REMINDER":
      return "Invoice";
    case "JOB_FOLLOW_UP":
    case "JOB_UPDATE":
    case "REPEAT_FOLLOW_UP":
      return "Project update";
    case "ESTIMATE_FOLLOW_UP":
      return "Estimate follow-up";
    case "REVIEW_REQUEST":
    case "REVIEW_REMINDER":
      return "Review request";
    case "REFERRAL_REQUEST":
      return "Referral";
    default:
      return "Message";
  }
}

export function customerFacingAdditionalWorkStatus(status: string): string {
  switch (status) {
    case "OPEN":
      return "Submitted";
    case "CONVERTED":
      return "Converted to a Change Order";
    case "DISMISSED":
      return "Closed";
    default:
      return "Submitted";
  }
}

export function customerFacingEstimateStatus(status: string): string {
  switch (status) {
    case "SENT":
      return "Ready for your review";
    case "APPROVED":
      return "Approved";
    default:
      return "Not available";
  }
}

export function customerFacingInvoiceTruth(status: string | null | undefined): {
  label: string;
  paid: boolean;
} {
  if (status === "PAID") return { label: "Paid", paid: true };
  if (status === "SENT") return { label: "Outstanding", paid: false };
  return { label: "Not available yet", paid: false };
}

export function portalAppointmentWindowEnd(
  scheduledAt: Date,
  arrivalWindowMinutes: number | null | undefined,
): Date | null {
  if (!arrivalWindowMinutes || arrivalWindowMinutes <= 0) return null;
  return new Date(scheduledAt.getTime() + arrivalWindowMinutes * 60 * 1000);
}

export function portalAppointmentWhenLabel(
  scheduledAt: Date | null | undefined,
  arrivalWindowMinutes: number | null | undefined,
  timeZone: string,
): { kind: "none" | "exact" | "window"; label: string } {
  if (!scheduledAt) {
    return { kind: "none", label: "Not scheduled" };
  }
  const windowEnd = portalAppointmentWindowEnd(scheduledAt, arrivalWindowMinutes);
  if (windowEnd) {
    return {
      kind: "window",
      label: `Arrival window: ${formatDateTime(scheduledAt, timeZone)} – ${formatTime(windowEnd, timeZone)}`,
    };
  }
  return {
    kind: "exact",
    label: `Appointment time: ${formatDateTime(scheduledAt, timeZone)}`,
  };
}

export function portalAppointmentConfirmationCopy(job: AppointmentJobFields): {
  confirmed: boolean;
  status: ReturnType<typeof effectiveAppointmentConfirmationStatus>;
  label: string;
} {
  const status = effectiveAppointmentConfirmationStatus(job);
  const confirmed = isCurrentAppointmentConfirmed(job);
  return {
    confirmed,
    status,
    label: customerAppointmentStatusLabel(status),
  };
}

export type PortalNextActionKind =
  | "review_estimate"
  | "confirm_appointment"
  | "review_change_order"
  | "pay_invoice"
  | "view_invoice"
  | "pay_deposit"
  | "view_appointment"
  | "none";

export type PortalNextAction = {
  kind: PortalNextActionKind;
  title: string;
  detail: string;
  href: string;
};

export function resolvePortalNextAction(input: {
  projectToken: string;
  estimatePublicToken: string | null;
  estimateStatus: string | null;
  appointmentScheduled: boolean;
  appointmentConfirmed: boolean;
  appointmentStatus: ReturnType<typeof effectiveAppointmentConfirmationStatus>;
  pendingChangeOrderCount: number;
  showPayInvoice: boolean;
  showPayDeposit: boolean;
  invoiceStatus: string | null;
}): PortalNextAction {
  const token = input.projectToken;
  if (
    input.estimatePublicToken &&
    input.estimateStatus === "SENT" &&
    isPublicEstimateDocumentVisible(input.estimateStatus)
  ) {
    return {
      kind: "review_estimate",
      title: "Review estimate",
      detail: "Your estimate is ready. Review and approve it when you are ready.",
      href: `/e/${input.estimatePublicToken}`,
    };
  }
  if (
    input.appointmentScheduled &&
    !input.appointmentConfirmed &&
    input.appointmentStatus === "AWAITING_CUSTOMER"
  ) {
    return {
      kind: "confirm_appointment",
      title: "Confirm appointment",
      detail: "Please confirm this appointment, or request a different time.",
      href: `#appointment`,
    };
  }
  if (input.pendingChangeOrderCount > 0) {
    return {
      kind: "review_change_order",
      title: "Review Change Order",
      detail:
        input.pendingChangeOrderCount === 1
          ? "A change order is waiting for your approval."
          : `${input.pendingChangeOrderCount} change orders are waiting for your approval.`,
      href: `#change-orders`,
    };
  }
  if (input.showPayInvoice) {
    return {
      kind: "pay_invoice",
      title: "Pay invoice",
      detail: "An invoice is outstanding. You can pay it from this project.",
      href: `#invoice`,
    };
  }
  if (input.invoiceStatus === "SENT" || input.invoiceStatus === "PAID") {
    return {
      kind: "view_invoice",
      title: "View invoice",
      detail:
        input.invoiceStatus === "PAID"
          ? "Your invoice is paid. You can view or download it anytime."
          : "Your invoice is ready to view.",
      href: `/p/${token}/invoice`,
    };
  }
  if (input.showPayDeposit) {
    return {
      kind: "pay_deposit",
      title: "Pay material deposit",
      detail: "A material deposit is still due for this project.",
      href: `#deposit`,
    };
  }
  if (input.appointmentScheduled) {
    return {
      kind: "view_appointment",
      title: "View scheduled appointment",
      detail: "Your next appointment is listed below.",
      href: `#appointment`,
    };
  }
  return {
    kind: "none",
    title: "No action needed right now",
    detail: "We will update this project as work moves forward.",
    href: `#project-status`,
  };
}

export type PortalCommunicationItem = {
  id: string;
  occurredAt: Date;
  direction: "INBOUND" | "OUTBOUND" | null;
  channel: string;
  purposeLabel: string;
  body: string;
  statusLabel: string;
};

const PORTAL_COMMUNICATION_SELECT = {
  id: true,
  direction: true,
  channel: true,
  purpose: true,
  bodySnapshot: true,
  status: true,
  createdAt: true,
  attemptedAt: true,
} as const;

/**
 * Customer-visible messages for this project token only.
 * Resolves the Job from projectToken, then loads this customer + this
 * business + this job/estimate/invoice/request graph. Sibling customers
 * and foreign businesses cannot appear.
 *
 * SENT/DELIVERED alone is not enough: MANUAL/SYSTEM/PHONE (and inbound)
 * rows can persist as SENT without being a customer-facing delivery.
 * Portal bodies require outbound EMAIL, SMS, or PORTAL plus SENT/DELIVERED.
 */
export async function loadPortalCustomerCommunications(
  db: PortalDb,
  token: string,
): Promise<PortalCommunicationItem[]> {
  const trimmed = token.trim();
  if (!trimmed) return [];

  const job = await db.job.findUnique({
    where: { projectToken: trimmed },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      estimateId: true,
      estimate: { select: { serviceRequestId: true } },
      invoices: { select: { id: true } },
    },
  });
  if (!job?.customerId) return [];

  const relatedOr: Prisma.CustomerCommunicationWhereInput[] = [
    { relatedType: "JOB", relatedId: job.id },
  ];
  if (job.estimateId) {
    relatedOr.push({ relatedType: "ESTIMATE", relatedId: job.estimateId });
  }
  if (job.estimate?.serviceRequestId) {
    relatedOr.push({
      relatedType: "SERVICE_REQUEST",
      relatedId: job.estimate.serviceRequestId,
    });
  }
  if (job.invoices.length > 0) {
    relatedOr.push({
      relatedType: "INVOICE",
      relatedId: { in: job.invoices.map((invoice) => invoice.id) },
    });
  }

  const rows = await db.customerCommunication.findMany({
    where: {
      businessId: job.businessId,
      customerId: job.customerId,
      direction: "OUTBOUND",
      channel: { in: [...PORTAL_CUSTOMER_VISIBLE_MESSAGE_CHANNELS] },
      status: { in: [...PORTAL_CUSTOMER_VISIBLE_MESSAGE_STATUSES] },
      OR: relatedOr,
    },
    orderBy: [{ attemptedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: PORTAL_COMMUNICATION_SELECT,
  });

  return rows.flatMap((row) => {
    if (row.direction !== "OUTBOUND") return [];
    if (!isPortalCustomerVisibleMessageChannel(row.channel)) return [];
    const statusLabel = customerFacingPortalMessageStatus(row.status);
    if (!statusLabel) return [];
    return [
      {
        id: row.id,
        occurredAt: row.attemptedAt ?? row.createdAt,
        direction: "OUTBOUND",
        channel: row.channel,
        purposeLabel: customerFacingPortalMessagePurpose(row.purpose),
        body: row.bodySnapshot,
        statusLabel,
      },
    ];
  });
}

export type PortalAdditionalWorkItem = {
  id: string;
  description: string;
  statusLabel: string;
  createdAt: Date;
  workLabels: string[];
};

export async function loadPortalAdditionalWorkRequests(
  db: PortalDb,
  token: string,
): Promise<PortalAdditionalWorkItem[]> {
  const trimmed = token.trim();
  if (!trimmed) return [];

  const job = await db.job.findUnique({
    where: { projectToken: trimmed },
    select: { id: true, businessId: true },
  });
  if (!job) return [];

  const rows = await db.additionalWorkRequest.findMany({
    where: { jobId: job.id, businessId: job.businessId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      description: true,
      status: true,
      createdAt: true,
      items: {
        orderBy: { sortOrder: "asc" },
        select: {
          quantity: true,
          customDescription: true,
          serviceCatalogItem: { select: { name: true } },
        },
      },
    },
  });

  return rows.map((row) => {
    const workLabels = requestedWorkLabels(row);
    return {
      id: row.id,
      description:
        row.description.trim() ||
        requestedWorkSummary(workLabels, 200) ||
        "Additional work request",
      statusLabel: customerFacingAdditionalWorkStatus(row.status),
      createdAt: row.createdAt,
      workLabels,
    };
  });
}

export type PortalRequestSummary = {
  summary: string | null;
  workLabels: string[];
};

export function portalRequestSummary(request: {
  summary?: string | null;
  description?: string | null;
  items?: Array<{
    quantity?: number | null;
    customDescription?: string | null;
    serviceCatalogItem?: { name: string } | null;
  }>;
  serviceCatalogItem?: { name: string } | null;
} | null): PortalRequestSummary | null {
  if (!request) return null;
  const workLabels = requestedWorkLabels(request);
  const summary =
    request.summary?.trim() ||
    request.description?.trim() ||
    requestedWorkSummary(workLabels, 160) ||
    null;
  if (!summary && workLabels.length === 0) return null;
  return { summary, workLabels };
}

export function portalJobStatusLabel(status: string): string {
  return customerFacingJobStatusLabel(status);
}

export function portalApprovedChangeOrderCount(
  changeOrders: readonly { status: string }[],
): number {
  return changeOrders.filter((changeOrder) => changeOrder.status === "APPROVED")
    .length;
}

export function portalPendingChangeOrderCount(
  changeOrders: readonly { status: string }[],
): number {
  return changeOrders.filter((changeOrder) => changeOrder.status === "SENT")
    .length;
}

export function portalChangeOrderStatusLabel(status: string): string {
  return customerFacingChangeOrderStatusLabel(status);
}
