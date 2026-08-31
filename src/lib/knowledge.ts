/**
 * Knowledge Hub domain -- trusted operational knowledge over existing
 * TBBT records. No AI provider. No invented lessons. SYSTEM_DERIVED is
 * reserved and never written in this core implementation.
 *
 * KNOWN → state confidently and show why.
 * ESTIMATE → label it as an estimate.
 * EXTERNAL → identify the source.
 * CONFLICT → flag it.
 * UNKNOWN → say it is unknown.
 */

export const KNOWLEDGE_AREAS = [
  "overview",
  "services",
  "estimating",
  "procedures",
  "policies",
  "vendors",
  "marketing",
  "safety",
  "training",
] as const;
export type KnowledgeArea = (typeof KNOWLEDGE_AREAS)[number];

export const KNOWLEDGE_AREA_LABELS: Record<KnowledgeArea, string> = {
  overview: "Overview",
  services: "Services & Pricing",
  estimating: "Estimating & Takeoffs",
  procedures: "Job Procedures",
  policies: "Customers & Policies",
  vendors: "Vendors & Materials",
  marketing: "Marketing & Brand",
  safety: "Safety / Compliance",
  training: "Training & How-To",
};

export function isKnowledgeArea(value: string | undefined): value is KnowledgeArea {
  return (KNOWLEDGE_AREAS as readonly string[]).includes(value ?? "");
}

export function parseKnowledgeArea(raw: string | undefined): KnowledgeArea {
  return isKnowledgeArea(raw) ? raw : "overview";
}

export const KNOWLEDGE_CATEGORIES = [
  "SERVICES_PRICING",
  "ESTIMATING_TAKEOFFS",
  "JOB_PROCEDURES",
  "CUSTOMERS_POLICIES",
  "VENDORS_MATERIALS",
  "MARKETING_BRAND",
  "SAFETY_COMPLIANCE",
  "TRAINING_HOWTO",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  SERVICES_PRICING: "Services & Pricing",
  ESTIMATING_TAKEOFFS: "Estimating & Takeoffs",
  JOB_PROCEDURES: "Job Procedures",
  CUSTOMERS_POLICIES: "Customers & Policies",
  VENDORS_MATERIALS: "Vendors & Materials",
  MARKETING_BRAND: "Marketing & Brand",
  SAFETY_COMPLIANCE: "Safety / Compliance",
  TRAINING_HOWTO: "Training & How-To",
};

export const AREA_TO_CATEGORY: Record<Exclude<KnowledgeArea, "overview">, KnowledgeCategory> = {
  services: "SERVICES_PRICING",
  estimating: "ESTIMATING_TAKEOFFS",
  procedures: "JOB_PROCEDURES",
  policies: "CUSTOMERS_POLICIES",
  vendors: "VENDORS_MATERIALS",
  marketing: "MARKETING_BRAND",
  safety: "SAFETY_COMPLIANCE",
  training: "TRAINING_HOWTO",
};

export function isKnowledgeCategory(value: string | undefined): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value ?? "");
}

export const KNOWLEDGE_SOURCE_TYPES = [
  "OWNER_CREATED",
  "TBBT_RECORD",
  "EXTERNAL_REFERENCE",
  "SYSTEM_DERIVED",
] as const;
export type KnowledgeSourceType = (typeof KNOWLEDGE_SOURCE_TYPES)[number];

export const KNOWLEDGE_SOURCE_TYPE_LABELS: Record<KnowledgeSourceType, string> = {
  OWNER_CREATED: "Owner created",
  TBBT_RECORD: "TBBT record",
  EXTERNAL_REFERENCE: "External reference",
  SYSTEM_DERIVED: "System derived",
};

export function isKnowledgeSourceType(value: string | undefined): value is KnowledgeSourceType {
  return (KNOWLEDGE_SOURCE_TYPES as readonly string[]).includes(value ?? "");
}

export const KNOWLEDGE_SOURCE_KINDS = [
  "SERVICE",
  "ESTIMATE",
  "JOB",
  "EXPENSE",
  "TIME",
  "MARKETING",
  "REVIEW",
] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_SOURCE_KIND_LABELS: Record<KnowledgeSourceKind, string> = {
  SERVICE: "Service",
  ESTIMATE: "Estimate",
  JOB: "Job",
  EXPENSE: "Expense",
  TIME: "Approved time",
  MARKETING: "Marketing content",
  REVIEW: "Review",
};

