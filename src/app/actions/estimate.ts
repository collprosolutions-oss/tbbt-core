"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
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

async function findReusableCustomer(
  db: {
    customer: {
      findFirst: (args: {
        where: { businessId: string; email?: string; phone?: string };
      }) => Promise<{ id: string; businessId: string } | null>;
    };
  },
  businessId: string,
  email: string,
  phone: string,
) {
  if (email) {
    const byEmail = await db.customer.findFirst({
      where: { businessId, email },
    });
    if (byEmail) {
      return byEmail;
    }
  }

  if (phone) {
    return db.customer.findFirst({
      where: { businessId, phone },
    });
  }

  return null;
}

export async function createManualEstimate(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  const mode = readString(formData, "mode");

  if (mode !== "existing" && mode !== "new") {
    return { error: "Choose an existing customer or enter a new customer." };
  }

  if (mode === "existing") {
    const selectedId = readString(formData, "customerId");
    if (!selectedId) {
      return { error: "Choose a customer." };
    }

    const customer = access.assertOwned(
      await prisma.customer.findFirst({
        where: { id: selectedId, ...access.scope },
      }),
    );

    const estimate = await prisma.estimate.create({
      data: {
        businessId: access.businessId,
        customerId: customer.id,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });

    revalidatePath("/estimates");
    redirect(`/estimates/${estimate.id}`);
  }

  const name = readString(formData, "name");
  const email = readString(formData, "email").toLowerCase();
  const phone = readString(formData, "phone");
  const address = readString(formData, "address");

  if (!name) {
    return { error: "Customer name is required." };
  }

  const estimate = await prisma.$transaction(async (tx) => {
    const existing = await findReusableCustomer(
      tx,
      access.businessId,
      email,
      phone,
    );
    const customer = existing
      ? access.assertOwned(existing)
      : await tx.customer.create({
          data: {
            businessId: access.businessId,
            name,
            email: email || null,
            phone: phone || null,
          },
        });

    if (address) {
      await tx.property.create({
        data: {
          businessId: access.businessId,
          customerId: customer.id,
          addressLine1: address,
        },
      });
    }

    return tx.estimate.create({
      data: {
        businessId: access.businessId,
        customerId: customer.id,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });
  });

  revalidatePath("/estimates");
  revalidatePath("/customers");
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

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

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
        type: "LABOR",
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
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
  const type = readString(formData, "type");

  if (!estimateId || !description || !quantity || !unitPrice) {
    return { error: "Description, quantity, and unit price are required." };
  }

  if (type !== "LABOR" && type !== "MATERIAL" && type !== "OTHER") {
    return { error: "Choose Labor, Material, or Other." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

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
        type,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function setEstimateLaborMinimumWaived(
  estimateId: string,
  waived: boolean,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { laborMinimumWaived: waived },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function removeEstimateLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  const estimateId = readString(formData, "estimateId");
  const lineItemId = readString(formData, "lineItemId");

  if (!estimateId || !lineItemId) {
    return { error: "That line item could not be removed." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  const lineItem = access.assertOwned(
    await prisma.lineItem.findFirst({
      where: {
        id: lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({
      where: {
        id: lineItem.id,
        estimateId: estimate.id,
        businessId: access.businessId,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function clearDraftEstimate(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  const estimateId = readString(formData, "estimateId");

  if (!estimateId) {
    return { error: "That estimate could not be cleared." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({
      where: {
        estimateId: estimate.id,
        businessId: access.businessId,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}
