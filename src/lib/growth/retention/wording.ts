import {
  CUSTOMER_FOLLOW_UP_STATUS_LABELS,
  FORBIDDEN_CADENCE_PATTERNS,
  FORBIDDEN_RETENTION_CLAIM_PATTERNS,
  type CustomerFollowUpStatus,
} from "@/lib/growth/retention/constants";
import type { RetentionWorkspace } from "@/lib/growth/retention/types";

export function isCustomerFollowUpStatus(value: string): value is CustomerFollowUpStatus {
  return value in CUSTOMER_FOLLOW_UP_STATUS_LABELS;
}

/**
 * Present the recorded CustomerFollowUp.status only. SENT is never
 * rewritten to DELIVERED. DONE is never rewritten to SENT.
 */
export function recordedFollowUpStatusLabel(status: string): string {
  if (isCustomerFollowUpStatus(status)) {
    return CUSTOMER_FOLLOW_UP_STATUS_LABELS[status];
  }
  return status;
}

export function retentionWorkspaceText(workspace: RetentionWorkspace): string {
  const parts: string[] = [];
  for (const row of workspace.groups.noReviewRequest) {
    parts.push(row.fact, row.lastCompletedAgeLabel ?? "");
  }
  for (const row of workspace.groups.noLaterJob) {
    parts.push(row.fact, row.lastCompletedAgeLabel ?? "");
  }
  for (const row of workspace.groups.dueOrOverdue) {
    parts.push(row.fact, row.status, row.statusLabel, row.dueStateLabel);
  }
  for (const row of workspace.groups.recordedFollowUp) {
    parts.push(row.fact, row.status, row.statusLabel, row.dueStateLabel);
  }
  for (const row of workspace.groups.noReferralRequest) {
    parts.push(row.fact, row.lastCompletedAgeLabel ?? "");
  }
  for (const row of workspace.groups.incompleteJourney) {
    parts.push(row.fact, row.queueLabel);
  }
  return parts.join("\n");
}

export function retentionTextHasForbiddenClaim(text: string): boolean {
  return FORBIDDEN_RETENTION_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function retentionTextHasInventedCadence(text: string): boolean {
  return FORBIDDEN_CADENCE_PATTERNS.some((pattern) => pattern.test(text));
}

export function followUpStatusIsDeliveredRewrite(status: string, label: string): boolean {
  return status === "SENT" && /deliver/i.test(label);
}
