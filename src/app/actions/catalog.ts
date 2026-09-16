"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import {
  requireOperatingBusinessAccess,
  requireOperatingBusinessAccessForForm,
} from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { installHandymanStarterCatalogForBusiness } from "@/lib/starter-catalog-install";
import {
  deleteOwnedServiceCatalogItem,
  setOwnedServiceCatalogItemActive,
} from "@/lib/catalog-ops";
import { catalogDefinitionFromSnapshot } from "@/lib/estimate-calculators";
import { catalogCalculatorDefinition, joinCatalogDescription } from "@/lib/estimate-line-scope";
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
    if (!rawPrice.trim()) {
      return { ok: true as const, price: null };
    }
    const price = parsePrice(rawPrice);
    if (!price) {
      return {
        ok: false as const,
        error: "Enter a valid default price, or leave it blank.",
      };
    }
    return { ok: true as const, price };
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
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
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
      description: joinCatalogDescription(
        description || null,
        catalogDefinitionFromSnapshot(null, name),
      ),
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
  const access = await requireOperatingBusinessAccess();
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
      description: joinCatalogDescription(
        description || null,
        catalogCalculatorDefinition(item.description) ??
          catalogDefinitionFromSnapshot(null, name),
      ),
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
  try {
    const access = await requireOperatingBusinessAccess();
    await setOwnedServiceCatalogItemActive(prisma, access, { id, active });
    revalidatePath("/services");
    return {};
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Could not update that catalog service.",
    };
  }
}

export async function deleteServiceCatalogItem(
  id: string,
): Promise<CatalogActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await deleteOwnedServiceCatalogItem(prisma, access, { id });
    revalidatePath("/services");
    return { message: "Catalog service deleted. Existing estimates keep their recorded lines." };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message
          ? error.message
          : "Could not delete that catalog service.",
    };
  }
}

export async function installHandymanStarterCatalog(): Promise<CatalogActionState> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);

  if (!isActiveTrade(access.workspace.business.tradeCode)) {
    return {
      error: "The Handyman starter catalog is only for Handyman workspaces.",
    };
  }

  const plan = await installHandymanStarterCatalogForBusiness(
    prisma,
    access.businessId,
  );

  revalidatePath("/services");
  return {
    added: plan.added,
    skipped: plan.skipped,
    message: `Added ${plan.added}. Skipped ${plan.skipped} already on your list.`,
  };
}
