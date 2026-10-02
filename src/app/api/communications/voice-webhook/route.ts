/**
 * Verified inbound Twilio Voice webhook. Signature is checked before
 * any payload is trusted. Responses never include tenant or customer
 * identifiers. Recordings and call content are not stored.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleInboundVoiceWebhookRequest } from "@/lib/communications/voice-webhook";

export async function POST(request: Request) {
  const result = await handleInboundVoiceWebhookRequest(prisma, {
    url: request.url,
    twilioSignature: request.headers.get("x-twilio-signature"),
    rawBody: await request.text(),
    contentType: request.headers.get("content-type"),
  });
  return new NextResponse(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType },
  });
}
