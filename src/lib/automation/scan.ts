import type { Prisma, PrismaClient } from "@prisma/client";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Invoice has no recorded due date. These windows are sent-age policy
 * from the authoritative INVOICE_SENT event only — never the invoice
 * creation timestamp and never an invented sent timestamp.
 */
export const INVOICE_DUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const INVOICE_OVERDUE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export async function scanScheduledBusinessEvents(db: Db, businessId: string) {
  const now = Date.now();
  const invoices = await db.invoice.findMany({
    where: { businessId, status: "SENT" },
    select: { id: true, customerId: true },
  });

  for (const invoice of invoices) {
    const sentEvent = await db.businessEvent.findFirst({
      where: {
        businessId,
        type: "INVOICE_SENT",
        subjectType: "INVOICE",
        subjectId: invoice.id,
      },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    });
    if (!sentEvent) continue;
    const age = now - sentEvent.occurredAt.getTime();
    if (age >= INVOICE_DUE_AFTER_MS) {
      await emitAndProcessBusinessEvent(db, {
        businessId,
        type: "INVOICE_DUE",
        subjectType: "INVOICE",
        subjectId: invoice.id,
        payload: {
          customerId: invoice.customerId,
          sentAt: sentEvent.occurredAt.toISOString(),
          policy: "invoice-sent-event",
        },
        idempotencyKey: `INVOICE_DUE:${invoice.id}`,
      });
    }
    if (age >= INVOICE_OVERDUE_AFTER_MS) {
      await emitAndProcessBusinessEvent(db, {
        businessId,
        type: "INVOICE_OVERDUE",
        subjectType: "INVOICE",
        subjectId: invoice.id,
        payload: {
          customerId: invoice.customerId,
          sentAt: sentEvent.occurredAt.toISOString(),
          policy: "invoice-sent-event",
        },
        idempotencyKey: `INVOICE_OVERDUE:${invoice.id}`,
      });
    }
  }

  const followUps = await db.customerFollowUp.findMany({
    where: { businessId, status: "OPEN" },
    select: { id: true, customerId: true, jobId: true },
  });
  for (const row of followUps) {
    await emitAndProcessBusinessEvent(db, {
      businessId,
      type: "CUSTOMER_FOLLOW_UP_DUE",
      subjectType: "CUSTOMER_FOLLOW_UP",
      subjectId: row.id,
      payload: { customerId: row.customerId, jobId: row.jobId, followUpId: row.id },
      idempotencyKey: `CUSTOMER_FOLLOW_UP_DUE:${row.id}`,
    });
  }
}
