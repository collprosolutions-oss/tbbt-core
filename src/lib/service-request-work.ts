export const OTHER_TASK_LABEL = "Other / Something Else";
export const MAX_REQUEST_ITEMS = 25;
export const MAX_CUSTOM_TASK_LENGTH = 400;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_INTAKE_PHOTOS = 5;

export type RequestedWorkSource = {
  items?: Array<{
    customDescription?: string | null;
    serviceCatalogItem?: { name: string } | null;
  }>;
  serviceCatalogItem?: { name: string } | null;
  summary?: string | null;
  description?: string | null;
};

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
      if (catalogName) return catalogName;
      const custom = item.customDescription?.trim();
      if (custom) return custom;
      return OTHER_TASK_LABEL;
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
  | { kind: "catalog"; serviceCatalogItemId: string }
  | { kind: "other"; customDescription: string };

export function parseSelectedTasks(input: {
  catalogItemIds: string[];
  includeOther: boolean;
  otherDescription: string;
}): { ok: true; tasks: SelectedPublicTask[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const tasks: SelectedPublicTask[] = [];

  for (const raw of input.catalogItemIds) {
    const id = raw.trim();
    if (!id || id === "other") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({ kind: "catalog", serviceCatalogItemId: id });
  }

  const otherDescription = input.otherDescription.trim();
  if (input.includeOther || otherDescription) {
    if (otherDescription.length > MAX_CUSTOM_TASK_LENGTH) {
      return { ok: false, error: "Please shorten the description of the other work." };
    }
    tasks.push({
      kind: "other",
      customDescription: otherDescription || OTHER_TASK_LABEL,
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
