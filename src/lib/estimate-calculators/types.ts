/**
 * Small reusable variable-scope calculator framework.
 *
 * Only Decorative Wall Paneling is implemented now. Later trade
 * calculators (drywall, siding, flooring, trim, concrete, cabinets,
 * painting) register the same way. Preview cannot add Prisma columns,
 * so snapshots live in existing description text.
 */
export const CALCULATOR_IDS = ["decorative-wall-paneling"] as const;

export type CalculatorId = (typeof CALCULATOR_IDS)[number];

export type CalculatorBreakdownLine = {
  key: string;
  label: string;
  quantity: number;
  rate: number;
  amount: number;
};

export type CalculatorResult = {
  recommendedAmount: number;
  lines: CalculatorBreakdownLine[];
};

export type CalculatorSnapshot = {
  calculatorId: CalculatorId;
  inputs: Record<string, unknown>;
  rates: Record<string, unknown>;
  result?: CalculatorResult;
  recommendedAmount?: number;
  appliedAmount?: number;
  overriddenAmount?: number | null;
};

export type CalculatorDefinition = {
  calculatorId: CalculatorId;
  rates: Record<string, unknown>;
};

export function isCalculatorId(value: unknown): value is CalculatorId {
  return (
    typeof value === "string" &&
    (CALCULATOR_IDS as readonly string[]).includes(value)
  );
}

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
