import { NextResponse } from "next/server";
import {
  applyVerifiedCheckoutPayment,
  getStripeWebhookSecret,
} from "@/lib/payments";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import { constructStripeWebhookEvent } from "@/lib/payments/stripe-adapter";
import { prisma } from "@/lib/prisma";

function webhookEventSummary(event: unknown) {
  if (!event || typeof event !== "object") {
    return {
      type: null,
      hasAccount: false,
      hasInvoiceId: false,
      hasBusinessId: false,
      hasConnectedAccountId: false,
      paymentStatus: null,
    };
  }
  const record = event as {
    type?: unknown;
    account?: unknown;
    data?: { object?: { metadata?: Record<string, unknown>; payment_status?: unknown } };
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
  };
}

export async function POST(request: Request) {
  const secret = getStripeWebhookSecret();
  if (!secret) {
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
    event = constructStripeWebhookEvent(payload, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const summary = webhookEventSummary(event);
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
  return NextResponse.json({ received: true, ...result });
}
