/**
 * Customer Project Portal read model for a callback request.
 *
 * Token lookup only. Mutation-free. Bounded reads. Never returns other
 * jobs, costs, warranty determinations, or owner-only fields.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  JOB_CALLBACK_OPEN_STATUSES,
  isPortalJobCallbackCoolingDown,
  parsePortalProjectToken,
  portalJobCallbackCooldownAvailableAt,
} from "@/lib/job-callback";

type Db = PrismaClient | Prisma.TransactionClient;

export type PortalJobCallbackView =
  | { status: "hidden" }
  | { status: "ready"; jobId: string }
  | { status: "already_requested"; jobId: string }
  | { status: "cooldown"; jobId: string; availableAt: Date };

const PORTAL_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
} as const;

export async function loadPortalJobCallbackView(
  db: Db,
  token: string,
): Promise<PortalJobCallbackView> {
  const projectToken = parsePortalProjectToken(token);
  if (!projectToken) return { status: "hidden" };

  const job = await db.job.findUnique({
    where: { projectToken },
    select: PORTAL_JOB_SELECT,
  });
  if (!job || job.status !== "COMPLETED") {
    return { status: "hidden" };
  }

  const open = await db.jobCallback.findFirst({
    where: {
      businessId: job.businessId,
      jobId: job.id,
      status: { in: [...JOB_CALLBACK_OPEN_STATUSES] },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true },
  });

  if (open) {
    return { status: "already_requested", jobId: job.id };
  }

  const resolved = await findLatestResolvedJobCallback(db, job.businessId, job.id);
  const resolvedAt = resolvedJobCallbackAt(resolved);
  if (resolvedAt && isPortalJobCallbackCoolingDown(resolvedAt)) {
    return {
      status: "cooldown",
      jobId: job.id,
      availableAt: portalJobCallbackCooldownAvailableAt(resolvedAt),
    };
  }
  return { status: "ready", jobId: job.id };
}

export async function findLatestResolvedJobCallback(
  db: Db,
  businessId: string,
  jobId: string,
) {
  return db.jobCallback.findFirst({
    where: {
      businessId,
      jobId,
      status: "OUTCOME_RECORDED",
    },
    orderBy: [
      { outcomeAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take: 1,
    select: { id: true, outcomeAt: true, updatedAt: true },
  });
}

export function resolvedJobCallbackAt(
  row: { outcomeAt: Date | null; updatedAt: Date } | null,
): Date | null {
  if (!row) return null;
  return row.outcomeAt ?? row.updatedAt;
}
