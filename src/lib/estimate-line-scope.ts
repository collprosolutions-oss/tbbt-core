/**
 * Scope / Included Work, calculator snapshots, and owner-only material
 * takeoff on estimate lines.
 *
 * Preview shares the Production database and does not run migrations, so
 * none of this can live in a new Prisma column. All of it is encoded in
 * the existing LineItem / EstimateVersionLineItem `description` after
 * stable markers. Totals never read them. Customer surfaces use
 * lineItemTitle() / included work only.
 */
import {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  isCalculatorId,
  type CalculatorCustomerPolicy,
  type CalculatorDefinition,
  type CalculatorSnapshot,
} from "@/lib/estimate-calculators/types";
import { normalizeVariableScopeComponents } from "@/lib/estimate-calculators/variable-scope";
import { normalizeCustomerPolicies } from "@/lib/estimate-policies";
import { normalizeTakeoffSnapshot } from "@/lib/material-takeoff/engine";
import type {
  TakeoffSnapshot,
  TakeoffSourceRef,
} from "@/lib/material-takeoff/types";

export const MAX_INCLUDED_WORK_LENGTH = 8000;
export const INCLUDED_WORK_MARKER = "\n\nScope / Included Work:\n";
export const CALCULATOR_SNAPSHOT_MARKER = "\n\nTBBT Calculator Snapshot:\n";
export const CALCULATOR_DEFINITION_MARKER = "\n\nTBBT Calculator Definition:\n";
export const CUSTOMER_POLICY_MARKER = "\n\nTBBT Customer Policy:\n";
export const MATERIAL_TAKEOFF_MARKER = "\n\nTBBT Material Takeoff:\n";
export const MATERIAL_TAKEOFF_SOURCE_MARKER = "\n\nTBBT Material Takeoff Source:\n";

const LINE_INTERNAL_MARKERS = [
  INCLUDED_WORK_MARKER,
  CUSTOMER_POLICY_MARKER,
  CALCULATOR_SNAPSHOT_MARKER,
  MATERIAL_TAKEOFF_MARKER,
  MATERIAL_TAKEOFF_SOURCE_MARKER,
] as const;

export function normalizeIncludedWork(
  raw: string | null | undefined,
): string | null {
  if (raw == null) {
    return null;
  }
  const text = stripCalculatorEncoding(raw.replace(/\r\n/g, "\n")).trim();
  if (!text) {
    return null;
  }
  return text.length > MAX_INCLUDED_WORK_LENGTH
    ? text.slice(0, MAX_INCLUDED_WORK_LENGTH)
    : text;
}

export function splitLineDescription(description: string | null | undefined): {
  title: string;
  includedWork: string | null;
  calculatorSnapshot: CalculatorSnapshot | null;
  customerPolicies: CalculatorCustomerPolicy[];
  materialTakeoff: TakeoffSnapshot | null;
  materialTakeoffSource: TakeoffSourceRef | null;
} {
  const raw = description ?? "";
  const calculatorSnapshot = parseCalculatorSnapshot(
    payloadAfterMarker(raw, CALCULATOR_SNAPSHOT_MARKER) ?? "",
  );
  const customerPolicies = parseCustomerPolicies(
    payloadAfterMarker(raw, CUSTOMER_POLICY_MARKER) ?? "",
  );
  const materialTakeoff = normalizeTakeoffSnapshot(
    parseJsonObject(payloadAfterMarker(raw, MATERIAL_TAKEOFF_MARKER) ?? ""),
  );
  const materialTakeoffSource = parseTakeoffSourceRef(
    payloadAfterMarker(raw, MATERIAL_TAKEOFF_SOURCE_MARKER),
  );
  const prefix = sliceBeforeFirstMarker(raw);
  return {
    title: prefix,
    includedWork: normalizeIncludedWork(
      payloadAfterMarker(raw, INCLUDED_WORK_MARKER),
    ),
    calculatorSnapshot,
    customerPolicies,
    materialTakeoff,
    materialTakeoffSource,
  };
}

export function lineItemTitle(description: string | null | undefined): string {
  return splitLineDescription(description).title;
}

export function lineItemIncludedWork(
  description: string | null | undefined,
): string | null {
  return splitLineDescription(description).includedWork;
}

export function lineCalculatorSnapshot(
  description: string | null | undefined,
): CalculatorSnapshot | null {
  return splitLineDescription(description).calculatorSnapshot;
}

