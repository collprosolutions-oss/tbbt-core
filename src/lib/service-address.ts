import { formatAddress } from "@/lib/format";

export const OTHER_CITY_VALUE = "__other__";

export const OUT_OF_AREA_WARNING =
  "This location may be outside our standard service area.";

export type StructuredServiceAddress = {
  streetAddress: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
};

export type ServiceAddressCountry = string | null | undefined;

export type AddressSuggestion = {
  streetAddress: string;
  unit?: string;
  city: string;
  region: string;
  postalCode: string;
};

export type AddressLookupProvider = {
  suggest(query: string): Promise<AddressSuggestion[]>;
};

/**
 * Hook point for street-address autocomplete. No Maps/Places/Mapbox
 * provider is configured in this project, so this returns null and the
 * form stays fully manual (plus native browser autofill).
 */
export function getAddressLookupProvider(): AddressLookupProvider | null {
  return null;
}

export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

const US_STATE_BY_NAME = new Map(
  US_STATES.flatMap((state) => [
    [state.code.toLowerCase(), state.code],
    [state.name.toLowerCase(), state.code],
  ]),
);

export function isUsServiceCountry(country: ServiceAddressCountry) {
  return (country ?? "").trim().toUpperCase() === "US";
}

export function normalizeAddressText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeCityName(value: string) {
  return normalizeAddressText(value);
}

export function normalizeUsPostalCode(value: string) {
  const compact = value.trim().replace(/\s+/g, "");
  const match = compact.match(/^(\d{5})(?:-?(\d{4}))?$/);
  if (!match) return compact;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}

export function isValidUsPostalCode(value: string) {
  return /^\d{5}(?:-\d{4})?$/.test(value.trim().replace(/\s+/g, ""));
}

export function normalizeRegion(value: string, country: ServiceAddressCountry) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!isUsServiceCountry(country)) return trimmed;
  return US_STATE_BY_NAME.get(trimmed.toLowerCase()) ?? trimmed.toUpperCase();
}

export function formatStructuredAddress(address: StructuredServiceAddress) {
  return formatAddress({
    addressLine1: address.streetAddress.trim(),
    addressLine2: address.unit.trim() || null,
    city: address.city.trim() || null,
    region: address.region.trim() || null,
    postalCode: address.postalCode.trim() || null,
  });
}

export function structuredAddressKey(
  address: StructuredServiceAddress,
  country: ServiceAddressCountry,
) {
  return [
    normalizeAddressText(address.streetAddress),
    normalizeAddressText(address.unit),
    normalizeCityName(address.city),
    normalizeAddressText(normalizeRegion(address.region, country)),
    normalizeAddressText(
      isUsServiceCountry(country)
        ? normalizeUsPostalCode(address.postalCode)
        : address.postalCode,
    ),
  ].join("|");
}

export function hasStructuredAddressInput(
  input: Partial<StructuredServiceAddress>,
) {
  return Boolean(
    input.streetAddress?.trim() ||
      input.unit?.trim() ||
      input.city?.trim() ||
      input.region?.trim() ||
      input.postalCode?.trim(),
  );
}

export function validateStructuredAddress(
  input: Partial<StructuredServiceAddress>,
  options: { country?: ServiceAddressCountry } = {},
): { ok: true; address: StructuredServiceAddress } | { ok: false; error: string } {
  const streetAddress = input.streetAddress?.trim() ?? "";
  const unit = input.unit?.trim() ?? "";
  const city = input.city?.trim() ?? "";
  const region = normalizeRegion(input.region ?? "", options.country);
  const rawPostal = input.postalCode?.trim() ?? "";
  const postalCode = isUsServiceCountry(options.country)
    ? normalizeUsPostalCode(rawPostal)
    : rawPostal;

  if (!streetAddress) {
    return { ok: false, error: "Street address is required." };
  }
  if (!city || city === OTHER_CITY_VALUE) {
    return { ok: false, error: "City / town is required." };
  }
  if (!region) {
    return { ok: false, error: "State is required." };
  }
  if (isUsServiceCountry(options.country)) {
    if (!postalCode) {
      return { ok: false, error: "ZIP code is required." };
    }
    if (!isValidUsPostalCode(postalCode)) {
      return { ok: false, error: "Enter a 5-digit ZIP or ZIP+4 code." };
    }
  }

  return {
    ok: true,
    address: { streetAddress, unit, city, region, postalCode },
  };
}

export function cityIsInServiceArea(city: string, approvedCities: readonly string[]) {
  if (approvedCities.length === 0) return true;
  const needle = normalizeCityName(city);
  if (!needle) return false;
  return approvedCities.some((approved) => normalizeCityName(approved) === needle);
}

export function shouldWarnOutsideServiceArea(
  city: string,
  approvedCities: readonly string[],
) {
  const trimmed = city.trim();
  if (!trimmed || trimmed === OTHER_CITY_VALUE) {
    return approvedCities.length > 0;
  }
  return !cityIsInServiceArea(trimmed, approvedCities);
}

export function applyAddressSuggestion(
  current: StructuredServiceAddress,
  suggestion: AddressSuggestion,
): StructuredServiceAddress {
  return {
    streetAddress: suggestion.streetAddress.trim(),
    unit: (suggestion.unit ?? current.unit).trim(),
    city: suggestion.city.trim(),
    region: suggestion.region.trim(),
    postalCode: suggestion.postalCode.trim(),
  };
}

export type StoredPropertyAddress = {
  id: string;
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
};

function storedAddressLooksStructured(property: StoredPropertyAddress) {
  return Boolean(
    property.addressLine2?.trim() ||
      property.city?.trim() ||
      property.region?.trim() ||
      property.postalCode?.trim(),
  );
}

export function findReusableProperty(
  properties: StoredPropertyAddress[],
  address: StructuredServiceAddress,
  country: ServiceAddressCountry,
) {
  const structuredKey = structuredAddressKey(address, country);
  const formatted = normalizeAddressText(formatStructuredAddress(address));
  const street = normalizeAddressText(address.streetAddress);

  return (
    properties.find((property) => {
      if (storedAddressLooksStructured(property)) {
        return (
          structuredAddressKey(
            {
              streetAddress: property.addressLine1,
              unit: property.addressLine2 ?? "",
              city: property.city ?? "",
              region: property.region ?? "",
              postalCode: property.postalCode ?? "",
            },
            country,
          ) === structuredKey
        );
      }
      const legacy = normalizeAddressText(property.addressLine1);
      return legacy === formatted || legacy === street;
    }) ?? null
  );
}

export function findReusableLegacyProperty(
  properties: Array<{ id: string; addressLine1: string }>,
  oneLineAddress: string,
) {
  const normalized = normalizeAddressText(oneLineAddress);
  if (!normalized) return null;
  return (
    properties.find(
      (property) => normalizeAddressText(property.addressLine1) === normalized,
    ) ?? null
  );
}
