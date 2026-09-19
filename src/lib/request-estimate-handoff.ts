/**
 * Owner Create Estimate handoff from an existing ServiceRequest.
 * Display-only: does not change draft line creation or pricing.
 */
import { formatMoney } from "@/lib/format";
import {
  CUSTOM_QUOTE_DRAFT_MARKER,
  STARTING_AT_DRAFT_MARKER,
} from "@/lib/request-estimate-draft";
import { lineItemIncludedWork } from "@/lib/estimate-line-scope";
import { coerceRequestQuantity, OTHER_TASK_LABEL } from "@/lib/service-request-work";

export const REQUEST_ESTIMATE_HANDOFF_TITLE = "Customer request";
export const EDIT_BUILD_ESTIMATE_LABEL = "Edit / Build Estimate";

export type RequestHandoffSource = {
  items?: Array<{
    quantity?: number | null;
    customDescription?: string | null;
    serviceCatalogItem?: { id?: string | null; name?: string | null } | null;
  }> | null;
  serviceCatalogItem?: { id?: string | null; name?: string | null } | null;
  description?: string | null;
  summary?: string | null;
  photos?: unknown[] | null;
  measurements?: unknown[] | null;
} | null;

export type RequestHandoffLaborLine = {
  serviceCatalogItemId?: string | null;
  description: string;
  quantity: { toString(): string } | number;
  unitPrice: { toString(): string; lte?: (value: number) => boolean } | number;
};

export type RequestedWorkStarterRow = {
  name: string;
  quantity: number;
  startingLaborLabel: string | null;
  includedScope: string | null;
};

export function isPopulatedCustomerRequest(request: RequestHandoffSource) {
  if (!request) return false;
  if ((request.items ?? []).length > 0) return true;
  if (request.serviceCatalogItem?.name?.trim()) return true;
  if (request.summary?.trim()) return true;
  if (request.description?.trim()) return true;
  if ((request.photos ?? []).length > 0) return true;
  if ((request.measurements ?? []).length > 0) return true;
  return false;
}

export function shouldCollapseRequestEstimateBuilder(input: {
  fromCustomerRequest: boolean;
  populated: boolean;
}) {
  return input.fromCustomerRequest && input.populated;
}

export function requestedWorkForHandoff(request: RequestHandoffSource) {
  const items = request?.items ?? [];
  if (items.length > 0) {
    return items.map((item) => {
      const catalogName = item.serviceCatalogItem?.name?.trim();
      const name =
        catalogName || item.customDescription?.trim() || OTHER_TASK_LABEL;
      return {
        catalogItemId: item.serviceCatalogItem?.id?.trim() || null,
        name,
        quantity: coerceRequestQuantity(item.quantity, 1),
      };
    });
  }
  const legacyName = request?.serviceCatalogItem?.name?.trim();
  if (legacyName) {
    return [
      {
        catalogItemId: request?.serviceCatalogItem?.id?.trim() || null,
        name: legacyName,
        quantity: 1,
      },
    ];
  }
  const summary = request?.summary?.trim();
  if (summary) {
    return [{ catalogItemId: null, name: summary, quantity: 1 }];
  }
  return [];
}

function laborUnitAmount(unitPrice: RequestHandoffLaborLine["unitPrice"]) {
  const raw =
    typeof unitPrice === "number" ? unitPrice : Number(unitPrice.toString());
  return Number.isFinite(raw) ? raw : 0;
}

function startingLaborLabelForLine(line: RequestHandoffLaborLine) {
  const amount = laborUnitAmount(line.unitPrice);
  if (amount <= 0 || line.description.includes(CUSTOM_QUOTE_DRAFT_MARKER)) {
    return null;
  }
  const money = formatMoney(amount);
  if (line.description.includes(STARTING_AT_DRAFT_MARKER)) {
    return `Starting labor: ${money}`;
  }
  return `Labor: ${money}`;
}

export function associateRequestedWorkWithStarterLabor(
  requested: Array<{
    catalogItemId?: string | null;
    name: string;
    quantity?: number | null;
  }>,
  laborLines: RequestHandoffLaborLine[],
): RequestedWorkStarterRow[] {
  const unused = [...laborLines];
  return requested.map((item) => {
    const catalogId = item.catalogItemId?.trim() || null;
    let index = -1;
    if (catalogId) {
      index = unused.findIndex(
        (line) => (line.serviceCatalogItemId ?? null) === catalogId,
      );
    }
    if (index < 0 && !catalogId) {
      index = unused.findIndex((line) => !line.serviceCatalogItemId);
    }
    const line = index >= 0 ? unused.splice(index, 1)[0] : null;
    return {
      name: item.name,
      quantity: coerceRequestQuantity(item.quantity, 1),
      startingLaborLabel: line ? startingLaborLabelForLine(line) : null,
      includedScope: line ? lineItemIncludedWork(line.description) : null,
    };
  });
}
