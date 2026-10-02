/**
 * Disposable Stripe test fixtures for TBBT SaaS billing proofs.
 *
 * These are signed test-mode webhook payloads only. They never call
 * live Stripe, never use production secrets, and never create a real
 * Checkout Session or Customer. Keep this file free of `@/` imports so
 * check scripts can load it before the TypeScript alias loader.
 */
import Stripe from "stripe";

/** Must stay identical to `SAAS_CHECKOUT_PURPOSE` in src/lib/saas-billing/config.ts. */
export const SAAS_CHECKOUT_PURPOSE = "tbbt_saas_subscription";

export const STRIPE_TEST_SECRET_KEY = "sk_test_owner_signup_billing_path";
export const STRIPE_TEST_WEBHOOK_SECRET = "whsec_owner_signup_billing_path";
export const STRIPE_TEST_FOUNDER_PRICE_ID = "price_saas_test";

export function applySaasStripeTestEnv(overrides = {}) {
  process.env.TBBT_SAAS_BILLING_ADAPTER = overrides.adapter ?? "fake";
  process.env.STRIPE_SECRET_KEY = overrides.secretKey ?? STRIPE_TEST_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = overrides.webhookSecret ?? STRIPE_TEST_WEBHOOK_SECRET;
  process.env.STRIPE_SAAS_PRICE_ID = overrides.priceId ?? STRIPE_TEST_FOUNDER_PRICE_ID;
  process.env.NEXT_PUBLIC_APP_URL =
    overrides.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://owner-signup-billing.test";
  delete process.env.VERCEL_ENV;
}

export function saasCheckoutCompletedFixture(input) {
  return {
    id: input.id,
    created: input.created ?? 1_700_000_000,
    type: "checkout.session.completed",
    data: {
      object: {
        object: "checkout.session",
        id: input.sessionId ?? "cs_test_owner_1",
        mode: "subscription",
        status: "complete",
        payment_status: input.paymentStatus ?? "paid",
        customer: input.customerId,
        subscription: input.subscriptionId,
        metadata: {
          purpose: SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
          priceId: input.priceId ?? STRIPE_TEST_FOUNDER_PRICE_ID,
        },
      },
    },
  };
}

export function saasSubscriptionFixture(input) {
  return {
    id: input.id,
    created: input.created ?? 1_700_000_100,
    type: input.type ?? "customer.subscription.updated",
    account: input.account,
    data: {
      object: {
        object: "subscription",
        id: input.subscriptionId,
        status: input.status ?? "active",
        customer: input.customerId,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        current_period_end: input.periodEnd ?? 1_800_000_000,
        items: {
          data: [
            {
              current_period_end: input.periodEnd ?? 1_800_000_000,
              price: { id: input.priceId ?? STRIPE_TEST_FOUNDER_PRICE_ID },
            },
          ],
        },
        metadata: {
          purpose: SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
        },
      },
    },
  };
}

export function saasInvoicePaidFixture(input) {
  return {
    id: input.id,
    created: input.created ?? 1_700_000_200,
    type: input.type ?? "invoice.paid",
    data: {
      object: {
        object: "invoice",
        id: input.invoiceId ?? "in_test_owner_1",
        customer: input.customerId,
        subscription: input.subscriptionId,
        paid: true,
        status: "paid",
        lines: {
          data: [
            {
              period: { end: input.periodEnd ?? 1_800_000_000 },
              price: { id: input.priceId ?? STRIPE_TEST_FOUNDER_PRICE_ID },
            },
          ],
        },
        metadata: {
          purpose: input.purpose ?? SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
        },
      },
    },
  };
}

export function signStripeTestEvent(event, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, signature };
}

export async function dispatchSignedSaasStripeFixture(prisma, event, secret) {
  const { dispatchStripeWebhookEvent, verifyStripeWebhookPayload } = await import(
    "@/lib/stripe-webhook-dispatch"
  );
  const { payload, signature } = signStripeTestEvent(event, secret);
  const verified = verifyStripeWebhookPayload(payload, signature);
  const result = await dispatchStripeWebhookEvent(prisma, verified);
  return { ...result, verified };
}

export function rememberFakeSubscription(provider, input) {
  provider.addSubscription({
    id: input.subscriptionId,
    customerId: input.customerId,
    priceId: input.priceId ?? STRIPE_TEST_FOUNDER_PRICE_ID,
    status: input.status,
    currentPeriodEnd: input.currentPeriodEnd ?? new Date((input.periodEnd ?? 1_800_000_000) * 1000),
    cancelAtPeriodEnd: input.cancelAtPeriodEnd === true,
  });
}
