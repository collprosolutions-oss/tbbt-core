import { formatAddress } from "@/lib/format";

/**
 * A plain external maps URL built from the property's own address --
 * exactly per the DIRECTIONS spec: "Use a standard external maps URL
 * generated from the address. Do not build route optimization. Do not
 * require a paid Maps API for this." Google's `/maps/search` endpoint
 * accepts a free-text query with no API key, and opens the installed Maps
 * app on a phone when tapped.
 */
export function directionsUrl(
  property: {
    addressLine1: string;
    addressLine2?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
  } | null,
): string | null {
  if (!property) {
    return null;
  }
  const address = formatAddress(property);
  if (!address) {
    return null;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

/** `tel:` link for click-to-call. Strips nothing -- browsers/phones handle formatted numbers fine. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone || !phone.trim()) {
    return null;
  }
  return `tel:${phone.trim()}`;
}

/** Text-first contact link. Uses digits only so SMS apps open reliably. */
export function smsHref(phone: string | null | undefined): string | null {
  if (!phone || !phone.trim()) {
    return null;
  }
  const digits = phone.replace(/\D/g, "");
  return digits ? `sms:${digits}` : null;
}
