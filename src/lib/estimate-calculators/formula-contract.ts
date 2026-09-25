/**
 * Trade-aware formula contract v1.
 *
 * One reusable declarative engine — not per-trade calculators.
 * Concrete / paneling remain specialized examples. Catalog JSON holds
 * formula structure; BusinessEstimatingDefault holds reusable rates;
 * the estimate snapshot holds job quantities and the applied result.
 *
 * LABOR LineItem.quantity is never hours.
 */
import { clampCount } from "@/lib/estimate-calculators/count-input";
import {
  roundMoney,
  type CalculatorAmountState,
  type CalculatorBreakdownLine,
  type CalculatorResult,
} from "@/lib/estimate-calculators/types";
import {
  isProductionUnit,
  normalizeProductionUnit,
  type ProductionUnit,
} from "@/lib/estimate-calculators/unit-registry";

export const FORMULA_CONTRACT_VERSION = 1 as const;

export const FORMULA_KINDS = [
  "unit",
  "area",
  "linear",
  "count",
  "minimum_plus_unit",
  "tier_table",
  "base_plus_components",
  "starting_range",
  "custom_quote",
] as const;

export type FormulaKind = (typeof FORMULA_KINDS)[number];

export type FormulaComponent = {
  key: string;
  name: string;
  quantityKey: string;
  rateKey: string;
  unit?: ProductionUnit;
  productionPerHourKey?: string;
};

export type FormulaTier = {
  upTo: number | null;
  rate: number;
};

export type FormulaContract = {
  version: 1;
  kind: FormulaKind;
  unit: ProductionUnit;
  quantityKey?: string;
  rateKey?: string;
  minimumKey?: string;
  baseKey?: string;
  startingKey?: string;
  widthKey?: string;
  heightKey?: string;
  productionPerHourKey?: string;
  components?: FormulaComponent[];
  tiers?: FormulaTier[];
};

export type FormulaComputeResult = CalculatorResult & {
  estimatedLaborHours: number | null;
};

export function isFormulaKind(value: unknown): value is FormulaKind {
  return typeof value === "string" && (FORMULA_KINDS as readonly string[]).includes(value);
}

export function defaultFormulaKeys(kind: FormulaKind) {
  if (kind === "area") {
    return {
      quantityKey: "areaSqFt",
      rateKey: "unitRate",
      widthKey: "widthFt",
      heightKey: "heightFt",
      productionPerHourKey: "unitsPerHour",
    };
  }
  if (kind === "linear") {
    return {
      quantityKey: "lengthLf",
      rateKey: "unitRate",
      productionPerHourKey: "unitsPerHour",
    };
  }
  if (kind === "minimum_plus_unit") {
    return {
      quantityKey: "quantity",
      rateKey: "unitRate",
      minimumKey: "minimumAmount",
      productionPerHourKey: "unitsPerHour",
    };
  }
  if (kind === "base_plus_components") {
    return {
      baseKey: "baseAmount",
    };
  }
  if (kind === "starting_range") {
    return { startingKey: "startingAmount" };
  }
  if (kind === "custom_quote") {
    return {};
  }
  if (kind === "tier_table") {
    return {
      quantityKey: "quantity",
      productionPerHourKey: "unitsPerHour",
    };
  }
  return {
    quantityKey: "quantity",
    rateKey: "unitRate",
    productionPerHourKey: "unitsPerHour",
  };
}

export function normalizeFormulaComponent(raw: unknown): FormulaComponent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const key = typeof item.key === "string" ? item.key.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const quantityKey =
    typeof item.quantityKey === "string" && item.quantityKey.trim()
      ? item.quantityKey.trim()
      : key;
  const rateKey =
    typeof item.rateKey === "string" && item.rateKey.trim()
      ? item.rateKey.trim()
      : "";
  if (!key || !name || !rateKey) return null;
  return {
    key,
    name,
    quantityKey,
    rateKey,
    ...(isOptionalUnit(item.unit) ? { unit: item.unit } : {}),
    ...(optionalKey(item.productionPerHourKey)
      ? { productionPerHourKey: String(item.productionPerHourKey).trim() }
      : {}),
  };
}

