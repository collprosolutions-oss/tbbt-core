export const BUSINESS_EVENT_TYPES = [
  "REQUEST_CREATED",
  "ESTIMATE_SENT",
  "ESTIMATE_APPROVED",
  "APPOINTMENT_SCHEDULED",
  "APPOINTMENT_CHANGED",
  "JOB_STARTED",
  "JOB_COMPLETED",
  "INVOICE_SENT",
  "INVOICE_DUE",
  "INVOICE_OVERDUE",
  "INVOICE_PAID",
  "REVIEW_OPPORTUNITY_CREATED",
  "REFERRAL_OPPORTUNITY_CREATED",
  "REVIEW_REQUEST_CREATED",
  "REFERRAL_REQUEST_CREATED",
  "CUSTOMER_FOLLOW_UP_DUE",
] as const;
export type BusinessEventType = (typeof BUSINESS_EVENT_TYPES)[number];

export const AUTOMATION_CHANNELS = ["EMAIL", "SMS", "BOTH", "NONE"] as const;
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number];

export const AUTOMATION_RUN_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "BLOCKED",
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const DEFAULT_AUTOMATION_RULES: Array<{
  eventType: BusinessEventType;
  purpose: string;
  kind: "COMMUNICATION" | "ACTION_SUGGESTION";
  channel: AutomationChannel;
  delayMinutes: number;
  templateKey: string;
  enabled: boolean;
}> = [
  { eventType: "ESTIMATE_SENT", purpose: "ESTIMATE_READY", kind: "COMMUNICATION", channel: "SMS", delayMinutes: 0, templateKey: "estimate-ready", enabled: false },
  { eventType: "APPOINTMENT_SCHEDULED", purpose: "APPOINTMENT_CONFIRMATION", kind: "COMMUNICATION", channel: "SMS", delayMinutes: 0, templateKey: "appointment-confirmation", enabled: false },
  { eventType: "APPOINTMENT_CHANGED", purpose: "SCHEDULE_CHANGE", kind: "COMMUNICATION", channel: "SMS", delayMinutes: 0, templateKey: "schedule-change", enabled: false },
  { eventType: "APPOINTMENT_SCHEDULED", purpose: "APPOINTMENT_REMINDER", kind: "COMMUNICATION", channel: "SMS", delayMinutes: 24 * 60, templateKey: "appointment-reminder", enabled: false },
  { eventType: "INVOICE_SENT", purpose: "INVOICE_READY", kind: "COMMUNICATION", channel: "EMAIL", delayMinutes: 0, templateKey: "invoice-ready", enabled: false },
  { eventType: "INVOICE_DUE", purpose: "PAYMENT_REMINDER", kind: "COMMUNICATION", channel: "SMS", delayMinutes: 0, templateKey: "payment-reminder", enabled: false },
  { eventType: "INVOICE_OVERDUE", purpose: "PAYMENT_REMINDER", kind: "COMMUNICATION", channel: "SMS", delayMinutes: 0, templateKey: "payment-overdue", enabled: false },
  { eventType: "REVIEW_OPPORTUNITY_CREATED", purpose: "REVIEW_REQUEST", kind: "ACTION_SUGGESTION", channel: "NONE", delayMinutes: 0, templateKey: "review-opportunity", enabled: true },
  { eventType: "REFERRAL_OPPORTUNITY_CREATED", purpose: "REFERRAL_REQUEST", kind: "ACTION_SUGGESTION", channel: "NONE", delayMinutes: 0, templateKey: "referral-opportunity", enabled: true },
  { eventType: "JOB_COMPLETED", purpose: "JOB_FOLLOW_UP", kind: "ACTION_SUGGESTION", channel: "NONE", delayMinutes: 0, templateKey: "job-follow-up-opportunity", enabled: true },
  { eventType: "REVIEW_REQUEST_CREATED", purpose: "REVIEW_REQUEST", kind: "COMMUNICATION", channel: "NONE", delayMinutes: 0, templateKey: "review-request", enabled: false },
  { eventType: "REFERRAL_REQUEST_CREATED", purpose: "REFERRAL_REQUEST", kind: "COMMUNICATION", channel: "NONE", delayMinutes: 0, templateKey: "referral-request", enabled: false },
  { eventType: "CUSTOMER_FOLLOW_UP_DUE", purpose: "JOB_FOLLOW_UP", kind: "COMMUNICATION", channel: "NONE", delayMinutes: 0, templateKey: "job-follow-up", enabled: false },
  { eventType: "CUSTOMER_FOLLOW_UP_DUE", purpose: "REPEAT_FOLLOW_UP", kind: "COMMUNICATION", channel: "NONE", delayMinutes: 0, templateKey: "repeat-follow-up", enabled: false },
];
