/**
 * Draft-estimate material takeoff persistence and MATERIAL conversion.
 *
 * Takeoff JSON stays on the parent line's description. Converted
 * customer MATERIAL lines get only a clean title plus an internal source
 * marker used for duplicate prevention — never formulas, waste, or cost
 * basis.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import {
  joinLineDescription,
  lineMaterialTakeoff,
  lineMaterialTakeoffSource,
  splitLineDescription,
} from "@/lib/estimate-line-scope";
import { EstimateLineError } from "@/lib/estimate-line-ops";
import { pricedCustomQuoteDescription } from "@/lib/request-estimate-draft";
import { recommendTakeoffLabor } from "@/lib/material-takeoff/labor-pricing";
import {
  addCustomTakeoffItem,
  applyTakeoffItemEdits,
  computeTakeoff,
  normalizeTakeoffSnapshot,
} from "@/lib/material-takeoff/engine";
import {
  hasValidCustomerUnitPrice,
  isTakeoffTypeId,
  workingQuantity,
  type TakeoffSnapshot,
  type TakeoffTypeId,
} from "@/lib/material-takeoff/types";
import { parsePositiveNumber } from "@/lib/material-takeoff/units";

type Db = PrismaClient;

export async function saveDraftMaterialTakeoff(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    snapshot: TakeoffSnapshot;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const snapshot = normalizeTakeoffSnapshot(input.snapshot);
  if (!snapshot) {
    throw new EstimateLineError("That material takeoff could not be saved.");
  }
  const { line } = await loadDraftParentLine(
    db,
    access,
    input.estimateId,
    input.lineItemId,
  );
  await persistTakeoffOnLine(db, line, snapshot);
  return snapshot;
}

export async function recalculateDraftMaterialTakeoff(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    takeoffType: TakeoffTypeId;
    inputs?: Record<string, unknown> | null;
    wastePercent?: number;
    measurementSource?: TakeoffSnapshot["measurementSource"];
    skippedMeasurements?: string[];
    snapshotEdits?: TakeoffSnapshot | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  if (!isTakeoffTypeId(input.takeoffType)) {
    throw new EstimateLineError("Choose a material takeoff type.");
  }
  const { line } = await loadDraftParentLine(
    db,
    access,
    input.estimateId,
    input.lineItemId,
  );
  const previous =
    normalizeTakeoffSnapshot(input.snapshotEdits) ??
    lineMaterialTakeoff(line.description);
  const computed = computeTakeoff({
    takeoffType: input.takeoffType,
    inputs: input.inputs ?? previous?.inputs,
    wastePercent: input.wastePercent ?? previous?.wastePercent,
    measurementSource: input.measurementSource ?? previous?.measurementSource,
    skippedMeasurements: input.skippedMeasurements ?? previous?.skippedMeasurements,
    previous,
  });
  if (computed.rejected && computed.snapshot.items.length === 0) {
    throw new EstimateLineError(computed.rejected);
  }
  await persistTakeoffOnLine(db, line, computed.snapshot);
  return computed;
}

export async function convertDraftMaterialTakeoff(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    snapshot?: TakeoffSnapshot | null;
    itemIds?: string[] | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const { line, estimate } = await loadDraftParentLine(
    db,
    access,
    input.estimateId,
    input.lineItemId,
  );
  const snapshot =
    normalizeTakeoffSnapshot(input.snapshot) ??
    lineMaterialTakeoff(line.description);
  if (!snapshot) {
    throw new EstimateLineError("Calculate a material takeoff before converting it.");
  }

  const estimateLines = await db.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    select: { id: true, description: true },
  });
  const existingByItemId = convertedLinesByItemId(estimateLines, line.id);

  const requested = new Set(
    (input.itemIds ?? snapshot.items.filter((item) => item.selected).map((item) => item.id)),
  );
  const nextItems = [...snapshot.items];
  const missingPriceLabels: string[] = [];
  const creates: Array<{
    itemId: string;
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    total: Prisma.Decimal;
  }> = [];

  for (const [index, item] of nextItems.entries()) {
    if (!requested.has(item.id) || !item.selected) continue;
    const existingId =
      (item.convertedLineItemId &&
      estimateLines.some((row) => row.id === item.convertedLineItemId)
        ? item.convertedLineItemId
        : null) ?? existingByItemId.get(item.id) ?? null;
    if (existingId) {
      nextItems[index] = { ...item, convertedLineItemId: existingId };
      continue;
    }
    const quantity = workingQuantity(item);
    if (!(quantity > 0)) continue;
    const customerUnitPrice = parsePositiveNumber(item.customerUnitPrice);
    if (customerUnitPrice == null || !hasValidCustomerUnitPrice(item)) {
      missingPriceLabels.push(item.label);
      continue;
    }
    const qty = new Prisma.Decimal(quantity.toFixed(4));
    const unitPrice = new Prisma.Decimal(customerUnitPrice.toFixed(2));
    creates.push({
      itemId: item.id,
      description: joinLineDescription(item.label, null, null, null, {
        materialTakeoffSource: { parentLineItemId: line.id, itemId: item.id },
      }),
      quantity: qty,
      unitPrice,
      total: qty.mul(unitPrice),
    });
  }

  if (missingPriceLabels.length > 0) {
    throw new EstimateLineError(missingCustomerPriceMessage(missingPriceLabels));
  }

  const nextSnapshot: TakeoffSnapshot = { ...snapshot, items: nextItems };

  await db.$transaction(async (tx) => {
    const createdIds: Record<string, string> = {};
    for (const row of creates) {
      const created = await tx.lineItem.create({
        data: {
          businessId: access.businessId,
          estimateId: estimate.id,
          description: row.description,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          total: row.total,
          type: "MATERIAL",
        },
      });
      createdIds[row.itemId] = created.id;
    }
    const stored: TakeoffSnapshot = {
      ...nextSnapshot,
      items: nextSnapshot.items.map((item) =>
        createdIds[item.id]
          ? { ...item, convertedLineItemId: createdIds[item.id] ?? item.convertedLineItemId }
          : item,
      ),
    };
    const parts = splitLineDescription(line.description);
    await tx.lineItem.update({
      where: { id: line.id },
      data: {
        description: joinLineDescription(
          parts.title,
          parts.includedWork,
          parts.calculatorSnapshot,
          parts.customerPolicies,
          { materialTakeoff: stored },
        ),
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return {
    created: creates.length,
    skippedDuplicates: requested.size - creates.length,
  };
}

/**
 * Apply the takeoff labor helper to the original request/service LABOR
 * line. Materials stay on MATERIAL lines. Recalc never calls this.
 */
