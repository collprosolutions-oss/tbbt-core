/**
 * Assigned-job maps handoff for native Today / job detail.
 *
 * Reuses the same-business structured-address rule from
 * `/today/day-route`. A maps link is produced only for one assigned
 * job with a complete street, city, state, and ZIP. This does not
 * change schedules, optimize travel, or expose foreign property data.
 */
import {
  buildOwnerDayRouteMapsHref,
  completeStructuredRouteAddress,
  ownedRouteDisplayAddress,
  type OwnerDayRouteProperty,
} from "@/lib/owner-day-route";

export const NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL = "Open in maps";

export const NATIVE_ASSIGNED_JOB_MAPS_DISCLAIMER =
  "This maps link opens the assigned job's recorded address. It does not rearrange stops for travel time, resolve coordinates through a mapping provider, or calculate arrival times.";

export const NATIVE_ASSIGNED_JOB_INCOMPLETE_MAPS_REASON =
  "Incomplete address — a maps link is unavailable until street, city, state, and ZIP are recorded.";

export const NATIVE_ASSIGNED_JOB_NO_PROPERTY_MAPS_REASON =
  "No property address recorded — a maps link is unavailable.";

export const NATIVE_ASSIGNED_JOB_FOREIGN_PROPERTY_MAPS_REASON =
  "Property is not in this business — a maps link is unavailable.";

export const NATIVE_JOB_PROPERTY_SELECT = {
  id: true,
  businessId: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
} as const;

export type NativeAssignedJobProperty = {
  id?: string | null;
  businessId?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
};

export type NativeAssignedJobPropertyRecord = {
  id: string;
  businessId: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
};

export type NativeAssignedJobMaps = {
  href: string | null;
  available: boolean;
  address: string | null;
  unavailableReason: string | null;
  label: string;
  disclaimer: string;
};

function routeProperty(
  property: NativeAssignedJobProperty | null | undefined,
): OwnerDayRouteProperty | null {
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

function unavailableReason(
  reason: "NO_PROPERTY" | "FOREIGN_PROPERTY" | "INCOMPLETE_ADDRESS",
) {
  if (reason === "NO_PROPERTY") return NATIVE_ASSIGNED_JOB_NO_PROPERTY_MAPS_REASON;
  if (reason === "FOREIGN_PROPERTY") return NATIVE_ASSIGNED_JOB_FOREIGN_PROPERTY_MAPS_REASON;
  return NATIVE_ASSIGNED_JOB_INCOMPLETE_MAPS_REASON;
}

export function nativeAssignedJobDisplayAddress(
  property: NativeAssignedJobProperty | null | undefined,
  businessId: string,
): string | null {
  const owned = routeProperty(property);
  const structured = completeStructuredRouteAddress(owned, businessId);
  if (structured.ok) return structured.address.formatted;
  if (structured.reason === "FOREIGN_PROPERTY" || structured.reason === "NO_PROPERTY") {
    return null;
  }
  return ownedRouteDisplayAddress(owned, businessId);
}

export function buildNativeAssignedJobMaps(input: {
  businessId: string;
  property: NativeAssignedJobProperty | null | undefined;
}): NativeAssignedJobMaps {
  const owned = routeProperty(input.property);
  const structured = completeStructuredRouteAddress(owned, input.businessId);
  if (structured.ok) {
    return {
      href: buildOwnerDayRouteMapsHref([structured.address.formatted]),
      available: true,
      address: structured.address.formatted,
      unavailableReason: null,
      label: NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL,
      disclaimer: NATIVE_ASSIGNED_JOB_MAPS_DISCLAIMER,
    };
  }
  return {
    href: null,
    available: false,
    address: nativeAssignedJobDisplayAddress(input.property, input.businessId),
    unavailableReason: unavailableReason(structured.reason),
    label: NATIVE_ASSIGNED_JOB_MAPS_LINK_LABEL,
    disclaimer: NATIVE_ASSIGNED_JOB_MAPS_DISCLAIMER,
  };
}
