/**
 * Tenant-scoped add-on assignment. Browser codes never authorize.
 * Cross-tenant assignment is impossible because businessId comes from
 * the server workspace, not the request body.
 *
 * Add-ons are not purchasable until an approved price exists. Support
 * or test assignment is explicit, additive, and auditable.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ADDON_SOURCES,
  ADDON_STATUSES,
  isAddonCode,
  type AddonCode,
} from "@/lib/product-catalog/codes";
import { getAddonDefinition } from "@/lib/product-catalog/addons";

type Db = PrismaClient | Prisma.TransactionClient;

export async function assignProductAddon(
  db: Db,
  input: {
    businessId: string;
    addonCode: string;
    source?: string;
    quantity?: number;
    providerRef?: string | null;
  },
) {
  if (!isAddonCode(input.addonCode)) {
    throw new Error("Unknown TBBT add-on code.");
  }
  const definition = getAddonDefinition(input.addonCode);
  const quantity = Math.max(1, input.quantity ?? 1);
  const existing = await db.businessProductAddon.findUnique({
    where: {
      businessId_addonCode: {
        businessId: input.businessId,
        addonCode: input.addonCode,
      },
    },
  });
  if (existing) {
    return db.businessProductAddon.update({
      where: { id: existing.id },
      data: {
        status: ADDON_STATUSES.ACTIVE,
        quantity,
        source: input.source ?? existing.source ?? ADDON_SOURCES.SUPPORT,
        providerRef: input.providerRef ?? existing.providerRef,
        grantedAt: existing.grantedAt ?? new Date(),
        revokedAt: null,
      },
    });
  }
  return db.businessProductAddon.create({
    data: {
      businessId: input.businessId,
      addonCode: definition.code,
      status: ADDON_STATUSES.ACTIVE,
      quantity,
      source: input.source ?? ADDON_SOURCES.SUPPORT,
      providerRef: input.providerRef ?? null,
      grantedAt: new Date(),
    },
  });
}

export async function revokeProductAddon(
  db: Db,
  input: { businessId: string; addonCode: AddonCode },
) {
  const existing = await db.businessProductAddon.findUnique({
    where: {
      businessId_addonCode: {
        businessId: input.businessId,
        addonCode: input.addonCode,
      },
    },
  });
  if (!existing || existing.businessId !== input.businessId) {
    return null;
  }
  return db.businessProductAddon.update({
    where: { id: existing.id },
    data: {
      status: ADDON_STATUSES.INACTIVE,
      revokedAt: new Date(),
    },
  });
}

export async function listBusinessProductAddons(db: Db, businessId: string) {
  return db.businessProductAddon.findMany({
    where: { businessId },
    orderBy: { createdAt: "asc" },
  });
}
