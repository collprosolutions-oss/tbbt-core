import {
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  computeDecorativeWallPaneling,
  emptyDecorativeWallPanelingInputs,
  normalizeDecorativeWallPanelingInputs,
  normalizeDecorativeWallPanelingRates,
} from "@/lib/estimate-calculators/decorative-wall-paneling";
import { DECORATIVE_WALL_PANELING_TEMPLATE } from "@/lib/estimate-calculators/decorative-wall-paneling-template";
import {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  isCalculatorId,
  type CalculatorDefinition,
  type CalculatorId,
  type CalculatorResult,
  type CalculatorSnapshot,
} from "@/lib/estimate-calculators/types";
import {
  computeVariableScope,
  defaultVariableScopeRates,
  emptyVariableScopeInputs,
  jobQuantityKeysFromTemplate,
  normalizeVariableScopeComponents,
  normalizeVariableScopeTemplate,
  persistableVariableScopeRates,
  type VariableScopeComponent,
  type VariableScopeTemplate,
} from "@/lib/estimate-calculators/variable-scope";
import { catalogCalculatorDefinition } from "@/lib/estimate-line-scope";
import { pickWorkAreaCalculatorInputs } from "@/lib/work-area-intake";

const TITLE_ALIASES: Partial<Record<CalculatorId, string[]>> = {
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

export function templateForCalculator(
  calculatorId: CalculatorId,
  components?: unknown[] | null,
): VariableScopeTemplate | null {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return DECORATIVE_WALL_PANELING_TEMPLATE;
  }
  if (calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) {
    return normalizeVariableScopeTemplate({
      calculatorId,
      title: "Custom Work",
      components,
    });
  }
  return null;
}

export function defaultCalculatorRates(
  calculatorId: CalculatorId,
  components?: unknown[] | null,
) {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return { ...DEFAULT_DECORATIVE_WALL_PANELING_RATES };
  }
  const template = templateForCalculator(calculatorId, components);
  return template ? defaultVariableScopeRates(template) : {};
}

export function emptyCalculatorInputs(
  calculatorId: CalculatorId,
  rates?: Record<string, unknown>,
  components?: unknown[] | null,
) {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return emptyDecorativeWallPanelingInputs(
      normalizeDecorativeWallPanelingRates(rates),
    );
  }
  const template = templateForCalculator(calculatorId, components);
  return template ? emptyVariableScopeInputs(template) : {};
}

export function computeCalculator(
  calculatorId: CalculatorId,
  inputs?: Record<string, unknown> | null,
  rates?: Record<string, unknown> | null,
  components?: unknown[] | null,
): CalculatorResult {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return computeDecorativeWallPaneling(inputs, rates);
  }
  const template = templateForCalculator(calculatorId, components);
  if (template) {
    return computeVariableScope(template, inputs, rates);
  }
  return { recommendedAmount: 0, lines: [] };
}

export function normalizeCalculatorSnapshot(
  snapshot: CalculatorSnapshot,
): CalculatorSnapshot {
  const calculatorId = snapshot.calculatorId;
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    const rates = normalizeDecorativeWallPanelingRates(snapshot.rates);
    return {
      ...snapshot,
      calculatorId,
      rates,
      inputs: normalizeDecorativeWallPanelingInputs(snapshot.inputs, rates),
    };
  }
  const template = templateForCalculator(calculatorId, snapshot.components);
  if (!template) {
    return { ...snapshot, calculatorId };
  }
  return {
    ...snapshot,
    calculatorId,
    rates: persistableVariableScopeRates(template, snapshot.rates, snapshot.inputs),
    inputs: {
      ...emptyVariableScopeInputs(template),
      ...(snapshot.inputs && typeof snapshot.inputs === "object"
        ? snapshot.inputs
        : {}),
    },
    components: template.components,
  };
}

export const JOB_SPECIFIC_CALCULATOR_INPUT_KEYS = [
  "wallWidthFt",
  "wallHeightFt",
  "removalType",
  "panelQuantity",
  "slidingPatioDoors",
  "standardDoors",
  "windows",
  "receptacles",
  "switches",
  "lightFixtures",
  "contentsHandlingLevel",
  "contentsHandlingCustomAmount",
  "contentsProtectionLevel",
  "contentsProtectionCustomAmount",
  "belongingsCleanupLevel",
  "belongingsCleanupCustomAmount",
  "notes",
] as const;

export function calculatorTitle(calculatorId: CalculatorId) {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    return DECORATIVE_WALL_PANELING_TITLE;
  }
  if (calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) {
    return "Custom Work";
  }
  return calculatorId;
}

