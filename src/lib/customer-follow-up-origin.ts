/**
 * CustomerFollowUp.origin.
 *
 * COMMUNICATION rows are the existing reviews/automation follow-ups and
 * remain eligible for CUSTOMER_FOLLOW_UP_DUE scans. RETENTION_TASK rows
 * are owner-recorded retention work and must never generate a due event
 * or send a message. An owner-set dueAt is only for the retention
 * due/overdue view.
 */
export const CUSTOMER_FOLLOW_UP_ORIGINS = {
  COMMUNICATION: "COMMUNICATION",
  RETENTION_TASK: "RETENTION_TASK",
} as const;

export type CustomerFollowUpOrigin =
  (typeof CUSTOMER_FOLLOW_UP_ORIGINS)[keyof typeof CUSTOMER_FOLLOW_UP_ORIGINS];

export function isRetentionFollowUpTask(origin: string | null | undefined): boolean {
  return origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK;
}

export function customerFollowUpDueScanWhere(businessId: string) {
  return {
    businessId,
    status: "OPEN" as const,
    origin: { not: CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK },
  };
}

export const RETENTION_FOLLOW_UP_LOCK_PREFIX = "retention-follow-up";

export function retentionFollowUpLockKey(input: {
  businessId: string;
  customerId: string;
  jobId: string;
}) {
  return `${RETENTION_FOLLOW_UP_LOCK_PREFIX}:${input.businessId}:${input.customerId}:${input.jobId}`;
}

export function retentionFollowUpStatusLockKey(followUpId: string) {
  return `${RETENTION_FOLLOW_UP_LOCK_PREFIX}-status:${followUpId}`;
}
