/**
 * Owner-recorded supplier quote unit conversion.
 *
 * Converts quantity and unit price between compatible construction units.
 * Incompatible families are refused — never guessed. Pack-to-each uses an
 * explicit pack size. Exact Decimal math; money stays two places.
 */
import { Prisma } from "@prisma/client";
import { MaterialsError } from "@/lib/materials/errors";
import { decimalMoney, decimalQuantity } from "@/lib/materials/money";

export type MaterialUnitFamily = "count" | "length" | "area" | "volume" | "mass" | "pack";

type UnitSpec = {
  family: MaterialUnitFamily;
  /** How many family-base units equal one of this unit. */
  toBase: Prisma.Decimal;
};

const UNIT_SPECS: Record<string, UnitSpec> = {
  ea: { family: "count", toBase: new Prisma.Decimal(1) },
  each: { family: "count", toBase: new Prisma.Decimal(1) },

  in: { family: "length", toBase: new Prisma.Decimal(1).div(12) },
  inch: { family: "length", toBase: new Prisma.Decimal(1).div(12) },
  inches: { family: "length", toBase: new Prisma.Decimal(1).div(12) },
  ft: { family: "length", toBase: new Prisma.Decimal(1) },
  foot: { family: "length", toBase: new Prisma.Decimal(1) },
  feet: { family: "length", toBase: new Prisma.Decimal(1) },
  lf: { family: "length", toBase: new Prisma.Decimal(1) },
  linearft: { family: "length", toBase: new Prisma.Decimal(1) },
  linearfoot: { family: "length", toBase: new Prisma.Decimal(1) },
  yd: { family: "length", toBase: new Prisma.Decimal(3) },
  yard: { family: "length", toBase: new Prisma.Decimal(3) },
  yards: { family: "length", toBase: new Prisma.Decimal(3) },

  sf: { family: "area", toBase: new Prisma.Decimal(1) },
  sqft: { family: "area", toBase: new Prisma.Decimal(1) },
  squarefoot: { family: "area", toBase: new Prisma.Decimal(1) },
  squarefeet: { family: "area", toBase: new Prisma.Decimal(1) },
  sy: { family: "area", toBase: new Prisma.Decimal(9) },
  sqyd: { family: "area", toBase: new Prisma.Decimal(9) },
  squareyard: { family: "area", toBase: new Prisma.Decimal(9) },

  cf: { family: "volume", toBase: new Prisma.Decimal(1) },
  cuft: { family: "volume", toBase: new Prisma.Decimal(1) },
  cubicfoot: { family: "volume", toBase: new Prisma.Decimal(1) },
  cubicfeet: { family: "volume", toBase: new Prisma.Decimal(1) },
  cy: { family: "volume", toBase: new Prisma.Decimal(27) },
  cuyd: { family: "volume", toBase: new Prisma.Decimal(27) },
  cubicyard: { family: "volume", toBase: new Prisma.Decimal(27) },

  oz: { family: "mass", toBase: new Prisma.Decimal("0.0625") },
  ounce: { family: "mass", toBase: new Prisma.Decimal("0.0625") },
  ounces: { family: "mass", toBase: new Prisma.Decimal("0.0625") },
  lb: { family: "mass", toBase: new Prisma.Decimal(1) },
  lbs: { family: "mass", toBase: new Prisma.Decimal(1) },
  pound: { family: "mass", toBase: new Prisma.Decimal(1) },
  pounds: { family: "mass", toBase: new Prisma.Decimal(1) },
  ton: { family: "mass", toBase: new Prisma.Decimal(2000) },
  tons: { family: "mass", toBase: new Prisma.Decimal(2000) },

  bag: { family: "pack", toBase: new Prisma.Decimal(1) },
  bags: { family: "pack", toBase: new Prisma.Decimal(1) },
  box: { family: "pack", toBase: new Prisma.Decimal(1) },
  boxes: { family: "pack", toBase: new Prisma.Decimal(1) },
  sheet: { family: "pack", toBase: new Prisma.Decimal(1) },
  sheets: { family: "pack", toBase: new Prisma.Decimal(1) },
  pack: { family: "pack", toBase: new Prisma.Decimal(1) },
  packs: { family: "pack", toBase: new Prisma.Decimal(1) },
  bundle: { family: "pack", toBase: new Prisma.Decimal(1) },
  bundles: { family: "pack", toBase: new Prisma.Decimal(1) },
};

