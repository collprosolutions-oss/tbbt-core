import { Prisma } from "@prisma/client";
import type { PurchaseOrderStatus } from "@/lib/materials/types";

export type PurchaseOrderReceiptQuantities = {
  quantityOrdered: Prisma.Decimal;
  quantityReceived: Prisma.Decimal;
  quantityRemaining: Prisma.Decimal;
  fullyReceived: boolean;
};

function asDecimal(value: Prisma.Decimal | string | number | null | undefined) {
  if (value instanceof Prisma.Decimal) return value;
  try {
    const decimal = new Prisma.Decimal(value ?? 0);
    return decimal.isNaN() ? new Prisma.Decimal(0) : decimal;
  } catch {
    return new Prisma.Decimal(0);
  }
}

/**
 * Ordered-versus-received math for one PO line. Uses Decimal so
 * remaining is exact (1.1 − 1 = 0.1, not 0.10000000000000009).
 * `quantityReceived` is the OWNER-recorded running total.
 */
export function purchaseOrderReceiptQuantities(input: {
  quantityOrdered: Prisma.Decimal | string | number;
  quantityReceived?: Prisma.Decimal | string | number | null;
}): PurchaseOrderReceiptQuantities {
  const quantityOrdered = asDecimal(input.quantityOrdered);
  const quantityReceived = asDecimal(input.quantityReceived);
  const difference = quantityOrdered.minus(quantityReceived);
  const quantityRemaining = difference.isNegative() ? new Prisma.Decimal(0) : difference;
  return {
    quantityOrdered,
    quantityReceived,
    quantityRemaining,
    fullyReceived: quantityOrdered.gt(0) && quantityReceived.gte(quantityOrdered),
  };
}

export function purchaseOrderStatusFromReceipts(
  lines: ReadonlyArray<PurchaseOrderReceiptQuantities>,
): PurchaseOrderStatus {
  if (lines.length > 0 && lines.every((line) => line.fullyReceived)) {
    return "RECEIVED";
  }
  if (lines.some((line) => line.quantityReceived.gt(0))) {
    return "PARTIALLY_RECEIVED";
  }
  return "ORDERED_EXTERNALLY";
}
