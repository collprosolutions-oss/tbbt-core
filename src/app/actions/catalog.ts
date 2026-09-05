"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  planStarterCatalogInstall,
  starterIntakeFields,
  starterPricingMode,
} from "@/lib/handyman-starter-catalog";
import { parsePricingMode } from "@/lib/pricing-mode";
import { prisma } from "@/lib/prisma";
import { normalizeServiceCategory } from "@/lib/service-catalog-category";
import { isActiveTrade } from "@/lib/trades";

export type CatalogActionState = {
  error?: string;
  added?: number;
  skipped?: number;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parsePrice(raw: string) {
  if (!raw) {
    return null;
  }
  try {
    const price = new Prisma.Decimal(raw);
    if (price.isNaN() || price.lte(0)) {
      return null;
    }
    return price;
  } catch {
    return null;
  }
}

function catalogPriceForMode(mode: string, rawPrice: string) {
  if (mode === "CUSTOM_QUOTE") {
    return { ok: true as const, price: null };
  }
  const price = parsePrice(rawPrice);
  if (!price) {
    return {
      ok: false as const,
      error: "Enter a valid price for this pricing mode.",
    };
  }
  return { ok: true as const, price };
}

export async function createServiceCatalogItem(
  _prev: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  const name = readString(formData, "name");
  const description = readString(formData, "description");
  const category = normalizeServiceCategory(readString(formData, "category"));
  const pricingMode = parsePricingMode(readString(formData, "pricingMode"));
  const priced = catalogPriceForMode(
    pricingMode ?? "",
    readString(formData, "price"),
  );

  if (!name || !pricingMode) {
    return { error: "Name and pricing mode are required." };
  }
  if (!priced.ok) {
    return { error: priced.error };
  }

  await prisma.serviceCatalogItem.create({
    data: {
      businessId: access.businessId,
      name,
      pricingMode,
      price: priced.price,
      description: description || null,
      category,
    },
  });

  revalidatePath("/services");
  return {};
}

export async function updateServiceCatalogItem(
  _prev: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  const id = readString(formData, "id");
  const name = readString(formData, "name");
  const description = readString(formData, "description");
  const category = normalizeServiceCategory(readString(formData, "category"));
  const pricingMode = parsePricingMode(readString(formData, "pricingMode"));
  const priced = catalogPriceForMode(
    pricingMode ?? "",
    readString(formData, "price"),
  );

  if (!id || !name || !pricingMode) {
    return { error: "Name and pricing mode are required." };
  }
  if (!priced.ok) {
    return { error: priced.error };
  }

  const item = access.assertOwned(
    await prisma.serviceCatalogItem.findFirst({
      where: { id, ...access.scope },
    }),
  );

  await prisma.serviceCatalogItem.update({
    where: { id: item.id },
    data: {
      name,
      pricingMode,
      price: priced.price,
      description: description || null,
      category,
    },
  });

  revalidatePath("/services");
  return {};
}

export async function setServiceCatalogItemActive(
  id: string,
  active: boolean,
): Promise<CatalogActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  const item = access.assertOwned(
    await prisma.serviceCatalogItem.findFirst({
      where: { id, ...access.scope },
    }),
  );

  await prisma.serviceCatalogItem.update({
    where: { id: item.id },
    data: { active },
  });

  revalidatePath("/services");
  return {};
}

export async function installHandymanStarterCatalog(): Promise<CatalogActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);

  if (!isActiveTrade(access.workspace.business.tradeCode)) {
    return {
      error: "The Handyman starter catalog is only for Handyman workspaces.",
    };
  }

  const existing = await prisma.serviceCatalogItem.findMany({
    where: access.scope,
    select: { name: true },
  });

  const plan = planStarterCatalogInstall(existing.map((item) => item.name));

  if (plan.add.length > 0) {
    await prisma.$transaction(
      plan.add.map((service) =>
        prisma.serviceCatalogItem.create({
          data: {
            businessId: access.businessId,
            name: service.name,
            description: service.description,
            pricingMode: starterPricingMode(service),
            price:
              service.startingPrice == null
                ? null
                : new Prisma.Decimal(service.startingPrice),
            // Stored directly from the starter template's own category
            // field, not derived later from the name.
            category: service.category,
            active: true,
            ...starterIntakeFields(service),
          },
        }),
      ),
    );
  }

  revalidatePath("/services");
  return {
    added: plan.add.length,
    skipped: plan.skip.length,
    message: `Added ${plan.add.length}. Skipped ${plan.skip.length} already on your list.`,
  };
}