export function normalizeFormulaTiers(raw: unknown): FormulaTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const rate = moneyOr(row.rate, null);
      if (rate == null) return null;
      const upTo =
        row.upTo == null || row.upTo === ""
          ? null
          : moneyOr(row.upTo, null);
      if (row.upTo != null && row.upTo !== "" && upTo == null) return null;
      return { upTo, rate };
    })
    .filter((item): item is FormulaTier => item != null)
    .sort((left, right) => {
      if (left.upTo == null) return 1;
      if (right.upTo == null) return -1;
      return left.upTo - right.upTo;
    });
}

export function normalizeFormulaContract(raw: unknown): FormulaContract | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (!isFormulaKind(item.kind)) return null;
  const defaults = defaultFormulaKeys(item.kind);
  const components = Array.isArray(item.components)
    ? item.components
        .map(normalizeFormulaComponent)
        .filter((row): row is FormulaComponent => row != null)
    : undefined;
  const tiers = item.kind === "tier_table" ? normalizeFormulaTiers(item.tiers) : undefined;
  if (item.kind === "base_plus_components" && (!components || components.length === 0)) {
    return null;
  }
  if (item.kind === "tier_table" && (!tiers || tiers.length === 0)) {
    return null;
  }
  return {
    version: FORMULA_CONTRACT_VERSION,
    kind: item.kind,
    unit: normalizeProductionUnit(item.unit, defaultUnitForKind(item.kind)),
    ...(optionalKey(item.quantityKey) || defaults.quantityKey
      ? { quantityKey: optionalKey(item.quantityKey) ?? defaults.quantityKey }
      : {}),
    ...(optionalKey(item.rateKey) || defaults.rateKey
      ? { rateKey: optionalKey(item.rateKey) ?? defaults.rateKey }
      : {}),
    ...(optionalKey(item.minimumKey) || defaults.minimumKey
      ? { minimumKey: optionalKey(item.minimumKey) ?? defaults.minimumKey }
      : {}),
    ...(optionalKey(item.baseKey) || defaults.baseKey
      ? { baseKey: optionalKey(item.baseKey) ?? defaults.baseKey }
      : {}),
    ...(optionalKey(item.startingKey) || defaults.startingKey
      ? { startingKey: optionalKey(item.startingKey) ?? defaults.startingKey }
      : {}),
    ...(optionalKey(item.widthKey) || defaults.widthKey
      ? { widthKey: optionalKey(item.widthKey) ?? defaults.widthKey }
      : {}),
    ...(optionalKey(item.heightKey) || defaults.heightKey
      ? { heightKey: optionalKey(item.heightKey) ?? defaults.heightKey }
      : {}),
    ...(optionalKey(item.productionPerHourKey) || defaults.productionPerHourKey
      ? {
          productionPerHourKey:
            optionalKey(item.productionPerHourKey) ?? defaults.productionPerHourKey,
        }
      : {}),
    ...(components && components.length > 0 ? { components } : {}),
    ...(tiers && tiers.length > 0 ? { tiers } : {}),
  };
}

export function formulaQuantityKeys(formula: FormulaContract) {
  const keys = new Set<string>();
  if (formula.quantityKey) keys.add(formula.quantityKey);
  if (formula.widthKey) keys.add(formula.widthKey);
  if (formula.heightKey) keys.add(formula.heightKey);
  for (const component of formula.components ?? []) {
    keys.add(component.quantityKey);
  }
  return [...keys];
}

export function formulaRateKeys(formula: FormulaContract) {
  const keys = new Set<string>();
  if (formula.rateKey) keys.add(formula.rateKey);
  if (formula.minimumKey) keys.add(formula.minimumKey);
  if (formula.baseKey) keys.add(formula.baseKey);
  if (formula.startingKey) keys.add(formula.startingKey);
  if (formula.productionPerHourKey) keys.add(formula.productionPerHourKey);
  for (const component of formula.components ?? []) {
    keys.add(component.rateKey);
    if (component.productionPerHourKey) keys.add(component.productionPerHourKey);
  }
  return [...keys];
}

