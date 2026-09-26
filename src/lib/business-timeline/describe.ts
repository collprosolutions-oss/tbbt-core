import { formatMoney } from "@/lib/format";

/** Same derivation as estimateNumberFromId / invoiceNumberFromId / jobReferenceFromId. */
function last8(id: string): string {
  return id.slice(-8).toUpperCase();
}

function humanizeToken(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Recorded";
  return trimmed
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => {
      if (part === part.toUpperCase() && part.length <= 4) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

export function estimateTimelineNumber(estimateId: string): string {
  return `EST-${last8(estimateId)}`;
}

export function invoiceTimelineNumber(invoiceId: string): string {
  return `INV-${last8(invoiceId)}`;
}

export function jobTimelineReference(jobId: string): string {
  return `JOB-${last8(jobId)}`;
}

export function describeRequestRecorded(): string {
  return "Request was recorded.";
}

export function describeEstimateRecorded(estimateId: string): string {
  return `Estimate ${estimateTimelineNumber(estimateId)} was recorded.`;
}

export function describeEstimateSent(estimateId: string): string {
  return `Estimate ${estimateTimelineNumber(estimateId)} was sent.`;
}

export function describeEstimateApproved(estimateId: string): string {
  return `Estimate ${estimateTimelineNumber(estimateId)} was approved.`;
}

export function describeJobRecorded(jobId: string): string {
  return `Job ${jobTimelineReference(jobId)} was recorded.`;
}

export function describeJobStarted(jobId: string): string {
  return `Job ${jobTimelineReference(jobId)} start was recorded.`;
}

export function describeJobCompleted(jobId: string): string {
  return `Job ${jobTimelineReference(jobId)} completion was recorded.`;
}

export function describeJobStartWithoutConfirmation(jobId: string): string {
  return `Job ${jobTimelineReference(jobId)} start without confirmation was recorded.`;
}

export function describeAppointmentEvent(eventType: string): string {
  if (eventType === "APPOINTMENT_NOTIFICATION_SENT") {
    return "Appointment notification status recorded as SENT.";
  }
  if (eventType === "APPOINTMENT_NOTIFICATION_FAILED") {
    return "Appointment notification status recorded as FAILED.";
  }
  return `${humanizeToken(eventType)} was recorded.`;
}

export function describeInvoiceRecorded(invoiceId: string): string {
  return `Invoice ${invoiceTimelineNumber(invoiceId)} was recorded.`;
}

export function describeInvoicePaid(invoiceId: string): string {
  return `Invoice ${invoiceTimelineNumber(invoiceId)} was marked paid.`;
}

export function describeInvoiceLifecycleEvent(type: string, invoiceId: string): string {
  const number = invoiceTimelineNumber(invoiceId);
  if (type === "INVOICE_SENT") return `Invoice ${number} send was recorded.`;
  if (type === "INVOICE_DUE") return `Invoice ${number} due event was recorded.`;
  if (type === "INVOICE_OVERDUE") return `Invoice ${number} overdue event was recorded.`;
  return `Invoice ${number} event ${type} was recorded.`;
}

export function describePaymentRecorded(amount: { toString(): string } | string | number): string {
  return `Payment of ${formatMoney(amount)} was recorded.`;
}

export function describeChangeOrderEvent(kind: string, title: string): string {
  const label = title.trim() || "Change order";
  if (kind === "created") return `Change order "${label}" was recorded.`;
  if (kind === "sent") return `Change order "${label}" was sent.`;
  if (kind === "approved") return `Change order "${label}" was approved.`;
  if (kind === "declined") return `Change order "${label}" was declined.`;
  if (kind === "cancelled") return `Change order "${label}" was cancelled.`;
  return `Change order "${label}" was recorded.`;
}

/**
 * Communications stay at recorded provider/status truth.
 * DELIVERED is a recorded status, not proof of a read receipt.
 */
export function describeRecordedCommunication(channel: string, status: string): string {
  return `${humanizeToken(channel)} status recorded as ${status}.`;
}

export function describePhoneInteraction(kind: string, status: string): string {
  return `Phone interaction recorded as ${kind} (${status}).`;
}

export function describeTimeEntryStarted(activityType: string): string {
  return `${humanizeToken(activityType)} time entry was started.`;
}

export function describeTimeEntryEnded(activityType: string): string {
  return `${humanizeToken(activityType)} time entry was ended.`;
}

export function describeAdditionalWorkRecorded(): string {
  return "Additional work request was recorded.";
}

export function describeAdditionalWorkReviewed(status: string): string {
  return `Additional work request review was recorded as ${status}.`;
}

export function describeProblemReportRecorded(): string {
  return "Job problem report was recorded.";
}

export function describeProblemReportResolved(): string {
  return "Job problem report resolution was recorded.";
}

export function describeReviewRequestRecorded(): string {
  return "Review request send was recorded.";
}

export function describeCustomerFollowUpSent(): string {
  return "Customer follow-up send was recorded.";
}

export function describeCustomerRecorded(): string {
  return "Customer was recorded.";
}

export function describeActionItemRecorded(title: string): string {
  const label = title.trim() || "Action item";
  return `Action item "${label}" was recorded.`;
}

export function describeRecommendationRecorded(recommendationKey: string): string {
  return `Recommendation state "${recommendationKey}" was recorded.`;
}

export function describeRecommendationHistoryStatus(status: string): string {
  return `Recommendation status recorded as ${status}.`;
}

export function describeVaultRecorded(title: string): string {
  const label = title.trim() || "Vault record";
  return `Business Vault record "${label}" was recorded.`;
}

export function describeAgreementRecorded(title: string): string {
  const label = title.trim() || "Agreement";
  return `Agreement "${label}" was recorded.`;
}

export function describeAgreementCompleted(title: string): string {
  const label = title.trim() || "Agreement";
  return `Agreement "${label}" completion was recorded.`;
}

export function describeAgreementOwnerReviewed(title: string): string {
  const label = title.trim() || "Agreement";
  return `Agreement "${label}" owner review was recorded.`;
}

export function describeAgreementLegalAcknowledged(title: string): string {
  const label = title.trim() || "Agreement";
  return `Agreement "${label}" legal-review acknowledgment was recorded.`;
}

export function describeProtectionAcknowledged(kind: string): string {
  return `Business Protection acknowledgment recorded as ${kind}.`;
}

export function businessTimelineEventLabel(eventType: string): string {
  return humanizeToken(eventType);
}
