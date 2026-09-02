/**
 * Owner-controlled estimate-draft preparation from a submitted request.
 *
 * createEstimate() copies these lines onto a DRAFT. This does not send,
 * approve, or create a Job/Invoice.
 */
import { Prisma } from "@prisma/client";
import { coerceRequestQuantity } from "@/lib/service-request-work";
import { publicCatalogUnitAmount } from "@/lib/pricing-mode";

export const STARTING_AT_DRAFT_MARKER = "(starting at)";
export const CUSTOM_QUOTE_DRAFT_MARKER = "(custom quote — enter price)";

export type RequestDraftSourceItem = {
  quantity?: number | null;
  customDescription?: string | null;
  serviceCatalogItem?: {
    id?: string;
    name: string;
    pricingMode: string;
    price: { toString(): string } | number | null;
  } | null;
};

export type DraftEstimateLine = {
  description: string;
  quantity: number;
  unitPrice: number | null;
  pricingMode: string;
  priced: boolean;
  serviceCatalogItemId: string | null;
};

export function draftEstimateLinesFromRequestItems(
  items: RequestDraftSourceItem[],
): DraftEstimateLine[] {
  return items.map((item) => {
    const catalog = item.serviceCatalogItem;
    const quantity = coerceRequestQuantity(item.quantity, 1);
    const serviceCatalogItemId = catalog?.id ?? null;
    if (!catalog) {
      return {
        description: item.customDescription?.trim() || "Custom work",
        quantity,
        unitPrice: null,
        pricingMode: "CUSTOM_QUOTE",
        priced: false,
        serviceCatalogItemId,
      };
    }
    const unitPrice = publicCatalogUnitAmount(catalog.pricingMode, catalog.price);
    return {
      description: catalog.name,
      quantity,
      unitPrice,
      pricingMode: catalog.pricingMode,
      priced: unitPrice != null,
      serviceCatalogItemId,
    };
  });
}

export function formatDraftEstimateDescription(line: DraftEstimateLine) {
  if (line.pricingMode === "STARTING_AT") {
    return `${line.description} ${STARTING_AT_DRAFT_MARKER}`;
  }
  if (!line.priced) {
    return `${line.description} ${CUSTOM_QUOTE_DRAFT_MARKER}`;
  }
  return line.description;
}

export function isUnpricedCustomQuoteDraftLine(item: {
  unitPrice: { lte: (value: number) => boolean } | number | string;
  description: string;
}) {
  const unpaid =
    typeof item.unitPrice === "object" && item.unitPrice && "lte" in item.unitPrice
      ? item.unitPrice.lte(0)
      : Number(item.unitPrice) <= 0;
  return unpaid && item.description.includes(CUSTOM_QUOTE_DRAFT_MARKER);
}

export function buildEstimateLineCreatesFromRequestItems(
  businessId: string,
  items: RequestDraftSourceItem[],
) {
  return draftEstimateLinesFromRequestItems(items).map((line) => {
    const unitPrice = line.priced && line.unitPrice != null ? line.unitPrice : 0;
    return {
      businessId,
      serviceCatalogItemId: line.serviceCatalogItemId,
      description: formatDraftEstimateDescription(line),
      quantity: line.quantity,
      unitPrice,
      total: line.priced && line.unitPrice != null ? line.unitPrice * line.quantity : 0,
      type: "LABOR" as const,
    };
  });
}

export async function addRequestDraftLines(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    estimateId: string;
    items: RequestDraftSourceItem[];
  },
) {
  const rows = buildEstimateLineCreatesFromRequestItems(input.businessId, input.items);
  if (rows.length === 0) return 0;
  await tx.lineItem.createMany({
    data: rows.map((row) => ({
      businessId: row.businessId,
      estimateId: input.estimateId,
      serviceCatalogItemId: row.serviceCatalogItemId,
      description: row.description,
      quantity: new Prisma.Decimal(row.quantity),
      unitPrice: new Prisma.Decimal(row.unitPrice),
      total: new Prisma.Decimal(row.total),
      type: row.type,
    })),
  });
  return rows.length;
}
