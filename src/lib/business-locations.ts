/**
 * Business Location foundation — optional office / shop addresses.
 *
 * This is not a timezone, Stripe account, service area, geo engine, or
 * tenant boundary. Adding a location never rewrites those records.
 * Historical jobs stay unassigned until a later step explicitly sets
 * Job.businessLocationId.
 */

export const BUSINESS_LOCATION_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type BusinessLocationStatus = (typeof BUSINESS_LOCATION_STATUSES)[number];

export const MAX_LOCATION_NAME_LENGTH = 80;
export const MAX_LOCATION_ADDRESS_LENGTH = 120;
export const MAX_LOCATION_NOTES_LENGTH = 500;

export const LOCATION_OWNER_ONLY_MESSAGE =
  "Only the owner can add or change business locations.";

export const LOCATION_FIELD_SCOPED_MESSAGE =
  "Business locations are an office directory. Field members stay on assigned jobs.";

export const LOCATION_ADDITIVE_MESSAGE =
  "Adding a location does not change timezone, Stripe, service areas, or existing jobs.";

export const LOCATION_EMPTY_MESSAGE =
  "No business locations yet. Existing jobs stay unassigned. Timezone, Stripe, and service areas stay on the business.";

export type RecordedBusinessLocation = {
  id: string;
  businessId: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  notes: string;
  status: BusinessLocationStatus;
};

export function isBusinessLocationStatus(value: string): value is BusinessLocationStatus {
  return (BUSINESS_LOCATION_STATUSES as readonly string[]).includes(value);
}

function trimField(value: string | undefined, max: number, label: string) {
  const next = (value ?? "").trim();
  if (next.length > max) {
    throw new Error(`${label} must be ${max} characters or fewer.`);
  }
  return next;
}

export function parseLocationName(value: string) {
  const name = trimField(value, MAX_LOCATION_NAME_LENGTH, "Location name");
  if (!name) {
    throw new Error("A location needs a name.");
  }
  return name;
}

export function parseLocationAddressInput(input: {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  notes?: string;
}) {
  return {
    addressLine1: trimField(input.addressLine1, MAX_LOCATION_ADDRESS_LENGTH, "Address line 1"),
    addressLine2: trimField(input.addressLine2, MAX_LOCATION_ADDRESS_LENGTH, "Address line 2"),
    city: trimField(input.city, MAX_LOCATION_ADDRESS_LENGTH, "City"),
    region: trimField(input.region, MAX_LOCATION_ADDRESS_LENGTH, "Region"),
    postalCode: trimField(input.postalCode, MAX_LOCATION_ADDRESS_LENGTH, "Postal code"),
    notes: trimField(input.notes, MAX_LOCATION_NOTES_LENGTH, "Notes"),
  };
}

export function formatLocationAddress(location: {
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
}) {
  const line = [location.addressLine1, location.addressLine2].filter(Boolean).join(", ");
  const locality = [location.city, location.region, location.postalCode]
    .filter(Boolean)
    .join(", ");
  return [line, locality].filter(Boolean).join(" · ");
}

export function toRecordedBusinessLocation(row: {
  id: string;
  businessId: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  notes: string;
  status: string;
}): RecordedBusinessLocation {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    notes: row.notes,
    status: isBusinessLocationStatus(row.status) ? row.status : "ACTIVE",
  };
}
