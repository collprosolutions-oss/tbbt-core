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
