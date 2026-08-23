"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export type EstimateActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parseDecimal(raw: string, allowZero = false) {
  if (!raw) {
    return null;
  }
  try {
    const value = new Prisma.Decimal(raw);
    if (value.isNaN() || value.lt(0) || (!allowZero && value.lte(0))) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function persistEstimateTotal(
  tx: Prisma.TransactionClient,
  estimateId: string,
  businessId: string,
) {
  const items = await tx.lineItem.findMany({
    where: { estimateId, businessId },
    select: { total: true },
  });
  const total = items.reduce(
    (sum, item) => sum.add(item.total),
    new Prisma.Decimal(0),
  );
  await tx.estimate.update({
    where: { id: estimateId },
    data: { total },
  });
}

export async function createEstimate(serviceRequestId: string) {
  const access = await requireBusinessAccess();
  const request = access.assertOwned(
    await prisma.serviceRequest.findFirst({
      where: { id: serviceRequestId, ...access.scope },
    }),
  );

  const existing = await prisma.estimate.findFirst({
    where: {
      ...access.scope,
      serviceRequestId: request.id,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (existing) {
    redirect(`/estimates/${existing.id}`);
  }

  const estimate = await prisma.estimate.create({
    data: {
      businessId: access.businessId,
      serviceRequestId: request.id,
      customerId: request.customerId,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });

  revalidatePath("/requests");
  redirect(`/estimates/${estimate.id}`);
}

export async function addCatalogLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  const estimateId = readString(formData, "estimateId");
  const catalogItemId = readString(formData, "catalogItemId");
  const quantity = parseDecimal(readString(formData, "quantity"));

  if (!estimateId || !catalogItemId || !quantity) {
    return { error: "Catalog item and a quantity greater than 0 are required." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  const catalogItem = access.assertOwned(
    await prisma.serviceCatalogItem.findFirst({
      where: { id: catalogItemId, ...access.scope },
    }),
  );

  if (!catalogItem.active) {
    return { error: "That service is not active." };
  }

  const unitPrice = catalogItem.price;
  const total = quantity.mul(unitPrice);

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        serviceCatalogItemId: catalogItem.id,
        description: catalogItem.name,
        quantity,
        unitPrice,
        total,
      },
    });
    await persistEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function addCustomLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  const estimateId = readString(formData, "estimateId");
  const description = readString(formData, "description");
  const quantity = parseDecimal(readString(formData, "quantity"));
  const unitPrice = parseDecimal(readString(formData, "unitPrice"), true);

  if (!estimateId || !description || !quantity || !unitPrice) {
    return { error: "Description, quantity, and unit price are required." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  const total = quantity.mul(unitPrice);

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        description,
        quantity,
        unitPrice,
        total,
      },
    });
    await persistEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}
