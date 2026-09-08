/**
 * Business estimating defaults for registered workspaces.
 *
 * Three layers:
 *   1. Permanent calculator DEFINITIONS — application registry
 *   2. Business estimating DEFAULTS — this module (per business + workspace)
 *   3. Project snapshot / overrides — estimate line descriptions
 *
 * Catalog rows and prior estimates are not the source of truth. Changing
 * a default must never rewrite SENT / APPROVED / job / invoice snapshots.
 *
 * This file is client-safe (no Prisma). Persistence lives in
 * estimating-defaults-db.ts.
 */
import {
  isEstimatingWorkspaceId,
  resolveEstimatingWorkspace,
  type EstimatingWorkspaceId,
} from "@/lib/estimate-calculators/estimating-registry";
import { persistableCalculatorRates } from "@/lib/estimate-calculators/registry";
import type { CalculatorId } from "@/lib/estimate-calculators/types";
import { isCalculatorId } from "@/lib/estimate-calculators/types";
import { computeTakeoff } from "@/lib/material-takeoff/engine";
import type { TakeoffItem, TakeoffSnapshot, TakeoffTypeId } from "@/lib/material-takeoff/types";
import { isTakeoffTypeId } from "@/lib/material-takeoff/types";
import { parseNonNegativeNumber, parsePositiveNumber } from "@/lib/material-takeoff/units";

export const BUSINESS_ESTIMATING_DEFAULT_VERSION = 1 as const;
export const BUSINESS_DEFAULT_SOURCE_LABEL = "Business default";

const PROJECT_TAKEOFF_INPUT_KEYS: Record<TakeoffTypeId, readonly string[]> = {
  "concrete-slab": [
    "lengthFt",
    "widthFt",
    "thicknessIn",
    "lengthFtPart",
    "lengthInPart",
    "widthFtPart",
    "widthInPart",
  ],
  "sheet-covering": [
    "wallWidthFt",
    "wallHeightFt",
    "wallWidthFtPart",
    "wallWidthInPart",
    "wallHeightFtPart",
    "wallHeightInPart",
    "slidingPatioDoors",
    "standardDoors",
    "windows",
  ],
  "framed-wall": [
    "wallLengthFt",
    "wallHeightFt",
    "wallLengthFtPart",
    "wallLengthInPart",
    "wallHeightFtPart",
    "wallHeightInPart",
    "openings",
  ],
  "generic-custom": ["laborQuantity"],
};

export type BusinessMaterialItemDefault = {
  id: string;
  kind: string;
  label?: string;
  unit?: string;
  selected?: boolean;
  unitCost: number | null;
  customerUnitPrice: number | null;
  defaultQuantity?: number | null;
};

export type BusinessEstimatingDefaultPayload = {
  version: 1;
  workspaceId: EstimatingWorkspaceId;
  labor: {
    laborRate?: number;
    calculatorId?: CalculatorId;
    rates?: Record<string, unknown>;
  };
  material: {
    takeoffType?: TakeoffTypeId;
    wastePercent?: number;
    markupPercent?: number;
    reusableInputs?: Record<string, unknown>;
    items?: BusinessMaterialItemDefault[];
  };
};

export type BusinessDefaultFieldSources = {
  laborRate: boolean;
  wastePercent: boolean;
  markupPercent: boolean;
  itemIds: string[];
  reusableInputKeys: string[];
};

