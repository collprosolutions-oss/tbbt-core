import { redirect } from "next/navigation";
import { getSessionUser, getWorkspaceCookie, setWorkspaceCookie } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  requireWorkspace as requireWorkspaceFromRequest,
  type WorkspaceContext,
  type WorkspaceRequestDeps,
} from "@/lib/workspace-request";

export type { WorkspaceContext, WorkspaceRequestDeps };

export type OptionalWorkspaceRequestDeps = Partial<WorkspaceRequestDeps>;

/**
 * Authenticated workspace load. Schema/data migration belongs exclusively
 * to the migration system. Missing required Business contact columns
 * fail closed via loadActiveWorkspaceMemberships — this is not a second
 * migrate deploy, including on Preview (shared production DATABASE_URL).
 */
export async function requireWorkspace(
  deps: OptionalWorkspaceRequestDeps = {},
): Promise<WorkspaceContext> {
  return requireWorkspaceFromRequest({
    db: deps.db ?? prisma,
    getSessionUser: deps.getSessionUser ?? getSessionUser,
    getWorkspaceCookie: deps.getWorkspaceCookie ?? getWorkspaceCookie,
    setWorkspaceCookie: deps.setWorkspaceCookie ?? setWorkspaceCookie,
    redirect: deps.redirect ?? redirect,
  });
}
