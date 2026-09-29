/**
 * OWNER Job location assignment — optional office / shop on a Job.
 *
 * Uses the existing nullable Job.businessLocationId from
 * prisma/migrations/20260927190000_add_business_location. This module
 * does not add schema, infer a location from timezone / Stripe / service
 * area, or rewrite tenant ownership, customer, or property.
 *
 * Null remains valid: historical Jobs and new Jobs created without an
 * explicit assignment stay unassigned until OWNER writes one.
 */

export const JOB_LOCATION_OWNER_ONLY_MESSAGE =
  "Only the owner can assign a business location to a job.";

export const JOB_LOCATION_STALE_MESSAGE =
  "This job changed while you were assigning a location. Refresh and try again.";

export const JOB_LOCATION_NOT_OWNED_MESSAGE =
  "Choose a location that belongs to this business.";

export const JOB_LOCATION_INACTIVE_MESSAGE =
  "That location is archived. Restore it before assigning it to a job.";

export const JOB_LOCATION_MISSING_JOB_MESSAGE = "That job could not be found.";

export const JOB_LOCATION_ADDITIVE_MESSAGE =
  "Assigning a location does not change timezone, Stripe, tenant ownership, or the customer property.";

export const JOB_LOCATION_UNASSIGNED_LABEL = "Unassigned";

export const JOB_LOCATION_FILTER_ALL = "all";
export const JOB_LOCATION_FILTER_UNASSIGNED = "unassigned";

const LOCATION_ID_PATTERN = /^[a-z0-9]{8,}$/i;

export type OwnerScheduleLocationFilter =
  | typeof JOB_LOCATION_FILTER_ALL
  | typeof JOB_LOCATION_FILTER_UNASSIGNED
  | string;

/**
 * Safe parse for the owner-schedule `location` query param. Unknown or
 * malformed values fail closed to "all" so the page never throws.
 */
export function parseOwnerScheduleLocationFilter(
  raw: string | string[] | undefined,
): OwnerScheduleLocationFilter {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (!value || value === JOB_LOCATION_FILTER_ALL) {
    return JOB_LOCATION_FILTER_ALL;
  }
  if (value === JOB_LOCATION_FILTER_UNASSIGNED) {
    return JOB_LOCATION_FILTER_UNASSIGNED;
  }
  if (LOCATION_ID_PATTERN.test(value)) {
    return value;
  }
  return JOB_LOCATION_FILTER_ALL;
}

export function jobLocationFilterWhere(filter: OwnerScheduleLocationFilter): {
  businessLocationId?: string | null;
} {
  if (filter === JOB_LOCATION_FILTER_ALL) return {};
  if (filter === JOB_LOCATION_FILTER_UNASSIGNED) {
    return { businessLocationId: null };
  }
  return { businessLocationId: filter };
}

export function ownerScheduleLocationQuery(
  filter: OwnerScheduleLocationFilter,
): Record<string, string> {
  if (filter === JOB_LOCATION_FILTER_ALL) return {};
  return { location: filter };
}

export function parseJobLocationId(value: string) {
  const next = value.trim();
  if (!next) return null;
  if (!LOCATION_ID_PATTERN.test(next)) {
    throw new Error(JOB_LOCATION_NOT_OWNED_MESSAGE);
  }
  return next;
}

export function jobLocationSnapshotsEqual(
  expectedUpdatedAt: string,
  current: Date,
) {
  const expectedMs = Date.parse(expectedUpdatedAt);
  return Number.isFinite(expectedMs) && expectedMs === current.getTime();
}
