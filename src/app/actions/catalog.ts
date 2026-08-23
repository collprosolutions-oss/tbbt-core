"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export type CatalogActionState = {
  error?: string;
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
    if (price.isNaN() || price.lt(0)) {
      return null;
    }
    return price;
  } catch {
    return null;
  }
}

export async function createServiceCatalogItem(
  _prev: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const access = await requireBusinessAccess();
  const name = readString(formData, "name");
  const description = readString(formData, "description");
  const price = parsePrice(readString(formData, "price"));

  if (!name || !price) {
    return { error: "Name and a valid price are required." };
  }

  await prisma.serviceCatalogItem.create({
    data: {
      businessId: access.businessId,
      name,
      price,
      description: description || null,
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
  const id = readString(formData, "id");
  const name = readString(formData, "name");
  const description = readString(formData, "description");
  const price = parsePrice(readString(formData, "price"));

  if (!id || !name || !price) {
    return { error: "Name and a valid price are required." };
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
      price,
      description: description || null,
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
