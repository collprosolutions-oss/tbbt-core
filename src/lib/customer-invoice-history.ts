/**
 * Customer-profile invoice-history display.
 *
 * Surfaces recorded invoice fields only. Does not calculate new financial
 * truth, invent a paid date, or invent a payment method.
 */
import { paymentMethodLabel } from "@/lib/invoice-payment";

export type CustomerInvoiceHistoryContext = {
  status: string;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentMethodLabel: string | null;
};

export function customerInvoiceHistoryContext(invoice: {
  status: string;
  paidAt: Date | null;
  paymentMethod: string | null;
}): CustomerInvoiceHistoryContext {
  const recordedMethod = invoice.paymentMethod?.trim() || null;
  const paidAt =
    invoice.status === "PAID" && invoice.paidAt ? invoice.paidAt : null;
  return {
    status: invoice.status,
    paidAt,
    paymentMethod: recordedMethod,
    paymentMethodLabel: recordedMethod ? paymentMethodLabel(recordedMethod) : null,
  };
}
