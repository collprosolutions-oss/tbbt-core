/**
 * OWNER-recorded, ordered Job milestones.
 *
 * Completion is an explicit OWNER mark only. Do not derive status from
 * Job.status, Invoice, or crew checklist. The locked 5-step customer
 * progress bar in project-progress.ts stays inferred from Job/Invoice;
 * this module is a separate, owner-authored list.
 *
 * The Customer Project Portal shows a milestone only when the OWNER
 * sets customerVisible on that row for the token-scoped Job.
 * These records never send email or SMS.
 */
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";

export const JOB_MILESTONE_KIND = "job-milestone" as const;
export const MAX_JOB_MILESTONES = 8;
export const MAX_MILESTONE_TITLE_LENGTH = 80;

export const JOB_MILESTONE_STATUSES = ["OPEN", "COMPLETED"] as const;
export type JobMilestoneStatus = (typeof JOB_MILESTONE_STATUSES)[number];

export const JOB_MILESTONE_EVENT_TYPES = [
  "RECORDED",
  "COMPLETED",
  "CUSTOMER_EXPOSED",
  "CUSTOMER_HIDDEN",
] as const;
export type JobMilestoneEventType = (typeof JOB_MILESTONE_EVENT_TYPES)[number];

export const TITLE_REQUIRED_MESSAGE = "Add at least one milestone title.";
export const TITLE_BLANK_MESSAGE = "Each milestone needs a title.";
export const TITLE_TOO_LONG_MESSAGE = `Milestone titles must be ${MAX_MILESTONE_TITLE_LENGTH} characters or fewer.`;
export const DUPLICATE_TITLE_MESSAGE =
  "That milestone title is already recorded on this job.";
export const MILESTONE_BOUND_MESSAGE = `A job can record at most ${MAX_JOB_MILESTONES} milestones.`;
export const MILESTONE_NOT_FOUND_MESSAGE =
  "That milestone is not in this workspace.";
export const JOB_NOT_FOUND_MESSAGE = "That work order is not in this workspace.";
export const OWNER_ONLY_MESSAGE = "Only the owner can record job milestones.";
export const NO_INFERRED_COMPLETION_MESSAGE =
  "Milestone completion is recorded by the owner. Job status, invoices, and crew checklists do not mark milestones complete.";
export const NO_AUTOMATIC_MESSAGE_MESSAGE =
  "Recording or completing a milestone does not send a customer message.";
export const CUSTOMER_HIDDEN_BY_DEFAULT_MESSAGE =
  "New milestones stay hidden from the customer portal until the owner chooses to show them.";
export const MILESTONE_UNAVAILABLE_MESSAGE =
  "Job milestones are unavailable on this environment until the milestone migration is applied.";

export type RecordedJobMilestoneInput = {
  title: string;
  customerVisible?: boolean;
};

export type OwnerJobMilestone = {
  id: string;
  businessId: string;
  jobId: string;
  title: string;
  sortOrder: number;
  customerVisible: boolean;
  status: JobMilestoneStatus;
  completedAt: Date | null;
};

export type CustomerJobMilestone = {
  id: string;
  title: string;
  sortOrder: number;
  status: JobMilestoneStatus;
  completedAt: Date | null;
};

export type JobMilestoneHistoryEvent = {
  id: string;
  milestoneId: string;
  eventType: string;
  status: string;
  createdAt: Date;
};

export function canManageJobMilestones(
  role: BusinessAccess["workspace"]["role"],
): boolean {
  return role === "OWNER" && canAccessManagementConsole(role);
}

export function assertCanManageJobMilestones(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  requireBusinessRole(access, "OWNER");
}

export function milestoneTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseMilestoneTitle(raw: string | null | undefined): {
  title: string | null;
  error: string | null;
} {
  const title = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!title) return { title: null, error: TITLE_BLANK_MESSAGE };
  if (title.length > MAX_MILESTONE_TITLE_LENGTH) {
    return { title: null, error: TITLE_TOO_LONG_MESSAGE };
  }
  return { title, error: null };
}

export function parseMilestoneTitleSet(
  rawTitles: readonly string[],
): { items: RecordedJobMilestoneInput[]; error: string | null } {
  const items: RecordedJobMilestoneInput[] = [];
  const seen = new Set<string>();
  for (const raw of rawTitles) {
    const parsed = parseMilestoneTitle(raw);
    if (parsed.error === TITLE_BLANK_MESSAGE && !raw.trim()) {
      continue;
    }
    if (parsed.error || !parsed.title) {
      return { items: [], error: parsed.error ?? TITLE_BLANK_MESSAGE };
    }
    const key = milestoneTitleKey(parsed.title);
    if (seen.has(key)) {
      return { items: [], error: DUPLICATE_TITLE_MESSAGE };
    }
    seen.add(key);
    items.push({ title: parsed.title, customerVisible: false });
  }
  if (items.length === 0) {
    return { items: [], error: TITLE_REQUIRED_MESSAGE };
  }
  if (items.length > MAX_JOB_MILESTONES) {
    return { items: [], error: MILESTONE_BOUND_MESSAGE };
  }
  return { items, error: null };
}

export function parseMilestoneTitlesFromText(raw: string | null | undefined) {
  return parseMilestoneTitleSet((raw ?? "").split(/\r?\n/));
}

export function applyOwnerCustomerVisibleFlag(
  items: RecordedJobMilestoneInput[],
  customerVisible: boolean,
): RecordedJobMilestoneInput[] {
  return items.map((item) => ({ ...item, customerVisible }));
}

export function isJobMilestoneStatus(value: unknown): value is JobMilestoneStatus {
  return (
    typeof value === "string" &&
    (JOB_MILESTONE_STATUSES as readonly string[]).includes(value)
  );
}

export function ownerMilestoneFromRow(row: {
  id: string;
  businessId: string;
  jobId: string;
  title: string;
  sortOrder: number;
  customerVisible: boolean;
  status: string;
  completedAt: Date | null;
}): OwnerJobMilestone {
  return {
    id: row.id,
    businessId: row.businessId,
    jobId: row.jobId,
    title: row.title,
    sortOrder: row.sortOrder,
    customerVisible: row.customerVisible,
    status: isJobMilestoneStatus(row.status) ? row.status : "OPEN",
    completedAt: row.completedAt,
  };
}

export function customerMilestoneFromRow(row: {
  id: string;
  title: string;
  sortOrder: number;
  status: string;
  completedAt: Date | null;
  customerVisible: boolean;
}): CustomerJobMilestone | null {
  if (!row.customerVisible) return null;
  return {
    id: row.id,
    title: row.title,
    sortOrder: row.sortOrder,
    status: isJobMilestoneStatus(row.status) ? row.status : "OPEN",
    completedAt: row.completedAt,
  };
}

export function isolateSameBusinessMilestones<T extends { businessId: string }>(
  rows: readonly T[],
  businessId: string,
): T[] {
  return rows.filter((row) => row.businessId === businessId);
}

export function orderJobMilestones<T extends { sortOrder: number; id: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

export function customerVisibleMilestones<
  T extends { customerVisible: boolean; sortOrder: number; id: string },
>(rows: readonly T[]): T[] {
  return orderJobMilestones(rows.filter((row) => row.customerVisible));
}

/**
 * Completion is never inferred. Job/invoice/checklist values are accepted
 * only so callers can prove they are ignored.
 */
export function resolveRecordedMilestoneStatus(milestone: {
  status: string;
  completedAt: Date | null;
}): JobMilestoneStatus {
  if (milestone.status === "COMPLETED" && milestone.completedAt) {
    return "COMPLETED";
  }
  return "OPEN";
}