export function parseBusinessEstimatingDefaultPayload(
  raw: unknown,
): BusinessEstimatingDefaultPayload | null {
  const parsed =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })()
      : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (!isEstimatingWorkspaceId(row.workspaceId)) return null;
  const laborRaw =
    row.labor && typeof row.labor === "object" && !Array.isArray(row.labor)
      ? (row.labor as Record<string, unknown>)
      : {};
  const materialRaw =
    row.material && typeof row.material === "object" && !Array.isArray(row.material)
      ? (row.material as Record<string, unknown>)
      : {};
  const calculatorId = isCalculatorId(laborRaw.calculatorId)
    ? laborRaw.calculatorId
    : undefined;
  const rates =
    calculatorId &&
    laborRaw.rates &&
    typeof laborRaw.rates === "object" &&
    !Array.isArray(laborRaw.rates)
      ? persistableCalculatorRates(
          calculatorId,
          laborRaw.rates as Record<string, unknown>,
        )
      : undefined;
  const items = Array.isArray(materialRaw.items)
    ? materialRaw.items.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const rec = item as Record<string, unknown>;
        if (typeof rec.id !== "string" || !rec.id.trim()) return [];
        const kind =
          typeof rec.kind === "string" && rec.kind.trim()
            ? rec.kind.trim()
            : rec.id.startsWith("custom:")
              ? "custom"
              : rec.id.trim();
        const defaultQuantity = parsePositiveNumber(rec.defaultQuantity);
        return [
          {
            id: rec.id.trim(),
            kind,
            ...(typeof rec.label === "string" && rec.label.trim()
              ? { label: rec.label.trim() }
              : {}),
            ...(typeof rec.unit === "string" && rec.unit.trim()
              ? { unit: rec.unit.trim() }
              : {}),
            ...(typeof rec.selected === "boolean" ? { selected: rec.selected } : {}),
            unitCost: parseNullableMoney(rec.unitCost),
            customerUnitPrice: parseNullableMoney(rec.customerUnitPrice),
            ...(defaultQuantity != null ? { defaultQuantity } : {}),
          },
        ];
      })
    : [];
  const takeoffType =
    materialRaw.takeoffType && isTakeoffTypeId(materialRaw.takeoffType)
      ? materialRaw.takeoffType
      : undefined;
  const reusableInputs =
    materialRaw.reusableInputs &&
    typeof materialRaw.reusableInputs === "object" &&
    !Array.isArray(materialRaw.reusableInputs)
      ? stripProjectTakeoffInputs(
          takeoffType ?? "generic-custom",
          materialRaw.reusableInputs as Record<string, unknown>,
        )
      : undefined;

  const laborRate = parsePositiveNumber(laborRaw.laborRate);
  const wastePercent = parseNonNegativeNumber(materialRaw.wastePercent);
  const markupPercent = parseNonNegativeNumber(materialRaw.markupPercent);

  return {
    version: 1,
    workspaceId: row.workspaceId,
    labor: {
      ...(laborRate != null ? { laborRate } : {}),
      ...(calculatorId ? { calculatorId } : {}),
      ...(rates ? { rates } : {}),
    },
    material: {
      ...(takeoffType ? { takeoffType } : {}),
      ...(wastePercent != null ? { wastePercent } : {}),
      ...(markupPercent != null ? { markupPercent } : {}),
      ...(reusableInputs && Object.keys(reusableInputs).length > 0
        ? { reusableInputs }
        : {}),
      ...(items.length > 0 ? { items } : {}),
    },
  };
}

export function extractReusableEstimatingDefaults(input: {
  workspaceId: EstimatingWorkspaceId;
  snapshot?: TakeoffSnapshot | null;
  calculatorId?: CalculatorId | null;
  calculatorRates?: Record<string, unknown> | null;
}): BusinessEstimatingDefaultPayload {
  const snapshot = input.snapshot ?? null;
  const takeoffType = snapshot?.takeoffType;
  const laborRate = snapshot ? parsePositiveNumber(snapshot.laborRate) : null;
  const items =
    snapshot?.items.flatMap((item) => {
      const saved = extractReusableMaterialItem(item);
      return saved ? [saved] : [];
    }) ?? [];
  const calculatorId =
    input.calculatorId && isCalculatorId(input.calculatorId)
      ? input.calculatorId
      : undefined;
  const rates =
    calculatorId && input.calculatorRates
      ? persistableCalculatorRates(calculatorId, input.calculatorRates)
      : undefined;
  const reusableInputs = snapshot
    ? stripProjectTakeoffInputs(snapshot.takeoffType, snapshot.inputs)
    : undefined;

  return {
    version: 1,
    workspaceId: input.workspaceId,
    labor: {
      ...(laborRate != null ? { laborRate } : {}),
      ...(calculatorId ? { calculatorId } : {}),
      ...(rates ? { rates } : {}),
    },
    material: {
      ...(takeoffType ? { takeoffType } : {}),
      ...(snapshot && parseNonNegativeNumber(snapshot.wastePercent) != null
        ? { wastePercent: snapshot.wastePercent }
        : {}),
      ...(snapshot && parseNonNegativeNumber(snapshot.markupPercent) != null
        ? { markupPercent: snapshot.markupPercent }
        : {}),
      ...(reusableInputs && Object.keys(reusableInputs).length > 0
        ? { reusableInputs }
        : {}),
      ...(items.length > 0 ? { items } : {}),
    },
  };
}

