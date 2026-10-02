/**
 * CustomerFollowUp.origin.
 *
 * COMMUNICATION rows are the existing reviews/automation follow-ups and
 * remain eligible for CUSTOMER_FOLLOW_UP_DUE scans. RETENTION_TASK rows
 * are owner-recorded retention work and must never generate a due event
 * or send a message. MAINTENANCE rows are OWNER-set Handyman aftercare
 * reminders: they appear in the owner queue when due and are never
 * scanned or sent automatically.
 */
export const CUSTOMER_FOLLOW_UP_ORIGINS = {
  COMMUNICATION: "COMMUNICATION",
  RETENTION_TASK: "RETENTION_TASK",
  MAINTENANCE: "MAINTENANCE",
} as const;

export type CustomerFollowUpOrigin =
  (typeof CUSTOMER_FOLLOW_UP_ORIGINS)[keyof typeof CUSTOMER_FOLLOW_UP_ORIGINS];

export function isRetentionFollowUpTask(origin: string | null | undefined): boolean {
  return origin === CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK;
}

export function isMaintenanceFollowUp(origin: string | null | undefined): boolean {
  return origin === CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE;
}

export function followUpSkipsAutomaticSend(origin: string | null | undefined): boolean {
  return isRetentionFollowUpTask(origin) || isMaintenanceFollowUp(origin);
}

export function customerFollowUpDueScanWhere(businessId: string) {
  return {
    businessId,
    status: "OPEN" as const,
    origin: {
      notIn: [
        CUSTOMER_FOLLOW_UP_ORIGINS.RETENTION_TASK,
        CUSTOMER_FOLLOW_UP_ORIGINS.MAINTENANCE,
      ],
    },
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
