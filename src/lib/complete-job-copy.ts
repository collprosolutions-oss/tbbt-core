/**
 * Owner Complete Job leaves a DRAFT invoice. Send is a separate click.
 * Field / native complete never create or send an invoice.
 */

export const COMPLETE_JOB_DRAFT_INVOICE_MESSAGE =
  "Job completed. Invoice drafted - review it and press Send when ready.";

export const FIELD_COMPLETE_JOB_MESSAGE =
  "This job is complete. The owner will review and send the invoice when ready.";

export const INVOICE_ALREADY_SENT_MESSAGE = "already sent";

export const COMPLETED_JOB_NO_INVOICE_MESSAGE =
  "Completing this job did not create an invoice. Create and send one from the approved work.";

export const COMPLETED_JOB_BILLED_MESSAGE =
  "Approved work on this job is billed. Opening an invoice will not rewrite it.";

export function completeJobDraftInvoiceHref(invoiceId: string) {
  return `/invoices/${invoiceId}`;
}

/**
 * Persistent Invoice-card copy on the owner job page after Complete Job.
 * Draft-only attention must show the Send prompt, not the generic unbilled detail.
 */
export function completedJobPageInvoiceMessage(input: {
  unbilled: boolean;
  reason?: string | null;
  detail?: string | null;
  invoiceStatuses: readonly string[];
}): string {
  if (input.reason === "draft-only-invoice") {
    return COMPLETE_JOB_DRAFT_INVOICE_MESSAGE;
  }
  if (input.unbilled) {
    return input.detail || "Completed job has unbilled approved work";
  }
  if (input.invoiceStatuses.length === 0) {
    return COMPLETED_JOB_NO_INVOICE_MESSAGE;
  }
  if (input.invoiceStatuses.includes("DRAFT")) {
    return COMPLETE_JOB_DRAFT_INVOICE_MESSAGE;
  }
  return COMPLETED_JOB_BILLED_MESSAGE;
}

/** Work-order card copy when a completed job already has an invoice. */
export function workOrderCardCompletedInvoiceMessage(
  invoiceStatus: string | null | undefined,
): string | null {
  return invoiceStatus === "DRAFT" ? COMPLETE_JOB_DRAFT_INVOICE_MESSAGE : null;
}

/** Owner invoice page status copy. Send lives on this page. */
export function invoicePageStatusMessage(
  status: string,
  dueIsZero = false,
): string | null {
  if (status === "DRAFT") {
    return COMPLETE_JOB_DRAFT_INVOICE_MESSAGE;
  }
  if (status === "SENT") {
    return dueIsZero
      ? "Recorded payments already cover this invoice. Mark it paid when you are ready to close it."
      : "Record the remaining balance here once the customer pays.";
  }
  if (status === "PAID") {
    return "This invoice is paid and cannot be reopened.";
  }
  return null;
}
