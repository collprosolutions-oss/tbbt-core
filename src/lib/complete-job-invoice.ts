/**
 * Owner Complete Job → create/reuse invoice → send to customer.
 *
 * Existing invoice "send" is the DRAFT → SENT status change
 * (src/app/actions/invoice.ts). SENT makes the invoice visible on the
 * Customer Project Portal. Email is attempted once on that first
 * transition when mail is configured; it is never required for SENT.
 *
 * Field completeAssignedJob() does not call this — owner financial
 * control stays on the Work Order Complete Job action.
 */
import type { PrismaClient } from "@prisma/client";
import { persistDraftInvoiceFromCompletedJob } from "@/lib/invoice-carry-forward";
import {
  buildInvoiceReadyEmail,
  formatInvoiceServiceAddress,
} from "@/lib/invoice-mail";
import { evaluateCompleteJob } from "@/lib/job-lifecycle";
import {
  getAppUrl,
  getMailConfig,
  isUsableEmail,
  senderFrom,
  sendTransactionalEmail,
} from "@/lib/mail";

export type CompleteJobInvoiceResult =
  | {
      ok: false;
      error: string;
      jobCompleted: boolean;
      invoiceId?: string;
    }
  | {
      ok: true;
      jobCompleted: true;
      invoiceId: string;
      invoiceCreated: boolean;
      invoiceReused: boolean;
      invoiceStatus: string;
      newlySent: boolean;
      customerNotified: boolean;
      warning?: string;
    };

export type SendDraftInvoiceResult =
  | {
      ok: true;
      status: string;
      newlySent: false;
      customerNotified: false;
    }
  | {
      ok: true;
      status: "SENT";
      newlySent: true;
      customerNotified: boolean;
      warning?: string;
    }
  | { ok: false; error: string; status?: string };

/** A customer notification is only attempted on a fresh DRAFT → SENT flip. */
export function invoiceSendShouldNotify(status: string): boolean {
  return status === "DRAFT";
}

export async function sendDraftInvoiceIfNeeded(
  db: PrismaClient,
  input: { businessId: string; invoiceId: string; businessName: string },
): Promise<SendDraftInvoiceResult> {
  if (!input.businessId || !input.invoiceId) {
    return { ok: false, error: "That invoice could not be sent." };
  }

  const invoice = await db.invoice.findFirst({
    where: { id: input.invoiceId, businessId: input.businessId },
    select: {
      id: true,
      status: true,
      total: true,
      customer: { select: { name: true, email: true } },
      job: {
        select: {
          projectToken: true,
          property: {
            select: {
              addressLine1: true,
              addressLine2: true,
              city: true,
              region: true,
              postalCode: true,
            },
          },
        },
      },
    },
  });

  if (!invoice) {
    return { ok: false, error: "That invoice could not be sent." };
  }

  if (invoice.status === "SENT" || invoice.status === "PAID") {
    return {
      ok: true,
      status: invoice.status,
      newlySent: false,
      customerNotified: false,
    };
  }

  if (invoice.status !== "DRAFT") {
    return { ok: false, error: "Only a draft invoice can be sent.", status: invoice.status };
  }

  const updated = await db.invoice.updateMany({
    where: {
      id: invoice.id,
      businessId: input.businessId,
      status: "DRAFT",
    },
    data: { status: "SENT" },
  });

  if (updated.count !== 1) {
    return {
      ok: false,
      error: "The invoice was created but could not be sent.",
      status: "DRAFT",
    };
  }

  const notified = await notifyCustomerInvoiceReady(db, {
    businessId: input.businessId,
    invoiceId: invoice.id,
    businessName: input.businessName,
    total: invoice.total,
    customerName: invoice.customer?.name ?? null,
    customerEmail: invoice.customer?.email ?? null,
    projectToken: invoice.job?.projectToken ?? null,
    address: formatInvoiceServiceAddress(invoice.job?.property ?? null),
  });

  return {
    ok: true,
    status: "SENT",
    newlySent: true,
    customerNotified: notified.sent,
    warning: notified.warning,
  };
}

async function notifyCustomerInvoiceReady(
  _db: PrismaClient,
  input: {
    businessId: string;
    invoiceId: string;
    businessName: string;
    total: { toString(): string };
    customerName: string | null;
    customerEmail: string | null;
    projectToken: string | null;
    address: string | null;
  },
): Promise<{ sent: boolean; warning?: string }> {
  const config = getMailConfig();
  if ("error" in config) {
    return { sent: false };
  }

  const recipient = input.customerEmail?.trim() ?? "";
  if (!isUsableEmail(recipient)) {
    return { sent: false };
  }

  const appUrl = config.appUrl || getAppUrl();
  if (!appUrl || !input.projectToken) {
    return {
      sent: false,
      warning:
        "Invoice is available in the customer portal, but the invoice email could not be sent.",
    };
  }

  const email = buildInvoiceReadyEmail({
    businessName: input.businessName,
    customerName: input.customerName,
    total: input.total,
    address: input.address,
    invoiceUrl: `${appUrl}/p/${input.projectToken}/invoice`,
  });

  const sent = await sendTransactionalEmail({
    apiKey: config.apiKey,
    from: senderFrom(input.businessName, config.fromAddress),
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
    idempotencyKey: `invoice-ready/${input.invoiceId}`,
  });

  if (sent.error) {
    return {
      sent: false,
      warning:
        "Invoice is available in the customer portal, but the invoice email could not be sent.",
    };
  }

  return { sent: true };
}

export async function completeJobAndSendInvoice(
  db: PrismaClient,
  input: { businessId: string; jobId: string; businessName: string },
): Promise<CompleteJobInvoiceResult> {
  const job = await db.job.findFirst({
    where: { id: input.jobId, businessId: input.businessId },
    select: { id: true, status: true },
  });

  if (!job) {
    return { ok: false, error: "That job could not be completed.", jobCompleted: false };
  }

  const lifecycle = evaluateCompleteJob(job.status);
  if (!lifecycle.ok) {
    return { ok: false, error: lifecycle.error, jobCompleted: false };
  }

  if (lifecycle.nextStatus) {
    const updated = await db.job.updateMany({
      where: {
        id: job.id,
        businessId: input.businessId,
        status: job.status,
      },
      data: { status: lifecycle.nextStatus },
    });
    if (updated.count !== 1 && job.status !== "COMPLETED") {
      const current = await db.job.findFirst({
        where: { id: job.id, businessId: input.businessId },
        select: { status: true },
      });
      if (current?.status !== "COMPLETED") {
        return { ok: false, error: "That job could not be completed.", jobCompleted: false };
      }
    }
  }

  const persist = await persistDraftInvoiceFromCompletedJob(db, {
    businessId: input.businessId,
    jobId: job.id,
  });

  if (!persist.ok) {
    return {
      ok: false,
      error: persist.error,
      jobCompleted: true,
    };
  }

  const sent = await sendDraftInvoiceIfNeeded(db, {
    businessId: input.businessId,
    invoiceId: persist.invoiceId,
    businessName: input.businessName,
  });

  if (!sent.ok) {
    return {
      ok: false,
      error: sent.error,
      jobCompleted: true,
      invoiceId: persist.invoiceId,
    };
  }

  return {
    ok: true,
    jobCompleted: true,
    invoiceId: persist.invoiceId,
    invoiceCreated: persist.reused === false,
    invoiceReused: persist.reused === true,
    invoiceStatus: sent.status,
    newlySent: sent.newlySent,
    customerNotified: sent.customerNotified,
    warning: sent.newlySent ? sent.warning : undefined,
  };
}
