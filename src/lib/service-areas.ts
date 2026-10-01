/**
 * Configurable served cities and postal areas.
 *
 * This is not a GIS engine. Matching uses owner-entered city/postal
 * strings only. Addresses and jurisdictions are never inferred.
 */
import { isUsStateCode, isUsStateName, US_STATES } from "@/lib/service-address";

export const SERVICE_AREA_KINDS = ["CITY", "POSTAL"] as const;
export type ServiceAreaKind = (typeof SERVICE_AREA_KINDS)[number];

export const SERVICE_AREA_KIND_LABELS: Record<ServiceAreaKind, string> = {
  CITY: "City",
  POSTAL: "ZIP / postal code",
};

export const SERVICE_AREA_QUALIFICATIONS = ["IN_AREA", "OUTSIDE_PREFERRED", "UNKNOWN"] as const;
export type ServiceAreaQualification = (typeof SERVICE_AREA_QUALIFICATIONS)[number];

export const SERVICE_AREA_QUALIFICATION_LABELS: Record<ServiceAreaQualification, string> = {
  IN_AREA: "Inside preferred area",
  OUTSIDE_PREFERRED: "Outside preferred area",
  UNKNOWN: "Area not qualified",
};

export function isServiceAreaKind(value: string): value is ServiceAreaKind {
  return (SERVICE_AREA_KINDS as readonly string[]).includes(value);
}

export function isServiceAreaQualification(
  value: string,
): value is ServiceAreaQualification {
  return (SERVICE_AREA_QUALIFICATIONS as readonly string[]).includes(value);
}

export type RecordedServiceArea = {
  id: string;
  kind: string;
  label: string;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  enabled: boolean;
  travelAdjustment: number | null;
  minimumAdjustment: number | null;
  notes: string;
};

