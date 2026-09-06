/**
 * Scope / Included Work and internal calculator snapshots on estimate lines.
 *
 * Preview shares the Production database and does not run migrations, so
 * neither scope nor calculator data can live in a new Prisma column.
 * Both are encoded in the existing LineItem / EstimateVersionLineItem
 * `description` after stable markers. Totals never read them.
 */
import {
  isCalculatorId,
  type CalculatorDefinition,
  type CalculatorSnapshot,
} from "@/lib/estimate-calculators/types";

export const MAX_INCLUDED_WORK_LENGTH = 8000;
export const INCLUDED_WORK_MARKER = "\n\nScope / Included Work:\n";
export const CALCULATOR_SNAPSHOT_MARKER = "\n\nTBBT Calculator Snapshot:\n";
export const CALCULATOR_DEFINITION_MARKER = "\n\nTBBT Calculator Definition:\n";

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
} {
  const raw = description ?? "";
  const snapshotIndex = raw.indexOf(CALCULATOR_SNAPSHOT_MARKER);
  const withoutSnapshot = snapshotIndex === -1 ? raw : raw.slice(0, snapshotIndex);
  const calculatorSnapshot =
    snapshotIndex === -1
      ? null
      : parseCalculatorSnapshot(
          raw.slice(snapshotIndex + CALCULATOR_SNAPSHOT_MARKER.length),
        );
  const index = withoutSnapshot.indexOf(INCLUDED_WORK_MARKER);
  if (index === -1) {
    return {
      title: withoutSnapshot,
      includedWork: null,
      calculatorSnapshot,
    };
  }
  return {
    title: withoutSnapshot.slice(0, index),
    includedWork: normalizeIncludedWork(
      withoutSnapshot.slice(index + INCLUDED_WORK_MARKER.length),
    ),
    calculatorSnapshot,
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

export function joinLineDescription(
  title: string,
  includedWork?: string | null,
  calculatorSnapshot?: CalculatorSnapshot | null,
): string {
  const cleanTitle = splitLineDescription(title).title;
  const scope = normalizeIncludedWork(includedWork);
  const snapshot = calculatorSnapshot
    ? serializeCalculatorSnapshot(calculatorSnapshot)
    : null;
  let next = cleanTitle;
  if (scope) {
    next = `${next}${INCLUDED_WORK_MARKER}${scope}`;
  }
  if (snapshot) {
    next = `${next}${CALCULATOR_SNAPSHOT_MARKER}${snapshot}`;
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
  const snapshotIndex = raw.indexOf(CALCULATOR_SNAPSHOT_MARKER);
  const withoutSnapshot = snapshotIndex === -1 ? raw : raw.slice(0, snapshotIndex);
  const definitionIndex = withoutSnapshot.indexOf(CALCULATOR_DEFINITION_MARKER);
  return definitionIndex === -1
    ? withoutSnapshot
    : withoutSnapshot.slice(0, definitionIndex);
}

function parseCalculatorSnapshot(raw: string): CalculatorSnapshot | null {
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
  });
}

function serializeCalculatorDefinition(definition: CalculatorDefinition) {
  return JSON.stringify({
    calculatorId: definition.calculatorId,
    rates: definition.rates,
  });
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
