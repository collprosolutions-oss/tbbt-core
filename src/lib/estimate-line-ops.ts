/**
 * Draft estimate line mutations used by the estimate builder and the
 * focused custom-price check. Callers must already have
 * requireBusinessAccess(); this module never trusts a browser businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import {
  isUnpricedCustomQuoteDraftLine,
  pricedCustomQuoteDescription,
} from "@/lib/request-estimate-draft";

type Db = PrismaClient;

export class EstimateLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateLineError";
  }
}

export function estimateLineErrorMessage(error: unknown, fallback: string) {
  if (error instanceof EstimateLineError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

function parsePositiveDecimal(raw: string, label: string) {
  if (!raw.trim()) {
    throw new EstimateLineError(`Enter a ${label}.`);
  }
  try {
    const value = new Prisma.Decimal(raw);
    if (value.isNaN() || value.lte(0)) {
      throw new EstimateLineError(`Enter a ${label} greater than zero.`);
    }
    return value;
  } catch (error) {
    if (error instanceof EstimateLineError) throw error;
    throw new EstimateLineError(`Enter a valid ${label}.`);
  }
}

/**
 * Assign the owner's job price (and optional quantity) on a prefilled
 * custom-quote / price-required draft line. Does not create a catalog
 * item and does not change existing catalog prices.
 */
export async function priceDraftEstimateLine(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    unitPrice: string;
    quantity?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);

  const unitPrice = parsePositiveDecimal(input.unitPrice, "price");
  const quantity = input.quantity?.trim()
    ? parsePositiveDecimal(input.quantity, "quantity")
    : null;

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }

  const line = access.assertOwned(
    await db.lineItem.findFirst({
      where: {
        id: input.lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );

  if (!isUnpricedCustomQuoteDraftLine(line)) {
    throw new EstimateLineError("This line already has a price.");
  }

  const nextQuantity = quantity ?? line.quantity;
  const total = nextQuantity.mul(unitPrice);
  const description = pricedCustomQuoteDescription(line.description);

  await db.$transaction(async (tx) => {
    await tx.lineItem.update({
      where: { id: line.id },
      data: {
        unitPrice,
        quantity: nextQuantity,
        total,
        description,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return db.lineItem.findFirstOrThrow({
    where: { id: line.id, businessId: access.businessId },
  });
}
