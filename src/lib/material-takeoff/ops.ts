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
  joinLineDescriptionFromParts,
  isOriginalEstimateWorkLine,
  isTakeoffGeneratedMaterialLine,
  lineMaterialTakeoff,
  lineMaterialTakeoffSource,
  splitLineDescription,
} from "@/lib/estimate-line-scope";
import { EstimateLineError } from "@/lib/estimate-line-ops";
import { descriptionsWithMaterialDeposit } from "@/lib/material-deposit";
import { publicCatalogUnitAmount } from "@/lib/pricing-mode";
import { parseWorkAreaIntake } from "@/lib/work-area-intake";
import { toStoredIntakeMeasurement } from "@/lib/intake-quote-handoff";
import {
  pickIntakeMeasurementForLine,
  suggestTakeoffInputs,
} from "@/lib/material-takeoff/measurements";
import {
  CUSTOM_QUOTE_DRAFT_MARKER,
  STARTING_AT_DRAFT_MARKER,
  addRequestDraftLines,
  customQuoteDisplayDescription,
  pricedCustomQuoteDescription,
  requestDraftItemIsAlreadyOnEstimate,
  sourceItemsFromServiceRequest,
} from "@/lib/request-estimate-draft";
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
import { applyBusinessEstimatingDefaults } from "@/lib/estimating-defaults";
import { loadBusinessEstimatingDefaults } from "@/lib/estimating-defaults-db";
import { resolveDraftEstimatingWorkspace } from "@/lib/estimate-calculators/estimating-registry";

type Db = PrismaClient;