export function lineCustomerPolicies(
  description: string | null | undefined,
): CalculatorCustomerPolicy[] {
  return splitLineDescription(description).customerPolicies;
}

export function lineMaterialTakeoff(
  description: string | null | undefined,
): TakeoffSnapshot | null {
  return splitLineDescription(description).materialTakeoff;
}

export function lineMaterialTakeoffSource(
  description: string | null | undefined,
): TakeoffSourceRef | null {
  return splitLineDescription(description).materialTakeoffSource;
}

export function joinLineDescription(
  title: string,
  includedWork?: string | null,
  calculatorSnapshot?: CalculatorSnapshot | null,
  customerPolicies?: CalculatorCustomerPolicy[] | null,
  extras?: {
    materialTakeoff?: TakeoffSnapshot | null;
    materialTakeoffSource?: TakeoffSourceRef | null;
  },
): string {
  const cleanTitle = splitLineDescription(title).title;
  const scope = normalizeIncludedWork(includedWork);
  const policies = normalizeCustomerPolicies(customerPolicies);
  const snapshot = calculatorSnapshot
    ? serializeCalculatorSnapshot(calculatorSnapshot)
    : null;
  const takeoff = extras?.materialTakeoff
    ? JSON.stringify(extras.materialTakeoff)
    : null;
  const takeoffSource = extras?.materialTakeoffSource
    ? JSON.stringify(extras.materialTakeoffSource)
    : null;
  let next = cleanTitle;
  if (scope) {
    next = `${next}${INCLUDED_WORK_MARKER}${scope}`;
  }
  if (policies.length > 0) {
    next = `${next}${CUSTOMER_POLICY_MARKER}${JSON.stringify(policies)}`;
  }
  if (snapshot) {
    next = `${next}${CALCULATOR_SNAPSHOT_MARKER}${snapshot}`;
  }
  if (takeoff) {
    next = `${next}${MATERIAL_TAKEOFF_MARKER}${takeoff}`;
  }
  if (takeoffSource) {
    next = `${next}${MATERIAL_TAKEOFF_SOURCE_MARKER}${takeoffSource}`;
  }
  return next;
}

export function includedWorkLines(raw: string | null | undefined): string[] {
  const text = normalizeIncludedWork(raw);
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function catalogScopeText(description: string | null | undefined): string | null {
  return splitCatalogDescription(description).includedWork;
}

export function catalogCalculatorDefinition(
  description: string | null | undefined,
): CalculatorDefinition | null {
  return splitCatalogDescription(description).definition;
}

export function splitCatalogDescription(description: string | null | undefined): {
  includedWork: string | null;
  definition: CalculatorDefinition | null;
} {
  const raw = description ?? "";
  const index = raw.indexOf(CALCULATOR_DEFINITION_MARKER);
  if (index === -1) {
    return {
      includedWork: normalizeIncludedWork(raw),
      definition: null,
    };
  }
  return {
    includedWork: normalizeIncludedWork(raw.slice(0, index)),
    definition: parseCalculatorDefinition(
      raw.slice(index + CALCULATOR_DEFINITION_MARKER.length),
    ),
  };
}

export function joinCatalogDescription(
  includedWork?: string | null,
  definition?: CalculatorDefinition | null,
): string | null {
  const scope = normalizeIncludedWork(includedWork);
  const encoded = definition ? serializeCalculatorDefinition(definition) : null;
  if (!scope && !encoded) return null;
  if (!encoded) return scope;
  return `${scope ?? ""}${CALCULATOR_DEFINITION_MARKER}${encoded}`;
}

export function stripCalculatorEncoding(raw: string) {
  let next = raw;
  for (const marker of [
    ...LINE_INTERNAL_MARKERS,
    CALCULATOR_DEFINITION_MARKER,
  ]) {
    const index = next.indexOf(marker);
    if (index !== -1) next = next.slice(0, index);
  }
  return next;
}

function sliceBeforeFirstMarker(raw: string) {
  let earliest = raw.length;
  for (const marker of LINE_INTERNAL_MARKERS) {
    const index = raw.indexOf(marker);
    if (index !== -1 && index < earliest) earliest = index;
  }
  return raw.slice(0, earliest);
}

function payloadAfterMarker(raw: string, marker: string): string | null {
  const start = raw.indexOf(marker);
  if (start === -1) return null;
  const after = raw.slice(start + marker.length);
  let end = after.length;
  for (const other of LINE_INTERNAL_MARKERS) {
    if (other === marker) continue;
    const index = after.indexOf(other);
    if (index !== -1 && index < end) end = index;
  }
  return after.slice(0, end);
}

function parseTakeoffSourceRef(raw: string | null): TakeoffSourceRef | null {
  const parsed = parseJsonObject(raw ?? "");
  if (!parsed) return null;
  const parentLineItemId =
    typeof parsed.parentLineItemId === "string" ? parsed.parentLineItemId.trim() : "";
  const itemId = typeof parsed.itemId === "string" ? parsed.itemId.trim() : "";
  if (!parentLineItemId || !itemId) return null;
  return { parentLineItemId, itemId };
}

function parseCalculatorSnapshot(raw: string): CalculatorSnapshot | null {
  if (!raw.trim()) return null;
  const parsed = parseJsonObject(raw);
  if (!parsed || !isCalculatorId(parsed.calculatorId)) {
    return null;
  }
  return {
    calculatorId: parsed.calculatorId,
    inputs:
      parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs)
        ? (parsed.inputs as Record<string, unknown>)
        : {},
    rates:
      parsed.rates && typeof parsed.rates === "object" && !Array.isArray(parsed.rates)
        ? (parsed.rates as Record<string, unknown>)
        : {},
    result:
      parsed.result && typeof parsed.result === "object"
        ? (parsed.result as CalculatorSnapshot["result"])
        : undefined,
    recommendedAmount:
      typeof parsed.recommendedAmount === "number" ? parsed.recommendedAmount : undefined,
    appliedAmount: typeof parsed.appliedAmount === "number" ? parsed.appliedAmount : undefined,
    overriddenAmount:
      parsed.overriddenAmount == null || typeof parsed.overriddenAmount === "number"
        ? (parsed.overriddenAmount as number | null | undefined)
        : undefined,
    ...calculatorComponentsField(parsed.calculatorId, parsed.components),
  };
}

