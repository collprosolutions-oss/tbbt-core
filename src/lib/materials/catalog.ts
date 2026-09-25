import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireMaterialsCatalogAccess } from "@/lib/materials/access";
import { MaterialsError } from "@/lib/materials/errors";
import { decimalMoney, parseNonNegativeDecimal } from "@/lib/materials/money";
import { appendMaterialPriceHistory } from "@/lib/materials/price-history";
import { normalizeMaterialName } from "@/lib/materials/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type CatalogItemInput = {
  name: string;
  sku?: string | null;
  unit: string;
  packSize?: string | number | null;
  preferredSupplierId?: string | null;
  lastKnownCost?: string | number | null;
  notes?: string | null;
  category?: string | null;
  takeoffIdentity?: string | null;
  active?: boolean;
};

function trimOrNull(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

async function resolveCatalogFields(db: Db, access: BusinessAccess, input: CatalogItemInput) {
  const name = input.name.trim();
  if (!name) throw new MaterialsError("Enter a material name.");
  const unit = input.unit.trim() || "ea";
  if (input.preferredSupplierId) {
    access.assertOwned(
      await db.supplier.findFirst({
        where: { id: input.preferredSupplierId, businessId: access.businessId },
        select: { id: true, businessId: true },
      }),
    );
  }
  return {
    name,
    normalizedName: normalizeMaterialName(name),
    sku: trimOrNull(input.sku),
    unit,
    packSize: parseNonNegativeDecimal(input.packSize ?? null),
    preferredSupplierId: input.preferredSupplierId || null,
    lastKnownCost: decimalMoney(input.lastKnownCost ?? null),
    notes: trimOrNull(input.notes),
    category: trimOrNull(input.category),
    takeoffIdentity: trimOrNull(input.takeoffIdentity),
    active: input.active !== false,
  };
}

export async function listMaterialCatalog(db: Db, access: BusinessAccess, activeOnly = false) {
  await requireMaterialsCatalogAccess(db, access);
  return db.materialCatalogItem.findMany({
    where: {
      businessId: access.businessId,
      ...(activeOnly ? { active: true } : {}),
    },
    include: {
      preferredSupplier: { select: { id: true, name: true, preferred: true, active: true } },
    },
    orderBy: [{ name: "asc" }],
  });
}

export async function createMaterialCatalogItem(
  db: Db,
  access: BusinessAccess,
  input: CatalogItemInput,
) {
  await requireMaterialsCatalogAccess(db, access);
  const fields = await resolveCatalogFields(db, access, input);
  const created = await db.materialCatalogItem.create({
    data: {
      businessId: access.businessId,
      ...fields,
      lastKnownCostAt: fields.lastKnownCost ? new Date() : null,
    },
  });
  if (fields.lastKnownCost) {
    await appendMaterialPriceHistory(db, access, {
      materialId: created.id,
      supplierId: fields.preferredSupplierId,
      unit: fields.unit,
      packSize: fields.packSize,
      price: fields.lastKnownCost,
      source: "OWNER_ENTRY",
    });
  }
  return created;
}

export async function updateMaterialCatalogItem(
  db: Db,
  access: BusinessAccess,
  input: CatalogItemInput & { materialId: string },
) {
  await requireMaterialsCatalogAccess(db, access);
  const existing = access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: input.materialId, businessId: access.businessId },
    }),
  );
  const fields = await resolveCatalogFields(db, access, input);
  const costChanged =
    fields.lastKnownCost != null &&
    (existing.lastKnownCost == null || !fields.lastKnownCost.eq(existing.lastKnownCost));
  const updated = await db.materialCatalogItem.update({
    where: { id: existing.id },
    data: {
      ...fields,
      lastKnownCostAt: costChanged ? new Date() : existing.lastKnownCostAt,
    },
  });
  if (costChanged && fields.lastKnownCost) {
    await appendMaterialPriceHistory(db, access, {
      materialId: existing.id,
      supplierId: fields.preferredSupplierId,
      unit: fields.unit,
      packSize: fields.packSize,
      price: fields.lastKnownCost,
      source: "OWNER_ENTRY",
    });
  }
  return updated;
}

export async function findCatalogItemForTakeoff(
  db: Db,
  businessId: string,
  input: { catalogMaterialId?: string | null; label: string; unit: string; takeoffIdentity?: string | null },
) {
  if (input.catalogMaterialId) {
    const byId = await db.materialCatalogItem.findFirst({
      where: { id: input.catalogMaterialId, businessId },
    });
    if (byId) return byId;
  }
  if (input.takeoffIdentity) {
    const byIdentity = await db.materialCatalogItem.findFirst({
      where: { businessId, takeoffIdentity: input.takeoffIdentity, active: true },
    });
    if (byIdentity) return byIdentity;
  }
  return db.materialCatalogItem.findFirst({
    where: {
      businessId,
      normalizedName: normalizeMaterialName(input.label),
      unit: input.unit.trim() || "ea",
      active: true,
    },
  });
}

export async function upsertCatalogFromTakeoffItem(
  db: Db,
  access: BusinessAccess,
  input: {
    label: string;
    unit: string;
    unitCost?: number | null;
    takeoffIdentity?: string | null;
    preferredSupplierId?: string | null;
  },
) {
  const existing = await findCatalogItemForTakeoff(db, access.businessId, {
    label: input.label,
    unit: input.unit,
    takeoffIdentity: input.takeoffIdentity,
  });
  if (existing) return existing;
  return createMaterialCatalogItem(db, access, {
    name: input.label,
    unit: input.unit,
    lastKnownCost: input.unitCost ?? null,
    takeoffIdentity: input.takeoffIdentity ?? null,
    preferredSupplierId: input.preferredSupplierId ?? null,
  });
}

export { Prisma };