export async function saveDraftMaterialTakeoff(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId?: string | null;
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

export async function seedDraftTakeoffFromBusinessDefaults(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const { line, estimate } = await loadDraftParentLine(
    db,
    access,
    input.estimateId,
    input.lineItemId,
  );
  if (lineMaterialTakeoff(line.description)) {
    return lineMaterialTakeoff(line.description);
  }
  const title = customQuoteDisplayDescription(line.description);
  const workspace = resolveDraftEstimatingWorkspace({
    title,
    customQuote: true,
  });
  const defaults = await loadBusinessEstimatingDefaults(
    db,
    access.businessId,
    workspace.id,
  );
  if (!defaults) return null;

  const request = estimate.serviceRequestId
    ? await db.serviceRequest.findFirst({
        where: { id: estimate.serviceRequestId, businessId: access.businessId },
        select: {
          items: {
            select: { serviceCatalogItemId: true },
          },
          measurements: {
            select: {
              source: true,
              width: true,
              height: true,
              length: true,
              quantity: true,
              unit: true,
              serviceRequestItem: {
                select: { serviceCatalogItemId: true },
              },
            },
          },
        },
      })
    : null;
  const measurements = (request?.measurements ?? []).map((row) =>
    toStoredIntakeMeasurement(row),
  );
  const suggestion = suggestTakeoffInputs({
    takeoffType: workspace.material.takeoffType,
    intakeMeasurement: pickIntakeMeasurementForLine(
      measurements,
      line.serviceCatalogItemId,
    ),
  });
  const computed = computeTakeoff({
    takeoffType: workspace.material.takeoffType,
    inputs: suggestion.inputs,
    measurementSource: suggestion.measurementSource,
    skippedMeasurements: suggestion.skippedMeasurements,
  });
  const seeded = applyBusinessEstimatingDefaults(computed.snapshot, defaults);
  await persistTakeoffOnLine(db, line, seeded);
  return seeded;
}

export async function recalculateDraftMaterialTakeoff(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId?: string | null;
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
    lineItemId?: string | null;
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
        description: joinLineDescriptionFromParts(parts, {
          materialTakeoff: stored,
        }),
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
    lineItemId?: string | null;
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
    laborAdjustment: recommendation.laborAdjustment,
  };
  const unitPrice = new Prisma.Decimal(recommendation.recommendedLabor.toFixed(2));
  const total = line.quantity.mul(unitPrice);
  const parts = splitLineDescription(line.description);
  const description = pricedCustomQuoteDescription(
    joinLineDescriptionFromParts(parts, {
      materialTakeoff: stored,
    }),
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

/**
 * Owner recovery: wipe takeoff experiments back to calculated defaults
 * from the current dimensions/options. Generated MATERIAL children of
 * this parent are removed. Unrelated custom lines, the original labor
 * line, request/scope, and photos stay. DRAFT only.
 */
export async function resetDraftTakeoffAndGeneratedMaterials(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const { line, estimate } = await loadDraftParentLine(
    db,
    access,
    input.estimateId,
    input.lineItemId,
  );
  const previous = lineMaterialTakeoff(line.description);
  const currentLines = await db.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    select: { id: true, type: true, description: true },
  });
  const generatedIds = takeoffGeneratedMaterialIds(currentLines, line.id);
  if (!previous && generatedIds.length === 0) {
    throw new EstimateLineError("There is no material takeoff or generated materials to reset.");
  }

  let nextSnapshot = previous;
  if (previous) {
    const computed = computeTakeoff({
      takeoffType: previous.takeoffType,
      inputs: previous.inputs,
      wastePercent: previous.wastePercent,
      measurementSource: previous.measurementSource,
      skippedMeasurements: previous.skippedMeasurements,
    });
    if (computed.rejected && computed.snapshot.items.length === 0) {
      throw new EstimateLineError(computed.rejected);
    }
    nextSnapshot = computed.snapshot;
    const title = customQuoteDisplayDescription(line.description);
    const workspace = resolveDraftEstimatingWorkspace({
      title,
      takeoffType: previous.takeoffType,
      customQuote: true,
    });
    const defaults = await loadBusinessEstimatingDefaults(
      db,
      access.businessId,
      workspace.id,
    );
    if (defaults) {
      nextSnapshot = applyBusinessEstimatingDefaults(nextSnapshot, defaults);
    }
  }

  await db.$transaction(async (tx) => {
    await deleteTakeoffGeneratedMaterials(tx, {
      estimateId: estimate.id,
      businessId: access.businessId,
      generatedIds,
      protectedLineIds: [line.id],
    });
    const parent = await tx.lineItem.findFirst({
      where: {
        id: line.id,
        estimateId: estimate.id,
        businessId: access.businessId,
      },
    });
    if (!parent || parent.type !== "LABOR") {
      throw new EstimateLineError(
        "The original customer-request labor line is missing. Restore it from the linked request instead of resetting takeoff.",
      );
    }
    if (nextSnapshot) {
      await persistTakeoffOnLine(tx, parent, nextSnapshot);
    }
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  const preserved = await db.lineItem.findFirst({
    where: { id: line.id, businessId: access.businessId },
  });
  if (!preserved || preserved.type !== "LABOR") {
    throw new EstimateLineError(
      "Reset cannot remove the original customer-request labor line.",
    );
  }

  return {
    removedMaterialCount: generatedIds.length,
    snapshot: nextSnapshot,
  };
}

/**
 * Owner recovery: return the original request LABOR/work line to the
 * pre-priced draft state, remove takeoff-generated MATERIAL children,
 * and clear the material deposit override and Final Customer Materials
 * Total override. Never deletes the original labor/work line. If that line is already missing on a DRAFT linked to
 * a ServiceRequest, reconstruct it from the request instead of creating
 * a duplicate. DRAFT only.
 */
export async function restoreDraftOriginalRequestPricing(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        serviceRequestId: true,
      },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }

  const lines = await db.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    orderBy: { createdAt: "asc" },
  });
  const originalWorkLines = lines.filter(isOriginalEstimateWorkLine);
  const requestedLine = input.lineItemId
    ? lines.find((row) => row.id === input.lineItemId)
    : null;
  if (requestedLine && lineMaterialTakeoffSource(requestedLine.description)) {
    throw new EstimateLineError(
      "Restore original request pricing applies to the original labor/service line.",
    );
  }
  if (requestedLine && requestedLine.type !== "LABOR") {
    throw new EstimateLineError(
      "Restore original request pricing applies to the original labor/service line.",
    );
  }

  const parentId = requestedLine?.id ?? null;
  const generatedIds = takeoffGeneratedMaterialIds(lines, parentId);
  const protectedLineIds = lines.filter((row) => row.type === "LABOR").map((row) => row.id);
  const workLinesToRestore = requestedLine
    ? [requestedLine]
    : originalWorkLines;

  await db.$transaction(async (tx) => {
    await deleteTakeoffGeneratedMaterials(tx, {
      estimateId: estimate.id,
      businessId: access.businessId,
      generatedIds,
      protectedLineIds,
    });

    for (const workLine of workLinesToRestore) {
      const stillThere = await tx.lineItem.findFirst({
        where: {
          id: workLine.id,
          estimateId: estimate.id,
          businessId: access.businessId,
          type: "LABOR",
        },
      });
      if (!stillThere) continue;
      const catalog = stillThere.serviceCatalogItemId
        ? await tx.serviceCatalogItem.findFirst({
            where: {
              id: stillThere.serviceCatalogItemId,
              businessId: access.businessId,
            },
            select: { pricingMode: true, price: true },
          })
        : null;
      const restored = originalRequestLaborState(
        splitLineDescription(stillThere.description),
        catalog,
      );
      const unitPrice = new Prisma.Decimal(restored.unitPrice.toFixed(2));
      await tx.lineItem.update({
        where: { id: stillThere.id },
        data: {
          unitPrice,
          total: stillThere.quantity.mul(unitPrice),
          description: restored.description,
        },
      });
    }

    const remainingAfterRestore = await tx.lineItem.findMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
      orderBy: { createdAt: "asc" },
    });
    if (!remainingAfterRestore.some(isOriginalEstimateWorkLine)) {
      await reconstructOriginalRequestWorkLines(tx, access, estimate);
    }

    const remaining = await tx.lineItem.findMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true, description: true },
    });
    const depositUpdates = descriptionsWithMaterialDeposit(remaining, null);
    for (const row of depositUpdates) {
      await tx.lineItem.update({
        where: { id: row.id },
        data: { description: row.description },
      });
    }
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  const after = await db.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    orderBy: { createdAt: "asc" },
  });
  const restoredLabor = after.find(isOriginalEstimateWorkLine);
  if (!restoredLabor) {
    throw new EstimateLineError(
      "Could not restore the original customer-request labor line.",
    );
  }
  return restoredLabor;
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
  lineItemId?: string | null,
) {
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        serviceRequestId: true,
      },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }

  const requestedId = lineItemId?.trim() || null;
  if (requestedId) {
    const line = access.assertOwned(
      await db.lineItem.findFirst({
        where: {
          id: requestedId,
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

  const line = await ensureDraftEstimateWorkLine(db, access, estimate);
  return { estimate, line };
}

/**
 * Reconstruct or create the original LABOR/work line so calculators have
 * a place to store project-specific state. Never deletes calculator
 * definitions. Never creates a duplicate LABOR line.
 */
export async function ensureDraftEstimateWorkLine(
  db: Db,
  access: BusinessAccess,
  estimate: { id: string; businessId: string; serviceRequestId: string | null; status?: string },
) {
  const owned = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimate.id, ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        serviceRequestId: true,
      },
    }),
  );
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  if (owned.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }
  const existing = await db.lineItem.findMany({
    where: { estimateId: owned.id, businessId: access.businessId },
    orderBy: { createdAt: "asc" },
  });
  const original = existing.find(isOriginalEstimateWorkLine);
  if (original) return original;

  await db.$transaction(async (tx) => {
    if (owned.serviceRequestId) {
      await reconstructOriginalRequestWorkLines(tx, access, owned);
    } else {
      await createGenericCustomWorkLine(tx, access, owned, existing);
    }
    await persistDraftEstimateTotal(tx, owned.id, access.businessId);
  });

  const after = await db.lineItem.findMany({
    where: { estimateId: owned.id, businessId: access.businessId },
    orderBy: { createdAt: "asc" },
  });
  const restored = after.find(isOriginalEstimateWorkLine);
  if (!restored) {
    throw new EstimateLineError(
      "Could not restore a labor/work line for the estimating workspace.",
    );
  }
  return restored;
}

