import { Prisma } from "@prisma/client";
import type { LineItemType } from "@prisma/client";

/**
 * Change Order lifecycle + totals.
 *
 * A ChangeOrder is a separately-approved, post-contract scope/pricing
 * change on a Job (see prisma/schema.prisma). It never rewrites the
 * original approved Estimate/EstimateVersion -- see src/lib/job-work-order.ts
 * for that, unchanged. This module only ever reads/derives from ChangeOrder
 * rows plus the pure "what is the current approved project total" math;
 * mutations live in src/app/actions/change-order.ts.
 */

const ZERO = new Prisma.Decimal(0);

export const CHANGE_ORDER_STATUSES = [
  "DRAFT",
  "SENT",
  "APPROVED",
  "DECLINED",
  "CANCELLED",
] as const;

export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

/**
 * Statuses a customer is ever allowed to see on the Project Portal. DRAFT is
 * an internal-only working state (never sent, so the customer has never
 * seen it); CANCELLED is an owner/admin withdrawal the customer never acted
 * on. Showing either would either leak unsent internal pricing or confuse a
 * customer with a change order they never had a chance to respond to.
 */
export const CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES = [
  "SENT",
  "APPROVED",
  "DECLINED",
] as const;

export function isCustomerVisibleChangeOrderStatus(
  status: string,
): status is (typeof CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES)[number] {
  return (
    CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES as readonly string[]
  ).includes(status);
}

/** Plain-language status for the customer-facing portal. */
export function customerFacingChangeOrderStatusLabel(status: string): string {
  switch (status) {
    case "SENT":
      return "Pending Approval";
    case "APPROVED":
      return "Approved";
    case "DECLINED":
      return "Declined";
    default:
      return status;
  }
}

export type ChangeOrderLike = {
  status: string;
  total: Prisma.Decimal;
};

/** Sum of only APPROVED change orders' totals. DRAFT/SENT/DECLINED/CANCELLED never contribute. */
export function sumApprovedChangeOrderTotals(
  changeOrders: readonly ChangeOrderLike[],
): Prisma.Decimal {
  return changeOrders
    .filter((changeOrder) => changeOrder.status === "APPROVED")
    .reduce((sum, changeOrder) => sum.add(changeOrder.total), ZERO);
}

/**
 * Original Approved Total (from the bound EstimateVersion, or the legacy
 * fallback -- see resolveApprovedWorkOrderScope) PLUS every currently
 * APPROVED Change Order's total. Never includes DRAFT/SENT/DECLINED/
 * CANCELLED change orders -- those must never move this number.
 */
export function resolveCurrentApprovedProjectTotal(
  originalApprovedTotal: Prisma.Decimal,
  changeOrders: readonly ChangeOrderLike[],
): Prisma.Decimal {
  return originalApprovedTotal.add(sumApprovedChangeOrderTotals(changeOrders));
}

export type ChangeOrderLineItemSummary = {
  id: string;
  description: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  total: Prisma.Decimal;
  type: LineItemType;
};

export type ChangeOrderSummary = {
  id: string;
  status: string;
  title: string;
  total: Prisma.Decimal;
  createdAt: Date;
  sentAt: Date | null;
  approvedAt: Date | null;
  declinedAt: Date | null;
  cancelledAt: Date | null;
  lineItems: ChangeOrderLineItemSummary[];
};

type TransactionClient = Prisma.TransactionClient;

/**
 * Recomputes and persists a DRAFT ChangeOrder's total from its own current
 * LineItem rows (LineItem.changeOrderId). No-ops for any non-DRAFT
 * ChangeOrder -- once SENT, nothing may rewrite its total again (see the
 * immutability note on the ChangeOrder model in prisma/schema.prisma).
 * Callers must run this inside the same transaction as the line item
 * mutation that triggered it, matching persistDraftEstimateTotal's pattern
 * in src/lib/labor-minimum.ts.
 */
export async function persistDraftChangeOrderTotal(
  tx: TransactionClient,
  changeOrderId: string,
  businessId: string,
) {
  const changeOrder = await tx.changeOrder.findFirst({
    where: { id: changeOrderId, businessId },
    select: { id: true, status: true },
  });

  if (!changeOrder || changeOrder.status !== "DRAFT") {
    return;
  }

  const items = await tx.lineItem.findMany({
    where: { changeOrderId, businessId },
    select: { total: true },
  });

  const total = items.reduce((sum, item) => sum.add(item.total), ZERO);

  await tx.changeOrder.update({
    where: { id: changeOrder.id },
    data: { total },
  });
}