export function defaultFormulaRates(
  formula: FormulaContract,
  rates?: Record<string, unknown> | null,
) {
  return persistableFormulaRates(formula, rates);
}

export function persistableFormulaRates(
  formula: FormulaContract,
  rates?: Record<string, unknown> | null,
) {
  const next: Record<string, number> = {};
  for (const key of formulaRateKeys(formula)) {
    next[key] = moneyOr(rates?.[key], 0) ?? 0;
  }
  if (formula.kind === "tier_table") {
    // Tier rates live on the formula structure, not as job quantities.
  }
  return next;
}

export function emptyFormulaInputs(formula: FormulaContract) {
  const inputs: Record<string, number> = {};
  for (const key of formulaQuantityKeys(formula)) {
    inputs[key] = 0;
  }
  return inputs;
}

export function computeFormula(
  formula: FormulaContract,
  rawInputs?: Record<string, unknown> | null,
  rawRates?: Record<string, unknown> | null,
): FormulaComputeResult {
  const rates = persistableFormulaRates(formula, rawRates);
  const inputs = rawInputs ?? {};
  const lines: CalculatorBreakdownLine[] = [];

  if (formula.kind === "custom_quote") {
    return {
      recommendedAmount: 0,
      lines: [
        {
          key: "custom_quote",
          label: "Custom quote",
          quantity: 0,
          rate: 0,
          amount: 0,
          amountState: "waiting",
        },
      ],
      estimatedLaborHours: null,
    };
  }

  if (formula.kind === "starting_range") {
    const startingKey = formula.startingKey ?? "startingAmount";
    const starting = moneyOr(rates[startingKey], 0) ?? 0;
    lines.push({
      key: "starting",
      label: "Starting range",
      quantity: 1,
      rate: starting,
      amount: starting,
      amountState: starting > 0 ? "ready" : "waiting",
    });
    return {
      recommendedAmount: roundMoney(starting),
      lines,
      estimatedLaborHours: null,
    };
  }

  if (formula.kind === "base_plus_components") {
    const baseKey = formula.baseKey ?? "baseAmount";
    const base = moneyOr(rates[baseKey], 0) ?? 0;
    if (base > 0) {
      lines.push({
        key: "base",
        label: "Base",
        quantity: 1,
        rate: base,
        amount: roundMoney(base),
        amountState: "ready",
      });
    }
    let productionQuantity = 0;
    let productionPerHour: number | null = productionRate(rates, formula.productionPerHourKey);
    for (const component of formula.components ?? []) {
      const quantity = quantityValue(inputs[component.quantityKey], component.unit);
      const rate = moneyOr(rates[component.rateKey], 0) ?? 0;
      lines.push({
        key: component.key,
        label: component.name,
        quantity,
        rate,
        amount: roundMoney(quantity * rate),
        amountState: amountStateForQuantity(quantity),
      });
      const componentRate = productionRate(rates, component.productionPerHourKey);
      if (componentRate != null && quantity > 0) {
        productionQuantity += quantity;
        if (productionPerHour == null) productionPerHour = componentRate;
      }
    }
    return {
      recommendedAmount: roundMoney(lines.reduce((sum, line) => sum + line.amount, 0)),
      lines,
      estimatedLaborHours: hoursFromProduction(productionQuantity, productionPerHour),
    };
  }

  const quantity = productionQuantity(formula, inputs);
  const rateKey = formula.rateKey ?? "unitRate";
  let billedRate = moneyOr(rates[rateKey], 0) ?? 0;
  let amount = roundMoney(quantity * billedRate);
  let amountState = amountStateForQuantity(quantity);

  if (formula.kind === "tier_table") {
    const tier = tierForQuantity(formula.tiers ?? [], quantity);
    billedRate = tier?.rate ?? 0;
    amount = roundMoney(quantity * billedRate);
  }

  if (formula.kind === "minimum_plus_unit") {
    const minimumKey = formula.minimumKey ?? "minimumAmount";
    const minimum = moneyOr(rates[minimumKey], 0) ?? 0;
    const unitAmount = roundMoney(quantity * billedRate);
    if (quantity > 0) {
      amount = roundMoney(Math.max(minimum, unitAmount));
      amountState = "ready";
      if (minimum > unitAmount) {
        lines.push({
          key: "minimum",
          label: "Labor minimum",
          quantity: 1,
          rate: minimum,
          amount: roundMoney(minimum),
          amountState: "ready",
        });
      }
    } else if (minimum > 0) {
      amountState = "waiting";
    }
  }

  lines.push({
    key: formula.kind,
    label: lineLabelForKind(formula),
    quantity,
    rate: billedRate,
    amount: formula.kind === "minimum_plus_unit" && lines.length > 0 ? amount : amount,
    amountState,
  });

  if (formula.kind === "minimum_plus_unit" && lines.length > 1) {
    const unitLine = lines[lines.length - 1];
    unitLine.amount = roundMoney(quantity * billedRate);
  }

  return {
    recommendedAmount:
      formula.kind === "minimum_plus_unit"
        ? quantity > 0
          ? roundMoney(
              Math.max(
                moneyOr(rates[formula.minimumKey ?? "minimumAmount"], 0) ?? 0,
                quantity * billedRate,
              ),
            )
          : 0
        : amount,
    lines,
    estimatedLaborHours: hoursFromProduction(
      quantity,
      productionRate(rates, formula.productionPerHourKey),
    ),
  };
}

