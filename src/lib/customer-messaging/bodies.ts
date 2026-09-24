export function estimateReadySmsBody(input: {
  businessName: string;
  url?: string | null;
}) {
  return input.url
    ? `${input.businessName} sent your estimate. View: ${input.url}`
    : `${input.businessName} sent your estimate.`;
}

export function appointmentConfirmationSmsBody(input: {
  businessName: string;
  url?: string | null;
  rescheduled?: boolean;
}) {
  const intro = input.rescheduled
    ? `${input.businessName} updated your appointment.`
    : `${input.businessName} proposed an appointment.`;
  return input.url ? `${intro} Confirm: ${input.url}` : intro;
}

export function appointmentReminderSmsBody(input: {
  businessName: string;
  url?: string | null;
}) {
  return input.url
    ? `Reminder: your appointment with ${input.businessName} is coming up. View: ${input.url}`
    : `Reminder: your appointment with ${input.businessName} is coming up.`;
}

export function invoiceReadySmsBody(input: {
  businessName: string;
  url?: string | null;
}) {
  return input.url
    ? `${input.businessName} sent your invoice. View: ${input.url}`
    : `${input.businessName} sent your invoice.`;
}

export function paymentReminderSmsBody(input: {
  businessName: string;
  url?: string | null;
}) {
  return input.url
    ? `Reminder: an invoice from ${input.businessName} is waiting. View: ${input.url}`
    : `Reminder: an invoice from ${input.businessName} is waiting.`;
}

export function reviewRequestSmsBody(input: { requestText: string; businessName: string }) {
  const text = input.requestText.trim();
  return text || `${input.businessName} would value an honest review.`;
}

export function reviewReminderSmsBody(input: { requestText: string; businessName: string }) {
  const text = input.requestText.trim();
  return text
    ? `Reminder from ${input.businessName}: ${text}`
    : `Reminder: ${input.businessName} would still value an honest review.`;
}

export function referralRequestSmsBody(input: { requestText: string; businessName: string }) {
  const text = input.requestText.trim();
  return text || `${input.businessName} would appreciate a referral if you are comfortable sharing.`;
}

export function jobFollowUpSmsBody(input: { businessName: string }) {
  return `${input.businessName} is checking in after your recent job. Reply STOP to opt out of SMS.`;
}

export function repeatFollowUpSmsBody(input: { businessName: string }) {
  return `${input.businessName} would be glad to help with your next project. Reply STOP to opt out of SMS.`;
}

export function customerSmsIdempotencyKey(purpose: string, relatedId: string, extra?: string) {
  return extra ? `sms:${purpose}:${relatedId}:${extra}` : `sms:${purpose}:${relatedId}`;
}
