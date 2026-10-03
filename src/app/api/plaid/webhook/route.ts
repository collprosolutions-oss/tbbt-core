/**
 * Plaid webhook for read-only Transactions Sync.
 *
 * Vercel Authentication on Preview deployments can reject Plaid POSTs
 * with 401 before this handler runs. Production webhook destinations
 * must be publicly reachable. The auth proxy allows this path without
 * a session cookie; signature verification still protects the handler.
 * Never log access tokens, account numbers, or owner bank logins.
 *
 * Delivery never creates a Payment, never changes an invoice, never
 * moves money, and never claims a verified cash balance.
 */
import { NextResponse } from "next/server";
import { handlePlaidWebhookPayload } from "@/lib/bank-connect";
import { prisma } from "@/lib/prisma";
import {
  MAX_PLAID_WEBHOOK_BYTES,
  PlaidWebhookVerificationError,
  verifyPlaidWebhookRequest,
} from "@/lib/plaid-webhook";

export async function POST(request: Request) {
  const announced = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > MAX_PLAID_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Webhook body is too large." }, { status: 413 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_PLAID_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Webhook body is too large." }, { status: 413 });
  }

  let verified: Awaited<ReturnType<typeof verifyPlaidWebhookRequest>>;
  try {
    verified = await verifyPlaidWebhookRequest(rawBody, request.headers);
  } catch (error) {
    if (error instanceof PlaidWebhookVerificationError) {
      return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
    }
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  try {
    const result = await handlePlaidWebhookPayload(prisma, {
      rawBody,
      jwtId: verified?.jti ?? null,
      issuedAt: verified?.iat ?? null,
    });
    return NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      processed: result.processed,
    });
  } catch {
    return NextResponse.json({ error: "Webhook could not be processed." }, { status: 400 });
  }
}
