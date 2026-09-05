export const OTHER_TASK_LABEL = "Other / Something Else";
export const MAX_REQUEST_ITEMS = 25;
export const MAX_CUSTOM_TASK_LENGTH = 400;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_INTAKE_PHOTOS = 8;
export const MIN_REQUEST_QUANTITY = 1;
export const MAX_REQUEST_QUANTITY = 99;

export type RequestedWorkSource = {
  items?: Array<{
    customDescription?: string | null;
    quantity?: number | null;
    serviceCatalogItem?: { name: string } | null;
  }>;
  serviceCatalogItem?: { name: string } | null;
  summary?: string | null;
  description?: string | null;
};

export function parseRequestQuantity(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return null;
    if (raw < MIN_REQUEST_QUANTITY || raw > MAX_REQUEST_QUANTITY) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (value < MIN_REQUEST_QUANTITY || value > MAX_REQUEST_QUANTITY) return null;
  return value;
}

export function coerceRequestQuantity(raw: unknown, fallback = MIN_REQUEST_QUANTITY) {
  return parseRequestQuantity(raw) ?? fallback;
}

export function formatRequestedWorkLabel(name: string, quantity?: number | null) {
  if (quantity == null) return name;
  return `${coerceRequestQuantity(quantity, 1)} × ${name}`;
}

/**
 * Customer-facing / owner-facing labels for requested work.
 * New multi-service requests use ServiceRequestItem rows.
 * Legacy rows with no items fall back to serviceCatalogItem, then
 * summary/description. Never invent tasks that were not stored.
 */
export function requestedWorkLabels(request: RequestedWorkSource): string[] {
  const items = request.items ?? [];
  if (items.length > 0) {
    return items.map((item) => {
      const catalogName = item.serviceCatalogItem?.name?.trim();
      const label = catalogName || item.customDescription?.trim() || OTHER_TASK_LABEL;
      return formatRequestedWorkLabel(label, item.quantity);
    });
  }

  const legacyName = request.serviceCatalogItem?.name?.trim();
  if (legacyName) return [legacyName];

  return [];
}

export function requestedWorkSummary(labels: string[], limit = 80) {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  const head = labels[0];
  const extra = labels.length - 1;
  const text = `${head} + ${extra} more`;
  return text.length <= limit ? text : `${head} +${extra}`;
}

export type SelectedPublicTask =
  | { kind: "catalog"; serviceCatalogItemId: string; quantity: number }
  | { kind: "other"; customDescription: string; quantity: number };

export function parseSelectedTasks(input: {
  catalogItemIds: string[];
  catalogQuantities?: Record<string, unknown>;
  includeOther: boolean;
  otherDescription: string;
  otherQuantity?: unknown;
}): { ok: true; tasks: SelectedPublicTask[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const tasks: SelectedPublicTask[] = [];
  const invalidQuantity = {
    ok: false as const,
    error: "Quantity must be a whole number from 1 to 99.",
  };

  for (const raw of input.catalogItemIds) {
    const id = raw.trim();
    if (!id || id === "other") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    let quantity = 1;
    if (input.catalogQuantities && Object.hasOwn(input.catalogQuantities, id)) {
      const parsed = parseRequestQuantity(input.catalogQuantities[id]);
      if (parsed == null) return invalidQuantity;
      quantity = parsed;
    }
    tasks.push({ kind: "catalog", serviceCatalogItemId: id, quantity });
  }

  const otherDescription = input.otherDescription.trim();
  if (input.includeOther || otherDescription) {
    if (otherDescription.length > MAX_CUSTOM_TASK_LENGTH) {
      return { ok: false, error: "Please shorten the description of the other work." };
    }
    let otherQuantity = 1;
    if (input.otherQuantity !== undefined && input.otherQuantity !== "") {
      const parsed = parseRequestQuantity(input.otherQuantity);
      if (parsed == null) return invalidQuantity;
      otherQuantity = parsed;
    }
    tasks.push({
      kind: "other",
      customDescription: otherDescription || OTHER_TASK_LABEL,
      quantity: otherQuantity,
    });
  }

  if (tasks.length === 0) {
    return {
      ok: false,
      error: "Select at least one service, or describe other work.",
    };
  }

  if (tasks.length > MAX_REQUEST_ITEMS) {
    return { ok: false, error: "Please choose fewer tasks for this visit." };
  }

  return { ok: true, tasks };
}
