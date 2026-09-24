/**
 * BSOS mutations. OWNER/ADMIN via VIEW_REPORTS + management console.
 * Tenant scope is re-checked on every write.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { isActionStatus, isGoalStatus } from "@/lib/bsos";

type Db = PrismaClient | Prisma.TransactionClient;

export class BsosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BsosError";
  }
}

export function bsosErrorMessage(error: unknown, fallback: string) {
  if (error instanceof BsosError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export async function createBusinessGoal(
  db: Db,
  access: BusinessAccess,
  input: { title: string; description?: string; recommendationKey?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const title = input.title.trim();
  if (!title) throw new BsosError("A goal needs a title.");
  return db.businessGoal.create({
    data: {
      businessId: access.businessId,
      title,
      description: input.description?.trim() ?? "",
      recommendationKey: input.recommendationKey?.trim() || null,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function updateBusinessGoalStatus(
  db: Db,
  access: BusinessAccess,
  input: { goalId: string; status: string },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  if (!isGoalStatus(input.status)) throw new BsosError("Choose a valid goal status.");
  const goal = access.assertOwned(
    await db.businessGoal.findFirst({
      where: { id: input.goalId, ...access.scope },
    }),
  );
  return db.businessGoal.update({
    where: { id: goal.id },
    data: { status: input.status },
  });
}

export async function createBusinessActionItem(
  db: Db,
  access: BusinessAccess,
  input: { title: string; recommendationKey: string; notes?: string; goalId?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const title = input.title.trim();
  const recommendationKey = input.recommendationKey.trim();
  if (!title) throw new BsosError("An action item needs a title.");
  if (!recommendationKey) throw new BsosError("An action item must name the recommendation it answers.");
  if (input.goalId) {
    access.assertOwned(
      await db.businessGoal.findFirst({
        where: { id: input.goalId, ...access.scope },
      }),
    );
  }
  return db.businessActionItem.create({
    data: {
      businessId: access.businessId,
      title,
      recommendationKey,
      notes: input.notes?.trim() ?? "",
      goalId: input.goalId || null,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function updateBusinessActionStatus(
  db: Db,
  access: BusinessAccess,
  input: { actionId: string; status: string },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  if (!isActionStatus(input.status)) throw new BsosError("Choose a valid action status.");
  const item = access.assertOwned(
    await db.businessActionItem.findFirst({
      where: { id: input.actionId, ...access.scope },
    }),
  );
  return db.businessActionItem.update({
    where: { id: item.id },
    data: { status: input.status },
  });
}
