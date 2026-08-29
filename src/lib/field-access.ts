/**
 * Assigned-job field authorization -- the Employee Field Workflow's
 * enforcement boundary, independent of (and in addition to)
 * `canAccessManagementConsole()` / `requireBusinessCapability()` in
 * src/lib/authorization.ts, which govern the OWNER/ADMIN management
 * console and are UNCHANGED by this module.
 *
 * Server-side rule, enforced everywhere a Field route or action touches a
 * Job:
 *
 *   Authenticated member
 *   + membership in the Job's Business (the caller's OWN active workspace,
 *     from the session -- never a businessId supplied by the browser)
 *   + explicit assignment to that Job (Job.assignedMembershipId equals the
 *     caller's OWN Membership id)
 *   = field access to that Job only.
 *
 * `assignedJobWhere()` below is the ONE scoping clause every Field Job
 * lookup (pages AND server actions) must use -- it filters by businessId
 * AND assignedMembershipId in the SAME query, so a mismatched business, an
 * unassigned Job, or another member's Job simply never comes back. There is
 * no separate "fetch, then compare" step that could be skipped or gotten
 * wrong. OWNER/ADMIN can use these same functions too (e.g. to preview a
 * Field Job assigned to themselves) -- field access is scoped by
 * assignment, not by role.
 */
import { notFound } from "next/navigation";
import { requireWorkspace, type WorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";

export type FieldWorkspace = {
  workspace: WorkspaceContext;
  businessId: string;
  membershipId: string;
};

export async function requireFieldWorkspace(): Promise<FieldWorkspace> {
  const workspace = await requireWorkspace();
  return {
    workspace,
    businessId: workspace.business.id,
    membershipId: workspace.membership.id,
  };
}

/** The one Prisma `where` clause every assigned-Job lookup must use. */
export function assignedJobWhere(jobId: string, field: FieldWorkspace) {
  return {
    id: jobId,
    businessId: field.businessId,
    assignedMembershipId: field.membershipId,
  } as const;
}

/**
 * For SERVER ACTIONS (mutations): returns a `null` job when the caller is
 * not assigned to it (wrong business, unassigned, or someone else's Job),
 * so every field action can fail safely with a plain "not available"
 * message -- never a stack trace, never a hint about whether the Job
 * exists at all.
 */
export async function findAssignedJob(jobId: string) {
  const field = await requireFieldWorkspace();
  const job = await prisma.job.findFirst({ where: assignedJobWhere(jobId, field) });
  return { ...field, job };
}

/**
 * For the Field Job PAGE only. Confirms assignment and, if it fails, calls
 * `notFound()` (which throws, aborting the render) rather than returning a
 * falsy value the page merely branches on -- matching the exact reasoning
 * behind `requireManagementPageAccess()` in src/lib/access.ts: Next.js
 * still serializes a matched page segment's own data fetching into the
 * response's Flight payload even when a parent conditionally omits it, so
 * the guard must abort the render itself, before the page fetches any
 * Job/customer detail, not just decide what to display. The page then runs
 * its own full-detail query using the exact same `assignedJobWhere()`
 * clause, so the real data it fetches is scoped identically to this check.
 */
export async function requireAssignedJobPageAccess(jobId: string) {
  const field = await requireFieldWorkspace();
  const job = await prisma.job.findFirst({
    where: assignedJobWhere(jobId, field),
    select: { id: true },
  });
  if (!job) {
    notFound();
  }
  return field;
}
