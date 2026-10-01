/**
 * Trade-neutral OWNER aftercare instructions for a completed Job.
 *
 * OWNER writes a draft and must explicitly publish before the customer
 * project token can read anything. Drafts and private owner notes stay
 * hidden. Recorded warranty terms are displayed as stored only — this
 * module never invents coverage, expiration, or a legal conclusion, and
 * never sends a customer message.
 */
import type { MembershipRole } from "@prisma/client";
import { completedSameBusinessJobEligible } from "@/lib/job-callback";

export const JOB_AFTERCARE_STATUSES = ["DRAFT", "PUBLISHED", "UNPUBLISHED"] as const;
export type JobAftercareStatus = (typeof JOB_AFTERCARE_STATUSES)[number];

export const JOB_AFTERCARE_EVENT_TYPES = [
  "DRAFTED",
  "REVISED",
  "PUBLISHED",
  "UNPUBLISHED",
] as const;
export type JobAftercareEventType = (typeof JOB_AFTERCARE_EVENT_TYPES)[number];

export const MAX_JOB_AFTERCARE_INSTRUCTIONS_LENGTH = 8000;
export const MAX_JOB_AFTERCARE_OWNER_NOTES_LENGTH = 4000;
export const JOB_AFTERCARE_HISTORY_BOUND = 80;

export const JOB_AFTERCARE_OWNER_ONLY_MESSAGE =
  "Only the business owner can write, publish, or unpublish job aftercare instructions.";

export const JOB_AFTERCARE_COMPLETED_JOB_MESSAGE =
  "Aftercare instructions can only be recorded against a completed job.";

export const JOB_AFTERCARE_JOB_REQUIRED_MESSAGE = "That job could not be found.";

export const JOB_AFTERCARE_UNKNOWN_MESSAGE =
  "Those aftercare instructions could not be found.";

export const JOB_AFTERCARE_INSTRUCTIONS_REQUIRED_MESSAGE =
  "Write the aftercare instructions before saving or publishing.";

export const JOB_AFTERCARE_NOTHING_TO_PUBLISH_MESSAGE =
  "Save aftercare instructions before publishing them to the customer project link.";

export const JOB_AFTERCARE_NOT_PUBLISHED_MESSAGE =
  "Those aftercare instructions are not published.";

export const JOB_AFTERCARE_ALREADY_PUBLISHED_MESSAGE =
  "Those aftercare instructions are already published.";

export const JOB_AFTERCARE_DRAFT_SAVED_MESSAGE =
  "Aftercare draft saved. It is not visible on the customer project link until you publish. No customer message was sent.";

export const JOB_AFTERCARE_PUBLISHED_MESSAGE =
  "Aftercare instructions published to this job's customer project link. No customer message was sent.";

export const JOB_AFTERCARE_UNPUBLISHED_MESSAGE =
  "Aftercare instructions unpublished. The customer project link no longer shows them. No customer message was sent.";

export const JOB_AFTERCARE_UNCHANGED_MESSAGE =
  "Those aftercare instructions are already recorded that way. No customer message was sent.";

export const JOB_AFTERCARE_OWNER_WORKFLOW_MESSAGE =
  "Write job-specific aftercare for this completed job, then publish it to the existing customer project link. Drafts and private owner notes stay hidden. Publishing does not send a message.";

export const JOB_AFTERCARE_UNAVAILABLE_MESSAGE =
  "Job aftercare is unavailable on this environment until the aftercare migration is applied.";

export const JOB_AFTERCARE_PORTAL_HEADING = "Aftercare instructions";

export const JOB_AFTERCARE_PORTAL_DESCRIPTION =
  "Care instructions the business published for this completed job. Shown as written.";

export { completedSameBusinessJobEligible };

export function jobAftercareWriteAllowed(role: MembershipRole | string): boolean {
  return role === "OWNER";
}

export function isJobAftercareStatus(value: string): value is JobAftercareStatus {
  return (JOB_AFTERCARE_STATUSES as readonly string[]).includes(value);
}

export function recordedAftercareStatusLabel(status: string): string {
  if (status === "DRAFT") return "Draft";
  if (status === "PUBLISHED") return "Published";
  if (status === "UNPUBLISHED") return "Unpublished";
  return status;
}

export function recordedAftercareEventLabel(eventType: string): string {
  if (eventType === "DRAFTED") return "Drafted";
  if (eventType === "REVISED") return "Revised";
  if (eventType === "PUBLISHED") return "Published";
  if (eventType === "UNPUBLISHED") return "Unpublished";
  return eventType;
}

export function parseJobAftercareInstructions(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  return value.slice(0, MAX_JOB_AFTERCARE_INSTRUCTIONS_LENGTH);
}

export function parseJobAftercareOwnerNotes(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, MAX_JOB_AFTERCARE_OWNER_NOTES_LENGTH);
}

export function missingJobAftercareSchema(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  return code === "P2021" || code === "P2022";
}

export type OwnerJobAftercareHistoryEvent = {
  id: string;
  eventType: string;
  eventLabel: string;
  fromStatus: string | null;
  toStatus: string;
  instructionsSnapshot: string | null;
  createdAt: Date;
  actorName: string | null;
};

export type OwnerJobAftercare = {
  id: string;
  jobId: string;
  status: JobAftercareStatus;
  statusLabel: string;
  draftInstructions: string;
  ownerNotes: string;
  publishedInstructions: string | null;
  publishedAt: Date | null;
  unpublishedAt: Date | null;
};

export type CustomerPublishedAftercare = {
  jobId: string;
  businessId: string;
  instructions: string;
  publishedAt: Date | null;
};
