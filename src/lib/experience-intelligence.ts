/**
 * Experience Intelligence domain.
 *
 * Candidates come from recorded work. They are never trusted company
 * policy until an owner reviews and approves them.
 */

export const EXPERIENCE_LEARNING_KINDS = [
  "DURATION_VARIANCE",
  "INTAKE_QUESTION",
  "RECURRING_CUSTOMER_QUESTION",
  "SCOPE_CHANGE",
  "FIELD_NOTE",
  "ESTIMATING_ASSUMPTION",
] as const;
export type ExperienceLearningKind = (typeof EXPERIENCE_LEARNING_KINDS)[number];

export const EXPERIENCE_LEARNING_KIND_LABELS: Record<ExperienceLearningKind, string> = {
  DURATION_VARIANCE: "Job took longer than expected",
  INTAKE_QUESTION: "Intake question that prevents rework",
  RECURRING_CUSTOMER_QUESTION: "Recurring customer question",
  SCOPE_CHANGE: "Common scope change",
  FIELD_NOTE: "Service-specific field note",
  ESTIMATING_ASSUMPTION: "Estimating assumption proved inaccurate",
};

export function isExperienceLearningKind(value: string | undefined): value is ExperienceLearningKind {
  return (EXPERIENCE_LEARNING_KINDS as readonly string[]).includes(value ?? "");
}

export const EXPERIENCE_LEARNING_STATUSES = ["CANDIDATE", "REVIEWED", "APPROVED", "REJECTED"] as const;
export type ExperienceLearningStatus = (typeof EXPERIENCE_LEARNING_STATUSES)[number];

export function isExperienceLearningStatus(value: string | undefined): value is ExperienceLearningStatus {
  return (EXPERIENCE_LEARNING_STATUSES as readonly string[]).includes(value ?? "");
}

export const EXPERIENCE_CANDIDATE_NOT_POLICY_MESSAGE =
  "This is a candidate learning from recorded work. It is not trusted company policy until you approve it.";
