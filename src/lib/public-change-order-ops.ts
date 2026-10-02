/**
 * Customer Project Portal change-order approve / decline.
 *
 * Resolves the Job from projectToken only. The unlocked live check can
 * race OWNER rotate/revoke, so the write transaction locks the Job and
 * re-validates Job.projectToken before flipping SENT. Never a
 * client-supplied businessId.
 */
import type { PrismaClient } from "@prisma/client";
import {
  assertLiveLockedProjectToken,
  findLiveJobByProjectToken,
} from "@/lib/project-link-data";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export const CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR =
  "This change order is not available.";
export const CUSTOMER_CHANGE_ORDER_NOT_READY_ERROR =
  "This change order is not ready to respond to.";

export type CustomerChangeOrderDecision = "APPROVED" | "DECLINED";

export type CustomerChangeOrderWriteResult =
  | { status: CustomerChangeOrderDecision }
  | { error: string };

/**
 * Test-only barrier. Production never sets this.
 * afterJobLock runs inside the write transaction after lockTenantOwnedJob
 * and before the post-lock live-token re-check.
 */
export const publicChangeOrderTestHooks: {
  afterJobLock?: (input: {
    jobId: string;
    token: string;
    kind: "approve" | "decline";
  }) => Promise<void> | void;
} = {};

async function respondToCustomerChangeOrder(
  db: PrismaClient,
  input: { token: string; changeOrderId: string },
  decision: CustomerChangeOrderDecision,
): Promise<CustomerChangeOrderWriteResult> {
  const token = input.token.trim();
  const changeOrderId = input.changeOrderId.trim();
  if (!token || !changeOrderId) {
    return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
  }

  const kind = decision === "APPROVED" ? "approve" : "decline";

  return db.$transaction(async (tx) => {
    const job = await findLiveJobByProjectToken(tx, token, {
      id: true,
      businessId: true,
    });
    if (!job) {
      return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
    }

    const locked = await lockTenantOwnedJob(tx, job.businessId, job.id);
    if (!locked || locked.businessId !== job.businessId) {
      return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
    }
    await publicChangeOrderTestHooks.afterJobLock?.({
      jobId: locked.id,
      token,
      kind,
    });
    if (
      !(await assertLiveLockedProjectToken(tx, {
        jobId: locked.id,
        businessId: locked.businessId,
        token,
      }))
    ) {
      return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
    }

    const changeOrder = await tx.changeOrder.findFirst({
      where: {
        id: changeOrderId,
        jobId: locked.id,
        businessId: locked.businessId,
      },
      select: { id: true, status: true },
    });
    if (!changeOrder) {
      return { error: CUSTOMER_CHANGE_ORDER_UNAVAILABLE_ERROR };
    }
    if (changeOrder.status === decision) {
      return { status: decision };
    }
    if (changeOrder.status !== "SENT") {
      return { error: CUSTOMER_CHANGE_ORDER_NOT_READY_ERROR };
    }

    const now = new Date();
    const updated = await tx.changeOrder.updateMany({
      where: {
        id: changeOrder.id,
        jobId: locked.id,
        businessId: locked.businessId,
        status: "SENT",
      },
      data:
        decision === "APPROVED"
          ? { status: "APPROVED", approvedAt: now }
          : { status: "DECLINED", declinedAt: now },
    });
    if (updated.count === 1) {
      return { status: decision };
    }

    const finalState = await tx.changeOrder.findFirst({
      where: {
        id: changeOrder.id,
        jobId: locked.id,
        businessId: locked.businessId,
      },
      select: { status: true },
    });
    if (finalState?.status === decision) {
      return { status: decision };
    }
    return { error: CUSTOMER_CHANGE_ORDER_NOT_READY_ERROR };
  }, { timeout: 15_000 });
}

export async function approveCustomerChangeOrder(
  db: PrismaClient,
  input: { token: string; changeOrderId: string },
): Promise<CustomerChangeOrderWriteResult> {
  return respondToCustomerChangeOrder(db, input, "APPROVED");
}

export async function declineCustomerChangeOrder(
  db: PrismaClient,
  input: { token: string; changeOrderId: string },
): Promise<CustomerChangeOrderWriteResult> {
  return respondToCustomerChangeOrder(db, input, "DECLINED");
}