export function normalizeMaterialUnit(unit: string) {
  return unit.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function materialUnitSpec(unit: string): UnitSpec | null {
  return UNIT_SPECS[normalizeMaterialUnit(unit)] ?? null;
}

export type UnitConversion = {
  fromUnit: string;
  toUnit: string;
  /** How many `toUnit` equal one `fromUnit`. */
  factor: Prisma.Decimal;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  label: string;
};

function packSizeFactor(packSize: Prisma.Decimal | number | string | null | undefined) {
  if (packSize == null || packSize === "") return null;
  try {
    const value = packSize instanceof Prisma.Decimal ? packSize : new Prisma.Decimal(packSize);
    if (value.isNaN() || value.lte(0)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Factor = how many `toUnit` equal one `fromUnit`.
 * Quantity converts by multiplying; unit price converts by dividing.
 */
export function materialUnitFactor(
  fromUnit: string,
  toUnit: string,
  packSize?: Prisma.Decimal | number | string | null,
): Prisma.Decimal {
  const from = fromUnit.trim() || "ea";
  const to = toUnit.trim() || "ea";
  if (normalizeMaterialUnit(from) === normalizeMaterialUnit(to)) {
    return new Prisma.Decimal(1);
  }
  const fromSpec = materialUnitSpec(from);
  const toSpec = materialUnitSpec(to);
  if (!fromSpec || !toSpec) {
    throw new MaterialsError(
      `Those units cannot be converted (${from} → ${to}). Use the same unit or a compatible pair.`,
    );
  }
  if (fromSpec.family === toSpec.family) {
    if (fromSpec.family === "pack" && normalizeMaterialUnit(from) !== normalizeMaterialUnit(to)) {
      throw new MaterialsError(
        `Those pack units cannot be converted (${from} → ${to}). Record both quotes in the same pack unit.`,
      );
    }
    return fromSpec.toBase.div(toSpec.toBase);
  }
  const pack = packSizeFactor(packSize);
  const packToCount =
    fromSpec.family === "pack" && toSpec.family === "count" && toSpec.toBase.eq(1);
  const countToPack =
    fromSpec.family === "count" && fromSpec.toBase.eq(1) && toSpec.family === "pack";
  if (pack && (packToCount || countToPack)) {
    return packToCount ? pack : new Prisma.Decimal(1).div(pack);
  }
  throw new MaterialsError(
    `Those units cannot be converted (${from} → ${to}). Use the same family or an explicit pack size for pack ↔ each.`,
  );
}

export function convertMaterialQuoteUnits(input: {
  quantity: Prisma.Decimal | number | string;
  unitPrice: Prisma.Decimal | number | string;
  fromUnit: string;
  toUnit: string;
  packSize?: Prisma.Decimal | number | string | null;
}): UnitConversion {
  const quantity = decimalQuantity(input.quantity);
  const unitPrice = decimalMoney(input.unitPrice);
  if (!quantity || !unitPrice) {
    throw new MaterialsError("Enter a quote quantity and unit price greater than zero.");
  }
  const factor = materialUnitFactor(input.fromUnit, input.toUnit, input.packSize);
  const convertedQuantity = quantity.mul(factor).toDecimalPlaces(4);
  const convertedPrice = unitPrice.div(factor).toDecimalPlaces(2);
  const from = input.fromUnit.trim() || "ea";
  const to = input.toUnit.trim() || "ea";
  const label = factor.eq(1)
    ? `${from}`
    : `${from} → ${to} × ${factor.toString()}`;
  return {
    fromUnit: from,
    toUnit: to,
    factor,
    quantity: convertedQuantity,
    unitPrice: convertedPrice,
    label,
  };
}
