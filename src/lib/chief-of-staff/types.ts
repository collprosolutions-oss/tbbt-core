/**
 * Bounded AI Chief of Staff orchestration contract.
 *
 * PR1 is READ/EXPLAIN only. Approval classes exist for later PRs;
 * this runner never grants authorization or executes domain mutations.
 */

export const APPROVAL_CLASSES = [
  "READ_EXPLAIN",
  "DRAFT_PREPARE",
  "OWNER_CONFIRMED_RECORD",
  "DOMAIN_AUTHORIZED",
  "EXTERNAL_ACTION",
] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const SPECIALIST_IDS = [
  "ATTENTION",
  "WORKFORCE",
  "FINANCIAL",
  "GROWTH",
  "KNOWLEDGE_LAUNCH",
  "MATERIALS",
  "COMMUNICATIONS",
  "BUSINESS_PROTECTION",
] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export const ORCHESTRATION_STATUSES = ["PENDING", "COMPLETED", "PARTIAL", "FAILED"] as const;
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

export const MAX_SPECIALIST_FANOUT = 4;
export const MAX_RECURSION_DEPTH = 1;
export const COS_APPROVAL_CLASS: ApprovalClass = "READ_EXPLAIN";

export type SpecialistSelection = {
  selectedIds: SpecialistId[];
  skipped: SkippedSpecialist[];
  recursionDepth: 1;
  fanout: number;
};

export type SkippedSpecialist = {
  id: SpecialistId;
  reason:
    | "DISABLED"
    | "UNKNOWN_QUESTION"
    | "FANOUT_CAP"
    | "NOT_RELEVANT"
    | "NO_DEEP_LOAD_PR1";
};

export type CosEntityHints = {
  jobId?: string;
  customerId?: string;
  requestId?: string;
  messageId?: string;
  recommendationKey?: string;
  customerDisplayName?: string;
  scheduledDate?: string;
};

export type SpecialistContext = {
  specialistId: SpecialistId;
  question: string;
  factKeys: string[];
  recommendationKeys: string[];
  facts: Record<string, string>;
  findings: Array<{ key: string; title: string; why: string; entityIds?: string[] }>;
  entityHints?: CosEntityHints;
};

export type SpecialistFinding = {
  key: string;
  title: string;
  summary: string;
  recommendationKeys: string[];
  factKeys: string[];
  entityIds?: string[];
};

export type SpecialistSkipReason =
  | "NOT_AUTHORIZED"
  | "NOT_ENTITLED"
  | "PRODUCT_CAPABILITY_MISSING"
  | "UNAVAILABLE";

export type SpecialistResult = {
  specialistId: SpecialistId;
  status: "OK" | "FAILED" | "SKIPPED";
  findings: SpecialistFinding[];
  factKeys: string[];
  recommendationKeys: string[];
  limitation?: string;
  skipReason?: SpecialistSkipReason;
  failure?: SpecialistFailure;
};

export type SpecialistFailure = {
  specialistId: SpecialistId;
  message: string;
};

export type ConflictKind =
  | "DUPLICATE_RECOMMENDATION"
  | "OVERLOAD_VS_FILL_CAPACITY"
  | "STAFFING_SHORTAGE_VS_SCHEDULED_WORK"
  | "UNASSIGNED_PLUS_AVAILABLE"
  | "SHARED_RECOMMENDATION"
  | "MISSING_WAGE_VS_MARGIN_PRICING"
  | "STAFFING_SHORTAGE_VS_PROFITABLE_WORK"
  | "SHARED_JOB_REFERENCE"
  | "STALE_PRICE_VS_CURRENT"
  | "PREFERRED_SUPPLIER_VS_RECORDED_PRICE"
  | "PURCHASE_LIST_VS_PO"
  | "PO_VS_SUPPLIER_CONFIRMATION"
  | "MATERIAL_VARIANCE_VS_JOB_MARGIN"
  | "MATERIAL_UNREADY_VS_SCHEDULE"
  | "MATERIAL_UNREADY_VS_GROWTH"
  | "MATERIAL_DELAY_VS_CUSTOMER_UPDATE"
  | "NO_INVENTORY_RECORDED"
  | "SMS_REVOKED_VS_TEXTABLE"
  | "UNKNOWN_CONSENT_IS_NOT_GRANTED"
  | "FAILED_DELIVERY_VS_DELIVERED"
  | "CHANNEL_UNAVAILABLE_VS_SEND"
  | "APPOINTMENT_DIFFERENT_TIME_VS_CONFIRMED"
  | "EMAIL_AVAILABLE_VS_SMS_LIMIT";

export type ConflictItem = {
  kind: ConflictKind;
  recommendationKeys: string[];
  summary: string;
};

export type ConflictResolution = {
  items: ConflictItem[];
  uniqueRecommendationKeys: string[];
};

export type OrchestrationSkipFailure = {
  skipped: SkippedSpecialist[];
  failures: SpecialistFailure[];
};

export type CosPlannerInput = {
  question: string;
  activeRecommendationKeys: string[];
  entityHints?: CosEntityHints;
};