export function mergeEstimatingDefaultPayloads(
  base: BusinessEstimatingDefaultPayload | null,
  patch: BusinessEstimatingDefaultPayload,
): BusinessEstimatingDefaultPayload {
  const current = base ?? {
    version: 1 as const,
    workspaceId: patch.workspaceId,
    labor: {},
    material: {},
  };
  const itemMap = new Map(
    (current.material.items ?? []).map((item) => [item.id, item]),
  );
  const patchItems = patch.material.items ?? [];
  const patchCustomIds = new Set(
    patchItems.filter((item) => isReusableCustomItem(item)).map((item) => item.id),
  );
  if (patch.material.items) {
    for (const [id, item] of [...itemMap.entries()]) {
      if (isReusableCustomItem(item) && !patchCustomIds.has(id)) {
        itemMap.delete(id);
      }
    }
  }
  for (const item of patchItems) {
    itemMap.set(item.id, item);
  }
  return {
    version: 1,
    workspaceId: patch.workspaceId,
    labor: {
      ...current.labor,
      ...patch.labor,
      rates: patch.labor.rates ?? current.labor.rates,
    },
    material: {
      ...current.material,
      ...patch.material,
      reusableInputs: {
        ...(current.material.reusableInputs ?? {}),
        ...(patch.material.reusableInputs ?? {}),
      },
      items: [...itemMap.values()],
    },
  };
}

/**
 * Apply reusable business defaults onto a project takeoff snapshot.
 * Never copies labor add-ons, quantity overrides, rounded job totals,
 * or project measurements that are already set.
 *
 * mode "seed": new estimate — reusable include flags and prices fill in,
 *              project dimensions still win.
 * mode "overlay": existing draft — project inputs/prices/add-ons win;
 *                 fill only missing prices and missing reusable custom items.
 */
export function applyBusinessEstimatingDefaults(
  snapshot: TakeoffSnapshot,
  defaults: BusinessEstimatingDefaultPayload | null,
  options?: { mode?: "seed" | "overlay" },
): TakeoffSnapshot {
  if (!defaults) return snapshot;
  const mode = options?.mode ?? "seed";
  const takeoffType = snapshot.takeoffType;
  const mergedInputs =
    mode === "overlay"
      ? { ...(defaults.material.reusableInputs ?? {}), ...snapshot.inputs }
      : {
          ...snapshot.inputs,
          ...(defaults.material.reusableInputs ?? {}),
          ...keepProjectTakeoffInputs(takeoffType, snapshot.inputs),
        };
  const computed = computeTakeoff({
    takeoffType,
    inputs: mergedInputs,
    wastePercent:
      mode === "overlay"
        ? snapshot.wastePercent
        : (defaults.material.wastePercent ?? snapshot.wastePercent),
    measurementSource: snapshot.measurementSource,
    skippedMeasurements: snapshot.skippedMeasurements,
    previous: {
      ...snapshot,
      inputs: mergedInputs,
      markupPercent:
        mode === "overlay"
          ? snapshot.markupPercent
          : (defaults.material.markupPercent ?? snapshot.markupPercent),
      laborRate:
        mode === "overlay"
          ? snapshot.laborRate
          : (defaults.labor.laborRate ?? snapshot.laborRate),
      laborAdjustment: snapshot.laborAdjustment,
    },
  }).snapshot;

  const savedItems = defaults.material.items ?? [];
  const savedById = new Map(savedItems.map((item) => [item.id, item]));
  const formulaItems = computed.items.map((item) => {
    if (item.kind === "custom") return item;
    const saved = savedById.get(item.id);
    if (!saved) return item;
    return {
      ...item,
      selected: mode === "overlay" ? item.selected : (saved.selected ?? item.selected),
      unitCost: item.unitCost ?? saved.unitCost,
      customerUnitPrice: item.customerUnitPrice ?? saved.customerUnitPrice,
      quantityOverride: item.quantityOverride,
    };
  });
  const customItems = savedItems
    .filter((item) => isReusableCustomItem(item))
    .flatMap((saved) => {
      if (formulaItems.some((item) => customItemMatchesSaved(item, saved))) {
        return [];
      }
      return [reusableCustomTakeoffItem(saved)];
    });

  return {
    ...computed,
    inputs: mergedInputs,
    wastePercent:
      mode === "overlay"
        ? snapshot.wastePercent
        : (defaults.material.wastePercent ?? computed.wastePercent),
    markupPercent:
      mode === "overlay"
        ? snapshot.markupPercent
        : (defaults.material.markupPercent ?? computed.markupPercent),
    laborRate:
      mode === "overlay"
        ? snapshot.laborRate
        : (defaults.labor.laborRate ?? snapshot.laborRate ?? computed.laborRate),
    laborAdjustment: snapshot.laborAdjustment,
    items: [
      ...formulaItems.map((item) => {
        if (item.kind !== "custom") return item;
        const saved =
          savedById.get(item.id) ??
          savedItems.find((candidate) => customItemMatchesSaved(item, candidate));
        if (!saved) return item;
        return {
          ...item,
          unitCost: item.unitCost ?? saved.unitCost,
          customerUnitPrice: item.customerUnitPrice ?? saved.customerUnitPrice,
          persistAs: "business-default" as const,
        };
      }),
      ...customItems,
    ],
  };
}

