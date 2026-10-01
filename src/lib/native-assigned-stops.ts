/**
 * Native Today assigned-stop maps handoff.
 *
 * One read-only Google Maps directions URL from the caller's assigned
 * jobs for the current business day. Eligible stops need a complete
 * same-business structured address (street, city, state, ZIP). Order is
 * recorded appointment time, then job id. This does not optimize travel,
 * geocode, or invent ETAs. Job-detail Directions stays on
 * `directionsUrl` / `directionsHref`.
 */
import type { FieldJob } from "@/lib/field-jobs";
import { formatAddress } from "@/lib/format";
import {
  OWNER_DAY_ROUTE_EXCLUDED_HEADING,
  OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL,
  OWNER_DAY_ROUTE_INCOMPLETE_LABEL,
  OWNER_DAY_ROUTE_MAPS_STOP_LIMIT,
  OWNER_DAY_ROUTE_NO_MAPPABLE_MESSAGE,
  OWNER_DAY_ROUTE_NO_PROPERTY_LABEL,
} from "@/lib/owner-day-route/constants";
import {
  completeStructuredRouteAddress,
  sameBusinessJob,
} from "@/lib/owner-day-route/address";
import {
  buildOwnerDayRouteMapsHandoff,
  extractOwnerDayRouteMapsAddresses,
} from "@/lib/owner-day-route/maps";
import type { OwnerDayRouteExclusionReason } from "@/lib/owner-day-route/types";
import type { DateRange } from "@/lib/schedule";

export const NATIVE_ASSIGNED_STOPS_MAPS_LINK_LABEL = "Open assigned stops in maps";

export const NATIVE_ASSIGNED_STOPS_DISCLAIMER =
  "One maps link is available for your assigned stops. It uses recorded complete addresses in appointment order. It does not rearrange stops for travel time, resolve coordinates through a mapping provider, or calculate arrival times.";

export const NATIVE_ASSIGNED_STOPS_ORDER_NOTE =
  "Stops are listed in recorded appointment order. That is not a travel-optimized sequence.";

export const NATIVE_ASSIGNED_STOPS_CAP_LABEL =
  "Complete address — over the maps stop cap";

export const NATIVE_ASSIGNED_STOPS_TRUNCATED_NOTE =
  "The maps link includes the first 11 complete assigned stops in appointment order. Remaining complete stops stay listed as excluded.";

export type NativeAssignedStopJob = FieldJob & {
  businessId?: string;
  assignedMembershipId?: string | null;
  property?:
    | (NonNullable<FieldJob["property"]> & {
        id?: string;
        businessId?: string;
      })
    | null;
};

export type NativeAssignedStopExclusion = {
  jobId: string;
  customerName: string;
  reason: OwnerDayRouteExclusionReason | "OVER_CAP";
  label: string;
};

export type NativeAssignedStopsMaps = {
  href: string | null;
  label: typeof NATIVE_ASSIGNED_STOPS_MAPS_LINK_LABEL;
  disclaimer: string;
  orderNote: string;
  includedStopCount: number;
  omittedCompleteStopCount: number;
  truncated: boolean;
  truncatedNotice: string | null;
  excludedHeading: string;
  excluded: NativeAssignedStopExclusion[];
  emptyMessage: string | null;
};

function exclusionLabel(reason: OwnerDayRouteExclusionReason) {
  if (reason === "NO_PROPERTY") return OWNER_DAY_ROUTE_NO_PROPERTY_LABEL;
  if (reason === "FOREIGN_PROPERTY") return OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL;
  return OWNER_DAY_ROUTE_INCOMPLETE_LABEL;
}

function isAssignedOwnedJob(
  job: NativeAssignedStopJob,
  input: { businessId: string; membershipId: string },
) {
  if (job.businessId != null && !sameBusinessJob({ businessId: job.businessId }, input.businessId)) {
    return false;
  }
  return job.assignedMembershipId === input.membershipId;
}

function inAppointmentDay(job: NativeAssignedStopJob, range: DateRange) {
  if (!job.scheduledAt) return false;
  return job.scheduledAt >= range.start && job.scheduledAt < range.end;
}

