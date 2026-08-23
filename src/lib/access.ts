/**
 * Workspace isolation helpers.
 * Future queries for customers, jobs, invoices, and related records
 * must always include the authenticated workspace businessId.
 */

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
