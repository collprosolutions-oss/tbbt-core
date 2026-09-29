/**
 * Transaction-scoped exact active-membership guard.
 *
 * Native assigned-job writes authorize once before the Job lock. Session
 * issuance and that pre-transaction read are not enough: a MEMBER can be
 * deactivated after the authorize read and still hold a live access
 * object. Callers lock/re-read the Job, recheck assignment, then invoke
 * this helper immediately before mutation.
 *
 * The query is exact: THIS Membership id in THIS business, locked for
 * the remainder of the transaction. It does not accept another person's
 * row or "any active membership" substitute.
 */
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export async function exactActiveMembershipHeld(
  db: Tx,
  actor: { businessId: string; membershipId: string },
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string; active: boolean }>>`
    SELECT id, active
    FROM "Membership"
    WHERE id = ${actor.membershipId}
      AND "businessId" = ${actor.businessId}
    FOR UPDATE
  `;
  return rows[0]?.active === true;
}
