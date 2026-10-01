/**
 * Worker-requested reassignment of one currently assigned upcoming job.
 *
 * Request create is request-only. Job assignment and schedule stay
 * unchanged until an OWNER accepts. Accept unassigns through the
 * canonical assignment write. Decline leaves the job unchanged.
 * These paths never send a customer message.
 */
import { isUpcomingFieldJob, type FieldJob } from "@/lib/field-jobs";

export const JOB_REASSIGNMENT_REQUEST_STATUSES = ["PENDING", "ACCEPTED", "DECLINED"] as const;
export type JobReassignmentRequestStatus = (typeof JOB_REASSIGNMENT_REQUEST_STATUSES)[number];

export const JOB_REASSIGNMENT_REQUEST_DECISIONS = ["ACCEPT", "DECLINE"] as const;
export type JobReassignmentRequestDecision = (typeof JOB_REASSIGNMENT_REQUEST_DECISIONS)[number];

export const JOB_REASSIGNMENT_REQUEST_STALE_MESSAGE =
  "That request already changed. Refresh and decide again. TBBT did not change the job assignment or schedule.";

export const JOB_REASSIGNMENT_REQUEST_PENDING_EXISTS_MESSAGE =
  "You already have a pending reassignment request for that job. Wait for the owner to decide.";

export const JOB_REASSIGNMENT_REQUEST_INACTIVE_MESSAGE =
  "That worker is no longer active on this team. TBBT did not change the job assignment or schedule.";

export const JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE =
  "That job is already completed. TBBT did not change the job assignment or schedule.";

export const JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE =
  "That job is cancelled. TBBT did not change the job assignment or schedule.";

export const JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE =
  "That job is no longer assigned to this worker. TBBT did not change the job assignment or schedule.";

export const JOB_REASSIGNMENT_REQUEST_NOT_UPCOMING_MESSAGE =
  "Choose one currently assigned upcoming job. Today, in-progress, completed, and cancelled jobs cannot be requested.";

export const JOB_REASSIGNMENT_REQUEST_REASON_MESSAGE =
  "Add a short reason the owner should see.";

export const JOB_REASSIGNMENT_REQUEST_DECIDE_CONFLICT_MESSAGE =
  "That decision could not be recorded. Refresh and decide again. TBBT did not change the job assignment or schedule.";

export const JOB_REASSIGNMENT_REQUEST_REASON_MAX = 240;
export const JOB_REASSIGNMENT_REQUEST_SELF_LIST_LIMIT = 50;
export const JOB_REASSIGNMENT_REQUEST_PENDING_LIST_LIMIT = 100;
export const JOB_REASSIGNMENT_REQUEST_RECENT_LIST_LIMIT = 20;

export class JobReassignmentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobReassignmentRequestError";
  }
}

export type JobReassignmentRequestRecord = {
  id: string;
  businessId: string;
  jobId: string;
  membershipId: string;
  workerName: string;
  jobLabel: string;
  scheduledAt: Date | null;
  reason: string;
  status: JobReassignmentRequestStatus;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedByMembershipId: string | null;
  updatedAt: Date;
};

export function requireJobReassignmentRequestReason(value: string | null | undefined): string {
  const reason = (value ?? "").trim();
  if (!reason) {
    throw new JobReassignmentRequestError(JOB_REASSIGNMENT_REQUEST_REASON_MESSAGE);
  }
  return reason.slice(0, JOB_REASSIGNMENT_REQUEST_REASON_MAX);
}

export function requireJobReassignmentRequestDecision(
  value: string | null | undefined,
): JobReassignmentRequestDecision {
  if (!(JOB_REASSIGNMENT_REQUEST_DECISIONS as readonly string[]).includes(value ?? "")) {
    throw new JobReassignmentRequestError("Choose accept or decline.");
  }
  return value as JobReassignmentRequestDecision;
}

export function isRequestableUpcomingAssignedJob(
  job: Pick<FieldJob, "id" | "status" | "scheduledAt">,
  now: Date,
  timeZone: string,
): boolean {
  if (job.status === "COMPLETED") return false;
  if (job.status === "CANCELLED") return false;
  return isUpcomingFieldJob(job, now, timeZone);
}

export function jobReassignmentRefusalMessage(status: string, assignedMembershipId: string | null, expectedMembershipId: string) {
  if (status === "COMPLETED") return JOB_REASSIGNMENT_REQUEST_COMPLETED_MESSAGE;
  if (status === "CANCELLED") return JOB_REASSIGNMENT_REQUEST_CANCELLED_MESSAGE;
  if (assignedMembershipId !== expectedMembershipId) {
    return JOB_REASSIGNMENT_REQUEST_ALREADY_REASSIGNED_MESSAGE;
  }
  return null;
}
