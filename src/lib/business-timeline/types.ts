/**
 * Read-only Business Timeline types.
 *
 * Only persisted timestamps and recorded statuses become events.
 * Lifecycle state without a matching *At / occurredAt field is not an event.
 * Stored instants stay ISO-8601; presentation uses Business.timezone.
 */

export const BUSINESS_TIMELINE_LIMIT = 80;
export const BUSINESS_TIMELINE_SOURCE_LIMIT = 80;
export const BUSINESS_TIMELINE_LOOKBACK_DAYS = 90;
export const BUSINESS_TIMELINE_CUSTOMER_FILTER_LIMIT = 200;

export const BUSINESS_TIMELINE_CATEGORIES = [
  "all",
  "sales",
  "work",
  "money",
  "communications",
  "operations",
] as const;

export type BusinessTimelineCategory = (typeof BUSINESS_TIMELINE_CATEGORIES)[number];

export const BUSINESS_TIMELINE_CATEGORY_LABELS: Record<BusinessTimelineCategory, string> = {
  all: "All",
  sales: "Sales",
  work: "Work",
  money: "Money",
  communications: "Communications",
  operations: "Business / Operations",
};

export const BUSINESS_EVENT_TIMELINE_TYPES = [
  "JOB_STARTED",
  "JOB_COMPLETED",
  "INVOICE_SENT",
  "INVOICE_DUE",
  "INVOICE_OVERDUE",
] as const;

export const BUSINESS_TIMELINE_EXCLUSIONS = [
  "ServiceRequest.status CONVERTED has no convertedAt — not an event.",
  "Estimate.status SENT without EstimateVersion.sentAt is not a send event.",
  "Estimate.status APPROVED without EstimateVersion.approvedAt is not an approval event.",
  "Invoice.status SENT without BusinessEvent INVOICE_SENT is not a send event.",
  "Invoice.status PAID without Invoice.paidAt is not a paid event.",
  "Job.status IN_PROGRESS / COMPLETED without BusinessEvent JOB_STARTED / JOB_COMPLETED is not a start/complete event.",
  "Job.scheduledAt is the appointment slot, not when scheduling was recorded.",
  "CustomerCommunication is never inferred from estimate, invoice, or job lifecycle.",
  "DELIVERED does not mean the customer read the message.",
  "BusinessActionItem DONE / DISMISSED has no doneAt / dismissedAt — status alone is not an event.",
  "BsosRecommendationState current status + updatedAt is not a status-change event.",
  "Recommendation status history stored inside JSON is not projected as Business Timeline events in V1 because it does not have a separately bounded queryable event stream.",
  "Generic BSOS / recommendation state is never labeled AI-originated.",
  "BusinessProtectionAuditLog and SettingsAuditLog are audit logs, not timeline sources.",
  "ReceptionistEvent is not included — receptionist queue is a separate surface.",
  "PipelineOpportunity.ownerStage has no stage-changed timestamp.",
] as const;

export type BusinessTimelineItem = {
  id: string;
  occurredAt: string;
  eventType: string;
  category: Exclude<BusinessTimelineCategory, "all">;
  description: string;
  customerId: string | null;
  customerName: string | null;
  relatedType: string;
  relatedId: string;
  relatedLabel: string;
  relatedHref: string | null;
  sourceStatus: string | null;
};

export type BusinessTimelineCustomerOption = {
  id: string;
  name: string;
};

export type BusinessTimeline = {
  businessId: string;
  timeZone: string;
  category: BusinessTimelineCategory;
  customerId: string | null;
  lookbackDays: number;
  limit: number;
  since: string;
  truncated: boolean;
  items: BusinessTimelineItem[];
  customers: BusinessTimelineCustomerOption[];
};

export type BusinessTimelineAccess = {
  businessId: string;
  scope: { readonly businessId: string };
  workspace: {
    role: "OWNER" | "ADMIN" | "MEMBER";
    membership?: { id: string };
    user?: { id: string };
    business?: { timezone?: string | null; name?: string | null };
  };
};

export type BusinessTimelineQuery = {
  category?: string | null;
  customerId?: string | null;
  limit?: number;
  lookbackDays?: number;
  since?: Date;
  now?: Date;
};

export type BusinessTimelineDraft = {
  id: string;
  occurredAt: Date;
  eventType: string;
  category: Exclude<BusinessTimelineCategory, "all">;
  description: string;
  customerId: string | null;
  relatedType: string;
  relatedId: string;
  relatedJobId: string | null;
  relatedLabel: string;
  sourceStatus: string | null;
};
