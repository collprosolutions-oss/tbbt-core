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
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
  recordSucceededPayment,
} from "@/lib/project-payments";
import { prisma } from "@/lib/prisma";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";

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

  if (!invoiceId) {
    return { error: "That invoice could not be marked paid." };
  }

  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
      include: { job: { select: { estimateId: true } } },
    }),
  );

  // Already paid: no second payment action, and never overwrite the
  // recorded paidAt/method/reference.
  if (invoice.status === "PAID") {
    return {};
  }

  if (invoice.status !== "SENT") {
    return { error: "Send the invoice before marking it paid." };
  }

  if (!isPaymentMethodValue(paymentMethod)) {
    return { error: "Choose a payment method." };
  }

  const payments = await listPaymentsForInvoice(prisma, {
    businessId: access.businessId,
    invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
  });
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments,
  });
  if (breakdown.amountDue.gt(0)) {
    await recordSucceededPayment(prisma, {
      businessId: invoice.businessId,
      customerId: invoice.customerId,
      estimateId: invoice.job?.estimateId ?? null,
      jobId: invoice.jobId,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: breakdown.amountDue,
      method: paymentMethod,
      note: paymentReference || null,
    });
  }

  const updated = await prisma.invoice.updateMany({
    where: {
      id: invoice.id,
      businessId: access.businessId,
      status: "SENT",
    },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paymentMethod,
      paymentReference: paymentReference || null,
    },
  });

  if (updated.count !== 1) {
    return { error: "Send the invoice before marking it paid." };
  }

  await emitAndProcessBusinessEvent(prisma, {
    businessId: access.businessId,
    type: "INVOICE_PAID",
    subjectType: "INVOICE",
    subjectId: invoice.id,
    payload: { customerId: invoice.customerId },
    idempotencyKey: `INVOICE_PAID:${invoice.id}`,
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  return {};
}
