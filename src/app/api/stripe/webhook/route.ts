import { NextResponse } from "next/server";
import {
  applyVerifiedCheckoutPayment,
  getStripeWebhookSecret,
} from "@/lib/payments";
import { parseCheckoutPaymentEvent } from "@/lib/payments/events";
import { constructStripeWebhookEvent } from "@/lib/payments/stripe-adapter";
import { prisma } from "@/lib/prisma";

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

  const payment = parseCheckoutPaymentEvent(event);
  if (!payment) {
    return NextResponse.json({ received: true, applied: false });
  }

  const result = await applyVerifiedCheckoutPayment(prisma, payment);
  return NextResponse.json({ received: true, ...result });
}
