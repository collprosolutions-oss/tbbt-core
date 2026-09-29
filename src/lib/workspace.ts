import { redirect } from "next/navigation";
import type { Business, Membership, MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import { getSessionUser, getWorkspaceCookie, setWorkspaceCookie } from "@/lib/auth";
import { loadActiveWorkspaceMemberships } from "@/lib/business-contact";
import { prisma } from "@/lib/prisma";

export type WorkspaceContext = {
  user: { id: string; email: string; name: string };
  business: Business;
  membership: Membership;
  role: MembershipRole;
};

export type WorkspaceRequestDeps = {
  db?: PrismaClient | Prisma.TransactionClient;
  getSessionUser?: typeof getSessionUser;
  getWorkspaceCookie?: typeof getWorkspaceCookie;
  setWorkspaceCookie?: typeof setWorkspaceCookie;
  redirect?: (path: string) => never;
};

/**
 * Authenticated workspace load. Schema/data migration belongs exclusively
 * to the migration system. Missing required Business contact columns
 * fail closed via loadActiveWorkspaceMemberships — this is not a second
 * migrate deploy, including on Preview (shared production DATABASE_URL).
 */
export async function requireWorkspace(
  deps: WorkspaceRequestDeps = {},
): Promise<WorkspaceContext> {
  const db = deps.db ?? prisma;
  const readUser = deps.getSessionUser ?? getSessionUser;
  const readCookie = deps.getWorkspaceCookie ?? getWorkspaceCookie;
  const writeCookie = deps.setWorkspaceCookie ?? setWorkspaceCookie;
  const bounce = deps.redirect ?? redirect;

  const user = await readUser();
  if (!user) {
    bounce("/sign-in");
    throw new Error("requireWorkspace redirected");
  }

  // Only an ACTIVE membership resolves to a real workspace -- an
  // OWNER/ADMIN-deactivated MEMBER membership (see removeTeamMember() in
  // src/app/actions/team.ts) must lose access here, at the single place
  // every authenticated page/action derives its workspace from, not just
  // in the Team UI.
  const memberships = await loadActiveWorkspaceMemberships(db, user.id);

  if (memberships.length === 0) {
    bounce("/sign-in");
    throw new Error("requireWorkspace redirected");
  }

  const requestedId = await readCookie();
  const current =
    memberships.find((membership) => membership.businessId === requestedId) ??
    memberships[0];

  if (current.businessId !== requestedId) {
    await writeCookie(current.businessId);
  }

  return {
    user,
    business: current.business,
    membership: current,
    role: current.role,
  };
}
