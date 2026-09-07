/**
 * Owner-controlled estimate-draft preparation from a submitted request.
 *
 * createEstimate() copies these lines onto a DRAFT. This does not send,
 * approve, or create a Job/Invoice.
 */
import { Prisma } from "@prisma/client";
import { startingCalculatorSnapshot } from "@/lib/estimate-calculators";
import {
  calculatorPrefillFromStoredMeasurement,
  customerReportedMeasurementForCatalog,
  mergeWorkAreaAndMeasurementPrefill,
  type StoredIntakeMeasurement,
} from "@/lib/intake-quote-handoff";
import {
  workAreaAnswerForCatalog,
  workAreaIntakeToCalculatorInputs,
  type WorkAreaIntakeRecord,
} from "@/lib/work-area-intake";
import {
  catalogCalculatorDefinition,
  catalogScopeText,
  joinLineDescription,
  splitLineDescription,
} from "@/lib/estimate-line-scope";
import { resolveCustomerPolicies } from "@/lib/estimate-policies";
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
    description?: string | null;
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

/** Owner/customer-facing title without the internal "enter price" marker. */
export function customQuoteDisplayDescription(description: string) {
  return splitLineDescription(description)
    .title.replace(` ${CUSTOM_QUOTE_DRAFT_MARKER}`, "")
    .trim();
}

/**
 * After the owner enters a job price, keep the original request wording
 * and encoded scope, and drop the price-required marker. Never writes the catalog.
 */
export function pricedCustomQuoteDescription(description: string) {
  const parts = splitLineDescription(description);
  const title =
    parts.title.replace(` ${CUSTOM_QUOTE_DRAFT_MARKER}`, "").trim() || parts.title;
  return joinLineDescription(
    title,
    parts.includedWork,
    parts.calculatorSnapshot,
    parts.customerPolicies,
    {
      materialTakeoff: parts.materialTakeoff,
      materialTakeoffSource: parts.materialTakeoffSource,
    },
  );
}

export function draftEstimateSendError(estimate: {
  status: string;
  lineItems: Array<{
    description: string;
    unitPrice: { lte: (value: number) => boolean } | number | string;
  }>;
}): string | null {
  if (estimate.status !== "DRAFT") {
    return "Only a draft estimate can be sent.";
  }
  if (estimate.lineItems.length === 0) {
    return "Add at least one line item before sending.";
  }
  if (estimate.lineItems.some(isUnpricedCustomQuoteDraftLine)) {
    return "Enter a price for each custom-quote line before sending.";
  }
  return null;
}

export function buildEstimateLineCreatesFromRequestItems(
  businessId: string,
  items: RequestDraftSourceItem[],
  workAreaIntake?: WorkAreaIntakeRecord | null,
  measurements?: StoredIntakeMeasurement[] | null,
) {
  return draftEstimateLinesFromRequestItems(items).map((line, index) => {
    const unitPrice = line.priced && line.unitPrice != null ? line.unitPrice : 0;
    const catalog = items[index]?.serviceCatalogItem;
    const calculatorDefinition = catalogCalculatorDefinition(catalog?.description);
    const catalogItemId = catalog?.id ?? line.serviceCatalogItemId;
    const workAreaAnswer = workAreaAnswerForCatalog(workAreaIntake, catalogItemId);
    const measurementPrefill = calculatorPrefillFromStoredMeasurement({
      measurement: customerReportedMeasurementForCatalog(
        measurements ?? [],
        catalogItemId,
      ),
      calculatorId: calculatorDefinition?.calculatorId,
      components: calculatorDefinition?.components,
      definition: calculatorDefinition,
    }).applied;
    const prefillInputs = mergeWorkAreaAndMeasurementPrefill({
      workAreaInputs: workAreaAnswer
        ? workAreaIntakeToCalculatorInputs(workAreaAnswer)
        : null,
      measurementInputs: measurementPrefill,
    });
    const snapshot =
      calculatorDefinition || workAreaAnswer || Object.keys(measurementPrefill).length > 0
        ? startingCalculatorSnapshot({
            title: catalog?.name ?? line.description,
            definition: calculatorDefinition,
            prefillInputs,
          })
        : null;
    return {
      businessId,
      serviceCatalogItemId: line.serviceCatalogItemId,
      description: joinLineDescription(
        formatDraftEstimateDescription(line),
        catalogScopeText(catalog?.description) ?? catalog?.description,
        snapshot,
        snapshot
          ? resolveCustomerPolicies(calculatorDefinition?.customerPolicies)
          : null,
      ),
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
    workAreaIntake?: WorkAreaIntakeRecord | null;
    measurements?: StoredIntakeMeasurement[] | null;
  },
) {
  const rows = buildEstimateLineCreatesFromRequestItems(
    input.businessId,
    input.items,
    input.workAreaIntake,
    input.measurements,
  );
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

/**
 * Same catalog pricing as estimate prefill, attached to a DRAFT Change
 * Order. Does not send or approve. Unpriced custom-quote lines stay $0
 * with the shared "enter price" description marker.
 */
export async function addChangeOrderDraftLines(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    changeOrderId: string;
    items: RequestDraftSourceItem[];
    workAreaIntake?: WorkAreaIntakeRecord | null;
  },
) {
  const rows = buildEstimateLineCreatesFromRequestItems(
    input.businessId,
    input.items,
    input.workAreaIntake,
  );
  if (rows.length === 0) return 0;
  await tx.lineItem.createMany({
    data: rows.map((row) => ({
      businessId: row.businessId,
      changeOrderId: input.changeOrderId,
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