async function createGenericCustomWorkLine(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  estimate: { id: string; businessId: string },
  existing: Array<{ type: string; description: string }>,
) {
  if (existing.some(isOriginalEstimateWorkLine)) return 0;
  await tx.lineItem.create({
    data: {
      businessId: access.businessId,
      estimateId: estimate.id,
      description: joinLineDescription(`Custom work ${CUSTOM_QUOTE_DRAFT_MARKER}`),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  return 1;
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
      description: joinLineDescriptionFromParts(parts, {
        materialTakeoff: snapshot,
      }),
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

function takeoffGeneratedMaterialIds(
  lines: Array<{ id: string; type: string; description: string }>,
  parentLineItemId?: string | null,
) {
  return lines
    .filter((row) => {
      if (!isTakeoffGeneratedMaterialLine(row)) return false;
      if (row.type === "LABOR") return false;
      if (parentLineItemId) {
        return (
          lineMaterialTakeoffSource(row.description)?.parentLineItemId ===
          parentLineItemId
        );
      }
      return true;
    })
    .map((row) => row.id);
}

async function deleteTakeoffGeneratedMaterials(
  tx: Pick<Db, "lineItem">,
  input: {
    estimateId: string;
    businessId: string;
    generatedIds: string[];
    protectedLineIds: string[];
  },
) {
  const removable = input.generatedIds.filter(
    (id) => !input.protectedLineIds.includes(id),
  );
  if (removable.length === 0) return;
  await tx.lineItem.deleteMany({
    where: {
      id: { in: removable },
      estimateId: input.estimateId,
      businessId: input.businessId,
      type: "MATERIAL",
    },
  });
}

async function reconstructOriginalRequestWorkLines(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  estimate: { id: string; businessId: string; serviceRequestId: string | null },
) {
  if (!estimate.serviceRequestId) {
    throw new EstimateLineError(
      "This draft has no original request labor line to restore.",
    );
  }
  const request = access.assertOwned(
    await tx.serviceRequest.findFirst({
      where: { id: estimate.serviceRequestId, businessId: access.businessId },
      include: {
        items: {
          orderBy: { sortOrder: "asc" },
          include: {
            serviceCatalogItem: {
              select: {
                id: true,
                name: true,
                pricingMode: true,
                price: true,
                description: true,
              },
            },
          },
        },
        measurements: {
          select: {
            source: true,
            width: true,
            height: true,
            length: true,
            quantity: true,
            unit: true,
            serviceRequestItem: { select: { serviceCatalogItemId: true } },
          },
        },
        serviceCatalogItem: {
          select: {
            id: true,
            name: true,
            pricingMode: true,
            price: true,
            description: true,
          },
        },
      },
    }),
  );
  const existing = await tx.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: access.businessId },
    select: {
      type: true,
      description: true,
      serviceCatalogItemId: true,
    },
  });
  const sourceItems = sourceItemsFromServiceRequest(request).filter(
    (item) => !requestDraftItemIsAlreadyOnEstimate(existing, item),
  );
  if (sourceItems.length === 0) return 0;
  return addRequestDraftLines(tx, {
    businessId: access.businessId,
    estimateId: estimate.id,
    items: sourceItems,
    workAreaIntake: parseWorkAreaIntake(request.description),
    measurements: request.measurements.map((row) => toStoredIntakeMeasurement(row)),
  });
}

function originalRequestLaborState(
  parts: ReturnType<typeof splitLineDescription>,
  catalog: { pricingMode: string; price: Prisma.Decimal | null } | null,
) {
  const displayTitle = customQuoteDisplayDescription(parts.title)
    .replace(` ${STARTING_AT_DRAFT_MARKER}`, "")
    .trim();
  const pricingMode = catalog?.pricingMode ?? "CUSTOM_QUOTE";
  const catalogAmount = catalog
    ? publicCatalogUnitAmount(pricingMode, catalog.price)
    : null;
  let title = displayTitle;
  let unitPrice = 0;
  if (pricingMode === "STARTING_AT") {
    title = `${displayTitle} ${STARTING_AT_DRAFT_MARKER}`;
    unitPrice = catalogAmount ?? 0;
  } else if (pricingMode === "FIXED" && catalogAmount != null) {
    unitPrice = catalogAmount;
  } else {
    title = `${displayTitle} ${CUSTOM_QUOTE_DRAFT_MARKER}`;
    unitPrice = 0;
  }
  return {
    unitPrice,
    description: joinLineDescription(
      title,
      parts.includedWork,
      parts.calculatorSnapshot,
      parts.customerPolicies,
      {
        materialTakeoff: null,
        materialTakeoffSource: null,
        materialDeposit: null,
        customerMaterialsTotal: null,
      },
    ),
  };
}
