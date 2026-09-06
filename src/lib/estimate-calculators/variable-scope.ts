/**
 * Reusable variable-scope estimating engine.
 *
 * Decorative Wall Paneling is the first fully configured template. Future
 * Custom Work / Other items can reuse this same definition + engine instead
 * of a new hardcoded calculator. Business rates persist; job quantities
 * reset; customer-visible pages never render these internals.
 */
import { clampCount } from "@/lib/estimate-calculators/count-input";
import {
  roundMoney,
  type CalculatorAmountState,
  type CalculatorBreakdownLine,
  type CalculatorResult,
} from "@/lib/estimate-calculators/types";

export const VARIABLE_SCOPE_INPUT_TYPES = [
  "measurement",
  "count",
  "rate",
  "allowance",
] as const;

export const VARIABLE_SCOPE_SECTIONS = [
  "measurements",
  "counts",
  "allowances",
] as const;

export type VariableScopeInputType = (typeof VARIABLE_SCOPE_INPUT_TYPES)[number];
export type VariableScopeSection = (typeof VARIABLE_SCOPE_SECTIONS)[number];

export type VariableScopeComponent = {
  key: string;
  name: string;
  inputType: VariableScopeInputType;
  units?: string;
  quantityKey?: string;
  rateKey?: string;
  defaultRate?: number;
  persistRate?: boolean;
  resetQuantity?: boolean;
  customerVisible?: boolean;
  section?: VariableScopeSection;
};

export type VariableScopeTemplate = {
  calculatorId: string;
  title: string;
  components: VariableScopeComponent[];
  intake?: { workArea?: boolean };
};

export function isVariableScopeInputType(
  value: unknown,
): value is VariableScopeInputType {
  return (
    typeof value === "string" &&
    (VARIABLE_SCOPE_INPUT_TYPES as readonly string[]).includes(value)
  );
}

export function isVariableScopeSection(value: unknown): value is VariableScopeSection {
  return (
    typeof value === "string" &&
    (VARIABLE_SCOPE_SECTIONS as readonly string[]).includes(value)
  );
}

export function normalizeVariableScopeComponent(
  raw: unknown,
): VariableScopeComponent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const key = typeof item.key === "string" ? item.key.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!key || !name || !isVariableScopeInputType(item.inputType)) return null;
  const persistRate =
    typeof item.persistRate === "boolean"
      ? item.persistRate
      : item.inputType === "rate" || item.inputType === "allowance" || Boolean(item.rateKey);
  const resetQuantity =
    typeof item.resetQuantity === "boolean"
      ? item.resetQuantity
      : item.inputType === "measurement" || item.inputType === "count";
  return {
    key,
    name,
    inputType: item.inputType,
    units: typeof item.units === "string" ? item.units : undefined,
    quantityKey: typeof item.quantityKey === "string" ? item.quantityKey : undefined,
    rateKey: typeof item.rateKey === "string" ? item.rateKey : undefined,
    defaultRate:
      typeof item.defaultRate === "number" && Number.isFinite(item.defaultRate)
        ? roundMoney(Math.max(0, item.defaultRate))
        : undefined,
    persistRate,
    resetQuantity,
    customerVisible: item.customerVisible === true,
    section: isVariableScopeSection(item.section) ? item.section : defaultSection(item.inputType),
  };
}

export function normalizeVariableScopeComponents(raw: unknown): VariableScopeComponent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeVariableScopeComponent)
    .filter((item): item is VariableScopeComponent => item != null);
}

export function normalizeVariableScopeTemplate(
  raw: unknown,
): VariableScopeTemplate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const calculatorId =
    typeof item.calculatorId === "string" ? item.calculatorId.trim() : "";
  const title = typeof item.title === "string" ? item.title.trim() : calculatorId;
  const components = normalizeVariableScopeComponents(item.components);
  if (!calculatorId || components.length === 0) return null;
  const intakeRaw =
    item.intake && typeof item.intake === "object" && !Array.isArray(item.intake)
      ? (item.intake as { workArea?: unknown })
      : null;
  const intake =
    intakeRaw?.workArea === true
      ? { workArea: true as const }
      : intakeRaw?.workArea === false
        ? { workArea: false as const }
        : undefined;
  return { calculatorId, title, components, ...(intake ? { intake } : {}) };
}

