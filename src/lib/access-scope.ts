/**
 * Pure workspace-scoping helpers.
 *
 * These are the query/guard primitives used by requireBusinessAccess()
 * (src/lib/access.ts). They have no request-cookie dependency so Node
 * isolation scripts can import the exact production helpers.
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
