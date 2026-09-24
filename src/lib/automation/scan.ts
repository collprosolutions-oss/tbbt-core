import type { Prisma, PrismaClient } from "@prisma/client";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Invoice has no recorded due date. These windows are sent-age policy
 * only — they are not invented invoice due dates or bank facts.
 */
export const INVOICE_DUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const INVOICE_OVERDUE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export async function scanScheduledBusinessEvents(db: Db, businessId: string) {
  const now = Date.now();
  const invoices = await db.invoice.findMany({
    where: { businessId, status: "SENT" },
    select: { id: true, customerId: true, createdAt: true },
  });

  for (const invoice of invoices) {
    const age = now - invoice.createdAt.getTime();
    if (age >= INVOICE_DUE_AFTER_MS) {
      await emitAndProcessBusinessEvent(db, {
        businessId,
        type: "INVOICE_DUE",
        subjectType: "INVOICE",
        subjectId: invoice.id,
        payload: {
          customerId: invoice.customerId,
          sentAt: invoice.createdAt.toISOString(),
          policy: "sent-age",
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
          sentAt: invoice.createdAt.toISOString(),
          policy: "sent-age",
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
