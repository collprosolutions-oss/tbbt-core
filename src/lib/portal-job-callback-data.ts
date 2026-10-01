/**
 * Customer Project Portal read model for a callback request.
 *
 * Token lookup only. Mutation-free. Bounded reads. Never returns other
 * jobs, costs, warranty determinations, or owner-only fields.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { JOB_CALLBACK_OPEN_STATUSES, parsePortalProjectToken } from "@/lib/job-callback";

type Db = PrismaClient | Prisma.TransactionClient;

export type PortalJobCallbackView =
  | { status: "hidden" }
  | { status: "ready"; jobId: string }
  | { status: "already_requested"; jobId: string };

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
  return { status: "ready", jobId: job.id };
}
