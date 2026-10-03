/**
 * Shared Stripe webhook verify + dispatch for the platform endpoint.
 *
 * SaaS subscription events and Connect invoice/deposit events share one
 * URL and one signature check, then split. Do not mix their records.
 */
import { applyRecordedConnectInvoicePayment } from "@/lib/connect-invoice-webhook";
import {
  applyVerifiedCheckoutPayment,
  getStripeWebhookSecret,
} from "@/lib/payments";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import { constructStripeWebhookEvent } from "@/lib/payments/stripe-adapter";
import type { PrismaClient } from "@prisma/client";
import {
  applyParsedSaasBillingEvent,
  constructStripeWebhookEventWithSecrets,
  parseSaasBillingEvent,
  saasBillingWebhookSecrets,
} from "@/lib/saas-billing";

export function stripeWebhookSecretsConfigured() {
  return saasBillingWebhookSecrets().length > 0;
}

export function verifyStripeWebhookPayload(payload: string, signature: string) {
  const secrets = saasBillingWebhookSecrets();
  try {
    return constructStripeWebhookEventWithSecrets(payload, signature, secrets);
  } catch {
    const fallback = getStripeWebhookSecret();
    if (!fallback) {
      throw new Error("Invalid signature.");
    }
    return constructStripeWebhookEvent(payload, signature, fallback);
  }
}

export async function dispatchStripeWebhookEvent(
  db: PrismaClient,
  event: unknown,
) {
  const saasEvent = parseSaasBillingEvent(event);
  if (saasEvent) {
    const result = await applyParsedSaasBillingEvent(db, saasEvent);
    return { system: "saas" as const, received: true as const, ...result };
  }

  const payment = parseCheckoutPaymentEvent(event);
  if (!payment) {
    return { received: true as const, applied: false as const, system: null };
  }

  if (payment.purpose === "invoice_balance") {
    const result = await applyRecordedConnectInvoicePayment(db, event, payment);
    return { system: "connect" as const, received: true as const, ...result };
  }

  const result = await applyVerifiedCheckoutPayment(db, payment);
  return { system: "connect" as const, received: true as const, ...result };
}
