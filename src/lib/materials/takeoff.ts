/**
 * Connect takeoff / estimate material lines to the reusable catalog
 * and a purchase list. Never rewrite SENT/APPROVED snapshots.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { lineItemTitle, lineMaterialTakeoff } from "@/lib/estimate-line-scope";
import { calculatorMaterialIdentity } from "@/lib/material-pricing/identities";
import {
  extendedMaterialCost,
  hasValidCustomerUnitPrice,
  workingQuantity,
  type TakeoffItem,
  type TakeoffSnapshot,
} from "@/lib/material-takeoff/types";
import { requireMaterialsEstimateAccess } from "@/lib/materials/access";
import { findCatalogItemForTakeoff, upsertCatalogFromTakeoffItem } from "@/lib/materials/catalog";
import { MaterialsError } from "@/lib/materials/errors";
import { addPurchaseListItem, ensurePurchaseList } from "@/lib/materials/purchase";
import { ownerEnteredMarkupPercent } from "@/lib/materials/markup";

type Db = PrismaClient;

function takeoffIdentityForItem(item: TakeoffItem) {
  return calculatorMaterialIdentity(item);
}

export async function convertTakeoffToPurchaseList(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    linkCatalog?: boolean;
  },
) {
  await requireMaterialsEstimateAccess(db, access);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, businessId: access.businessId },
      select: {
        id: true,
        businessId: true,
        status: true,
        approvedVersionId: true,
        lineItems: {
          select: { id: true, description: true, quantity: true, unitPrice: true, total: true, type: true },
        },
      },
    }),
  );
  const list = await ensurePurchaseList(db, access, { estimateId: estimate.id });
  const existing = await db.materialPurchaseListItem.findMany({
    where: { businessId: access.businessId, purchaseListId: list.id },
    select: { takeoffItemId: true, lineItemId: true },
  });
  const seenTakeoff = new Set(existing.map((row) => row.takeoffItemId).filter(Boolean));
  const seenLines = new Set(existing.map((row) => row.lineItemId).filter(Boolean));

  let created = 0;
  for (const line of estimate.lineItems) {
    const snapshot = lineMaterialTakeoff(line.description);
    if (snapshot) {
      const markupPercent = ownerEnteredMarkupPercent(snapshot.markupPercent);
      for (const item of snapshot.items) {
        if (!item.selected) continue;
        const quantity = workingQuantity(item);
        if (!(quantity > 0)) continue;
        if (seenTakeoff.has(item.id)) continue;
        const identity = takeoffIdentityForItem(item);
        const catalog = input.linkCatalog
          ? await upsertCatalogFromTakeoffItem(db, access, {
              label: item.label,
              unit: item.unit,
              unitCost: item.unitCost,
              takeoffIdentity: identity,
            })
          : await findCatalogItemForTakeoff(db, access.businessId, {
              catalogMaterialId: item.catalogMaterialId,
              label: item.label,
              unit: item.unit,
              takeoffIdentity: identity,
            });
        await addPurchaseListItem(db, access, {
          purchaseListId: list.id,
          materialId: catalog?.id ?? item.catalogMaterialId ?? null,
          supplierId: catalog?.preferredSupplierId ?? null,
          lineItemId: item.convertedLineItemId ?? line.id,
          takeoffItemId: item.id,
          name: item.label,
          quantityNeeded: quantity,
          unit: item.unit,
          plannedUnitCost: item.unitCost,
          markupPercent,
          customerUnitPrice: hasValidCustomerUnitPrice(item) ? item.customerUnitPrice : null,
          estimatedQuantity: quantity,
          estimatedCost: extendedMaterialCost(item) || null,
          pickupRequired: identity === "pickup-procurement" || /pickup/i.test(item.label),
        });
        created += 1;
      }
      continue;
    }
    if (line.type !== "MATERIAL") continue;
    if (seenLines.has(line.id)) continue;
    const name = lineItemTitle(line.description);
    if (!name) continue;
    const catalog = input.linkCatalog
      ? await upsertCatalogFromTakeoffItem(db, access, {
          label: name,
          unit: "ea",
          unitCost: Number(line.unitPrice.toString()),
        })
      : await findCatalogItemForTakeoff(db, access.businessId, {
          label: name,
          unit: "ea",
        });
    await addPurchaseListItem(db, access, {
      purchaseListId: list.id,
      materialId: catalog?.id ?? null,
      supplierId: catalog?.preferredSupplierId ?? null,
      lineItemId: line.id,
      name,
      quantityNeeded: line.quantity.toString(),
      unit: catalog?.unit ?? "ea",
      plannedUnitCost: line.unitPrice.toString(),
      customerUnitPrice: line.unitPrice.toString(),
      estimatedQuantity: line.quantity.toString(),
      estimatedCost: line.total.toString(),
    });
    created += 1;
  }

  if (created === 0 && existing.length === 0) {
    throw new MaterialsError("No takeoff or material lines were ready to convert.");
  }
  return { purchaseListId: list.id, created, alreadyPresent: existing.length };
}

export async function linkDraftTakeoffItemToCatalog(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    takeoffItemId: string;
    materialId: string;
  },
) {
  await requireMaterialsEstimateAccess(db, access);
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, businessId: access.businessId },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new MaterialsError("Only a draft estimate takeoff can be linked to the catalog.");
  }
  const line = access.assertOwned(
    await db.lineItem.findFirst({
      where: { id: input.lineItemId, estimateId: estimate.id, businessId: access.businessId },
    }),
  );
  const snapshot = lineMaterialTakeoff(line.description);
  if (!snapshot) {
    throw new MaterialsError("That line does not have a material takeoff.");
  }
  const material = access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: input.materialId, businessId: access.businessId },
    }),
  );
  const next: TakeoffSnapshot = {
    ...snapshot,
    items: snapshot.items.map((item) =>
      item.id === input.takeoffItemId ? { ...item, catalogMaterialId: material.id } : item,
    ),
  };
  return { snapshot: next, materialId: material.id };
}
