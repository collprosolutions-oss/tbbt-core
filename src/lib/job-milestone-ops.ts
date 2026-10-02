/**
 * OWNER writes for Job milestones.
 * businessId always comes from BusinessAccess. This module writes only
 * JobMilestone / JobMilestoneEvent rows. It never writes Job.status,
 * Invoice, JobCrewVisit.checklistJson, or customer messages.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, canAccessManagementConsole } from "@/lib/authorization";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";
import {
  CUSTOMER_HIDDEN_BY_DEFAULT_MESSAGE,
  DUPLICATE_SORT_ORDER_MESSAGE,
  DUPLICATE_TITLE_MESSAGE,
  JOB_MILESTONE_HISTORY_BOUND,
  JOB_NOT_FOUND_MESSAGE,
  MAX_JOB_MILESTONES,
  MILESTONE_BOUND_MESSAGE,
  MILESTONE_NOT_FOUND_MESSAGE,
  MILESTONE_UNAVAILABLE_MESSAGE,
  NO_AUTOMATIC_MESSAGE_MESSAGE,
  NO_INFERRED_COMPLETION_MESSAGE,
  TITLE_BLANK_MESSAGE,
  TITLE_REQUIRED_MESSAGE,
  assertCanManageJobMilestones,
  customerMilestoneFromRow,
  milestoneTitleKey,
  orderJobMilestones,
  ownerMilestoneFromRow,
  parseMilestoneTitle,
  parseMilestoneTitleSet,
  resolveRecordedMilestoneStatus,
  type CustomerJobMilestone,
  type JobMilestoneHistoryEvent,
  type OwnerJobMilestone,
  type RecordedJobMilestoneInput,
} from "@/lib/job-milestones";

type Db = PrismaClient | Prisma.TransactionClient;

async function withWriteTx<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) {
    return db.$transaction(fn);
  }
  return fn(db);
}

export class JobMilestoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobMilestoneError";
  }
}

function prismaErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

export function missingJobMilestoneSchema(error: unknown) {
  const code = prismaErrorCode(error);
  return code === "P2021" || code === "P2022";
}

function prismaUniqueTargets(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("meta" in error)) return [];
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];
  return [];
}

export function isDuplicateJobMilestoneSortOrderError(error: unknown) {
  return (
    prismaErrorCode(error) === "P2002" &&
    prismaUniqueTargets(error).some((target) => /sortOrder/i.test(target))
  );
}

export function isDuplicateJobMilestoneTitleError(error: unknown) {
  return (
    prismaErrorCode(error) === "P2002" &&
    prismaUniqueTargets(error).some((target) => /titleKey/i.test(target))
  );
}

/**
 * Test-only barriers. Production never sets these.
 * afterJobLock runs inside the write transaction after lockTenantOwnedJob
 * and before the cap / status snapshot.
 */
export const jobMilestoneTestHooks: {
  afterJobLock?: (input: { jobId: string; kind: string }) => Promise<void> | void;
} = {};

export function jobMilestoneErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobMilestoneError || error instanceof ForbiddenError) {
    return error.message;
  }
  if (missingJobMilestoneSchema(error)) {
    return MILESTONE_UNAVAILABLE_MESSAGE;
  }
  if (isDuplicateJobMilestoneSortOrderError(error)) {
    return DUPLICATE_SORT_ORDER_MESSAGE;
  }
  if (isDuplicateJobMilestoneTitleError(error)) {
    return DUPLICATE_TITLE_MESSAGE;
  }
  if (
    error instanceof Error &&
    (error.message === MILESTONE_NOT_FOUND_MESSAGE ||
      error.message === JOB_NOT_FOUND_MESSAGE)
  ) {
    return error.message;
  }
  return fallback;
}

function actorMembershipId(access: BusinessAccess): string | null {
  return access.workspace.membership?.id ?? null;
}

async function requireOwnedJob(db: Db, access: BusinessAccess, jobId: string) {
  assertCanManageJobMilestones(access);
  if (!jobId) {
    throw new JobMilestoneError(JOB_NOT_FOUND_MESSAGE);
  }
  const job = access.assertOwned(
    await db.job.findFirst({
      where: { id: jobId, businessId: access.businessId },
      select: { id: true, businessId: true, projectToken: true },
    }),
  );
  return job;
}