function parseCalculatorDefinition(raw: string): CalculatorDefinition | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || !isCalculatorId(parsed.calculatorId)) {
    return null;
  }
  return {
    calculatorId: parsed.calculatorId,
    rates:
      parsed.rates && typeof parsed.rates === "object" && !Array.isArray(parsed.rates)
        ? (parsed.rates as Record<string, unknown>)
        : {},
    customerPolicies: normalizeCustomerPolicies(parsed.customerPolicies),
    ...calculatorComponentsField(parsed.calculatorId, parsed.components),
    ...calculatorIntakeField(parsed.intake),
  };
}

function serializeCalculatorSnapshot(snapshot: CalculatorSnapshot) {
  return JSON.stringify({
    calculatorId: snapshot.calculatorId,
    inputs: snapshot.inputs,
    rates: snapshot.rates,
    result: snapshot.result,
    recommendedAmount: snapshot.recommendedAmount,
    appliedAmount: snapshot.appliedAmount,
    overriddenAmount: snapshot.overriddenAmount ?? null,
    ...calculatorComponentsField(snapshot.calculatorId, snapshot.components),
  });
}

function serializeCalculatorDefinition(definition: CalculatorDefinition) {
  const customerPolicies = normalizeCustomerPolicies(definition.customerPolicies);
  return JSON.stringify({
    calculatorId: definition.calculatorId,
    rates: definition.rates,
    ...(customerPolicies.length > 0 ? { customerPolicies } : {}),
    ...calculatorComponentsField(definition.calculatorId, definition.components),
    ...calculatorIntakeField(definition.intake),
  });
}

function calculatorIntakeField(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const workArea = (raw as { workArea?: unknown }).workArea;
  if (workArea === true) return { intake: { workArea: true } };
  if (workArea === false) return { intake: { workArea: false } };
  return {};
}

function calculatorComponentsField(
  calculatorId: CalculatorSnapshot["calculatorId"],
  components: unknown,
) {
  if (calculatorId !== CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) return {};
  const normalized = normalizeVariableScopeComponents(
    Array.isArray(components) ? components : null,
  );
  return normalized.length > 0 ? { components: normalized } : {};
}

function parseCustomerPolicies(raw: string): CalculatorCustomerPolicy[] {
  if (!raw.trim()) return [];
  try {
    return normalizeCustomerPolicies(JSON.parse(raw.trim()));
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
