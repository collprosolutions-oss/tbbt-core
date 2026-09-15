/**
 * Stripe webhook for two separate billing systems:
 *
 * 1. TBBT SaaS billing (platform): the trade business pays TBBT for
 *    software access. Events: checkout.session.completed (mode
 *    subscription), customer.subscription.created/updated/deleted.
 * 2. Stripe Connect (connected accounts): customers pay the trade
 *    business for invoices/deposits. Events carry event.account.
 *
 * Vercel Authentication on Preview deployments can reject Stripe POSTs
 * with 401 before this handler runs. Do not disable Preview protection
 * globally to make webhooks work. Production webhook destinations must
 * be publicly reachable by Stripe. This route stays protected by Stripe
 * signature verification (STRIPE_WEBHOOK_SECRET, and optionally
 * STRIPE_SAAS_WEBHOOK_SECRET). Never log secrets, account ids, customer
 * names, emails, or bank details.
 *
 * Browser Checkout redirects never mark a Business subscribed. Stripe
 * webhook state is authoritative for SaaS status.
 */
import { NextResponse } from "next/server";
import {
  applyVerifiedCheckoutPayment,
  getStripeWebhookSecret,
} from "@/lib/payments";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import { constructStripeWebhookEvent } from "@/lib/payments/stripe-adapter";
import { prisma } from "@/lib/prisma";
import {
  applyParsedSaasBillingEvent,
  constructStripeWebhookEventWithSecrets,
  parseSaasBillingEvent,
  saasBillingWebhookSecrets,
} from "@/lib/saas-billing";

function webhookEventSummary(event: unknown) {
  if (!event || typeof event !== "object") {
    return {
      type: null,
      hasAccount: false,
      hasInvoiceId: false,
      hasBusinessId: false,
      hasConnectedAccountId: false,
      paymentStatus: null,
      mode: null,
    };
  }
  const record = event as {
    type?: unknown;
    account?: unknown;
    data?: {
      object?: {
        metadata?: Record<string, unknown>;
        payment_status?: unknown;
        mode?: unknown;
      };
    };
  };
  const metadata = record.data?.object?.metadata ?? {};
  return {
    type: typeof record.type === "string" ? record.type : null,
    hasAccount: typeof record.account === "string" && record.account.length > 0,
    hasInvoiceId: typeof metadata.invoiceId === "string",
    hasBusinessId: typeof metadata.businessId === "string",
    hasConnectedAccountId: typeof metadata.connectedAccountId === "string",
    paymentStatus:
      typeof record.data?.object?.payment_status === "string"
        ? record.data.object.payment_status
        : null,
    mode: typeof record.data?.object?.mode === "string" ? record.data.object.mode : null,
  };
}

function verifyStripeWebhook(payload: string, signature: string) {
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

export async function POST(request: Request) {
  const secrets = saasBillingWebhookSecrets();
  if (secrets.length === 0) {
    return NextResponse.json(
      { error: "Webhook secret is not configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  const payload = await request.text();
  let event: unknown;
  try {
    event = verifyStripeWebhook(payload, signature);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const summary = webhookEventSummary(event);
  const saasEvent = parseSaasBillingEvent(event);
  if (saasEvent) {
    const result = await applyParsedSaasBillingEvent(prisma, saasEvent);
    console.info(
      "[saas-billing] webhook",
      JSON.stringify({
        ...summary,
        parsed: true,
        applied: result.applied,
        reason: result.reason,
      }),
    );
    return NextResponse.json({ received: true, system: "saas", ...result });
  }

  const payment = parseCheckoutPaymentEvent(event);
  if (!payment) {
    console.info(
      "[payments] webhook",
      JSON.stringify({ ...summary, parsed: false, applied: false }),
    );
    return NextResponse.json({ received: true, applied: false });
  }

  const result = await applyVerifiedCheckoutPayment(prisma, payment);
  console.info(
    "[payments] webhook",
    JSON.stringify({
      ...summary,
      parsed: true,
      applied: result.applied,
      reason: result.reason,
    }),
  );
  return NextResponse.json({ received: true, system: "connect", ...result });
}
