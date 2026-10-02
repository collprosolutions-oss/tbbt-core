/**
 * Transaction-scoped exact active-membership guard.
 *
 * Assigned-job writes (web and native) authorize once before the Job
 * lock. Session issuance and that pre-transaction read are not enough:
 * a MEMBER can be deactivated after the authorize read and still hold a
 * live access object. Callers lock/re-read the Job, recheck assignment,
 * then invoke this helper immediately before mutation.
 *
 * The query is exact: THIS Membership id in THIS business, locked for
 * the remainder of the transaction. It does not accept another person's
 * row or "any active membership" substitute.
 *
 * When more than one Membership must be locked (actor, previous
 * assignee, next assignee), use lockTenantOwnedMemberships so every
 * writer takes those rows in the same id order after Job locks.
 */
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type LockedTenantMembership = {
  id: string;
  active: boolean;
  role: string;
};

/**
 * Tenant-scoped Membership row locks in stable id order. Callers that
 * already hold the schedule-reservation advisory lock and Job row
 * locks take this next so deactivate and reassign cannot 40P01.
 */
export async function lockTenantOwnedMemberships(
  db: Tx,
  businessId: string,
  membershipIds: ReadonlyArray<string | null | undefined>,
): Promise<LockedTenantMembership[]> {
  const ids = [
    ...new Set(membershipIds.filter((id): id is string => Boolean(id))),
  ].sort();
  const locked: LockedTenantMembership[] = [];
  for (const membershipId of ids) {
    const rows = await db.$queryRaw<LockedTenantMembership[]>`
      SELECT id, active, role
      FROM "Membership"
      WHERE id = ${membershipId}
        AND "businessId" = ${businessId}
      FOR UPDATE
    `;
    if (rows[0]) {
      locked.push(rows[0]);
    }
  }
  return locked;
}

export async function exactActiveMembershipHeld(
  db: Tx,
  actor: { businessId: string; membershipId: string },
): Promise<boolean> {
  const rows = await lockTenantOwnedMemberships(db, actor.businessId, [
    actor.membershipId,
  ]);
  return rows[0]?.id === actor.membershipId && rows[0].active === true;
}