function normalizeToken(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function normalizePostal(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

const ALLOWED_LABEL_CHAR = /^[\p{L} .'’\-,]+$/u;
const SPACED_DASH = / - | – /;
const CITY_LABEL_CONNECTOR = /(?:\s+and\s+|&|\/|;)/i;
const NON_CITY_LABEL_WORD =
  /\b(?:area|greater|metro|county|region|vicinity|or|within|miles|serving|near|nearby|around|surrounding)\b/i;
const COMPASS_WORD =
  /^(?:north|south|east|west|northern|southern|eastern|western|southwest|southeast|northwest|northeast|central)$/i;

function isStateOrCompassState(city: string) {
  if (isUsStateName(city)) return true;
  const words = city.split(" ");
  if (words.length < 2) return false;
  if (!COMPASS_WORD.test(words[0] ?? "")) return false;
  return isUsStateName(words.slice(1).join(" "));
}

function hasTrailingStateToken(city: string) {
  const words = city.split(" ");
  const last = words[words.length - 1] ?? "";
  if (isUsStateCode(last) || isUsStateName(last)) return true;
  const lower = city.toLowerCase();
  return US_STATES.some((state) => {
    const name = state.name.toLowerCase();
    return lower === name || lower.endsWith(` ${name}`);
  });
}

/**
 * Split an owner-entered display label into a single city plus an optional
 * 2-letter US state. This is not geocoding. Ambiguous marketing copy,
 * multi-city lists, ZIP-only text, and free-text regions do not parse.
 *
 * Hyphen decision: a no-comma hyphenated label such as Reno-Sparks is
 * skipped so it cannot become one fake city. Official hyphenated cities
 * stay syncable when written as City, ST (Winston-Salem, NC). Multi-word
 * cities without hyphens (Fort Myers, Salt Lake City) still sync.
 */
export function parseServiceAreaLabelParts(label: string): {
  city: string;
  region: string | null;
} {
  const empty = { city: "", region: null as string | null };
  const raw = label.trim();
  if (!raw) return empty;
  if (!ALLOWED_LABEL_CHAR.test(raw)) return empty;
  if (SPACED_DASH.test(raw)) return empty;
  if ((raw.match(/,/g) ?? []).length > 1) return empty;

  const trimmed = raw.replace(/\s+/g, " ");
  if (CITY_LABEL_CONNECTOR.test(trimmed)) return empty;

  const comma = trimmed.indexOf(",");
  let city: string;
  let region: string | null = null;
  if (comma === -1) {
    city = trimmed;
    if (city.includes("-")) return empty;
    if (hasTrailingStateToken(city) || isStateOrCompassState(city)) return empty;
  } else {
    city = trimmed.slice(0, comma).trim();
    const regionRaw = trimmed.slice(comma + 1).trim();
    if (!city || !regionRaw) return empty;
    if (!/^[A-Za-z]{2}$/.test(regionRaw) || !isUsStateCode(regionRaw)) {
      return empty;
    }
    region = regionRaw.toUpperCase();
    if (isStateOrCompassState(city)) return empty;
  }
  if (!city || NON_CITY_LABEL_WORD.test(city)) {
    return empty;
  }
  return { city, region };
}

export function parseOptionalMoney(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return Number.NaN;
  return Math.round(amount * 100) / 100;
}

export function matchServiceArea(
  areas: readonly RecordedServiceArea[],
  input: { city?: string | null; postalCode?: string | null },
): RecordedServiceArea | null {
  const enabled = areas.filter((area) => area.enabled);
  const postal = normalizePostal(input.postalCode);
  if (postal) {
    const postalMatch = enabled.find(
      (area) => area.kind === "POSTAL" && normalizePostal(area.postalCode) === postal,
    );
    if (postalMatch) return postalMatch;
  }
  const city = normalizeToken(input.city);
  if (city) {
    const cityMatch = enabled.find((area) => {
      if (area.kind !== "CITY") return false;
      return normalizeToken(area.city) === city || normalizeToken(area.label) === city;
    });
    if (cityMatch) return cityMatch;
  }
  return null;
}

export function qualifyServiceAddress(
  areas: readonly RecordedServiceArea[],
  input: { city?: string | null; postalCode?: string | null },
): {
  qualification: ServiceAreaQualification;
  matchedAreaId: string | null;
} {
  const enabled = areas.filter((area) => area.enabled);
  if (enabled.length === 0) {
    return { qualification: "UNKNOWN", matchedAreaId: null };
  }
  const matched = matchServiceArea(enabled, input);
  if (matched) {
    return { qualification: "IN_AREA", matchedAreaId: matched.id };
  }
  const hasCityOrPostal = Boolean(normalizeToken(input.city) || normalizePostal(input.postalCode));
  return {
    qualification: hasCityOrPostal ? "OUTSIDE_PREFERRED" : "UNKNOWN",
    matchedAreaId: null,
  };
}

export function serviceAreaCities(areas: readonly RecordedServiceArea[]) {
  return [
    ...new Set(
      areas
        .filter((area) => area.enabled && area.kind === "CITY")
        .map((area) => area.city?.trim() || area.label.trim())
        .filter(Boolean),
    ),
  ];
}

export function serviceAreaPostalCodes(areas: readonly RecordedServiceArea[]) {
  return [
    ...new Set(
      areas
        .filter((area) => area.enabled && area.kind === "POSTAL")
        .map((area) => area.postalCode?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function slugifyLocalPagePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function publicServiceCityPath(slug: string, serviceSlug: string, citySlug: string) {
  return `/hire/${slug}/in/${citySlug}/${serviceSlug}`;
}

export function resolvePublicLocalPage<
  TArea extends { enabled: boolean; kind: string; city: string | null; label: string },
  TService extends { name: string; active?: boolean },
>(input: {
  citySlug: string;
  serviceSlug: string;
  areas: readonly TArea[];
  services: readonly TService[];
}): { city: TArea; service: TService } | null {
  const city = input.areas.find(
    (area) =>
      area.enabled &&
      area.kind === "CITY" &&
      slugifyLocalPagePart(area.city || area.label) === input.citySlug,
  );
  const service = input.services.find(
    (item) =>
      slugifyLocalPagePart(item.name) === input.serviceSlug && item.active !== false,
  );
  if (!city || !service) return null;
  return { city, service };
}