export function startingTakeoffDraftWithDefaults(input: {
  snapshot?: TakeoffSnapshot | null;
  takeoffType: TakeoffTypeId;
  suggestedInputs?: Record<string, unknown> | null;
  measurementSource?: TakeoffSnapshot["measurementSource"];
  skippedMeasurements?: string[];
  businessDefaults?: BusinessEstimatingDefaultPayload | null;
}): TakeoffSnapshot {
  if (input.snapshot) return input.snapshot;
  const computed = computeTakeoff({
    takeoffType: input.takeoffType,
    inputs: input.suggestedInputs,
    measurementSource: input.measurementSource,
    skippedMeasurements: input.skippedMeasurements,
  }).snapshot;
  return applyBusinessEstimatingDefaults(computed, input.businessDefaults ?? null, {
    mode: "seed",
  });
}

export function businessDefaultFieldSources(
  snapshot: TakeoffSnapshot,
  defaults: BusinessEstimatingDefaultPayload | null,
): BusinessDefaultFieldSources {
  if (!defaults) {
    return {
      laborRate: false,
      wastePercent: false,
      markupPercent: false,
      itemIds: [],
      reusableInputKeys: [],
    };
  }
  const laborRate =
    defaults.labor.laborRate != null &&
    (snapshot.laborRate === defaults.labor.laborRate ||
      (snapshot.laborRate === 0 && defaults.labor.laborRate > 0));
  const wastePercent =
    defaults.material.wastePercent != null &&
    snapshot.wastePercent === defaults.material.wastePercent;
  const markupPercent =
    defaults.material.markupPercent != null &&
    snapshot.markupPercent === defaults.material.markupPercent;
  const prices = new Map(
    (defaults.material.items ?? []).map((item) => [item.id, item]),
  );
  const itemIds = snapshot.items
    .filter((item) => {
      const saved = prices.get(item.id);
      if (!saved) return false;
      return (
        (saved.unitCost != null && saved.unitCost === item.unitCost) ||
        (saved.customerUnitPrice != null &&
          saved.customerUnitPrice === item.customerUnitPrice)
      );
    })
    .map((item) => item.id);
  const reusableInputKeys = Object.entries(defaults.material.reusableInputs ?? {})
    .filter(([key, value]) => snapshot.inputs[key] === value)
    .map(([key]) => key);
  return { laborRate, wastePercent, markupPercent, itemIds, reusableInputKeys };
}

export function resolveWorkspaceIdForTakeoff(input: {
  workspaceId?: string | null;
  snapshot?: TakeoffSnapshot | null;
  calculatorId?: CalculatorId | null;
  title?: string | null;
}): EstimatingWorkspaceId | null {
  if (input.workspaceId && isEstimatingWorkspaceId(input.workspaceId)) {
    return input.workspaceId;
  }
  return (
    resolveEstimatingWorkspace({
      takeoffType: input.snapshot?.takeoffType,
      calculatorId: input.calculatorId,
      title: input.title,
      customQuote: true,
    })?.id ?? null
  );
}

