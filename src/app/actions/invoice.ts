"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { sendDraftInvoiceIfNeeded } from "@/lib/complete-job-invoice";
import { persistDraftInvoiceFromCompletedJob } from "@/lib/invoice-carry-forward";
import { isPaymentMethodValue } from "@/lib/invoice-payment";
import {
  InvoiceCreditError,
  invoiceCreditErrorMessage,
  recordOwnerInvoiceCredit,
} from "@/lib/invoice-credits";
import {
  PaymentError,
  resolveStripeCreditMismatchReview,
} from "@/lib/payments";
import {
  ProjectPaymentError,
  recordOwnerInvoiceBalancePayment,
} from "@/lib/project-payments";
import { prisma } from "@/lib/prisma";
import {
  RECURRING_OCCURRENCE_INVOICE_CREATED_MESSAGE,
  RECURRING_OCCURRENCE_INVOICE_REUSED_MESSAGE,
  createOwnedDraftInvoiceFromCompletedRecurringOccurrence,
  recurringOccurrenceInvoiceErrorMessage,
} from "@/lib/recurring-occurrence-invoice";

export type InvoiceActionState = {
  error?: string;
  message?: string;
  invoiceId?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Invoice billable total is computed ONCE at create and never rewritten.
 * The first invoice for a job is ORIGINAL (approved estimate + approved
 * Change Orders at that moment). A Change Order approved AFTER that
 * invoice exists is billed on a separate SUPPLEMENTAL / balance invoice —
 * never retro-added to the original. persistDraftInvoiceFromCompletedJob
 * is idempotent and tenant-scoped.
 *
 * Approved estimate / change-order line items are copied as LineItem
 * snapshots. Recovery / manual create also sends the invoice (DRAFT → SENT)
 * so the owner is not left with a second send step after Complete Job.
 */
export async function createInvoiceFromJob(
  jobId: string,
): Promise<InvoiceActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
      select: { id: true, status: true, businessId: true },
    }),
  );

  if (job.status !== "COMPLETED") {
    return { error: "Only a completed job can become an invoice." };
  }

  const result = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: access.businessId,
    jobId: job.id,
  });

  if (!result.ok) {
    return { error: result.error };
  }

  const sent = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: access.businessId,
    invoiceId: result.invoiceId,
    businessName: access.workspace.business.name,
  });
  if (!sent.ok) {
    revalidatePath(`/jobs/${job.id}`);
    revalidatePath(`/invoices/${result.invoiceId}`);
    return { error: sent.error };
  }

  revalidatePath(`/jobs/${job.id}`);
  revalidatePath("/invoices");
  redirect(`/invoices/${result.invoiceId}`);
}

/**
 * OWNER-only. Creates or reuses a DRAFT invoice for one completed
 * recurring occurrence. Does not send, charge, or bill the source job.
 */
export async function createDraftInvoiceFromCompletedRecurringOccurrence(
  _prev: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const jobId = readString(formData, "jobId");
  if (!jobId) {
    return { error: "That recurring booking could not be invoiced." };
  }

  try {
    const result = await createOwnedDraftInvoiceFromCompletedRecurringOccurrence(
      prisma,
      access,
      {
        jobId,
        confirmCreate: readString(formData, "confirmCreate"),
      },
    );
    revalidatePath("/jobs");
    revalidatePath("/invoices");
    revalidatePath(`/jobs/${jobId}`);
    revalidatePath(`/invoices/${result.invoiceId}`);
    return {
      invoiceId: result.invoiceId,
      message: result.reused
        ? RECURRING_OCCURRENCE_INVOICE_REUSED_MESSAGE
        : RECURRING_OCCURRENCE_INVOICE_CREATED_MESSAGE,
    };
  } catch (error) {
    return {
      error: recurringOccurrenceInvoiceErrorMessage(
        error,
        "That draft invoice could not be created.",
      ),
    };
  }
}

export async function markInvoiceSent(
  invoiceId: string,
): Promise<InvoiceActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
    }),
  );

  const sent = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: access.businessId,
    invoiceId: invoice.id,
    businessName: access.workspace.business.name,
  });

  if (!sent.ok) {
    return { error: sent.error };
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  if (invoice.jobId) {
    revalidatePath(`/jobs/${invoice.jobId}`);
  }
  return {};
}

export async function markInvoicePaid(
  _prev: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const invoiceId = readString(formData, "invoiceId");
  const paymentMethod = readString(formData, "paymentMethod");
  const paymentReference = readString(formData, "paymentReference");
  const amount = readString(formData, "amount");
  const closeCovered = readString(formData, "closeCovered") === "1";

  if (!invoiceId) {
    return { error: "That invoice could not be marked paid." };
  }

  if (!closeCovered && !isPaymentMethodValue(paymentMethod)) {
    return { error: "Choose a payment method." };
  }

  access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
      select: { id: true, businessId: true },
    }),
  );

  try {
    await recordOwnerInvoiceBalancePayment(prisma, access, {
      invoiceId,
      amount: closeCovered ? null : amount,
      method: closeCovered ? null : paymentMethod,
      note: closeCovered ? null : paymentReference || null,
      closeCovered,
    });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/customers");
    revalidatePath("/dashboard");
    return {};
  } catch (error) {
    if (error instanceof ProjectPaymentError) {
      return { error: error.message };
    }
    throw error;
  }
}

export async function recordInvoiceCredit(
  _prev: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  requireBusinessCapability(access, CAPABILITIES.RECORD_INVOICE_CREDIT);
  const invoiceId = readString(formData, "invoiceId");
  const amount = readString(formData, "amount");
  const reason = readString(formData, "reason");
  const idempotencyKey = readString(formData, "idempotencyKey");

  if (!invoiceId) {
    return { error: "That credit could not be recorded." };
  }

  access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
      select: { id: true, businessId: true },
    }),
  );

  try {
    await recordOwnerInvoiceCredit(prisma, access, {
      invoiceId,
      amount,
      reason,
      idempotencyKey,
    });
    revalidatePath("/invoices");
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/customers");
    revalidatePath("/dashboard");
    return {};
  } catch (error) {
    if (error instanceof InvoiceCreditError || error instanceof ProjectPaymentError) {
      return { error: invoiceCreditErrorMessage(error, error.message) };
    }
    throw error;
  }
}

export async function resolveInvoiceStripeCreditMismatch(
  _prev: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return { error: operating.error };
  const access = operating.access;
  const paymentId = readString(formData, "paymentId");
  const invoiceId = readString(formData, "invoiceId");
  if (!paymentId) {
    return { error: "That review could not be resolved." };
  }
  try {
    await resolveStripeCreditMismatchReview(prisma, access, paymentId);
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    if (invoiceId) {
      revalidatePath(`/invoices/${invoiceId}`);
    }
    return {};
  } catch (error) {
    if (error instanceof PaymentError) {
      return { error: error.message };
    }
    throw error;
  }
}
