/**
 * Verified Resend bounce and complaint webhook.
 * Signature is checked before any payload is trusted. Responses never
 * include tenant or customer identifiers.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  handleMailWebhookRequest,
  mailWebhookHeadersFromRequest,
} from "@/lib/mail-webhook";

export async function POST(request: Request) {
  const result = await handleMailWebhookRequest(prisma, {
    rawBody: await request.text(),
    headers: mailWebhookHeadersFromRequest(request),
  });
  return NextResponse.json(result.body, { status: result.status });
}