export function describeSavedBusinessDefaults(
  payload: BusinessEstimatingDefaultPayload,
) {
  const items = payload.material.items ?? [];
  const customCount = items.filter((item) => isReusableCustomItem(item)).length;
  const standardPriced = items.filter(
    (item) =>
      !isReusableCustomItem(item) &&
      (item.unitCost != null || item.customerUnitPrice != null),
  ).length;
  const parts: string[] = [];
  if (payload.labor.laborRate != null) parts.push("labor rate");
  if (payload.material.wastePercent != null) parts.push("waste");
  if (payload.material.markupPercent != null) parts.push("markup");
  if (payload.material.reusableInputs?.bagYieldCuFt != null) parts.push("bag yield");
  if (standardPriced > 0) parts.push("standard material prices");
  if (customCount > 0) {
    parts.push(
      `${customCount} reusable custom material${customCount === 1 ? "" : "s"}`,
    );
  }
  const workspace =
    payload.workspaceId === "concrete-slab"
      ? "Concrete Slab"
      : payload.workspaceId.replace(/-/g, " ");
  const detail =
    parts.length === 0
      ? "reusable calculator pricing"
      : parts.length === 1
        ? parts[0]
        : parts.length === 2
          ? `${parts[0]} and ${parts[1]}`
          : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `Business defaults saved — ${detail} will be used as starting values on future ${workspace} estimates.`;
}

export function reusableCustomMaterialId(label: string, unit: string) {
  return `custom:${slugToken(label)}:${slugToken(unit) || "ea"}`;
}

export function isReusableCustomItem(item: { id: string; kind?: string }) {
  return item.kind === "custom" || item.id.startsWith("custom:");
}

function extractReusableMaterialItem(item: TakeoffItem): BusinessMaterialItemDefault | null {
  if (item.kind === "custom") {
    if (item.persistAs !== "business-default") return null;
    const label = item.label.trim();
    if (!label) return null;
    const unit = item.unit.trim() || "ea";
    return {
      id: reusableCustomMaterialId(label, unit),
      kind: "custom",
      label,
      unit,
      selected: item.selected,
      unitCost: parseNullableMoney(item.unitCost),
      customerUnitPrice: parseNullableMoney(item.customerUnitPrice),
    };
  }
  if (item.unitCost == null && item.customerUnitPrice == null) return null;
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    unit: item.unit,
    selected: item.selected,
    unitCost: parseNullableMoney(item.unitCost),
    customerUnitPrice: parseNullableMoney(item.customerUnitPrice),
  };
}

function reusableCustomTakeoffItem(saved: BusinessMaterialItemDefault): TakeoffItem {
  return {
    id: saved.id,
    kind: "custom",
    label: saved.label?.trim() || saved.id,
    unit: saved.unit?.trim() || "ea",
    optional: true,
    selected: saved.selected !== false,
    calculatedQuantity: 1,
    quantityOverride: null,
    unitCost: saved.unitCost,
    customerUnitPrice: saved.customerUnitPrice,
    explanation: "Reusable business-default material for this calculator.",
    convertedLineItemId: null,
    persistAs: "business-default",
  };
}

function customItemMatchesSaved(
  item: TakeoffItem,
  saved: BusinessMaterialItemDefault,
) {
  if (item.kind !== "custom" && !isReusableCustomItem(item)) return false;
  if (item.id === saved.id) return true;
  return reusableCustomMaterialId(item.label, item.unit) === saved.id;
}

function slugToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

export function stripProjectTakeoffInputs(
  takeoffType: TakeoffTypeId,
  inputs: Record<string, unknown>,
) {
  const project = new Set(PROJECT_TAKEOFF_INPUT_KEYS[takeoffType] ?? []);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (project.has(key)) continue;
    next[key] = value;
  }
  return next;
}

function keepProjectTakeoffInputs(
  takeoffType: TakeoffTypeId,
  inputs: Record<string, unknown>,
) {
  const project = new Set(PROJECT_TAKEOFF_INPUT_KEYS[takeoffType] ?? []);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (project.has(key)) next[key] = value;
  }
  return next;
}

function parseNullableMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = parseNonNegativeNumber(value);
  return parsed == null ? null : parsed;
}
