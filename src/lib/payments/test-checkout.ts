import { notFound } from "next/navigation";
import { getAppUrl } from "@/lib/mail";
import { prisma } from "@/lib/prisma";
import { findInvoiceCheckoutSession } from "@/lib/payments/checkout-session-record";
import { isFakePaymentsAdapterEnabled } from "@/lib/payments/config";
import {
  applyCheckoutSessionId,
  fakeStripeTestCheckoutUrl,
  isFakeCheckoutSessionId,
  isFakePaymentProvider,
  type FakeCheckoutSession,
  type FakePaymentProvider,
} from "@/lib/payments/fake";
import { getPaymentProvider } from "@/lib/payments/provider";
import { applyVerifiedCheckoutPayment } from "@/lib/payments/service";
import { getTenantAppOrigin } from "@/lib/tenant-app-url";
import { formatMoney } from "@/lib/format";

export const STRIPE_TEST_CHECKOUT_HEADING = "Stripe test checkout";
export const STRIPE_TEST_CHECKOUT_BANNER =
  "Test mode only. No real card is charged and no live Stripe session is created.";
export const STRIPE_TEST_CHECKOUT_UNAVAILABLE = "This test checkout is not available.";
export const STRIPE_TEST_CHECKOUT_PAY_LABEL = "Pay with test card";
export const STRIPE_TEST_CHECKOUT_CANCEL_LABEL = "Cancel";

async function restoreFakeCheckoutFromInvoiceRecord(
  sessionId: string,
  provider: FakePaymentProvider,
): Promise<FakeCheckoutSession | null> {
  const row = await findInvoiceCheckoutSession(prisma, sessionId);
  if (!row) return null;
  const invoice = await prisma.invoice.findFirst({
    where: { id: row.invoiceId, businessId: row.businessId },
    select: {
      job: { select: { projectToken: true } },
      business: {
        select: {
          slug: true,
          paymentAccount: { select: { stripeAccountId: true } },
        },
      },
    },
  });
  const token = invoice?.job?.projectToken;
  const accountId = invoice?.business?.paymentAccount?.stripeAccountId;
  const origin =
    getTenantAppOrigin(invoice?.business?.slug) ?? getAppUrl();
  if (!token || !accountId || !origin) return null;
  const successUrl = `${origin}/p/${token}?checkout=return&session_id={CHECKOUT_SESSION_ID}`;
  const session: FakeCheckoutSession = {
    id: sessionId,
    url: fakeStripeTestCheckoutUrl(sessionId, successUrl),
    connectedAccountId: accountId,
    amountCents: row.amountCents,
    currency: "usd",
    invoiceId: row.invoiceId,
    estimateId: null,
    purpose: "invoice_balance",
    businessId: row.businessId,
    paid: false,
    successUrl,
    cancelUrl: `${origin}/p/${token}?checkout=cancelled`,
  };
  provider.checkouts.push(session);
  return session;
}

export async function requireFakeTestCheckoutSession(
  sessionId: string,
): Promise<FakeCheckoutSession> {
  if (!isFakePaymentsAdapterEnabled() || !isFakeCheckoutSessionId(sessionId)) {
    notFound();
  }
  const provider = getPaymentProvider();
  if (!isFakePaymentProvider(provider)) {
    notFound();
  }
  const existing = provider.findCheckout(sessionId);
  if (existing) return existing;
  const restored = await restoreFakeCheckoutFromInvoiceRecord(sessionId, provider);
  if (!restored) {
    notFound();
  }
  return restored;
}

export function fakeTestCheckoutPurposeLabel(purpose: FakeCheckoutSession["purpose"]) {
  return purpose === "material_deposit" ? "Material deposit" : "Invoice";
}

export function fakeTestCheckoutAmountLabel(session: FakeCheckoutSession) {
  return formatMoney((session.amountCents / 100).toFixed(2));
}

export function fakeTestCheckoutSuccessHref(session: FakeCheckoutSession) {
  return applyCheckoutSessionId(session.successUrl, session.id);
}

export async function completeFakeTestCheckout(
  sessionId: string,
): Promise<FakeCheckoutSession> {
  const session = await requireFakeTestCheckoutSession(sessionId);
  const provider = getPaymentProvider();
  if (!isFakePaymentProvider(provider)) {
    notFound();
  }
  provider.completeCheckout(session.id);
  await applyVerifiedCheckoutPayment(prisma, {
    purpose: session.purpose,
    invoiceId: session.invoiceId,
    estimateId: session.estimateId,
    checkoutSessionId: session.id,
    businessId: session.businessId,
    connectedAccountId: session.connectedAccountId,
    amountCents: session.amountCents,
    currency: session.currency,
    paymentReference: session.id,
    paymentStatus: "paid",
  });
  return session;
}
