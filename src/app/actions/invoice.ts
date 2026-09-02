"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftInvoiceFromCompletedJob } from "@/lib/invoice-carry-forward";
import { isPaymentMethodValue } from "@/lib/invoice-payment";
import { prisma } from "@/lib/prisma";

export type InvoiceActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Invoice billable total = Original Approved Total (from the bound
 * EstimateVersion, or the legacy-estimate fallback -- see
 * resolveApprovedWorkOrderScope) PLUS every currently APPROVED Change
 * Order's total (see resolveCurrentApprovedProjectTotal in
 * src/lib/change-order.ts). DRAFT/SENT/DECLINED/CANCELLED change orders
 * never contribute.
 *
 * This total is computed ONCE, at invoice creation, and never
 * recalculated afterward: a Change Order approved AFTER this Job's invoice
 * already exists is deliberately NOT retro-added to that invoice (see the
 * "This job has approved changes not yet billed" note surfaced on the
 * Work Order page instead) -- this function must never be called to
 * "refresh" an existing invoice's total.
 *
 * Approved estimate / change-order line items are copied onto the new
 * Invoice as LineItem snapshots (see persistDraftInvoiceFromCompletedJob).
 * This action never auto-sends or marks the invoice paid.
 */
export async function createInvoiceFromJob(
  jobId: string,
): Promise<InvoiceActionState> {
  const access = await requireBusinessAccess();
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

  const existing = await prisma.invoice.findFirst({
    where: {
      ...access.scope,
      jobId: job.id,
    },
    select: { id: true },
  });

  if (existing) {
    redirect(`/invoices/${existing.id}`);
  }

  const result = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: access.businessId,
    jobId: job.id,
  });

  if (!result.ok) {
    return { error: result.error };
  }

  revalidatePath(`/jobs/${job.id}`);
  redirect(`/invoices/${result.invoiceId}`);
}

export async function markInvoiceSent(
  invoiceId: string,
): Promise<InvoiceActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
    }),
  );

  if (invoice.status === "SENT" || invoice.status === "PAID") {
    return {};
  }

  if (invoice.status !== "DRAFT") {
    return { error: "Only a draft invoice can be sent." };
  }

  const updated = await prisma.invoice.updateMany({
    where: {
      id: invoice.id,
      businessId: access.businessId,
      status: "DRAFT",
    },
    data: { status: "SENT" },
  });

  if (updated.count !== 1) {
    return { error: "Only a draft invoice can be sent." };
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  return {};
}

export async function markInvoicePaid(
  _prev: InvoiceActionState,
  formData: FormData,
): Promise<InvoiceActionState> {
  const access = await requireBusinessAccess();
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

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  return {};
}