export function hoursFromProduction(
  quantity: number,
  unitsPerHour: number | null,
): number | null {
  if (unitsPerHour == null || !(unitsPerHour > 0) || !(quantity > 0)) return null;
  return Math.round((quantity / unitsPerHour) * 100) / 100;
}

function productionQuantity(
  formula: FormulaContract,
  inputs: Record<string, unknown>,
) {
  if (formula.kind === "area") {
    const areaKey = formula.quantityKey ?? "areaSqFt";
    const direct = moneyOr(inputs[areaKey], 0) ?? 0;
    if (direct > 0) return direct;
    const width = moneyOr(inputs[formula.widthKey ?? "widthFt"], 0) ?? 0;
    const height = moneyOr(inputs[formula.heightKey ?? "heightFt"], 0) ?? 0;
    return roundMoney(width * height);
  }
  const key = formula.quantityKey ?? "quantity";
  if (formula.kind === "count" || formula.unit === "each" || formula.unit === "opening") {
    return clampCount(inputs[key], 0);
  }
  return moneyOr(inputs[key], 0) ?? 0;
}

function quantityValue(value: unknown, unit?: ProductionUnit) {
  if (unit === "each" || unit === "opening" || unit === "room" || unit === "bag") {
    return clampCount(value, 0);
  }
  return moneyOr(value, 0) ?? 0;
}

function tierForQuantity(tiers: FormulaTier[], quantity: number) {
  if (tiers.length === 0) return null;
  for (const tier of tiers) {
    if (tier.upTo == null || quantity <= tier.upTo) return tier;
  }
  return tiers[tiers.length - 1];
}

function productionRate(rates: Record<string, number>, key?: string) {
  if (!key) return null;
  const value = moneyOr(rates[key], null);
  return value != null && value > 0 ? value : null;
}

function amountStateForQuantity(quantity: number): CalculatorAmountState {
  return quantity > 0 ? "ready" : "waiting";
}

function lineLabelForKind(formula: FormulaContract) {
  if (formula.kind === "area") return `Area (${formula.unit})`;
  if (formula.kind === "linear") return `Length (${formula.unit})`;
  if (formula.kind === "count") return `Count (${formula.unit})`;
  if (formula.kind === "minimum_plus_unit") return `Production (${formula.unit})`;
  if (formula.kind === "tier_table") return `Tiered (${formula.unit})`;
  return `Unit (${formula.unit})`;
}

function defaultUnitForKind(kind: FormulaKind): ProductionUnit {
  if (kind === "area") return "sf";
  if (kind === "linear") return "lf";
  if (kind === "count") return "each";
  return "each";
}

function optionalKey(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOptionalUnit(value: unknown): value is ProductionUnit {
  return isProductionUnit(value);
}

function moneyOr(value: unknown, fallback: number | null) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return fallback;
  return roundMoney(amount);
}
