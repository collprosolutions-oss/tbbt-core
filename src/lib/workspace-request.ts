import type { Business, Membership, MembershipRole, Prisma, PrismaClient } from "@prisma/client";
import { loadActiveWorkspaceMemberships } from "@/lib/business-contact";

export type WorkspaceContext = {
  user: { id: string; email: string; name: string };
  business: Business;
  membership: Membership;
  role: MembershipRole;
};

export type WorkspaceRequestUser = {
  id: string;
  email: string;
  name: string;
};

export type WorkspaceRequestDeps = {
  db: PrismaClient | Prisma.TransactionClient;
  getSessionUser: () => Promise<WorkspaceRequestUser | null>;
  getWorkspaceCookie: () => Promise<string | null>;
  setWorkspaceCookie: (businessId: string) => Promise<void>;
  redirect: (path: string) => never;
};

/**
 * Next.js forbids cookie writes during Server Component render.
 * Isolation already selected the authorized membership; a stale or
 * foreign workspace cookie must not 500 Settings or any other page.
 */
export function isReadonlyCookieMutationError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes(
      "Cookies can only be modified in a Server Action or Route Handler",
    )
  );
}

/**
 * Preview-mode and production request path for authenticated workspace
 * load. Schema/data migration belongs exclusively to the migration
 * system. Missing required Business contact columns fail closed via
 * loadActiveWorkspaceMemberships.
 */
export async function requireWorkspace(
  deps: WorkspaceRequestDeps,
): Promise<WorkspaceContext> {
  const user = await deps.getSessionUser();
  if (!user) {
    deps.redirect("/sign-in");
    throw new Error("requireWorkspace redirected");
  }

  // Only an ACTIVE membership resolves to a real workspace -- an
  // OWNER/ADMIN-deactivated MEMBER membership (see removeTeamMember() in
  // src/app/actions/team.ts) must lose access here, at the single place
  // every authenticated page/action derives its workspace from, not just
  // in the Team UI.
  const memberships = await loadActiveWorkspaceMemberships(deps.db, user.id);

  if (memberships.length === 0) {
    deps.redirect("/sign-in");
    throw new Error("requireWorkspace redirected");
  }

  const requestedId = await deps.getWorkspaceCookie();
  const current =
    memberships.find((membership) => membership.businessId === requestedId) ??
    memberships[0];

  if (current.businessId !== requestedId) {
    try {
      await deps.setWorkspaceCookie(current.businessId);
    } catch (error) {
      if (!isReadonlyCookieMutationError(error)) throw error;
    }
  }

  return {
    user,
    business: current.business,
    membership: current,
    role: current.role,
  };
}
