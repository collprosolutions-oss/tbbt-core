"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";

export type InvoiceActionState = {
  error?: string;
};

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
  invoiceId: string,
): Promise<InvoiceActionState> {
  const access = await requireBusinessAccess();
  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
    }),
  );

  if (invoice.status === "PAID") {
    return {};
  }

  if (invoice.status !== "SENT") {
    return { error: "Send the invoice before marking it paid." };
  }

  const updated = await prisma.invoice.updateMany({
    where: {
      id: invoice.id,
      businessId: access.businessId,
      status: "SENT",
    },
    data: { status: "PAID" },
  });

  if (updated.count !== 1) {
    return { error: "Send the invoice before marking it paid." };
  }

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoice.id}`);
  return {};
}
