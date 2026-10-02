import { notFound } from "next/navigation";
import { isFakePaymentsAdapterEnabled } from "@/lib/payments/config";
import {
  applyCheckoutSessionId,
  isFakeCheckoutSessionId,
  isFakePaymentProvider,
  type FakeCheckoutSession,
} from "@/lib/payments/fake";
import { getPaymentProvider } from "@/lib/payments/provider";
import { formatMoney } from "@/lib/format";

export const STRIPE_TEST_CHECKOUT_HEADING = "Stripe test checkout";
export const STRIPE_TEST_CHECKOUT_BANNER =
  "Test mode only. No real card is charged and no live Stripe session is created.";
export const STRIPE_TEST_CHECKOUT_UNAVAILABLE = "This test checkout is not available.";
export const STRIPE_TEST_CHECKOUT_PAY_LABEL = "Pay with test card";
export const STRIPE_TEST_CHECKOUT_CANCEL_LABEL = "Cancel";

export function requireFakeTestCheckoutSession(sessionId: string): FakeCheckoutSession {
  if (!isFakePaymentsAdapterEnabled() || !isFakeCheckoutSessionId(sessionId)) {
    notFound();
  }
  const provider = getPaymentProvider();
  if (!isFakePaymentProvider(provider)) {
    notFound();
  }
  const session = provider.findCheckout(sessionId);
  if (!session) {
    notFound();
  }
  return session;
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

export function completeFakeTestCheckout(sessionId: string): FakeCheckoutSession {
  const session = requireFakeTestCheckoutSession(sessionId);
  const provider = getPaymentProvider();
  if (!isFakePaymentProvider(provider)) {
    notFound();
  }
  provider.completeCheckout(session.id);
  return session;
}