export async function applyDraftTakeoffRecommendedLabor(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    snapshot?: TakeoffSnapshot | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const { line, estimate } = await loadDraftParentLine(
    db,
    access,
    input.estimateId,
    input.lineItemId,
  );
  if (line.type !== "LABOR") {
    throw new EstimateLineError(
      "Recommended labor applies to the original request/service labor line.",
    );
  }
  const snapshot =
    normalizeTakeoffSnapshot(input.snapshot) ?? lineMaterialTakeoff(line.description);
  if (!snapshot) {
    throw new EstimateLineError("Calculate a material takeoff before applying labor.");
  }
  const recommendation = recommendTakeoffLabor(snapshot);
  if (!recommendation.available || !(recommendation.recommendedLabor > 0)) {
    throw new EstimateLineError(
      recommendation.unavailableReason ??
        "This takeoff does not have a recommended labor price yet.",
    );
  }
  const stored: TakeoffSnapshot = {
    ...snapshot,
    laborRate: recommendation.rate,
  };
  const unitPrice = new Prisma.Decimal(recommendation.recommendedLabor.toFixed(2));
  const total = line.quantity.mul(unitPrice);
  const parts = splitLineDescription(line.description);
  const description = pricedCustomQuoteDescription(
    joinLineDescription(
      parts.title,
      parts.includedWork,
      parts.calculatorSnapshot,
      parts.customerPolicies,
      {
        materialTakeoff: stored,
        materialTakeoffSource: parts.materialTakeoffSource,
      },
    ),
  );

  await db.$transaction(async (tx) => {
    await tx.lineItem.update({
      where: { id: line.id },
      data: {
        unitPrice,
        total,
        description,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return {
    recommendedLabor: recommendation.recommendedLabor,
    customerMaterialTotal: recommendation.customerMaterialTotal,
    recommendedSubtotal: recommendation.recommendedSubtotal,
    line: await db.lineItem.findFirstOrThrow({
      where: { id: line.id, businessId: access.businessId },
    }),
  };
}

export function parseTakeoffFormSnapshot(raw: string) {
  try {
    return normalizeTakeoffSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyTakeoffFormMutations(
  snapshot: TakeoffSnapshot,
  form: {
    wastePercent?: number;
    removedIds?: string[];
    customLabel?: string;
    customUnit?: string;
    customQuantity?: number;
    customUnitCost?: number | null;
    customCustomerUnitPrice?: number | null;
    itemEdits?: Array<{
      id: string;
      selected?: boolean;
      quantityOverride?: number | null;
      unitCost?: number | null;
      customerUnitPrice?: number | null;
      label?: string;
      remove?: boolean;
    }>;
  },
) {
  let next = snapshot;
  if (form.wastePercent != null) {
    next = { ...next, wastePercent: form.wastePercent };
  }
  if (form.itemEdits?.length) {
    next = applyTakeoffItemEdits(next, form.itemEdits);
  }
  if (form.removedIds?.length) {
    next = applyTakeoffItemEdits(
      next,
      form.removedIds.map((id) => ({ id, remove: true })),
    );
  }
  if (form.customLabel?.trim()) {
    next = addCustomTakeoffItem(next, {
      label: form.customLabel,
      unit: form.customUnit || "ea",
      quantity: form.customQuantity ?? 1,
      unitCost: form.customUnitCost,
      customerUnitPrice: form.customCustomerUnitPrice,
    });
  }
  return next;
}

function missingCustomerPriceMessage(labels: string[]) {
  return `Enter a customer unit price before converting: ${labels.join(", ")}.`;
}

async function loadDraftParentLine(
  db: Db,
  access: BusinessAccess,
  estimateId: string,
  lineItemId: string,
) {
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }
  const line = access.assertOwned(
    await db.lineItem.findFirst({
      where: {
        id: lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );
  if (lineMaterialTakeoffSource(line.description)) {
    throw new EstimateLineError(
      "Converted material lines keep customer pricing only. Edit takeoff on the parent work line.",
    );
  }
  return { estimate, line };
}

async function persistTakeoffOnLine(
  db: Pick<Db, "lineItem">,
  line: { id: string; description: string },
  snapshot: TakeoffSnapshot,
) {
  const parts = splitLineDescription(line.description);
  await db.lineItem.update({
    where: { id: line.id },
    data: {
      description: joinLineDescription(
        parts.title,
        parts.includedWork,
        parts.calculatorSnapshot,
        parts.customerPolicies,
        {
          materialTakeoff: snapshot,
          materialTakeoffSource: parts.materialTakeoffSource,
        },
      ),
    },
  });
}

function convertedLinesByItemId(
  lines: Array<{ id: string; description: string }>,
  parentLineItemId: string,
) {
  const found = new Map<string, string>();
  for (const line of lines) {
    const source = lineMaterialTakeoffSource(line.description);
    if (source?.parentLineItemId === parentLineItemId && source.itemId) {
      found.set(source.itemId, line.id);
    }
  }
  return found;
}
