/**
 * Verified SMS webhook for Twilio delivery callbacks and STOP/START/HELP.
 * Signature is checked before any payload is trusted. Responses never
 * include tenant or customer identifiers.
 */
import { prisma } from "@/lib/prisma";
import {
  customerMessagingWebhookResponse,
  handleCustomerMessagingWebhookRequest,
} from "@/lib/customer-messaging/webhook";

export async function POST(request: Request) {
  const result = await handleCustomerMessagingWebhookRequest(prisma, {
    url: request.url,
    twilioSignature: request.headers.get("x-twilio-signature"),
    tbbtSignature: request.headers.get("x-tbbt-messaging-signature"),
    rawBody: await request.text(),
    contentType: request.headers.get("content-type"),
  });
  return customerMessagingWebhookResponse(result);
}
