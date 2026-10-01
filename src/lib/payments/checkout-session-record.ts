/**
 * Durable expected-cents record for a Stripe Checkout session.
 * Request paths fail closed when the table is missing. They must not
 * CREATE TABLE.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertRequiredTablesExist } from "@/lib/request-path-schema";

type SessionDb = PrismaClient | Prisma.TransactionClient;

const SESSION_SELECT = {
  id: true,
  businessId: true,
  invoiceId: true,
  stripeSessionId: true,
  amountCents: true,
  createdAt: true,
} as const;

export type InvoiceCheckoutSessionRow = {
  id: string;
  businessId: string;
  invoiceId: string;
  stripeSessionId: string;
  amountCents: number;
  createdAt: Date;
};

let ensureTablePromise: Promise<void> | null = null;

export function resetInvoiceCheckoutSessionTableEnsure() {
  ensureTablePromise = null;
}

export async function ensureInvoiceCheckoutSessionTable(db: SessionDb) {
  if (!ensureTablePromise) {
    ensureTablePromise = assertRequiredTablesExist(db, ["InvoiceCheckoutSession"]).catch(
      (error) => {
        ensureTablePromise = null;
        throw error;
      },
    );
  }
  await ensureTablePromise;
}

export async function recordInvoiceCheckoutSession(
  db: SessionDb,
  input: {
    businessId: string;
    invoiceId: string;
    stripeSessionId: string;
    amountCents: number;
  },
): Promise<InvoiceCheckoutSessionRow> {
  await ensureInvoiceCheckoutSessionTable(db);
  return db.invoiceCheckoutSession.upsert({
    where: { stripeSessionId: input.stripeSessionId },
    update: {
      businessId: input.businessId,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
    },
    create: {
      businessId: input.businessId,
      invoiceId: input.invoiceId,
      stripeSessionId: input.stripeSessionId,
      amountCents: input.amountCents,
    },
    select: SESSION_SELECT,
  });
}

export async function findInvoiceCheckoutSession(
  db: SessionDb,
  stripeSessionId: string | null | undefined,
): Promise<InvoiceCheckoutSessionRow | null> {
  if (!stripeSessionId) return null;
  await ensureInvoiceCheckoutSessionTable(db);
  return db.invoiceCheckoutSession.findUnique({
    where: { stripeSessionId },
    select: SESSION_SELECT,
  });
}
