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