export function defaultVariableScopeRates(template: VariableScopeTemplate) {
  const rates: Record<string, number> = {};
  for (const component of template.components) {
    if (!component.rateKey || !component.persistRate) continue;
    rates[component.rateKey] = component.defaultRate ?? 0;
  }
  return rates;
}

export function emptyVariableScopeInputs(template: VariableScopeTemplate) {
  const inputs: Record<string, unknown> = {};
  for (const component of template.components) {
    if (!component.resetQuantity) continue;
    const key = component.quantityKey ?? component.key;
    inputs[key] = component.inputType === "count" ? 0 : 0;
  }
  return inputs;
}

export function persistableVariableScopeRates(
  template: VariableScopeTemplate,
  rates?: Record<string, unknown> | null,
  inputs?: Record<string, unknown> | null,
) {
  const next: Record<string, number> = {};
  for (const component of template.components) {
    if (!component.rateKey || component.persistRate === false) continue;
    const fromRates = moneyOr(rates?.[component.rateKey], null);
    const fromInput =
      component.inputType === "allowance"
        ? moneyOr(inputs?.[component.quantityKey ?? component.key], null)
        : null;
    next[component.rateKey] =
      fromInput ?? fromRates ?? component.defaultRate ?? 0;
  }
  return next;
}

export function jobQuantityKeysFromTemplate(template: VariableScopeTemplate) {
  return template.components
    .filter((component) => component.resetQuantity)
    .map((component) => component.quantityKey ?? component.key);
}

export function computeVariableScope(
  template: VariableScopeTemplate,
  rawInputs?: Record<string, unknown> | null,
  rawRates?: Record<string, unknown> | null,
): CalculatorResult {
  const rates = persistableVariableScopeRates(template, rawRates, rawInputs);
  const lines: CalculatorBreakdownLine[] = [];
  for (const component of template.components) {
    const line = computeComponentLine(component, rawInputs ?? {}, rates);
    if (line) lines.push(line);
  }
  return {
    recommendedAmount: roundMoney(lines.reduce((sum, line) => sum + line.amount, 0)),
    lines,
  };
}

function computeComponentLine(
  component: VariableScopeComponent,
  inputs: Record<string, unknown>,
  rates: Record<string, number>,
): CalculatorBreakdownLine | null {
  if (!component.rateKey && component.inputType !== "allowance") {
    return null;
  }
  const rateKey = component.rateKey ?? component.key;
  const quantityKey = component.quantityKey ?? component.key;
  const rate = moneyOr(rates[rateKey], component.defaultRate ?? 0) ?? 0;
  const quantity =
    component.inputType === "allowance"
      ? 1
      : component.inputType === "count"
        ? clampCount(inputs[quantityKey], 0)
        : moneyOr(inputs[quantityKey], 0) ?? 0;
  const billedRate =
    component.inputType === "allowance"
      ? (moneyOr(inputs[quantityKey], rate) ?? rate)
      : rate;
  return {
    key: component.key,
    label: component.name,
    quantity,
    rate: billedRate,
    amount: roundMoney(quantity * billedRate),
    amountState: amountStateFor(component, quantity),
  };
}

function amountStateFor(
  component: VariableScopeComponent,
  quantity: number,
): CalculatorAmountState {
  if (component.inputType === "allowance" || component.inputType === "rate") {
    return "ready";
  }
  if (quantity > 0) return "ready";
  return component.inputType === "measurement" ? "waiting" : "not_entered";
}

function defaultSection(inputType: VariableScopeInputType): VariableScopeSection {
  if (inputType === "count") return "counts";
  if (inputType === "allowance") return "allowances";
  return "measurements";
}

function moneyOr(value: unknown, fallback: number | null) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) return fallback;
  return roundMoney(amount);
}
