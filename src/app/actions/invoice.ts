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
  ProjectPaymentError,
  recordOwnerInvoiceBalancePayment,
} from "@/lib/project-payments";
import { prisma } from "@/lib/prisma";

export type InvoiceActionState = {
  error?: string;
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

  if (!invoiceId) {
    return { error: "That invoice could not be marked paid." };
  }

  if (!isPaymentMethodValue(paymentMethod)) {
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
      amount,
      method: paymentMethod,
      note: paymentReference || null,
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
