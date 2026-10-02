/**
 * Project-link reads and the live-token resolver used by every
 * /p/[token] page and customer action.
 *
 * Token lookup only for the customer path. OWNER review is scoped by
 * BusinessAccess. Mutation-free. Missing tables degrade: a matching
 * Job.projectToken stays live until the status row says REVOKED.
 * Table presence is probed with to_regclass so a missing schema never
 * runs a Prisma find inside an open transaction (P2021 aborts Postgres
 * and the next statement throws 25P02).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { jobProjectLinkWriteAllowed } from "@/lib/project-link";
import {
  JOB_PROJECT_LINK_HISTORY_BOUND,
  JOB_PROJECT_LINK_OWNER_WORKFLOW_MESSAGE,
  JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE,
  missingJobProjectLinkSchema,
  parseProjectLinkToken,
  recordedProjectLinkEventLabel,
  recordedProjectLinkStatusLabel,
  type JobProjectLinkStatus,
  type OwnerJobProjectLink,
  type OwnerJobProjectLinkHistoryEvent,
} from "@/lib/project-link";

type Db = PrismaClient | Prisma.TransactionClient;

export { JOB_PROJECT_LINK_PORTAL_UNAVAILABLE_MESSAGE };

async function jobProjectLinkTablesPresent(db: Db): Promise<boolean> {
  const probe = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT
      to_regclass('"JobProjectLink"') IS NOT NULL
      AND to_regclass('"JobProjectLinkEvent"') IS NOT NULL
      AS present
  `;
  return Boolean(probe[0]?.present);
}

export type OwnerJobProjectLinkReview = {
  jobId: string;
  eligible: true;
  canWrite: boolean;
  workflowMessage: string;
  link: OwnerJobProjectLink;
  history: OwnerJobProjectLinkHistoryEvent[];
};

async function loadLinkStatus(
  db: Db,
  jobId: string,
): Promise<{ status: string } | null> {
  if (!(await jobProjectLinkTablesPresent(db))) return null;
  try {
    return await db.jobProjectLink.findFirst({
      where: { jobId },
      select: { status: true },
    });
  } catch (error) {
    if (missingJobProjectLinkSchema(error)) return null;
    throw error;
  }
}

export async function isLiveProjectToken(
  db: Db,
  token: string | null | undefined,
): Promise<boolean> {
  const parsed = parseProjectLinkToken(token);
  if (!parsed) return false;
  const job = await db.job.findUnique({
    where: { projectToken: parsed },
    select: { id: true },
  });
  if (!job) return false;
  const link = await loadLinkStatus(db, job.id);
  return link?.status !== "REVOKED";
}

/**
 * Customer-token resolver. Old rotated tokens miss Job.projectToken.
 * Revoked jobs miss even when a burned unused token is still stored.
 */
export async function findLiveJobByProjectToken<T extends Prisma.JobSelect>(
  db: Db,
  token: string | null | undefined,
  select: T,
): Promise<Prisma.JobGetPayload<{ select: T }> | null> {
  const parsed = parseProjectLinkToken(token);
  if (!parsed) return null;
  if (!(await isLiveProjectToken(db, parsed))) return null;
  return db.job.findUnique({
    where: { projectToken: parsed },
    select,
  });
}

/**
 * Post-lock re-check for customer writes that look up a token, then
 * take Job FOR UPDATE. Rotate/revoke can commit between the unlocked
 * live check and the lock; the supplied token must still be
 * Job.projectToken and the link must not be REVOKED.
 */
export async function assertLiveLockedProjectToken(
  db: Db,
  input: { jobId: string; businessId?: string; token: string },
): Promise<boolean> {
  const parsed = parseProjectLinkToken(input.token);
  if (!parsed) return false;
  const job = await db.job.findFirst({
    where: {
      id: input.jobId,
      ...(input.businessId ? { businessId: input.businessId } : {}),
    },
    select: { projectToken: true },
  });
  if (!job || job.projectToken !== parsed) return false;
  const link = await loadLinkStatus(db, input.jobId);
  return link?.status !== "REVOKED";
}

/** Outbound customer URLs omit rotated or revoked tokens. */
export async function liveOutboundProjectToken(
  db: Db,
  token: string | null | undefined,
): Promise<string | null> {
  const parsed = parseProjectLinkToken(token);
  if (!parsed) return null;
  if (!(await isLiveProjectToken(db, parsed))) return null;
  return parsed;
}

export async function loadProjectLinkActiveByJobIds(
  db: Db,
  jobIds: readonly string[],
): Promise<Map<string, boolean>> {
  const active = new Map<string, boolean>();
  const ids = [...new Set(jobIds.filter(Boolean))];
  for (const id of ids) active.set(id, true);
  if (ids.length === 0) return active;
  if (!(await jobProjectLinkTablesPresent(db))) return active;
  try {
    const rows = await db.jobProjectLink.findMany({
      where: { jobId: { in: ids } },
      select: { jobId: true, status: true },
    });
    for (const row of rows) {
      active.set(row.jobId, row.status !== "REVOKED");
    }
  } catch (error) {
    if (!missingJobProjectLinkSchema(error)) throw error;
  }
  return active;
}

export async function loadJobProjectLinkReview(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<OwnerJobProjectLinkReview | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: { id: true, businessId: true, projectToken: true },
  });
  if (!job) return null;
  access.assertOwned(job);

  let status: JobProjectLinkStatus = "ACTIVE";
  let rotatedAt: Date | null = null;
  let revokedAt: Date | null = null;
  let history: OwnerJobProjectLinkHistoryEvent[] = [];

  if (await jobProjectLinkTablesPresent(db)) {
    try {
      const link = await db.jobProjectLink.findFirst({
        where: { jobId: job.id, businessId: access.businessId },
        select: {
          status: true,
          rotatedAt: true,
          revokedAt: true,
          events: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: JOB_PROJECT_LINK_HISTORY_BOUND,
            select: {
              id: true,
              eventType: true,
              fromStatus: true,
              toStatus: true,
              createdAt: true,
              actor: { select: { user: { select: { name: true } } } },
            },
          },
        },
      });
      if (link) {
        status = link.status === "REVOKED" ? "REVOKED" : "ACTIVE";
        rotatedAt = link.rotatedAt;
        revokedAt = link.revokedAt;
        history = link.events.map((event) => ({
          id: event.id,
          eventType: event.eventType,
          eventLabel: recordedProjectLinkEventLabel(event.eventType),
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          createdAt: event.createdAt,
          actorName: event.actor.user.name,
        }));
      }
    } catch (error) {
      if (!missingJobProjectLinkSchema(error)) throw error;
    }
  }

  const active = status === "ACTIVE";
  return {
    jobId: job.id,
    eligible: true,
    canWrite: jobProjectLinkWriteAllowed(access.workspace.role),
    workflowMessage: JOB_PROJECT_LINK_OWNER_WORKFLOW_MESSAGE,
    link: {
      jobId: job.id,
      status,
      statusLabel: recordedProjectLinkStatusLabel(status),
      active,
      projectToken: active ? job.projectToken : null,
      projectPath: active ? `/p/${job.projectToken}` : null,
      rotatedAt,
      revokedAt,
    },
    history,
  };
}