export async function listOwnerJobMilestones(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<OwnerJobMilestone[]> {
  const job = await requireOwnedJob(db, access, jobId);
  const rows = await db.jobMilestone.findMany({
    where: { jobId: job.id, businessId: access.businessId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return orderJobMilestones(rows.map(ownerMilestoneFromRow));
}

/**
 * OWNER/ADMIN Work Order read. Separate from the Job include so a missing
 * milestone table cannot take down the Work Order page before migrate.
 */
export async function loadWorkOrderMilestones(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<OwnerJobMilestone[]> {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  try {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: jobId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
    const rows = await db.jobMilestone.findMany({
      where: { jobId: job.id, businessId: access.businessId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    return orderJobMilestones(rows.map(ownerMilestoneFromRow));
  } catch (error) {
    if (missingJobMilestoneSchema(error)) return [];
    throw error;
  }
}

export async function listJobMilestoneHistory(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<JobMilestoneHistoryEvent[]> {
  const job = await requireOwnedJob(db, access, jobId);
  const rows = await db.jobMilestoneEvent.findMany({
    where: { jobId: job.id, businessId: access.businessId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: JOB_MILESTONE_HISTORY_BOUND,
    select: {
      id: true,
      milestoneId: true,
      eventType: true,
      status: true,
      createdAt: true,
    },
  });
  return [...rows].reverse();
}

export async function loadCustomerVisibleMilestonesForProjectToken(
  db: Db,
  projectToken: string,
): Promise<{ jobId: string; businessId: string; milestones: CustomerJobMilestone[] } | null> {
  const token = projectToken.trim();
  if (!token) return null;
  try {
    const job = await findLiveJobByProjectToken(db, token, {
      id: true,
      businessId: true,
    });
    if (!job) return null;
    const rows = await db.jobMilestone.findMany({
      where: {
        jobId: job.id,
        businessId: job.businessId,
        customerVisible: true,
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: {
        title: true,
        sortOrder: true,
        status: true,
        completedAt: true,
        customerVisible: true,
      },
    });
    return {
      jobId: job.id,
      businessId: job.businessId,
      milestones: rows
        .map(customerMilestoneFromRow)
        .filter((row): row is CustomerJobMilestone => row !== null),
    };
  } catch (error) {
    if (missingJobMilestoneSchema(error)) return null;
    throw error;
  }
}

export async function recordJobMilestones(
  db: Db,
  access: BusinessAccess,
  input: { jobId: string; items: RecordedJobMilestoneInput[] },
): Promise<{
  milestones: OwnerJobMilestone[];
  message: string;
}> {
  const parsed =
    input.items.length > 0
      ? parseMilestoneTitleSet(input.items.map((item) => item.title))
      : { items: [], error: TITLE_REQUIRED_MESSAGE };
  if (parsed.error || parsed.items.length === 0) {
    throw new JobMilestoneError(parsed.error ?? TITLE_REQUIRED_MESSAGE);
  }
  const job = await requireOwnedJob(db, access, input.jobId);
  const actorId = actorMembershipId(access);

  try {
    const created = await withWriteTx(db, async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, job.id);
      if (!locked) {
        throw new JobMilestoneError(JOB_NOT_FOUND_MESSAGE);
      }
      await jobMilestoneTestHooks.afterJobLock?.({ jobId: job.id, kind: "record" });
      const existing = await tx.jobMilestone.findMany({
        where: { jobId: job.id, businessId: access.businessId },
        select: { sortOrder: true, titleKey: true },
      });
      if (existing.length + parsed.items.length > MAX_JOB_MILESTONES) {
        throw new JobMilestoneError(MILESTONE_BOUND_MESSAGE);
      }
      const existingKeys = new Set(existing.map((row) => row.titleKey));
      let nextOrder =
        existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
      const rows: OwnerJobMilestone[] = [];
      for (let index = 0; index < parsed.items.length; index += 1) {
        const title = parsed.items[index].title;
        const titleKey = milestoneTitleKey(title);
        if (existingKeys.has(titleKey)) {
          throw new JobMilestoneError(DUPLICATE_TITLE_MESSAGE);
        }
        existingKeys.add(titleKey);
        const customerVisible = input.items[index]?.customerVisible === true;
        const row = await tx.jobMilestone.create({
          data: {
            businessId: access.businessId,
            jobId: job.id,
            title,
            titleKey,
            sortOrder: nextOrder,
            customerVisible,
            status: "OPEN",
            createdByMembershipId: actorId,
          },
        });
        nextOrder += 1;
        await tx.jobMilestoneEvent.create({
          data: {
            businessId: access.businessId,
            jobId: job.id,
            milestoneId: row.id,
            eventType: "RECORDED",
            status: "OPEN",
            actorMembershipId: actorId,
            payload: customerVisible ? "customerVisible" : "customerHidden",
          },
        });
        if (customerVisible) {
          await tx.jobMilestoneEvent.create({
            data: {
              businessId: access.businessId,
              jobId: job.id,
              milestoneId: row.id,
              eventType: "CUSTOMER_EXPOSED",
              status: "OPEN",
              actorMembershipId: actorId,
            },
          });
        }
        rows.push(ownerMilestoneFromRow(row));
      }
      return rows;
    });

    return {
      milestones: created,
      message: created.some((row) => row.customerVisible)
        ? NO_AUTOMATIC_MESSAGE_MESSAGE
        : CUSTOMER_HIDDEN_BY_DEFAULT_MESSAGE,
    };
  } catch (error) {
    if (error instanceof JobMilestoneError || error instanceof ForbiddenError) {
      throw error;
    }
    if (missingJobMilestoneSchema(error)) {
      throw new JobMilestoneError(MILESTONE_UNAVAILABLE_MESSAGE);
    }
    if (isDuplicateJobMilestoneSortOrderError(error)) {
      throw new JobMilestoneError(DUPLICATE_SORT_ORDER_MESSAGE);
    }
    if (isDuplicateJobMilestoneTitleError(error)) {
      throw new JobMilestoneError(DUPLICATE_TITLE_MESSAGE);
    }
    throw error;
  }
}

export async function completeJobMilestone(
  db: Db,
  access: BusinessAccess,
  milestoneId: string,
): Promise<{
  milestone: OwnerJobMilestone;
  alreadyComplete: boolean;
  message: string;
}> {
  assertCanManageJobMilestones(access);
  if (!milestoneId) {
    throw new JobMilestoneError(MILESTONE_NOT_FOUND_MESSAGE);
  }
  const actorId = actorMembershipId(access);
  const now = new Date();

  return withWriteTx(db, async (tx) => {
    const preview = access.assertOwned(
      await tx.jobMilestone.findFirst({
        where: { id: milestoneId, businessId: access.businessId },
      }),
    );
    const locked = await lockTenantOwnedJob(tx, access.businessId, preview.jobId);
    if (!locked) {
      throw new JobMilestoneError(JOB_NOT_FOUND_MESSAGE);
    }
    await jobMilestoneTestHooks.afterJobLock?.({
      jobId: preview.jobId,
      kind: "complete",
    });
    const current = access.assertOwned(
      await tx.jobMilestone.findFirst({
        where: { id: preview.id, businessId: access.businessId },
      }),
    );
    if (current.status === "COMPLETED") {
      return {
        milestone: ownerMilestoneFromRow(current),
        alreadyComplete: true,
        message: NO_INFERRED_COMPLETION_MESSAGE,
      };
    }
    const updated = await tx.jobMilestone.updateMany({
      where: {
        id: current.id,
        businessId: access.businessId,
        jobId: current.jobId,
        status: "OPEN",
      },
      data: {
        status: "COMPLETED",
        completedAt: now,
        completedByMembershipId: actorId,
      },
    });
    if (updated.count !== 1) {
      const after = access.assertOwned(
        await tx.jobMilestone.findFirst({
          where: { id: current.id, businessId: access.businessId },
        }),
      );
      return {
        milestone: ownerMilestoneFromRow(after),
        alreadyComplete: true,
        message: NO_INFERRED_COMPLETION_MESSAGE,
      };
    }
    await tx.jobMilestoneEvent.create({
      data: {
        businessId: access.businessId,
        jobId: current.jobId,
        milestoneId: current.id,
        eventType: "COMPLETED",
        status: "COMPLETED",
        actorMembershipId: actorId,
      },
    });
    const after = access.assertOwned(
      await tx.jobMilestone.findFirst({
        where: { id: current.id, businessId: access.businessId },
      }),
    );
    return {
      milestone: ownerMilestoneFromRow(after),
      alreadyComplete: false,
      message: NO_AUTOMATIC_MESSAGE_MESSAGE,
    };
  });
}

export async function setJobMilestoneCustomerVisible(
  db: Db,
  access: BusinessAccess,
  input: { milestoneId: string; customerVisible: boolean },
): Promise<{
  milestone: OwnerJobMilestone;
  unchanged: boolean;
}> {
  assertCanManageJobMilestones(access);
  if (!input.milestoneId) {
    throw new JobMilestoneError(MILESTONE_NOT_FOUND_MESSAGE);
  }
  const actorId = actorMembershipId(access);
  const customerVisible = input.customerVisible === true;

  return withWriteTx(db, async (tx) => {
    const preview = access.assertOwned(
      await tx.jobMilestone.findFirst({
        where: { id: input.milestoneId, businessId: access.businessId },
      }),
    );
    const locked = await lockTenantOwnedJob(tx, access.businessId, preview.jobId);
    if (!locked) {
      throw new JobMilestoneError(JOB_NOT_FOUND_MESSAGE);
    }
    await jobMilestoneTestHooks.afterJobLock?.({
      jobId: preview.jobId,
      kind: "visibility",
    });
    const current = access.assertOwned(
      await tx.jobMilestone.findFirst({
        where: { id: preview.id, businessId: access.businessId },
      }),
    );
    const snapshotStatus = resolveRecordedMilestoneStatus(current);
    if (current.customerVisible === customerVisible) {
      return {
        milestone: ownerMilestoneFromRow(current),
        unchanged: true,
      };
    }
    const updated = await tx.jobMilestone.updateMany({
      where: {
        id: current.id,
        businessId: access.businessId,
        jobId: current.jobId,
        customerVisible: { not: customerVisible },
      },
      data: { customerVisible },
    });
    if (updated.count === 1) {
      await tx.jobMilestoneEvent.create({
        data: {
          businessId: access.businessId,
          jobId: current.jobId,
          milestoneId: current.id,
          eventType: customerVisible ? "CUSTOMER_EXPOSED" : "CUSTOMER_HIDDEN",
          status: snapshotStatus,
          actorMembershipId: actorId,
        },
      });
    }
    const after = access.assertOwned(
      await tx.jobMilestone.findFirst({
        where: { id: current.id, businessId: access.businessId },
      }),
    );
    return {
      milestone: ownerMilestoneFromRow(after),
      unchanged: updated.count !== 1,
    };
  });
}

export function parseRecordedMilestoneFormItems(
  formData: FormData,
): RecordedJobMilestoneInput[] {
  const expose = formData.get("customerVisible") === "1";
  if (formData.has("titles")) {
    const fromLines = parseMilestoneTitleSet(
      String(formData.get("titles") ?? "").split(/\r?\n/),
    );
    if (fromLines.error || fromLines.items.length === 0) {
      throw new JobMilestoneError(fromLines.error ?? TITLE_REQUIRED_MESSAGE);
    }
    return fromLines.items.map((item) => ({
      ...item,
      customerVisible: expose,
    }));
  }
  const titles = formData
    .getAll("title")
    .map((value) => (typeof value === "string" ? value : ""));
  const parsed = parseMilestoneTitleSet(titles);
  if (parsed.error || parsed.items.length === 0) {
    throw new JobMilestoneError(parsed.error ?? TITLE_REQUIRED_MESSAGE);
  }
  return parsed.items.map((item) => ({ ...item, customerVisible: expose }));
}

export function parseSingleMilestoneTitle(
  raw: string | null | undefined,
): string {
  const parsed = parseMilestoneTitle(raw);
  if (parsed.error || !parsed.title) {
    throw new JobMilestoneError(parsed.error ?? TITLE_BLANK_MESSAGE);
  }
  return parsed.title;
}
