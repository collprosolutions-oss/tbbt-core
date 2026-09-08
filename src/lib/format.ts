export function formatMoney(value: { toString(): string } | string | number) {
  const amount = typeof value === "number" ? value : Number(value.toString());
  if (Number.isNaN(amount)) {
    return typeof value === "number" ? String(value) : value.toString();
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export function formatDate(value: Date) {
  return value.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: Date) {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatTime(value: Date) {
  return value.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatAddress(property: {
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}) {
  const cityRegion = [property.city, property.region].filter(Boolean).join(", ");
  return [
    property.addressLine1,
    property.addressLine2,
    cityRegion || null,
    property.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Customer-facing U.S. phone display. Storage is left as entered.
 * 11 digits starting with country code 1 drop the leading 1. Exactly 10
 * remaining digits render as (###) ###-####. Anything else is shown as stored.
 */
export function formatPublicPhoneDisplay(
  value: string | null | undefined,
): string | null {
  const original = value?.trim() ?? "";
  if (!original) return null;
  const digits = original.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length === 10) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return original;
}

type MailingAddressInput = {
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
};

/**
 * Customer-facing mailing-label lines. Does not invent missing parts.
 * Line 1: street + address 2 when present
 * Line 2: city, state
 * Line 3: ZIP
 */
export function formatMailingAddressLines(property: MailingAddressInput): string[] {
  const street = [property.addressLine1, property.addressLine2]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
  const cityState = [property.city, property.region]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
  const postalCode = property.postalCode?.trim() ?? "";
  return [street, cityState, postalCode].filter(Boolean);
}

export function formatMailingAddress(property: MailingAddressInput): string | null {
  const lines = formatMailingAddressLines(property);
  return lines.length > 0 ? lines.join("\n") : null;
}

export function latestDate(dates: Array<Date | null | undefined>) {
  return dates.reduce<Date | null>((latest, date) => {
    if (!date) {
      return latest;
    }
    if (!latest || date > latest) {
      return date;
    }
    return latest;
  }, null);
}