export function persistableCalculatorRates(
  calculatorId: CalculatorId,
  rates?: Record<string, unknown> | null,
  inputs?: Record<string, unknown> | null,
  components?: unknown[] | null,
): Record<string, unknown> {
  if (calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID) {
    const normalized = normalizeDecorativeWallPanelingRates(rates);
    const job = normalizeDecorativeWallPanelingInputs(inputs ?? undefined, normalized);
    return {
      panelRate: normalized.panelRate,
      removalRatePerSqFt: normalized.removalRatePerSqFt,
      slidingPatioDoorRate: normalized.slidingPatioDoorRate,
      standardDoorRate: normalized.standardDoorRate,
      windowRate: normalized.windowRate,
      receptacleRate: normalized.receptacleRate,
      switchRate: normalized.switchRate,
      lightFixtureRate: normalized.lightFixtureRate,
      defaultTrimAllowance: job.trimAllowance,
      defaultCleanupAllowance: job.cleanupAllowance,
      contentsHandlingLightRate: normalized.contentsHandlingLightRate,
      contentsHandlingModerateRate: normalized.contentsHandlingModerateRate,
      contentsHandlingHeavyRate: normalized.contentsHandlingHeavyRate,
      contentsProtectionLightRate: normalized.contentsProtectionLightRate,
      contentsProtectionModerateRate: normalized.contentsProtectionModerateRate,
      contentsProtectionHeavyRate: normalized.contentsProtectionHeavyRate,
      belongingsCleanupLightRate: normalized.belongingsCleanupLightRate,
      belongingsCleanupModerateRate: normalized.belongingsCleanupModerateRate,
      belongingsCleanupHeavyRate: normalized.belongingsCleanupHeavyRate,
    };
  }
  const template = templateForCalculator(calculatorId, components);
  return template
    ? persistableVariableScopeRates(template, rates, inputs)
    : { ...(rates ?? {}) };
}

export function calculatorRatesEqual(
  left?: Record<string, unknown> | null,
  right?: Record<string, unknown> | null,
) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

export function definitionOmitsJobQuantities(
  definition: CalculatorDefinition | null | undefined,
) {
  if (!definition) return true;
  const maybeInputs = (definition as { inputs?: unknown }).inputs;
  if (maybeInputs && typeof maybeInputs === "object") {
    return false;
  }
  const template = templateForCalculator(
    definition.calculatorId,
    definition.components,
  );
  const quantityKeys = new Set<string>([
    ...JOB_SPECIFIC_CALCULATOR_INPUT_KEYS,
    ...(template ? jobQuantityKeysFromTemplate(template) : []),
  ]);
  const rates = definition.rates ?? {};
  if ([...quantityKeys].some((key) => Object.hasOwn(rates, key))) {
    return false;
  }
  if (definition.calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) {
    return true;
  }
  const encoded = JSON.stringify({
    calculatorId: definition.calculatorId,
    rates: definition.rates,
  });
  return JOB_SPECIFIC_CALCULATOR_INPUT_KEYS.every(
    (key) => !encoded.includes(`"${key}"`),
  );
}

export function catalogDefinitionFromSnapshot(
  snapshot: CalculatorSnapshot | null,
  title?: string | null,
): CalculatorDefinition | null {
  const calculatorId = resolveCalculatorId({ title, snapshot });
  if (!calculatorId) return null;
  const components = persistableCalculatorComponents(calculatorId, snapshot?.components);
  const template = templateForCalculator(calculatorId, components);
  return {
    calculatorId,
    rates: persistableCalculatorRates(
      calculatorId,
      snapshot?.rates ?? defaultCalculatorRates(calculatorId, components),
      snapshot?.inputs,
      components,
    ),
    ...(components ? { components } : {}),
    ...(template?.intake ? { intake: template.intake } : {}),
  };
}

export function persistableCalculatorComponents(
  calculatorId: CalculatorId,
  components?: unknown[] | null,
): VariableScopeComponent[] | undefined {
  if (calculatorId !== CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID) return undefined;
  const normalized = normalizeVariableScopeComponents(components);
  return normalized.length > 0 ? normalized : undefined;
}

