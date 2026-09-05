"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftChangeOrderTotal } from "@/lib/change-order";
import { prisma } from "@/lib/prisma";
import {
  addChangeOrderDraftLines,
  isUnpricedCustomQuoteDraftLine,
} from "@/lib/request-estimate-draft";

export type ChangeOrderActionState = {
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

async function revalidateChangeOrder(jobId: string, changeOrderId: string) {
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/jobs/${jobId}/change-orders/${changeOrderId}`);
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { projectToken: true },
  });
  if (job) {
    revalidatePath(`/p/${job.projectToken}`);
  }
}

/**
 * Creates a DRAFT ChangeOrder for a Job. If `additionalWorkRequestId` is
 * supplied, that OPEN AdditionalWorkRequest is atomically linked to the new
 * ChangeOrder and marked CONVERTED -- the request itself is never treated
 * as approval; the resulting ChangeOrder still starts DRAFT and must be
 * priced, sent, and separately approved like any other.
 */
export async function createChangeOrder(
  _prev: ChangeOrderActionState,
  formData: FormData,
): Promise<ChangeOrderActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const jobId = readString(formData, "jobId");
  const title = readString(formData, "title");
  const additionalWorkRequestId = readString(
    formData,
    "additionalWorkRequestId",
  );

  if (!jobId || !title) {
    return { error: "A title is required to create a change order." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );

  let sourceRequest: {
    id: string;
    businessId: string;
    status: string;
    items: Array<{
      quantity: number;
      customDescription: string | null;
      serviceCatalogItem: {
        id: string;
        name: string;
        pricingMode: string;
        price: Prisma.Decimal | null;
      } | null;
    }>;
  } | null = null;
  if (additionalWorkRequestId) {
    sourceRequest = access.assertOwned(
      await prisma.additionalWorkRequest.findFirst({
        where: {
          id: additionalWorkRequestId,
          jobId: job.id,
          ...access.scope,
        },
        select: {
          id: true,
          businessId: true,
          status: true,
          items: {
            orderBy: { sortOrder: "asc" },
            select: {
              quantity: true,
              customDescription: true,
              serviceCatalogItem: {
                select: {
                  id: true,
                  name: true,
                  pricingMode: true,
                  price: true,
                },
              },
            },
          },
        },
      }),
    );
    if (sourceRequest.status !== "OPEN") {
      return { error: "That request has already been handled." };
    }
  }

  const changeOrder = await prisma.$transaction(async (tx) => {
    const created = await tx.changeOrder.create({
      data: {
        businessId: access.businessId,
        jobId: job.id,
        title,
      },
    });

    const sourceRequestId = sourceRequest?.id ?? null;
    if (sourceRequestId) {
      const linked = await tx.additionalWorkRequest.updateMany({
        where: { id: sourceRequestId, businessId: access.businessId, status: "OPEN" },
        data: {
          status: "CONVERTED",
          changeOrderId: created.id,
          reviewedAt: new Date(),
        },
      });
      if (linked.count !== 1) {
        throw new Error("That request has already been handled.");
      }
      if (
        sourceRequest &&
        sourceRequest.items.some((item) => item.serviceCatalogItem)
      ) {
        await addChangeOrderDraftLines(tx, {
          businessId: access.businessId,
          changeOrderId: created.id,
          items: sourceRequest.items,
        });
        await persistDraftChangeOrderTotal(tx, created.id, access.businessId);
      }
    }

    return created;
  });

  revalidatePath(`/jobs/${job.id}`);
  redirect(`/jobs/${job.id}/change-orders/${changeOrder.id}`);
}

export async function updateChangeOrderTitle(
  _prev: ChangeOrderActionState,
  formData: FormData,
): Promise<ChangeOrderActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrderId = readString(formData, "changeOrderId");
  const title = readString(formData, "title");

  if (!changeOrderId || !title) {
    return { error: "A title is required." };
  }

  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
    }),
  );

  if (changeOrder.status !== "DRAFT") {
    return { error: "Only a draft change order can be edited." };
  }

  await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, businessId: access.businessId, status: "DRAFT" },
    data: { title },
  });

  await revalidateChangeOrder(changeOrder.jobId, changeOrder.id);
  return {};
}

export async function addChangeOrderLineItem(
  _prev: ChangeOrderActionState,
  formData: FormData,
): Promise<ChangeOrderActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrderId = readString(formData, "changeOrderId");
  const description = readString(formData, "description");
  const quantity = parseDecimal(readString(formData, "quantity"));
  const unitPrice = parseDecimal(readString(formData, "unitPrice"), true);
  const type = readString(formData, "type");

  if (!changeOrderId || !description || !quantity || !unitPrice) {
    return { error: "Description, quantity, and price are required." };
  }

  if (type !== "LABOR" && type !== "MATERIAL" && type !== "OTHER") {
    return { error: "Choose Labor, Material, or Other." };
  }

  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
    }),
  );

  if (changeOrder.status !== "DRAFT") {
    return { error: "Only a draft change order can be edited." };
  }

  const total = quantity.mul(unitPrice);

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        changeOrderId: changeOrder.id,
        description,
        quantity,
        unitPrice,
        total,
        type,
      },
    });
    await persistDraftChangeOrderTotal(tx, changeOrder.id, access.businessId);
  });

  await revalidateChangeOrder(changeOrder.jobId, changeOrder.id);
  return {};
}

export async function removeChangeOrderLineItem(
  _prev: ChangeOrderActionState,
  formData: FormData,
): Promise<ChangeOrderActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrderId = readString(formData, "changeOrderId");
  const lineItemId = readString(formData, "lineItemId");

  if (!changeOrderId || !lineItemId) {
    return { error: "That line item could not be removed." };
  }

  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
    }),
  );

  if (changeOrder.status !== "DRAFT") {
    return { error: "Only a draft change order can be edited." };
  }

  const lineItem = access.assertOwned(
    await prisma.lineItem.findFirst({
      where: {
        id: lineItemId,
        changeOrderId: changeOrder.id,
        ...access.scope,
      },
    }),
  );

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({
      where: {
        id: lineItem.id,
        changeOrderId: changeOrder.id,
        businessId: access.businessId,
      },
    });
    await persistDraftChangeOrderTotal(tx, changeOrder.id, access.businessId);
  });

  await revalidateChangeOrder(changeOrder.jobId, changeOrder.id);
  return {};
}

/**
 * DRAFT -> SENT. Once this succeeds, no application code path ever edits
 * this ChangeOrder's title/lineItems/total again (see the immutability note
 * on the ChangeOrder model in prisma/schema.prisma) -- the row itself is now
 * the exact terms the customer will see and approve/decline.
 */
export async function sendChangeOrder(
  _prev: ChangeOrderActionState,
  formData: FormData,
): Promise<ChangeOrderActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrderId = readString(formData, "changeOrderId");

  if (!changeOrderId) {
    return { error: "That change order could not be sent." };
  }

  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
      include: {
        lineItems: { select: { id: true, unitPrice: true, description: true } },
      },
    }),
  );

  if (changeOrder.status !== "DRAFT") {
    return { error: "Only a draft change order can be sent." };
  }

  if (changeOrder.lineItems.length === 0) {
    return { error: "Add at least one line item before sending." };
  }
  if (changeOrder.lineItems.some((item) => isUnpricedCustomQuoteDraftLine(item))) {
    return { error: "Enter a price for each custom-quote line before sending." };
  }

  const updated = await prisma.changeOrder.updateMany({
    where: {
      id: changeOrder.id,
      businessId: access.businessId,
      status: "DRAFT",
    },
    data: { status: "SENT", sentAt: new Date() },
  });

  if (updated.count !== 1) {
    return { error: "Only a draft change order can be sent." };
  }

  await revalidateChangeOrder(changeOrder.jobId, changeOrder.id);
  return {};
}

/**
 * Withdraws a change order the customer has not (yet) approved or declined.
 * Terminal -- a CANCELLED change order can never be revived, sent, or
 * edited. If the terms still need to be offered, create a new ChangeOrder.
 */
export async function cancelChangeOrder(
  _prev: ChangeOrderActionState,
  formData: FormData,
): Promise<ChangeOrderActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrderId = readString(formData, "changeOrderId");

  if (!changeOrderId) {
    return { error: "That change order could not be cancelled." };
  }

  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
    }),
  );

  if (changeOrder.status !== "DRAFT" && changeOrder.status !== "SENT") {
    return {
      error: "Only a draft or sent change order can be cancelled.",
    };
  }

  const updated = await prisma.changeOrder.updateMany({
    where: {
      id: changeOrder.id,
      businessId: access.businessId,
      status: { in: ["DRAFT", "SENT"] },
    },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });

  if (updated.count !== 1) {
    return {
      error: "Only a draft or sent change order can be cancelled.",
    };
  }

  await revalidateChangeOrder(changeOrder.jobId, changeOrder.id);
  return {};
}
