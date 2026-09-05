import { Prisma } from "@prisma/client";
import { invoiceAmountDue } from "@/lib/invoice-document";
import type { InvoiceAmount } from "@/lib/payments/types";

export function toInvoiceDecimal(value: InvoiceAmount): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  return new Prisma.Decimal(typeof value === "number" ? value.toString() : String(value));
}

export function invoiceAmountToCents(total: InvoiceAmount): number {
  const cents = toInvoiceDecimal(total).mul(100);
  if (!cents.isInteger()) {
    throw new Error("Invoice total must be a whole-cent amount.");
  }
  const asNumber = cents.toNumber();
  if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
    throw new Error("Invoice total is not a payable amount.");
  }
  return asNumber;
}

export function invoiceDueCents(status: string, total: InvoiceAmount): number {
  return invoiceAmountToCents(invoiceAmountDue(status, toInvoiceDecimal(total)));
}

export function payInvoiceButtonLabel(amountLabel: string) {
  return `Pay Invoice — ${amountLabel}`;
}
