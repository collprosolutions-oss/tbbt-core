"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { isPaymentMethodValue } from "@/lib/invoice-payment";
import { prisma } from "@/lib/prisma";

export type InvoiceActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createInvoiceFromJob(
  jobId: string,
): Promise<InvoiceActionState> {
  const access = await requireBusinessAccess();
  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
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

  if (!job.estimateId) {
    return { error: "This job has no linked estimate." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: job.estimateId, ...access.scope },
    }),
  );

  const invoice = await prisma.invoice.create({
    data: {
      businessId: access.businessId,
      customerId: job.customerId,
      jobId: job.id,
      total: estimate.total,
    },
  });

  revalidatePath(`/jobs/${job.id}`);
  redirect(`/invoices/${invoice.id}`);
}

export async function markInvoiceSent(
  invoiceId: string,
): Promise<InvoiceActionState> {
  const access = await requireBusinessAccess();
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
