/**
 * Workspace isolation helpers.
 * Future queries for customers, jobs, invoices, and related records
 * must always include the authenticated workspace businessId.
 */

import { redirect } from "next/navigation";
import { canAccessManagementConsole } from "@/lib/authorization";
import { requireWorkspace, type WorkspaceContext } from "@/lib/workspace";

export function businessScope(businessId: string) {
  return { businessId } as const;
}

export function belongsToBusiness(
  record: { businessId: string } | null | undefined,
  businessId: string,
) {
  return Boolean(record && record.businessId === businessId);
}

export function assertBusinessRecord<T extends { businessId: string }>(
  record: T | null | undefined,
  businessId: string,
): T {
  if (!record || record.businessId !== businessId) {
    throw new Error("Record is not in the authorized business workspace.");
  }
  return record;
}

export type BusinessAccess = {
  workspace: WorkspaceContext;
  businessId: string;
  scope: { readonly businessId: string };
  assertOwned: <T extends { businessId: string }>(
    record: T | null | undefined,
  ) => T;
  assertAttachable: <T extends { businessId: string }>(
    record: T | null | undefined,
  ) => T;
};

/**
 * Server-side enforcement for future business-owned reads/writes.
 * Derives the active workspace, then scopes queries and relation attachments
 * to that Business.
 */
export async function requireBusinessAccess(): Promise<BusinessAccess> {
  const workspace = await requireWorkspace();
  const businessId = workspace.business.id;

  function assertOwned<T extends { businessId: string }>(
    record: T | null | undefined,
  ): T {
    return assertBusinessRecord(record, businessId);
  }

  return {
    workspace,
    businessId,
    scope: businessScope(businessId),
    assertOwned,
    assertAttachable: assertOwned,
  };
}

/**
 * Use this instead of `requireBusinessAccess()` at the top of every
 * management-console PAGE (Dashboard, Requests, Customers, Estimates,
 * Jobs, Invoices, Reports, Marketing, Reviews, Pipeline, Services, Time Cards, Payroll, Expenses, Settings) -- NOT in server actions, which
 * should keep calling `requireBusinessAccess()` directly plus a specific
 * `requireBusinessCapability()` check (see src/lib/authorization.ts), so a
 * future assigned-job-scoped MEMBER capability isn't blocked by a blanket
 * page-level gate.
 *
 * This MUST run, and MUST redirect() (not just branch on the result),
 * before a page does ANY business-data query: Next.js still renders and
 * serializes a matched page segment into the response's Flight payload
 * even when an ancestor layout's returned tree conditionally omits
 * `{children}`, so a role check that merely decides what to render --
 * without throwing -- does not stop the page's own data fetching from
 * running and shipping data to an unauthorized member's browser. Calling
 * `redirect()` here throws before the page continues, so the query never
 * runs at all. See also the equivalent check in `(app)/layout.tsx` --
 * both exist independently as defense-in-depth; neither depends on the
 * other running first.
 */
export async function requireManagementPageAccess(): Promise<BusinessAccess> {
  const access = await requireBusinessAccess();
  if (!canAccessManagementConsole(access.workspace.role)) {
    redirect("/access-restricted");
  }
  return access;
}
