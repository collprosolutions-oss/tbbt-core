import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireMaterialsCatalogAccess } from "@/lib/materials/access";
import { MaterialsError } from "@/lib/materials/errors";

type Db = PrismaClient | Prisma.TransactionClient;

function trimOrNull(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export type SupplierInput = {
  name: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  accountReference?: string | null;
  preferred?: boolean;
  notes?: string | null;
  active?: boolean;
  categories?: string | null;
  locationDescription?: string | null;
};

function assertNoSecrets(input: SupplierInput) {
  const haystack = [
    input.accountReference,
    input.notes,
    input.website,
    input.contactName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    /password\s*[:=]|api[_-]?secret|api[_-]?key\s*[:=]|secret\s*[:=]/.test(haystack)
  ) {
    throw new MaterialsError(
      "Do not store supplier passwords or API secrets on vendor records.",
    );
  }
}

function resolveSupplierFields(input: SupplierInput) {
  const name = input.name.trim();
  if (!name) throw new MaterialsError("Enter a supplier name.");
  assertNoSecrets(input);
  return {
    name,
    contactName: trimOrNull(input.contactName),
    contactEmail: trimOrNull(input.contactEmail),
    contactPhone: trimOrNull(input.contactPhone),
    website: trimOrNull(input.website),
    accountReference: trimOrNull(input.accountReference),
    preferred: Boolean(input.preferred),
    notes: trimOrNull(input.notes),
    active: input.active !== false,
    categories: trimOrNull(input.categories),
    locationDescription: trimOrNull(input.locationDescription),
  };
}

export async function listSuppliers(db: Db, access: BusinessAccess, activeOnly = false) {
  await requireMaterialsCatalogAccess(db as PrismaClient, access);
  return db.supplier.findMany({
    where: {
      businessId: access.businessId,
      ...(activeOnly ? { active: true } : {}),
    },
    orderBy: [{ preferred: "desc" }, { name: "asc" }],
  });
}

export async function createSupplier(db: Db, access: BusinessAccess, input: SupplierInput) {
  await requireMaterialsCatalogAccess(db as PrismaClient, access);
  const fields = resolveSupplierFields(input);
  return db.supplier.create({
    data: {
      businessId: access.businessId,
      ...fields,
    },
  });
}

export async function updateSupplier(
  db: Db,
  access: BusinessAccess,
  input: SupplierInput & { supplierId: string },
) {
  await requireMaterialsCatalogAccess(db as PrismaClient, access);
  const existing = access.assertOwned(
    await db.supplier.findFirst({
      where: { id: input.supplierId, businessId: access.businessId },
    }),
  );
  const fields = resolveSupplierFields(input);
  return db.supplier.update({
    where: { id: existing.id },
    data: fields,
  });
}

export async function loadOwnedSupplier(db: Db, access: BusinessAccess, supplierId: string) {
  return access.assertOwned(
    await db.supplier.findFirst({
      where: { id: supplierId, businessId: access.businessId },
    }),
  );
}
