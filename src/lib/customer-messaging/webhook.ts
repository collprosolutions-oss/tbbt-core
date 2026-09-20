import { NextResponse } from "next/server";
import { applyInboundConsentEvent } from "@/lib/customer-messaging/inbound";
import { applyCustomerMessageDeliveryUpdate } from "@/lib/customer-messaging/ops";
import { getCustomerMessagingProvider } from "@/lib/customer-messaging/provider";
import { getCustomerMessagingWebhookSecret } from "@/lib/customer-messaging/config";
import type { ParsedCustomerMessagingWebhook } from "@/lib/customer-messaging/types";
import type { PrismaClient } from "@prisma/client";

const GENERIC_NOT_FOUND = { error: "Not found." };
const GENERIC_INVALID = { error: "Invalid signature." };
const GENERIC_OK = { ok: true as const };

export type CustomerMessagingWebhookRequest = {
  url: string;
  twilioSignature: string | null;
  tbbtSignature: string | null;
  rawBody: string;
  contentType: string | null;
};

export async function handleParsedCustomerMessagingWebhook(
  db: PrismaClient,
  parsed: ParsedCustomerMessagingWebhook,
) {
  if (parsed.kind === "inbound") {
    await applyInboundConsentEvent(db, parsed.inbound);
    return GENERIC_OK;
  }
  await applyCustomerMessageDeliveryUpdate(db, parsed.update);
  return GENERIC_OK;
}

export async function handleCustomerMessagingWebhookRequest(
  db: PrismaClient,
  request: CustomerMessagingWebhookRequest,
): Promise<{ status: number; body: { ok?: true; error?: string } }> {
  const provider = getCustomerMessagingProvider();
  if (!provider.connected) {
    return { status: 404, body: GENERIC_NOT_FOUND };
  }

  if (provider.parseWebhook) {
    const parsed = provider.parseWebhook({
      url: request.url,
      signature: request.twilioSignature,
      rawBody: request.rawBody,
      contentType: request.contentType,
    });
    if (!parsed) {
      return { status: 400, body: GENERIC_INVALID };
    }
    await handleParsedCustomerMessagingWebhook(db, parsed);
    return { status: 200, body: GENERIC_OK };
  }

  const secret = getCustomerMessagingWebhookSecret();
  if (!provider.verifyDeliveryCallback || !secret) {
    return { status: 404, body: GENERIC_NOT_FOUND };
  }
  const update = provider.verifyDeliveryCallback(request.rawBody, request.tbbtSignature);
  if (!update) {
    return { status: 400, body: GENERIC_INVALID };
  }
  await applyCustomerMessageDeliveryUpdate(db, update);
  return { status: 200, body: GENERIC_OK };
}

export function customerMessagingWebhookResponse(result: {
  status: number;
  body: { ok?: true; error?: string };
}) {
  return NextResponse.json(result.body, { status: result.status });
}
