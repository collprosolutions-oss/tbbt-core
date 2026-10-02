/**
 * Shared payment-to-invoice attribution.
 *
 * One Payment is never counted on more than one invoice. Invoice pages,
 * accounting export, collected cash, profitability outstanding, and
 * reports remaining-due must use this rule.
 *
 * 1. Payment.invoiceId present → belongs ONLY to that invoice.
 * 2. Payment.invoiceId null (legacy estimate/job-linked) → belongs ONLY
 *    to the ORIGINAL invoice for that job. Supplemental invoices never
 *    claim unallocated job-only rows.
 * 3. Once a job has ORIGINAL + SUPPLEMENTAL invoices, an unallocated
 *    job-only Payment is never counted independently on every invoice.
 */
import { isOriginalInvoiceKind } from "@/lib/revenue-integrity";

export type InvoicePaymentTarget = {
  id: string;
  jobId?: string | null;
  kind?: string | null;
};

export function paymentBelongsToInvoice(
  payment: { invoiceId?: string | null; jobId?: string | null },
  invoice: InvoicePaymentTarget,
): boolean {
  if (payment.invoiceId) {
    return payment.invoiceId === invoice.id;
  }
  if (!isOriginalInvoiceKind(invoice.kind)) {
    return false;
  }
  return Boolean(invoice.jobId) && payment.jobId === invoice.jobId;
}

export function paymentsBelongingToInvoice<
  T extends { id: string; invoiceId?: string | null; jobId?: string | null },
>(invoice: InvoicePaymentTarget, payments: readonly T[]): T[] {
  const seen = new Set<string>();
  return payments.filter((row) => {
    if (seen.has(row.id)) return false;
    const belongs = paymentBelongsToInvoice(row, invoice);
    if (belongs) seen.add(row.id);
    return belongs;
  });
}