function compareAppointmentOrder(left: NativeAssignedStopJob, right: NativeAssignedStopJob) {
  const leftTime = left.scheduledAt?.getTime() ?? 0;
  const rightTime = right.scheduledAt?.getTime() ?? 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

export type NativeAssignedJobDisplayProperty = {
  id?: string | null;
  businessId?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
};

function routeProperty(
  property: NativeAssignedJobDisplayProperty | null | undefined,
) {
  if (!property) return null;
  return {
    id: property.id ?? "",
    businessId: property.businessId ?? "",
    addressLine1: property.addressLine1,
    addressLine2: property.addressLine2 ?? null,
    city: property.city ?? null,
    region: property.region ?? null,
    postalCode: property.postalCode ?? null,
  };
}

/**
 * Same-business display text for an assigned job. Foreign or missing
 * properties stay hidden. Incomplete street-only rows can still be
 * shown; they are not maps-eligible.
 */
export function nativeAssignedJobDisplayAddress(
  property: NativeAssignedJobDisplayProperty | null | undefined,
  businessId: string,
): string | null {
  const owned = routeProperty(property);
  const structured = completeStructuredRouteAddress(owned, businessId);
  if (structured.ok) return structured.address.formatted;
  if (structured.reason === "FOREIGN_PROPERTY" || structured.reason === "NO_PROPERTY") {
    return null;
  }
  if (!owned) return null;
  const formatted = formatAddress(owned);
  return formatted.trim() ? formatted : null;
}

/** Maps waypoints are joined with `|`; a literal pipe would become an extra stop. */
export function sanitizeNativeAssignedStopMapsAddress(address: string) {
  return address.replaceAll("|", " ").replace(/\s+/g, " ").trim();
}

export function buildNativeAssignedStopsMaps(
  jobs: readonly NativeAssignedStopJob[],
  input: {
    businessId: string;
    membershipId: string;
    range: DateRange;
  },
): NativeAssignedStopsMaps {
  const ordered = [...jobs]
    .filter((job) => isAssignedOwnedJob(job, input))
    .filter((job) => inAppointmentDay(job, input.range))
    .sort(compareAppointmentOrder);

  const excluded: NativeAssignedStopExclusion[] = [];
  const completeAddresses: string[] = [];

  for (const job of ordered) {
    const property = job.property
      ? {
          id: job.property.id ?? job.id,
          businessId: job.property.businessId ?? "",
          addressLine1: job.property.addressLine1,
          addressLine2: job.property.addressLine2,
          city: job.property.city,
          region: job.property.region,
          postalCode: job.property.postalCode,
        }
      : null;
    const structured = completeStructuredRouteAddress(property, input.businessId);
    const customerName = job.customer?.name?.trim() || "Assigned job";
    if (!structured.ok) {
      excluded.push({
        jobId: job.id,
        customerName,
        reason: structured.reason,
        label: exclusionLabel(structured.reason),
      });
      continue;
    }
    if (completeAddresses.length >= OWNER_DAY_ROUTE_MAPS_STOP_LIMIT) {
      excluded.push({
        jobId: job.id,
        customerName,
        reason: "OVER_CAP",
        label: NATIVE_ASSIGNED_STOPS_CAP_LABEL,
      });
      continue;
    }
    completeAddresses.push(sanitizeNativeAssignedStopMapsAddress(structured.address.formatted));
  }

  const maps = buildOwnerDayRouteMapsHandoff(completeAddresses);
  const overflow = excluded.filter((stop) => stop.reason === "OVER_CAP").length;

  return {
    href: maps.href,
    label: NATIVE_ASSIGNED_STOPS_MAPS_LINK_LABEL,
    disclaimer: NATIVE_ASSIGNED_STOPS_DISCLAIMER,
    orderNote: NATIVE_ASSIGNED_STOPS_ORDER_NOTE,
    includedStopCount: maps.includedStopCount,
    omittedCompleteStopCount: overflow,
    truncated: overflow > 0,
    truncatedNotice: overflow > 0 ? NATIVE_ASSIGNED_STOPS_TRUNCATED_NOTE : null,
    excludedHeading: OWNER_DAY_ROUTE_EXCLUDED_HEADING,
    excluded,
    emptyMessage: maps.href ? null : OWNER_DAY_ROUTE_NO_MAPPABLE_MESSAGE,
  };
}

export function nativeAssignedStopsMapsFollowsAppointmentOrder(
  href: string | null,
  addresses: readonly string[],
) {
  const actual = extractOwnerDayRouteMapsAddresses(href);
  const expected = addresses.slice(0, OWNER_DAY_ROUTE_MAPS_STOP_LIMIT);
  return (
    expected.length === actual.length &&
    expected.every((address, index) => actual[index] === address)
  );
}