export function isKnowledgeSourceKind(value: string | undefined): value is KnowledgeSourceKind {
  return (KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(value ?? "");
}

export const KNOWLEDGE_TRUST_STATES = [
  "VERIFIED",
  "SUPPORTED",
  "ESTIMATE",
  "NEEDS_REVIEW",
  "CONFLICT",
  "UNKNOWN",
] as const;
export type KnowledgeTrustState = (typeof KNOWLEDGE_TRUST_STATES)[number];

export const KNOWLEDGE_TRUST_LABELS: Record<KnowledgeTrustState, string> = {
  VERIFIED: "Verified",
  SUPPORTED: "Supported",
  ESTIMATE: "Estimate",
  NEEDS_REVIEW: "Needs review",
  CONFLICT: "Conflict",
  UNKNOWN: "Unknown",
};

export function isKnowledgeTrustState(value: string | undefined): value is KnowledgeTrustState {
  return (KNOWLEDGE_TRUST_STATES as readonly string[]).includes(value ?? "");
}

export function needsKnowledgeReview(trustState: string): boolean {
  return trustState === "NEEDS_REVIEW" || trustState === "CONFLICT";
}

export function knowledgeAiAvailable(): false {
  return false;
}

export const NO_AI_MESSAGE =
  "TBBT does not generate business knowledge automatically. Entries are owner-created or referenced from existing records.";

export const TAKEOFF_UNAVAILABLE_MESSAGE =
  "Material takeoff learning is not available. TBBT does not have a takeoff model in this step.";

export const SYSTEM_DERIVED_DISABLED_MESSAGE =
  "System-derived knowledge is reserved for future evidence-backed learning. It cannot be written in this step.";

export const LEARNING_LOOP_STEPS = [
  { id: "estimate", label: "Estimate", availability: "available" },
  { id: "takeoff", label: "Takeoff", availability: "unavailable" },
  { id: "purchase", label: "Purchase", availability: "available" },
  { id: "perform", label: "Perform", availability: "available" },
  { id: "actual-time", label: "Actual Time", availability: "available" },
  { id: "actual-materials", label: "Actual Materials", availability: "unavailable" },
  { id: "compare", label: "Compare", availability: "future" },
  { id: "learn", label: "Learn", availability: "future" },
  { id: "recommend", label: "Recommend", availability: "future" },
  { id: "owner-approves", label: "Owner Approves", availability: "future" },
] as const;

export type LearningLoopAvailability = "available" | "unavailable" | "future";

export const LEARNING_LOOP_AVAILABILITY_LABELS: Record<LearningLoopAvailability, string> = {
  available: "Real TBBT data can be referenced",
  unavailable: "No supporting model yet",
  future: "Future — not operating today",
};

export function sourceRecordHref(
  kind: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (kind === "ESTIMATE" && id) return `/estimates/${id}`;
  if (kind === "JOB" && id) return `/jobs/${id}`;
  if (kind === "SERVICE") return "/services";
  if (kind === "EXPENSE") return "/expenses";
  if (kind === "TIME") return "/time-cards";
  if (kind === "MARKETING") return "/marketing";
  if (kind === "REVIEW") return "/reviews";
  return null;
}

export function matchesKnowledgeSearch(
  haystacks: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((value) => (value ?? "").toLowerCase().includes(needle));
}

export const RECENT_DAYS = 7;

export function isRecentlyUpdated(updatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - updatedAt.getTime() <= RECENT_DAYS * 86_400_000;
}

export function parseKnowledgeTrustFilter(raw: string | undefined): KnowledgeTrustState | "all" {
  return isKnowledgeTrustState(raw) ? raw : "all";
}

export function parseKnowledgeArchiveFilter(raw: string | undefined): "active" | "archived" | "all" {
  if (raw === "archived" || raw === "all") return raw;
  return "active";
}

export function parseKnowledgeReviewFilter(raw: string | undefined): "needs-review" | "all" {
  return raw === "needs-review" ? "needs-review" : "all";
}

export const MIN_KNOWLEDGE_BODY_LENGTH = 8;

export function isUsefulKnowledgeBody(value: string | undefined): boolean {
  return (value ?? "").trim().length >= MIN_KNOWLEDGE_BODY_LENGTH;
}
