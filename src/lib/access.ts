/**
 * Workspace isolation helpers.
 * Future queries for customers, jobs, invoices, and related records
 * must always include the authenticated workspace businessId.
 */

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
