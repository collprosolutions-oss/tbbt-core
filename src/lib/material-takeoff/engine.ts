/**
 * Trade-aware material takeoff engine.
 *
 * Recalculation preserves owner quantity, internal unit cost,
 * customer unit price, selection, and conversion ids. New formulas
 * register in TAKEOFF_FORMULAS without changing snapshot storage or
 * MATERIAL conversion.
 */
import { computeConcreteSlabTakeoff } from "@/lib/material-takeoff/formulas/concrete-slab";
import { computeFramedWallTakeoff } from "@/lib/material-takeoff/formulas/framed-wall";
import { computeSheetCoveringTakeoff } from "@/lib/material-takeoff/formulas/sheet-covering";
import {
  isTakeoffTypeId,
  type TakeoffItem,
  type TakeoffSnapshot,
  type TakeoffTypeId,
} from "@/lib/material-takeoff/types";
import { parseNonNegativeNumber, parsePositiveNumber } from "@/lib/material-takeoff/units";

const TAKEOFF_FORMULAS: Record<
  TakeoffTypeId,
  (input: {
    inputs?: Record<string, unknown> | null;
    wastePercent?: number;
    measurementSource?: TakeoffSnapshot["measurementSource"];
    skippedMeasurements?: string[];
  }) => { snapshot: TakeoffSnapshot; rejected: string | null }
> = {
  "concrete-slab": computeConcreteSlabTakeoff,
  "sheet-covering": computeSheetCoveringTakeoff,
  "framed-wall": computeFramedWallTakeoff,
};

export function computeTakeoff(input: {
  takeoffType: TakeoffTypeId;
  inputs?: Record<string, unknown> | null;
  wastePercent?: number;
  measurementSource?: TakeoffSnapshot["measurementSource"];
  skippedMeasurements?: string[];
  previous?: TakeoffSnapshot | null;
}): { snapshot: TakeoffSnapshot; rejected: string | null } {
  const formula = TAKEOFF_FORMULAS[input.takeoffType];
  const computed = formula({
    inputs: input.inputs,
    wastePercent: input.wastePercent,
    measurementSource: input.measurementSource ?? input.previous?.measurementSource,
    skippedMeasurements:
      input.skippedMeasurements ?? input.previous?.skippedMeasurements,
  });
  if (computed.rejected) {
    return {
      rejected: computed.rejected,
      snapshot: mergeTakeoffSnapshots(computed.snapshot, input.previous),
    };
  }
  return {
    rejected: null,
    snapshot: mergeTakeoffSnapshots(computed.snapshot, input.previous),
  };
}

export function mergeTakeoffSnapshots(
  calculated: TakeoffSnapshot,
  previous?: TakeoffSnapshot | null,
): TakeoffSnapshot {
  if (!previous || previous.takeoffType !== calculated.takeoffType) {
    return {
      ...calculated,
      removedItemIds: [],
    };
  }
  const removed = new Set(previous.removedItemIds ?? []);
  const prevById = new Map(previous.items.map((item) => [item.id, item]));
  const formulaItems = calculated.items
    .filter((item) => !removed.has(item.id))
    .map((item) => preserveOwnerOverrides(item, prevById.get(item.id)));
  const formulaIds = new Set(calculated.items.map((item) => item.id));
  const customItems = previous.items.filter(
    (item) => item.kind === "custom" && !removed.has(item.id),
  );
  const convertedOrphans = previous.items.filter(
    (item) =>
      item.convertedLineItemId &&
      !formulaIds.has(item.id) &&
      item.kind !== "custom" &&
      !removed.has(item.id),
  );
  return {
    ...calculated,
    wastePercent: previous.wastePercent === calculated.wastePercent
      ? calculated.wastePercent
      : calculated.wastePercent,
    removedItemIds: [...removed],
    items: [...formulaItems, ...customItems, ...convertedOrphans],
  };
}

function preserveOwnerOverrides(next: TakeoffItem, previous?: TakeoffItem): TakeoffItem {
  if (!previous) return next;
  return {
    ...next,
    selected: previous.selected,
    quantityOverride: previous.quantityOverride,
    unitCost: previous.unitCost,
    customerUnitPrice: previous.customerUnitPrice,
    convertedLineItemId: previous.convertedLineItemId,
    label: previous.kind === "custom" ? previous.label : next.label,
  };
}

