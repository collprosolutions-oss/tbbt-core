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
