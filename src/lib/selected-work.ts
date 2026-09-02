/**
 * Shared selected-work + quantity helpers for Services and Request a Quote.
 * Quantity is structured (1–99). Client prices are never trusted here.
 */
import { formatMoney } from "@/lib/format";
import { parsePricingMode } from "@/lib/pricing-mode";
import {
  MAX_REQUEST_QUANTITY,
  MIN_REQUEST_QUANTITY,
  OTHER_TASK_LABEL,
  coerceRequestQuantity,
  parseRequestQuantity,
} from "@/lib/service-request-work";

export { MAX_REQUEST_QUANTITY, MIN_REQUEST_QUANTITY };

type NamedCatalogItem = {
  id: string;
  name: string;
  pricingMode: string;
  unitAmount: number | null;
};

export type SelectedWorkState = {
  catalogIds: string[];
  quantities: Record<string, number>;
  includeOther: boolean;
  otherDescription: string;
  otherQuantity: number;
};

export type SelectedWorkQueryInput = {
  catalogIds?: string[];
  quantities?: Record<string, number>;
  includeOther?: boolean;
  otherDescription?: string;
  otherQuantity?: number;
};

export function emptySelectedWork(): SelectedWorkState {
  return {
    catalogIds: [],
    quantities: {},
    includeOther: false,
    otherDescription: "",
    otherQuantity: 1,
  };
}

export function quantityForId(quantities: Record<string, number> | undefined, id: string) {
  return coerceRequestQuantity(quantities?.[id], 1);
}

export function setSelectedQuantity(
  selected: SelectedWorkState,
  id: string,
  raw: unknown,
): SelectedWorkState {
  const quantity = coerceRequestQuantity(raw, 1);
  return {
    ...selected,
    quantities: { ...selected.quantities, [id]: quantity },
  };
}

export function toggleSelectedCatalog(
  selected: SelectedWorkState,
  id: string,
): SelectedWorkState {
  if (selected.catalogIds.includes(id)) {
    const quantities = { ...selected.quantities };
    delete quantities[id];
    return {
      ...selected,
      catalogIds: selected.catalogIds.filter((value) => value !== id),
      quantities,
    };
  }
  return {
    ...selected,
    catalogIds: [...selected.catalogIds, id],
    quantities: { ...selected.quantities, [id]: 1 },
  };
}

export function formatWorkQuantityLabel(quantity: number, name: string) {
  return `${coerceRequestQuantity(quantity, 1)} × ${name}`;
}

export function selectedWorkLabels(
  selected: SelectedWorkState,
  items: NamedCatalogItem[],
) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const labels = selected.catalogIds
    .map((id) => {
      const item = byId.get(id);
      if (!item) return null;
      return formatWorkQuantityLabel(quantityForId(selected.quantities, id), item.name);
    })
    .filter((name): name is string => Boolean(name));
  if (selected.includeOther) {
    labels.push(
      formatWorkQuantityLabel(
        selected.otherQuantity,
        selected.otherDescription.trim() || OTHER_TASK_LABEL,
      ),
    );
  }
  return labels;
}

export function parseServicesSearchToken(raw: string, validIds?: Set<string>) {
  const catalogIds: string[] = [];
  const quantities: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const colon = token.lastIndexOf(":");
    const id = colon === -1 ? token : token.slice(0, colon);
    const qtyRaw = colon === -1 ? "1" : token.slice(colon + 1);
    if (!id || (validIds && !validIds.has(id))) continue;
    if (catalogIds.includes(id)) continue;
    catalogIds.push(id);
    quantities[id] = coerceRequestQuantity(qtyRaw, 1);
  }
  return { catalogIds, quantities };
}

export function parseSelectedWorkSearch(
  query: {
    services?: string;
    other?: string;
    otherText?: string;
    otherQty?: string;
  },
  validIds?: Set<string>,
): SelectedWorkState {
  const parsed = parseServicesSearchToken(query.services ?? "", validIds);
  const includeOther = query.other === "1" || query.other === "true";
  return {
    catalogIds: parsed.catalogIds,
    quantities: parsed.quantities,
    includeOther,
    otherDescription: (query.otherText ?? "").trim(),
    otherQuantity: includeOther ? coerceRequestQuantity(query.otherQty, 1) : 1,
  };
}