export function applyTakeoffItemEdits(
  snapshot: TakeoffSnapshot,
  edits: Array<{
    id: string;
    selected?: boolean;
    quantityOverride?: number | null;
    unitCost?: number | null;
    customerUnitPrice?: number | null;
    label?: string;
    remove?: boolean;
  }>,
): TakeoffSnapshot {
  const removed = new Set(snapshot.removedItemIds);
  let items = snapshot.items;
  for (const edit of edits) {
    if (edit.remove) {
      removed.add(edit.id);
      items = items.filter((item) => item.id !== edit.id);
      continue;
    }
    items = items.map((item) => {
      if (item.id !== edit.id) return item;
      return {
        ...item,
        selected: edit.selected ?? item.selected,
        quantityOverride:
          edit.quantityOverride === undefined
            ? item.quantityOverride
            : edit.quantityOverride,
        unitCost: edit.unitCost === undefined ? item.unitCost : edit.unitCost,
        customerUnitPrice:
          edit.customerUnitPrice === undefined
            ? item.customerUnitPrice
            : edit.customerUnitPrice,
        label: edit.label?.trim() ? edit.label.trim() : item.label,
      };
    });
  }
  return { ...snapshot, removedItemIds: [...removed], items };
}

export function addCustomTakeoffItem(
  snapshot: TakeoffSnapshot,
  input: {
    label: string;
    unit: string;
    quantity: number;
    unitCost?: number | null;
    customerUnitPrice?: number | null;
  },
): TakeoffSnapshot {
  const label = input.label.trim();
  if (!label) return snapshot;
  const quantity = parsePositiveNumber(input.quantity) ?? 0;
  const item: TakeoffItem = {
    id: `custom-${globalThis.crypto.randomUUID()}`,
    kind: "custom",
    label,
    unit: input.unit.trim() || "ea",
    optional: true,
    selected: true,
    calculatedQuantity: quantity,
    quantityOverride: quantity,
    unitCost: parseNonNegativeNumber(input.unitCost) ?? null,
    customerUnitPrice: parseNonNegativeNumber(input.customerUnitPrice) ?? null,
    explanation: "Owner-added takeoff item.",
    convertedLineItemId: null,
  };
  return { ...snapshot, items: [...snapshot.items, item] };
}

export function normalizeTakeoffSnapshot(raw: unknown): TakeoffSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Record<string, unknown>;
  if (!isTakeoffTypeId(parsed.takeoffType)) return null;
  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => {
        const normalized = normalizeTakeoffItem(item);
        return normalized ? [normalized] : [];
      })
    : [];
  const inputs =
    parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs)
      ? (parsed.inputs as Record<string, unknown>)
      : {};
  return {
    version: 1,
    takeoffType: parsed.takeoffType,
    inputs,
    wastePercent: parseNonNegativeNumber(parsed.wastePercent) ?? 0,
    measurementSource: normalizeMeasurementSource(parsed.measurementSource),
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    skippedMeasurements: Array.isArray(parsed.skippedMeasurements)
      ? parsed.skippedMeasurements.filter((value): value is string => typeof value === "string")
      : [],
    removedItemIds: Array.isArray(parsed.removedItemIds)
      ? parsed.removedItemIds.filter((value): value is string => typeof value === "string")
      : [],
    items,
  };
}

function normalizeTakeoffItem(raw: unknown): TakeoffItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Record<string, unknown>;
  if (typeof parsed.id !== "string" || !parsed.id.trim()) return null;
  if (typeof parsed.label !== "string" || !parsed.label.trim()) return null;
  const calculatedQuantity = parseNonNegativeNumber(parsed.calculatedQuantity) ?? 0;
  return {
    id: parsed.id,
    kind: typeof parsed.kind === "string" && parsed.kind.trim() ? parsed.kind : "custom",
    label: parsed.label.trim(),
    unit: typeof parsed.unit === "string" && parsed.unit.trim() ? parsed.unit : "ea",
    optional: parsed.optional === true,
    selected: parsed.selected !== false,
    calculatedQuantity,
    quantityOverride:
      parsed.quantityOverride == null
        ? null
        : parseNonNegativeNumber(parsed.quantityOverride),
    unitCost:
      parsed.unitCost == null ? null : parseNonNegativeNumber(parsed.unitCost),
    customerUnitPrice:
      parsed.customerUnitPrice == null
        ? null
        : parseNonNegativeNumber(parsed.customerUnitPrice),
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    convertedLineItemId:
      typeof parsed.convertedLineItemId === "string" && parsed.convertedLineItemId.trim()
        ? parsed.convertedLineItemId
        : null,
  };
}

function normalizeMeasurementSource(
  raw: unknown,
): TakeoffSnapshot["measurementSource"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Record<string, unknown>;
  if (
    parsed.kind !== "intake" &&
    parsed.kind !== "calculator" &&
    parsed.kind !== "manual"
  ) {
    return null;
  }
  return {
    kind: parsed.kind,
    label: typeof parsed.label === "string" ? parsed.label : parsed.kind,
    unverified: parsed.unverified === true,
  };
}

export function emptyTakeoffSnapshot(takeoffType: TakeoffTypeId): TakeoffSnapshot {
  return computeTakeoff({ takeoffType }).snapshot;
}
