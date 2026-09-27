import {
  OWNER_DAY_ROUTE_MAPS_STOP_LIMIT,
  OWNER_DAY_ROUTE_MAPS_TRUNCATED_NOTE,
} from "@/lib/owner-day-route/constants";
import type { OwnerDayRouteMapsHandoff, OwnerDayRouteStop } from "@/lib/owner-day-route/types";

/** Eligible maps queries stay in recorded appointment order. */
export function eligibleOwnerDayRouteMapsQueries(stops: readonly OwnerDayRouteStop[]) {
  return stops
    .filter((stop) => stop.includedInMaps)
    .map((stop) => stop.mapsQuery)
    .filter((address): address is string => Boolean(address));
}

export function ownerDayRouteExclusionLine(stop: OwnerDayRouteStop) {
  return `Stop ${stop.sequence} · ${stop.customerName} — ${stop.exclusionLabel ?? "Excluded from the maps route"}`;
}

export function ownerDayRouteMapsFollowsAppointmentOrder(
  href: string | null,
  stops: readonly OwnerDayRouteStop[],
) {
  const expected = eligibleOwnerDayRouteMapsQueries(stops).slice(0, OWNER_DAY_ROUTE_MAPS_STOP_LIMIT);
  const actual = extractOwnerDayRouteMapsAddresses(href);
  return (
    expected.length === actual.length &&
    expected.every((address, index) => actual[index] === address)
  );
}

/**
 * External Google Maps directions URL from recorded addresses only.
 * Addresses stay as stored text. This does not call a mapping provider.
 */
export function buildOwnerDayRouteMapsHref(addresses: readonly string[]): string | null {
  const queries = addresses.map((address) => address.trim()).filter(Boolean);
  if (queries.length === 0) return null;
  if (queries.length === 1) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(queries[0])}&travelmode=driving`;
  }
  const limited = queries.slice(0, OWNER_DAY_ROUTE_MAPS_STOP_LIMIT);
  const origin = limited[0];
  const destination = limited[limited.length - 1];
  const waypoints = limited.slice(1, -1);
  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: "driving",
  });
  if (waypoints.length > 0) {
    params.set("waypoints", waypoints.join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function extractOwnerDayRouteMapsAddresses(href: string | null): string[] {
  if (!href) return [];
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return [];
  }
  const addresses: string[] = [];
  const destination = url.searchParams.get("destination");
  const origin = url.searchParams.get("origin");
  const query = url.searchParams.get("query");
  const waypoints = url.searchParams.get("waypoints");
  if (origin) addresses.push(origin);
  if (waypoints) {
    for (const waypoint of waypoints.split("|")) {
      const trimmed = waypoint.trim();
      if (trimmed) addresses.push(trimmed);
    }
  }
  if (destination) addresses.push(destination);
  if (query) addresses.push(query);
  return addresses;
}

export function buildOwnerDayRouteMapsHandoff(
  addresses: readonly string[],
): OwnerDayRouteMapsHandoff {
  const included = addresses.slice(0, OWNER_DAY_ROUTE_MAPS_STOP_LIMIT);
  const omittedCompleteStopCount = Math.max(0, addresses.length - included.length);
  return {
    href: buildOwnerDayRouteMapsHref(included),
    includedStopCount: included.length,
    omittedCompleteStopCount,
    truncated: omittedCompleteStopCount > 0,
    addresses: included,
  };
}

export function ownerDayRouteMapsTruncationNote(maps: OwnerDayRouteMapsHandoff) {
  return maps.truncated ? OWNER_DAY_ROUTE_MAPS_TRUNCATED_NOTE : null;
}
