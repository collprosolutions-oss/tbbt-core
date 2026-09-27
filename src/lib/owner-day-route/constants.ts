/**
 * Owner day-route view — recorded same-business scheduled jobs only.
 *
 * This is a read-only projection. It does not optimize travel, geocode,
 * or invent ETAs. Opening the page does not write Job schedule fields.
 */

export const OWNER_DAY_ROUTE_PATH = "/today/day-route";

export const OWNER_DAY_ROUTE_JOBS_TAKE = 50;

/** Google Maps URL directions allow origin + destination + 9 waypoints. */
export const OWNER_DAY_ROUTE_MAPS_STOP_LIMIT = 11;

export const OWNER_DAY_ROUTE_MUTATIONS_ON_LOAD = false;

export const OWNER_DAY_ROUTE_READ_ONLY_MESSAGE =
  "This page lists recorded same-business scheduled jobs. Opening it does not change any schedule.";

export const OWNER_DAY_ROUTE_MAPS_DISCLAIMER =
  "The maps link opens an external maps app with recorded stop addresses in scheduled order. It does not rearrange stops for travel time, resolve coordinates through a mapping provider, or calculate arrival times.";

export const OWNER_DAY_ROUTE_ORDER_NOTE =
  "Stops are listed in recorded appointment order. That is not a travel-optimized sequence.";

export const OWNER_DAY_ROUTE_INCOMPLETE_LABEL =
  "Incomplete address — excluded from the maps route";

export const OWNER_DAY_ROUTE_FOREIGN_PROPERTY_LABEL =
  "Property is not in this business — excluded from the maps route";

export const OWNER_DAY_ROUTE_NO_PROPERTY_LABEL =
  "No property address recorded — excluded from the maps route";

export const OWNER_DAY_ROUTE_NO_STOPS_MESSAGE =
  "No scheduled jobs for this business day.";

export const OWNER_DAY_ROUTE_NO_MAPPABLE_MESSAGE =
  "No complete structured addresses are available for a maps handoff.";

export const OWNER_DAY_ROUTE_MAPS_TRUNCATED_NOTE =
  "Maps handoff includes the first 11 complete stops in scheduled order. Remaining complete stops stay listed here.";

export const FORBIDDEN_DAY_ROUTE_CLAIM_PATTERNS = [
  /\boptimized route\b/i,
  /\btraffic optimization\b/i,
  /\blive traffic\b/i,
  /\bshortest route\b/i,
  /\bautomatic ETA\b/i,
  /\bprecise GIS\b/i,
  /\bgeocod(?:e|ing)\b/i,
] as const;
