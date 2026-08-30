/**
 * Founder Design Mode authorization.
 *
 * This is a PLATFORM-LEVEL developer flag (User.isFounder in
 * prisma/schema.prisma), completely independent of the tenant
 * Membership/MembershipRole system (src/lib/authorization.ts) used
 * everywhere else in the app. A subscriber OWNER/ADMIN/MEMBER -- no
 * matter how privileged within their own business -- is never a TBBT
 * developer, so none of those roles are ever consulted here.
 *
 * Deliberately does NOT touch src/lib/auth.ts (session validation is
 * security-critical and already covered by getSessionUser()); this file
 * only adds one small, independent read of the already-authenticated
 * User's own isFounder flag.
 *
 * GRANTING / REVOKING FOUNDER ACCESS:
 * There is no UI or API for this, by design (see the "do not expose
 * founder authorization through editable business settings" requirement).
 * Use the maintenance script instead:
 *
 *   node --experimental-strip-types scripts/set-founder-access.mjs <email> true|false
 *
 * ...which simply does `prisma.user.update({ where: { email }, data: {
 * isFounder } })`. This requires direct database/deploy access, matching
 * every other "add a real founder to prod" action in this codebase.
 */
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export class FounderAccessError extends Error {
  constructor(message = "Founder Design Mode is not available for this account.") {
    super(message);
    this.name = "FounderAccessError";
  }
}

/**
 * Non-throwing check, safe to call from any page/layout to decide
 * whether to render the Founder Design Mode trigger at all. Returns the
 * founder's own user id (needed to scope their saved overrides) or null.
 * NEVER derives founder status from anything client-supplied.
 */
export async function checkFounderAccess(): Promise<{ id: string } | null> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, isFounder: true },
  });
  if (!user?.isFounder) {
    return null;
  }
  return { id: user.id };
}

/**
 * The enforcement boundary for every Founder Design Mode server action
 * (src/app/actions/founder-design.ts). Throws FounderAccessError -- never
 * silently no-ops -- so a non-founder's mutation attempt fails loudly and
 * visibly in server logs, exactly like requireBusinessCapability() does
 * for tenant-role violations.
 */
export async function requireFounderAccess(): Promise<{ id: string }> {
  const founder = await checkFounderAccess();
  if (!founder) {
    throw new FounderAccessError();
  }
  return founder;
}
