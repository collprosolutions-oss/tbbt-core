import {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  computeDecorativeWallPaneling,
  emptyDecorativeWallPanelingInputs,
  normalizeDecorativeWallPanelingInputs,
  normalizeDecorativeWallPanelingRates,
} from "@/lib/estimate-calculators/decorative-wall-paneling";
import {
  isCalculatorId,
  type CalculatorDefinition,
  type CalculatorId,
  type CalculatorResult,
  type CalculatorSnapshot,
} from "@/lib/estimate-calculators/types";

const TITLE_ALIASES: Record<CalculatorId, string[]> = {
  "decorative-wall-paneling": [DECORATIVE_WALL_PANELING_TITLE.toLowerCase()],
};

export function resolveCalculatorId(input: {
  title?: string | null;
  snapshot?: CalculatorSnapshot | null;
  definition?: CalculatorDefinition | null;
}): CalculatorId | null {
  if (input.snapshot && isCalculatorId(input.snapshot.calculatorId)) {
    return input.snapshot.calculatorId;
  }
  if (input.definition && isCalculatorId(input.definition.calculatorId)) {
    return input.definition.calculatorId;
  }
  const title = input.title?.trim().toLowerCase();
  if (!title) return null;
  for (const [id, aliases] of Object.entries(TITLE_ALIASES) as Array<
    [CalculatorId, string[]]
  >) {
    if (aliases.some((alias) => title === alias || title.startsWith(`${alias} `))) {
      return id;
    }
  }
  return null;
}

export function defaultCalculatorRates(calculatorId: CalculatorId) {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return { ...DEFAULT_DECORATIVE_WALL_PANELING_RATES };
  }
  return {};
}

export function emptyCalculatorInputs(
  calculatorId: CalculatorId,
  rates?: Record<string, unknown>,
) {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return emptyDecorativeWallPanelingInputs(
      normalizeDecorativeWallPanelingRates(rates),
    );
  }
  return {};
}

export function computeCalculator(
  calculatorId: CalculatorId,
  inputs?: Record<string, unknown> | null,
  rates?: Record<string, unknown> | null,
): CalculatorResult {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return computeDecorativeWallPaneling(inputs, rates);
  }
  return { recommendedAmount: 0, lines: [] };
}

export function normalizeCalculatorSnapshot(
  snapshot: CalculatorSnapshot,
): CalculatorSnapshot {
  const calculatorId = snapshot.calculatorId;
  const rates =
    calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID
      ? normalizeDecorativeWallPanelingRates(snapshot.rates)
      : snapshot.rates;
  const inputs =
    calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID
      ? normalizeDecorativeWallPanelingInputs(
          snapshot.inputs,
          normalizeDecorativeWallPanelingRates(snapshot.rates),
        )
      : snapshot.inputs;
  return {
    ...snapshot,
    calculatorId,
    rates,
    inputs,
  };
}

export function catalogDefinitionFromSnapshot(
  snapshot: CalculatorSnapshot | null,
  title?: string | null,
): CalculatorDefinition | null {
  const calculatorId = resolveCalculatorId({ title, snapshot });
  if (!calculatorId) return null;
  return {
    calculatorId,
    rates: snapshot?.rates ?? defaultCalculatorRates(calculatorId),
  };
}

export function startingCalculatorSnapshot(input: {
  title?: string | null;
  definition?: CalculatorDefinition | null;
  snapshot?: CalculatorSnapshot | null;
}): CalculatorSnapshot | null {
  const calculatorId = resolveCalculatorId(input);
  if (!calculatorId) return null;
  const rates =
    input.definition?.rates ??
    input.snapshot?.rates ??
    defaultCalculatorRates(calculatorId);
  return {
    calculatorId,
    rates,
    inputs: emptyCalculatorInputs(calculatorId, rates),
  };
}
