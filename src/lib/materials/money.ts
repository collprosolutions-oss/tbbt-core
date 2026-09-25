import { Prisma } from "@prisma/client";
import { roundMoney } from "@/lib/estimate-calculators/types";

export function parsePositiveDecimal(raw: unknown): Prisma.Decimal | null {
  if (raw == null || raw === "") return null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  try {
    const value = new Prisma.Decimal(cleaned);
    if (value.isNaN() || value.lte(0)) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseNonNegativeDecimal(raw: unknown): Prisma.Decimal | null {
  if (raw == null || raw === "") return null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  try {
    const value = new Prisma.Decimal(cleaned);
    if (value.isNaN() || value.lt(0)) return null;
    return value;
  } catch {
    return null;
  }
}

export function decimalMoney(raw: unknown): Prisma.Decimal | null {
  const value = parsePositiveDecimal(raw);
  return value ? value.toDecimalPlaces(2) : null;
}

export function decimalQuantity(raw: unknown): Prisma.Decimal | null {
  const value = parsePositiveDecimal(raw);
  return value ? value.toDecimalPlaces(4) : null;
}

export function asMoneyNumber(value: { toString(): string } | null | undefined) {
  if (value == null) return null;
  const numeric = Number(value.toString());
  return Number.isFinite(numeric) ? roundMoney(numeric) : null;
}

export function extendedCost(
  quantity: Prisma.Decimal | null | undefined,
  unitCost: Prisma.Decimal | null | undefined,
) {
  if (!quantity || !unitCost) return null;
  return quantity.mul(unitCost).toDecimalPlaces(2);
}
