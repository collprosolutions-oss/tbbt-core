/**
 * Owner Complete Job leaves a DRAFT invoice. Send is a separate click.
 * Field / native complete never create or send an invoice.
 */

export const COMPLETE_JOB_DRAFT_INVOICE_MESSAGE =
  "Job completed. Invoice drafted - review it and press Send when ready.";

export const FIELD_COMPLETE_JOB_MESSAGE =
  "Job completed. The owner will review and send the invoice when ready.";

export function completeJobDraftInvoiceHref(invoiceId: string) {
  return `/invoices/${invoiceId}`;
}
