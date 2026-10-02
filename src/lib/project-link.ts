/**
 * OWNER rotate / revoke of an existing Job customer project link.
 *
 * Rotate replaces Job.projectToken so every /p/[token] page and action
 * refuses the old token immediately. The new token stays on the same
 * business and job. Revoke burns the current token and marks the link
 * REVOKED so even the unused replacement cannot open the portal.
 * Historical Job, invoice, and communication rows are preserved.
 * These writes never send a customer message.
 */
import type { MembershipRole } from "@prisma/client";
import { parsePortalProjectToken } from "@/lib/job-callback";

export const JOB_PROJECT_LINK_STATUSES = ["ACTIVE", "REVOKED"] as const;
export type JobProjectLinkStatus = (typeof JOB_PROJECT_LINK_STATUSES)[number];

export const JOB_PROJECT_LINK_EVENT_TYPES = ["ROTATED", "REVOKED"] as const;
export type JobProjectLinkEventType = (typeof JOB_PROJECT_LINK_EVENT_TYPES)[number];

export const JOB_PROJECT_LINK_HISTORY_BOUND = 80;

export const JOB_PROJECT_LINK_OWNER_ONLY_MESSAGE =
  "Only the business owner can rotate or revoke a customer project link.";

export const JOB_PROJECT_LINK_JOB_REQUIRED_MESSAGE = "That job could not be found.";

export const JOB_PROJECT_LINK_NOT_ACTIVE_MESSAGE =
  "There is no active customer project link to change.";

export const JOB_PROJECT_LINK_CONFLICT_MESSAGE =
  "That project link was just changed. Refresh and try again.";

export const JOB_PROJECT_LINK_ROTATED_MESSAGE =
  "Project link rotated. The previous customer URL stopped working immediately. Copy the new link if you want to share it. No customer message was sent.";

export const JOB_PROJECT_LINK_REVOKED_MESSAGE =
  "Project link revoked. Every previous customer URL for this job stopped working immediately. No customer message was sent.";

export const JOB_PROJECT_LINK_ALREADY_REVOKED_MESSAGE =
  "That customer project link is already revoked. No customer message was sent.";

export const JOB_PROJECT_LINK_UNAVAILABLE_MESSAGE =
  "Project link rotation is unavailable on this environment until the project-link migration is applied.";

export const JOB_PROJECT_LINK_OWNER_WORKFLOW_MESSAGE =
  "Rotate this job's customer project link to replace the URL, or revoke it so the portal stops working. The new link stays on this same job. Historical records stay. This does not send a message.";

export const JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE =
  "This project link is not available.";

export function jobProjectLinkWriteAllowed(role: MembershipRole | string): boolean {
  return role === "OWNER";
}

export function isJobProjectLinkStatus(value: string): value is JobProjectLinkStatus {
  return (JOB_PROJECT_LINK_STATUSES as readonly string[]).includes(value);
}

export function recordedProjectLinkStatusLabel(status: string): string {
  if (status === "ACTIVE") return "Active";
  if (status === "REVOKED") return "Revoked";
  return status;
}

export function recordedProjectLinkEventLabel(eventType: string): string {
  if (eventType === "ROTATED") return "Rotated";
  if (eventType === "REVOKED") return "Revoked";
  return eventType;
}

export function missingJobProjectLinkSchema(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  return code === "P2021" || code === "P2022";
}

export function parseProjectLinkToken(raw: string | null | undefined): string | null {
  return parsePortalProjectToken(raw);
}

export type OwnerJobProjectLinkHistoryEvent = {
  id: string;
  eventType: string;
  eventLabel: string;
  fromStatus: string | null;
  toStatus: string;
  createdAt: Date;
  actorName: string | null;
};

export type OwnerJobProjectLink = {
  jobId: string;
  status: JobProjectLinkStatus;
  statusLabel: string;
  active: boolean;
  projectToken: string | null;
  projectPath: string | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
};

export { parsePortalProjectToken };