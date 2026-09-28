import type { RecoveryQueue } from "@/lib/growth";
import type { RetentionGroup } from "@/lib/growth/retention/constants";
import type { RetentionFollowUpDueState } from "@/lib/growth/retention/due";

export type RetentionCompletionSource = "JOB_COMPLETED" | "unrecorded";

export type RetentionLink = {
  href: string;
  label: string;
};

export type RetentionCandidate = {
  group: RetentionGroup;
  fact: string;
  customerId: string;
  customerName: string;
  lastCompletedJobId: string;
  lastCompletedAt: Date | null;
  lastCompletedAtSource: RetentionCompletionSource;
  daysSinceCompleted: number | null;
  lastCompletedAgeLabel: string | null;
  completedJobCount: number;
  laterJobRecorded: boolean;
  lastInvoiceStatus: string | null;
  lastInvoiceId: string | null;
  lastReviewRequestStatus: string | null;
  lastFollowUpStatus: string | null;
  lastFollowUpKind: string | null;
  links: RetentionLink[];
};

export type { RetentionFollowUpDueState };

export type RetentionFollowUpRow = {
  group: "RECORDED_FOLLOW_UP" | "DUE_OR_OVERDUE";
  fact: string;
  followUpId: string;
  customerId: string;
  customerName: string;
  jobId: string | null;
  kind: string;
  status: string;
  statusLabel: string;
  origin: string;
  dueAt: Date | null;
  dueState: RetentionFollowUpDueState;
  dueStateLabel: string;
  links: RetentionLink[];
};

export type RetentionJourneyRow = {
  group: "INCOMPLETE_JOURNEY";
  fact: string;
  queue: RecoveryQueue;
  queueLabel: string;
  customerId: string | null;
  customerName: string;
  requestId: string | null;
  estimateId: string | null;
  links: RetentionLink[];
};

export type RetentionWorkspace = {
  businessId: string;
  timeZone: string;
  candidateLimit: number;
  readOnly: true;
  mutationsOnLoad: false;
  groups: {
    noReviewRequest: RetentionCandidate[];
    noLaterJob: RetentionCandidate[];
    recordedFollowUp: RetentionFollowUpRow[];
    dueOrOverdue: RetentionFollowUpRow[];
    noReferralRequest: RetentionCandidate[];
    incompleteJourney: RetentionJourneyRow[];
  };
  totals: {
    noReviewRequest: number;
    noLaterJob: number;
    recordedFollowUp: number;
    dueOrOverdue: number;
    noReferralRequest: number;
    incompleteJourney: number;
  };
};
