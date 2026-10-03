/**
 * Dropbox Sign (and local fake) e-sign webhook.
 *
 * Official callbacks are multipart/form-data with a `json` field.
 * Successful handlers must return HTTP 200 and the exact body
 * "Hello API Event Received". Event hash is verified before any write.
 *
 * https://developers.hellosign.com/docs/guides/events-and-callbacks/walkthrough/
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  dispatchEsignWebhook,
  ESIGN_WEBHOOK_HELLO,
  parseEsignWebhookJson,
} from "@/lib/esign/dispatch";
import { isEsignProviderConfigured } from "@/lib/esign/config";

export async function POST(request: Request) {
  if (!isEsignProviderConfigured()) {
    return new NextResponse("E-sign provider is not configured.", { status: 503 });
  }

  const rawJson = await parseEsignWebhookJson(request);
  if (!rawJson.trim()) {
    return new NextResponse("Missing event payload.", { status: 400 });
  }

  const result = await dispatchEsignWebhook(prisma, {
    rawJson,
    contentSha256: request.headers.get("content-sha256"),
  });

  if (result.hello) {
    return new NextResponse(ESIGN_WEBHOOK_HELLO, {
      status: result.status,
      headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.json({ error: result.reason }, { status: result.status });
}