export function selectedWorkQuery(input: SelectedWorkQueryInput) {
  const params = new URLSearchParams();
  if (input.catalogIds?.length) {
    params.set(
      "services",
      input.catalogIds
        .map((id) => {
          const qty = quantityForId(input.quantities, id);
          return qty === 1 ? id : `${id}:${qty}`;
        })
        .join(","),
    );
  }
  if (input.includeOther) {
    params.set("other", "1");
    if (input.otherDescription?.trim()) {
      params.set("otherText", input.otherDescription.trim());
    }
    const otherQty = coerceRequestQuantity(input.otherQuantity, 1);
    if (otherQty !== 1) params.set("otherQty", String(otherQty));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export type SelectedPricingRow = {
  pricingMode: string;
  unitAmount: number | null;
  quantity: number;
};

export type SelectedPricingSummary = {
  fixedTotal: number;
  startingTotal: number;
  customCount: number;
  estimatedStartingTotal: number;
  allFixed: boolean;
  hasPricedWork: boolean;
};

export function summarizeSelectedWorkPricing(
  rows: SelectedPricingRow[],
): SelectedPricingSummary {
  let fixedTotal = 0;
  let startingTotal = 0;
  let customCount = 0;
  let pricedCount = 0;

  for (const row of rows) {
    const quantity = coerceRequestQuantity(row.quantity, 1);
    const mode = parsePricingMode(row.pricingMode);
    if (mode === "CUSTOM_QUOTE" || row.unitAmount == null) {
      customCount += 1;
      continue;
    }
    const unit = Number(row.unitAmount);
    if (!Number.isFinite(unit) || unit < 0) {
      customCount += 1;
      continue;
    }
    const line = unit * quantity;
    if (mode === "FIXED") {
      fixedTotal += line;
      pricedCount += 1;
    } else {
      startingTotal += line;
      pricedCount += 1;
    }
  }

  return {
    fixedTotal,
    startingTotal,
    customCount,
    estimatedStartingTotal: fixedTotal + startingTotal,
    allFixed: pricedCount > 0 && customCount === 0 && startingTotal === 0,
    hasPricedWork: pricedCount > 0,
  };
}

export function selectedCatalogPricingRows(
  selected: SelectedWorkState,
  items: NamedCatalogItem[],
): SelectedPricingRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows: SelectedPricingRow[] = [];
  for (const id of selected.catalogIds) {
    const item = byId.get(id);
    if (!item) continue;
    rows.push({
      pricingMode: item.pricingMode,
      unitAmount: item.unitAmount,
      quantity: quantityForId(selected.quantities, id),
    });
  }
  if (selected.includeOther) {
    rows.push({
      pricingMode: "CUSTOM_QUOTE",
      unitAmount: null,
      quantity: selected.otherQuantity,
    });
  }
  return rows;
}

export function formatPricingSummaryLines(summary: SelectedPricingSummary) {
  const lines: string[] = [];
  if (summary.fixedTotal > 0) {
    lines.push(`Fixed-price work: ${formatMoney(summary.fixedTotal)}`);
  }
  if (summary.startingTotal > 0) {
    lines.push(`Starting-price work: Starting at ${formatMoney(summary.startingTotal)}`);
  }
  if (summary.customCount > 0) {
    lines.push(
      `Custom quote items: ${summary.customCount}`,
    );
  }
  if (summary.allFixed) {
    lines.push(`Estimated total: ${formatMoney(summary.estimatedStartingTotal)}`);
  } else if (summary.hasPricedWork && summary.customCount > 0) {
    lines.push(
      `Estimated starting total: ${formatMoney(summary.estimatedStartingTotal)} + custom-quote work`,
    );
  } else if (summary.hasPricedWork && summary.startingTotal > 0 && summary.fixedTotal > 0) {
    lines.push(
      `Estimated starting total: ${formatMoney(summary.estimatedStartingTotal)}`,
    );
  } else if (summary.hasPricedWork && summary.startingTotal > 0) {
    lines.push(
      `Starting subtotal: ${formatMoney(summary.startingTotal)}`,
    );
  }
  return lines;
}

export function catalogQuantitiesFromState(selected: SelectedWorkState) {
  const quantities: Record<string, number> = {};
  for (const id of selected.catalogIds) {
    quantities[id] = quantityForId(selected.quantities, id);
  }
  return quantities;
}

export function parseSubmittedQuantity(raw: unknown) {
  return parseRequestQuantity(raw);
}
