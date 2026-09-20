/**
 * Provider-neutral delivery callback. No vendor is configured in
 * production, so this route 404s unless a connected adapter exposes
 * verifyDeliveryCallback and a webhook secret is set. The payload cannot
 * change tenant ownership; updates locate the communication by provider
 * message id and write only status fields.
 */
import { NextResponse } from "next/server";
import {
  applyCustomerMessageDeliveryUpdate,
  getCustomerMessagingProvider,
  getCustomerMessagingWebhookSecret,
} from "@/lib/customer-messaging";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const provider = getCustomerMessagingProvider();
  const secret = getCustomerMessagingWebhookSecret();
  if (!provider.connected || !provider.verifyDeliveryCallback || !secret) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const signature = request.headers.get("x-tbbt-messaging-signature");
  const payload = await request.text();
  const update = provider.verifyDeliveryCallback(payload, signature);
  if (!update) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const result = await applyCustomerMessageDeliveryUpdate(prisma, update);
  return NextResponse.json(result);
}
