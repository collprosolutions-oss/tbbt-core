import { formatMoney } from "@/lib/format";

export const PRICING_MODES = ["FIXED", "STARTING_AT", "CUSTOM_QUOTE"] as const;

export type PricingMode = (typeof PRICING_MODES)[number];

export function parsePricingMode(value: string): PricingMode | null {
  if (
    value === "FIXED" ||
    value === "STARTING_AT" ||
    value === "CUSTOM_QUOTE"
  ) {
    return value;
  }
  return null;
}

export function publicCatalogUnitAmount(
  mode: string,
  price: { toString(): string } | number | null | undefined,
): number | null {
  if (mode === "CUSTOM_QUOTE" || price == null) return null;
  const amount = typeof price === "number" ? price : Number(price.toString());
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

export function formatCatalogPriceLabel(
  mode: string,
  price: { toString(): string } | number | null | undefined,
) {
  if (mode === "CUSTOM_QUOTE" || price == null) {
    return "Custom Quote";
  }
  const money = formatMoney(price);
  if (mode === "FIXED") {
    return `Fixed ${money}`;
  }
  return `Starting at ${money}`;
}

export function pricingModeLabel(mode: string) {
  if (mode === "FIXED") return "Fixed";
  if (mode === "CUSTOM_QUOTE") return "Custom Quote";
  return "Starting at";
}

export function pricingModeDescription(mode: string) {
  if (mode === "FIXED") return "For predictable services.";
  if (mode === "CUSTOM_QUOTE") return "For highly variable work.";
  return "For moderately variable services.";
}
