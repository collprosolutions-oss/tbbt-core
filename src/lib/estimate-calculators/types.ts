/**
 * Small reusable variable-scope calculator framework.
 *
 * Decorative Wall Paneling is the first fully configured template.
 * `custom-variable-scope` is the reusable engine for future Custom Work
 * / Other items. Preview cannot add Prisma columns, so snapshots live
 * in existing description text.
 */
import type { VariableScopeComponent } from "@/lib/estimate-calculators/variable-scope";

export const CALCULATOR_IDS = [
  "decorative-wall-paneling",
  "custom-variable-scope",
] as const;

export const CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID = "custom-variable-scope" as const;

export type CalculatorId = (typeof CALCULATOR_IDS)[number];

export type CalculatorAmountState =
  | "ready"
  | "waiting"
  | "not_entered"
  | "zero_selected";

export type CalculatorBreakdownLine = {
  key: string;
  label: string;
  quantity: number;
  rate: number;
  amount: number;
  amountState?: CalculatorAmountState;
};

export type CalculatorCustomerPolicy = {
  id: string;
  title: string;
  body: string;
  family?: "core" | "trade" | "project" | "business";
  optional?: boolean;
  disabled?: boolean;
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
  components?: VariableScopeComponent[];
};

export type CalculatorIntakeConfig = {
  workArea?: boolean;
};

export type CalculatorDefinition = {
  calculatorId: CalculatorId;
  rates: Record<string, unknown>;
  customerPolicies?: CalculatorCustomerPolicy[];
  components?: VariableScopeComponent[];
  intake?: CalculatorIntakeConfig;
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
