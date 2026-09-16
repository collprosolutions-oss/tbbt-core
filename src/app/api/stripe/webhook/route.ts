/**
 * Stripe webhook for two separate billing systems:
 *
 * 1. TBBT SaaS billing (platform): the trade business pays TBBT for
 *    software access. Events: checkout.session.completed (mode
 *    subscription), customer.subscription.created/updated/deleted/paused/resumed,
 *    and invoice.paid / invoice.payment_succeeded for payment recovery.
 * 2. Stripe Connect (connected accounts): customers pay the trade
 *    business for invoices/deposits. Events carry event.account.
 *
 * Vercel Authentication on Preview deployments can reject Stripe POSTs
 * with 401 before this handler runs. Do not disable Preview protection
 * globally to make webhooks work. Production webhook destinations must
 * be publicly reachable by Stripe. The auth proxy allows this path
 * without a session cookie; Stripe signature verification still
 * protects the handler (STRIPE_WEBHOOK_SECRET, and optionally
 * STRIPE_SAAS_WEBHOOK_SECRET). Never log secrets, account ids, customer
 * names, emails, or bank details.
 *
 * Browser Checkout redirects never mark a Business subscribed. Stripe
 * webhook state is authoritative for SaaS status.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  dispatchStripeWebhookEvent,
  stripeWebhookSecretsConfigured,
  verifyStripeWebhookPayload,
} from "@/lib/stripe-webhook-dispatch";

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

export async function POST(request: Request) {
  if (!stripeWebhookSecretsConfigured()) {
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
    event = verifyStripeWebhookPayload(payload, signature);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const summary = webhookEventSummary(event);
  const result = await dispatchStripeWebhookEvent(prisma, event);
  const logLabel = result.system === "saas" ? "[saas-billing] webhook" : "[payments] webhook";
  console.info(
    logLabel,
    JSON.stringify({
      ...summary,
      parsed: result.system !== null,
      applied: "applied" in result ? result.applied : false,
      reason: "reason" in result ? result.reason : undefined,
    }),
  );
  return NextResponse.json(result);
}
