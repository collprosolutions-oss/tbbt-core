/**
 * Dashboard Needs attention items for appointment owner action.
 * Inclusion uses ownerAppointmentAttention() from appointment confirmation.
 * This file does not invent a second appointment-state model.
 */
import {
  ownerAppointmentAttention,
  parseAppointmentChangeRequestNote,
  type AppointmentJobFields,
  type OwnerAppointmentAttentionKind,
} from "@/lib/appointment-confirmation";
import { formatAppointmentWhen } from "@/lib/format";

export const DASHBOARD_DIFFERENT_TIME_ATTENTION_TITLE =
  "Customer requested a different appointment time";
export const DASHBOARD_RECONFIRMATION_ATTENTION_TITLE =
  "Appointment changed — customer reconfirmation required";

export const DASHBOARD_APPOINTMENT_ATTENTION_TAKE = 25;

export type DashboardAppointmentAttentionItem = {
  jobId: string;
  kind: OwnerAppointmentAttentionKind;
  title: string;
  customerName: string;
  whenLabel: string;
  customerNote: string | null;
  href: string;
  sortAt: Date;
};

export const DASHBOARD_APPOINTMENT_ATTENTION_SELECT = {
  id: true,
  businessId: true,
  updatedAt: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  appointmentConfirmationStatus: true,
  appointmentProposalId: true,
  appointmentConfirmedForProposalId: true,
  appointmentConfirmationSource: true,
  appointmentChangeRequestNote: true,
  propertyAccessMethod: true,
  propertyAccessInstructions: true,
  propertyAccessContactName: true,
  propertyAccessContactInfo: true,
  propertyAccessPickupLocation: true,
  propertyAccessNote: true,
  customer: { select: { name: true } },
} as const;

/**
 * Candidate filter only. The page still applies ownerAppointmentAttention()
 * so first-time awaiting confirmation and confirmed jobs stay off the list.
 */
export function dashboardAppointmentAttentionCandidateWhere() {
  return {
    scheduledAt: { not: null },
    OR: [
      { appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED" },
      { appointmentChangeRequestNote: { not: null } },
      {
        appointmentConfirmedForProposalId: { not: null },
        appointmentConfirmationStatus: { not: "CONFIRMED" },
      },
    ],
  };
}

export function dashboardAppointmentAttentionHref(jobId: string) {
  return `/jobs/${jobId}`;
}

export function dashboardAppointmentAttentionItems(
  jobs: Array<
    AppointmentJobFields & {
      id: string;
      businessId: string;
      updatedAt: Date;
      customer?: { name: string | null } | null;
    }
  >,
  businessId: string,
): DashboardAppointmentAttentionItem[] {
  const items: DashboardAppointmentAttentionItem[] = [];
  for (const job of jobs) {
    if (job.businessId !== businessId) continue;
    if (!job.scheduledAt) continue;
    const kind = ownerAppointmentAttention(job);
    if (!kind) continue;
    items.push({
      jobId: job.id,
      kind,
      title:
        kind === "DIFFERENT_TIME"
          ? DASHBOARD_DIFFERENT_TIME_ATTENTION_TITLE
          : DASHBOARD_RECONFIRMATION_ATTENTION_TITLE,
      customerName: job.customer?.name?.trim() || "Customer",
      whenLabel: formatAppointmentWhen(job.scheduledAt),
      customerNote:
        kind === "DIFFERENT_TIME"
          ? parseAppointmentChangeRequestNote(job.appointmentChangeRequestNote ?? "")
          : null,
      href: dashboardAppointmentAttentionHref(job.id),
      sortAt: job.updatedAt,
    });
  }
  items.sort((left, right) => right.sortAt.getTime() - left.sortAt.getTime());
  return items;
}
