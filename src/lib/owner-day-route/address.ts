import { formatAddress } from "@/lib/format";
import { formatStructuredAddress, validateStructuredAddress } from "@/lib/service-address";
import type { OwnerDayRouteProperty } from "@/lib/owner-day-route/types";

export type CompleteRouteAddress = {
  formatted: string;
  streetAddress: string;
  city: string;
  region: string;
  postalCode: string;
};

/**
 * A maps-eligible stop needs a same-business structured address:
 * street, city, state, and ZIP. A one-line addressLine1 is not enough.
 */
export function completeStructuredRouteAddress(
  property: OwnerDayRouteProperty | null | undefined,
  businessId: string,
):
  | { ok: true; address: CompleteRouteAddress }
  | { ok: false; reason: "NO_PROPERTY" | "FOREIGN_PROPERTY" | "INCOMPLETE_ADDRESS" } {
  if (!property) {
    return { ok: false, reason: "NO_PROPERTY" };
  }
  if (property.businessId !== businessId) {
    return { ok: false, reason: "FOREIGN_PROPERTY" };
  }
  const validated = validateStructuredAddress(
    {
      streetAddress: property.addressLine1,
      unit: property.addressLine2 ?? "",
      city: property.city ?? "",
      region: property.region ?? "",
      postalCode: property.postalCode ?? "",
    },
    { country: "US" },
  );
  if (!validated.ok) {
    return { ok: false, reason: "INCOMPLETE_ADDRESS" };
  }
  return {
    ok: true,
    address: {
      formatted: formatStructuredAddress(validated.address),
      streetAddress: validated.address.streetAddress,
      city: validated.address.city,
      region: validated.address.region,
      postalCode: validated.address.postalCode,
    },
  };
}

export function sameBusinessJob(job: { businessId: string }, businessId: string) {
  return job.businessId === businessId;
}

/**
 * Same-business recorded address text only. Foreign property fields stay hidden.
 * Incomplete street-only rows can still be shown; they are not maps-eligible.
 */
export function ownedRouteDisplayAddress(
  property: OwnerDayRouteProperty | null | undefined,
  businessId: string,
): string | null {
  if (!property || property.businessId !== businessId) return null;
  const formatted = formatAddress(property);
  return formatted.trim() ? formatted : null;
}
