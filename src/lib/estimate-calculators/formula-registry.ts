/**
 * Approved title / starter-template bindings for formula contract v1.
 *
 * Catalog rows may embed a CalculatorDefinition. Request → draft estimate
 * must still attach the intended calculator when only an approved title
 * mapping exists (the Decorative Wall Paneling wiring bug).
 *
 * Do not convert the entire Handyman catalog here. This is the first
 * proof set plus the existing paneling calculator.
 */
import {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
} from "@/lib/estimate-calculators/decorative-wall-paneling";
import {
  normalizeFormulaContract,
  persistableFormulaRates,
  type FormulaContract,
} from "@/lib/estimate-calculators/formula-contract";
import {
  TRADE_FORMULA_CALCULATOR_ID,
  type CalculatorDefinition,
  type CalculatorId,
} from "@/lib/estimate-calculators/types";

export type FormulaServiceBinding = {
  templateKey: string;
  titles: readonly string[];
  calculatorId: CalculatorId;
  formula?: FormulaContract;
  defaultRates?: Record<string, unknown>;
};

const STANDARD_DOOR_KNOB_FORMULA = normalizeFormulaContract({
  kind: "count",
  unit: "each",
  quantityKey: "quantity",
  rateKey: "unitRate",
  productionPerHourKey: "unitsPerHour",
})!;

const WEATHERSTRIPPING_FORMULA = normalizeFormulaContract({
  kind: "linear",
  unit: "lf",
  quantityKey: "lengthLf",
  rateKey: "unitRate",
  productionPerHourKey: "unitsPerHour",
})!;

const GRAB_BAR_FORMULA = normalizeFormulaContract({
  kind: "minimum_plus_unit",
  unit: "each",
  quantityKey: "quantity",
  rateKey: "unitRate",
  minimumKey: "minimumAmount",
  productionPerHourKey: "unitsPerHour",
})!;

export const HANDYMAN_FORMULA_PROOF_BINDINGS: readonly FormulaServiceBinding[] = [
  {
    templateKey: "decorative-wall-paneling-finish-carpentry",
    titles: [
      "Decorative Wall Paneling & Finish Carpentry",
      "Decorative Wall Paneling",
    ],
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    defaultRates: { ...DEFAULT_DECORATIVE_WALL_PANELING_RATES },
  },
  {
    templateKey: "standard-door-knob-replacement",
    titles: ["Standard Door Knob Replacement"],
    calculatorId: TRADE_FORMULA_CALCULATOR_ID,
    formula: STANDARD_DOOR_KNOB_FORMULA,
    defaultRates: {
      unitRate: 75,
      unitsPerHour: 2,
    },
  },
  {
    templateKey: "weatherstripping-replacement",
    titles: ["Weatherstripping Replacement"],
    calculatorId: TRADE_FORMULA_CALCULATOR_ID,
    formula: WEATHERSTRIPPING_FORMULA,
    defaultRates: {
      unitRate: 8,
      unitsPerHour: 20,
    },
  },
  {
    templateKey: "grab-bar-installation",
    titles: ["Grab Bar Installation"],
    calculatorId: TRADE_FORMULA_CALCULATOR_ID,
    formula: GRAB_BAR_FORMULA,
    defaultRates: {
      unitRate: 100,
      minimumAmount: 100,
      unitsPerHour: 1.5,
    },
  },
];

export const HANDYMAN_FORMULA_PROOF_TEMPLATE_KEYS = HANDYMAN_FORMULA_PROOF_BINDINGS.map(
  (binding) => binding.templateKey,
);

function titleKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function formulaBindingForTitle(title?: string | null): FormulaServiceBinding | null {
  const key = title ? titleKey(title) : "";
  if (!key) return null;
  return (
    HANDYMAN_FORMULA_PROOF_BINDINGS.find((binding) =>
      binding.titles.some((alias) => {
        const aliasKey = titleKey(alias);
        return key === aliasKey || key.startsWith(`${aliasKey} `);
      }),
    ) ?? null
  );
}

export function formulaBindingForTemplateKey(
  templateKey?: string | null,
): FormulaServiceBinding | null {
  if (!templateKey) return null;
  return (
    HANDYMAN_FORMULA_PROOF_BINDINGS.find((binding) => binding.templateKey === templateKey) ??
    null
  );
}

export function formulaBindingForCalculatorId(
  calculatorId: CalculatorId,
  title?: string | null,
): FormulaServiceBinding | null {
  const fromTitle = formulaBindingForTitle(title);
  if (fromTitle?.calculatorId === calculatorId) return fromTitle;
  if (calculatorId !== TRADE_FORMULA_CALCULATOR_ID) {
    return (
      HANDYMAN_FORMULA_PROOF_BINDINGS.find((binding) => binding.calculatorId === calculatorId) ??
      null
    );
  }
  return fromTitle;
}

export function definitionFromFormulaBinding(
  binding: FormulaServiceBinding,
): CalculatorDefinition {
  const formula = binding.formula ? normalizeFormulaContract(binding.formula) : undefined;
  const rates = formula
    ? persistableFormulaRates(formula, binding.defaultRates)
    : { ...(binding.defaultRates ?? {}) };
  return {
    calculatorId: binding.calculatorId,
    rates,
    ...(formula ? { formula } : {}),
  };
}

export function resolveFormulaContract(input: {
  title?: string | null;
  calculatorId?: CalculatorId | null;
  definition?: { formula?: unknown } | null;
  snapshot?: { formula?: unknown } | null;
}): FormulaContract | null {
  const fromDefinition = normalizeFormulaContract(input.definition?.formula);
  if (fromDefinition) return fromDefinition;
  const fromSnapshot = normalizeFormulaContract(input.snapshot?.formula);
  if (fromSnapshot) return fromSnapshot;
  const binding =
    formulaBindingForTitle(input.title) ??
    (input.calculatorId
      ? formulaBindingForCalculatorId(input.calculatorId, input.title)
      : null);
  return binding?.formula ? normalizeFormulaContract(binding.formula) : null;
}

export function calculatorTitleAliases(): Partial<Record<CalculatorId, string[]>> {
  const aliases: Partial<Record<CalculatorId, string[]>> = {};
  for (const binding of HANDYMAN_FORMULA_PROOF_BINDINGS) {
    const current = aliases[binding.calculatorId] ?? [];
    aliases[binding.calculatorId] = [
      ...current,
      ...binding.titles.map((title) => title.toLowerCase()),
    ];
  }
  return aliases;
}