export function findCatalogCalculatorDefinition(
  items: Array<{
    id?: string | null;
    name?: string | null;
    description?: string | null;
  }>,
  input: {
    calculatorId?: CalculatorId | null;
    catalogItemId?: string | null;
    title?: string | null;
  },
): CalculatorDefinition | null {
  const calculatorId =
    input.calculatorId ??
    resolveCalculatorId({
      title: input.title,
      definition: input.catalogItemId
        ? catalogCalculatorDefinition(
            items.find((item) => item.id === input.catalogItemId)?.description,
          )
        : null,
    });
  if (!calculatorId) return null;

  if (input.catalogItemId) {
    const linked = items.find((item) => item.id === input.catalogItemId);
    const definition = catalogCalculatorDefinition(linked?.description);
    if (definition?.calculatorId === calculatorId) return definition;
  }

  const title = input.title?.trim().toLowerCase();
  if (title) {
    const named = items.find((item) => item.name?.trim().toLowerCase() === title);
    const definition = catalogCalculatorDefinition(named?.description);
    if (definition?.calculatorId === calculatorId) return definition;
  }

  const canonical = calculatorTitle(calculatorId).toLowerCase();
  const namedCanonical = items.find(
    (item) => item.name?.trim().toLowerCase() === canonical,
  );
  const namedDefinition = catalogCalculatorDefinition(namedCanonical?.description);
  if (namedDefinition?.calculatorId === calculatorId) return namedDefinition;

  for (const item of items) {
    const definition = catalogCalculatorDefinition(item.description);
    if (definition?.calculatorId === calculatorId) return definition;
  }
  return null;
}

export function resolveCalculatorRatesForForm(input: {
  calculatorId: CalculatorId;
  snapshot?: CalculatorSnapshot | null;
  businessRates?: Record<string, unknown> | null;
  components?: unknown[] | null;
}) {
  const components = input.components ?? input.snapshot?.components;
  const applied =
    input.snapshot?.appliedAmount != null ||
    input.snapshot?.recommendedAmount != null;
  if (applied) {
    return persistableCalculatorRates(
      input.calculatorId,
      input.snapshot?.rates,
      input.snapshot?.inputs,
      components,
    );
  }
  return persistableCalculatorRates(
    input.calculatorId,
    input.businessRates ??
      input.snapshot?.rates ??
      defaultCalculatorRates(input.calculatorId, components),
    undefined,
    components,
  );
}

export function calculatorSnapshotIsApplied(snapshot?: CalculatorSnapshot | null) {
  return snapshot?.appliedAmount != null || snapshot?.recommendedAmount != null;
}

/**
 * Copy positive numeric job quantities from a source onto calculator
 * keys that already exist. Used so stored intake measurements can prefill
 * width/height/length fields without inventing new calculator inputs.
 */
export function pickPositiveNumericCalculatorInputs(
  source?: Record<string, unknown> | null,
  allowedKeys?: string[],
) {
  const next: Record<string, number> = {};
  if (!source) return next;
  const keys = allowedKeys ?? Object.keys(source);
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = source[key];
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : NaN;
    if (Number.isFinite(n) && n > 0) next[key] = n;
  }
  return next;
}

export function startingCalculatorSnapshot(input: {
  title?: string | null;
  definition?: CalculatorDefinition | null;
  snapshot?: CalculatorSnapshot | null;
  prefillInputs?: Record<string, unknown> | null;
}): CalculatorSnapshot | null {
  const calculatorId = resolveCalculatorId(input);
  if (!calculatorId) return null;
  const components = persistableCalculatorComponents(
    calculatorId,
    input.definition?.components ?? input.snapshot?.components,
  );
  const rates = persistableCalculatorRates(
    calculatorId,
    input.definition?.rates ??
      input.snapshot?.rates ??
      defaultCalculatorRates(calculatorId, components),
    undefined,
    components,
  );
  const empty = emptyCalculatorInputs(calculatorId, rates, components);
  const allowedKeys = Object.keys(empty);
  return {
    calculatorId,
    rates,
    inputs: {
      ...empty,
      ...pickPositiveNumericCalculatorInputs(input.prefillInputs, allowedKeys),
      ...pickPositiveNumericCalculatorInputs(input.snapshot?.inputs, allowedKeys),
      ...pickWorkAreaCalculatorInputs(input.prefillInputs ?? input.snapshot?.inputs),
    },
    ...(components ? { components } : {}),
  };
}

export function formCalculatorInputs(input: {
  calculatorId: CalculatorId;
  snapshot?: CalculatorSnapshot | null;
  rates?: Record<string, unknown> | null;
  components?: unknown[] | null;
}) {
  const empty = emptyCalculatorInputs(
    input.calculatorId,
    input.rates ?? undefined,
    input.components,
  );
  if (calculatorSnapshotIsApplied(input.snapshot)) {
    return input.snapshot?.inputs ?? empty;
  }
  return {
    ...empty,
    ...pickPositiveNumericCalculatorInputs(input.snapshot?.inputs, Object.keys(empty)),
    ...pickWorkAreaCalculatorInputs(input.snapshot?.inputs),
  };
}
