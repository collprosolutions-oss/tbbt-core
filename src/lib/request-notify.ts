import { formatRequestServiceAddress, requestedWorkForCompanyEmail, buildNewRequestCompanyEmail } from "@/lib/request-mail";
import {
  getMailConfig,
  isUsableEmail,
  newRequestCompanyEmailIdempotencyKey,
  senderFrom,
  sendTransactionalEmail,
  type MailConfig,
} from "@/lib/mail";

export type RequestCompanyNotifyDb = {
  business: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; name: true; publicEmail: true };
    }) => Promise<{ id: string; name: string; publicEmail: string | null } | null>;
  };
  serviceRequest: {
    findFirst: (args: {
      where: { id: string; businessId: string };
      select: {
        id: true;
        businessId: true;
        summary: true;
        description: true;
        customer: { select: { name: true; email: true; phone: true } };
        property: {
          select: {
            addressLine1: true;
            addressLine2: true;
            city: true;
            region: true;
            postalCode: true;
          };
        };
        items: {
          orderBy: { sortOrder: "asc" };
          select: {
            customDescription: true;
            quantity: true;
            serviceCatalogItem: { select: { name: true } };
          };
        };
        serviceCatalogItem: { select: { name: true } };
      };
    }) => Promise<{
      id: string;
      businessId: string;
      summary: string | null;
      description: string | null;
      customer: { name: string; email: string | null; phone: string | null } | null;
      property: {
        addressLine1: string;
        addressLine2: string | null;
        city: string | null;
        region: string | null;
        postalCode: string | null;
      } | null;
      items: Array<{
        customDescription: string | null;
        quantity: number;
        serviceCatalogItem: { name: string } | null;
      }>;
      serviceCatalogItem: { name: string } | null;
    } | null>;
  };
};

/**
 * Configured company/business notification inbox. This is Business.publicEmail
 * from first-run, website setup, and Settings public contact. Never the
 * homeowner's submitted email.
 */
export function resolveBusinessNotificationEmail(
  publicEmail: string | null | undefined,
) {
  const trimmed = publicEmail?.trim() ?? "";
  return isUsableEmail(trimmed) ? trimmed : null;
}

export type RequestCompanyNotifyResult = {
  sent: boolean;
  to?: string;
  skipped?: "not_configured" | "no_business_email" | "request_not_found" | "send_failed";
};

/**
 * Best-effort company notification after a public request is persisted.
 * Failures must not roll back the request. Recipient is only this tenant's
 * publicEmail; customer email is contact text at most, never `to`.
 */
export async function notifyBusinessNewPublicRequest(
  db: RequestCompanyNotifyDb,
  input: { businessId: string; requestId: string },
  deps?: {
    getConfig?: () => MailConfig | { error: string };
    send?: typeof sendTransactionalEmail;
  },
): Promise<RequestCompanyNotifyResult> {
  const config = (deps?.getConfig ?? getMailConfig)();
  if ("error" in config) {
    return { sent: false, skipped: "not_configured" };
  }

  const business = await db.business.findUnique({
    where: { id: input.businessId },
    select: { id: true, name: true, publicEmail: true },
  });
  const recipient = resolveBusinessNotificationEmail(business?.publicEmail);
  if (!business || !recipient) {
    return { sent: false, skipped: "no_business_email" };
  }

  const request = await db.serviceRequest.findFirst({
    where: { id: input.requestId, businessId: business.id },
    select: {
      id: true,
      businessId: true,
      summary: true,
      description: true,
      customer: { select: { name: true, email: true, phone: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      items: {
        orderBy: { sortOrder: "asc" },
        select: {
          customDescription: true,
          quantity: true,
          serviceCatalogItem: { select: { name: true } },
        },
      },
      serviceCatalogItem: { select: { name: true } },
    },
  });
  if (!request) {
    return { sent: false, skipped: "request_not_found" };
  }

  const email = buildNewRequestCompanyEmail({
    businessName: business.name,
    customerName: request.customer?.name ?? null,
    customerPhone: request.customer?.phone ?? null,
    customerEmail: request.customer?.email ?? null,
    address: formatRequestServiceAddress(request.property),
    requestedWork: requestedWorkForCompanyEmail(request),
    notes: request.description,
    requestsUrl: `${config.appUrl}/requests`,
  });

  const send = deps?.send ?? sendTransactionalEmail;
  const sent = await send({
    apiKey: config.apiKey,
    from: senderFrom(business.name, config.fromAddress),
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
    kind: "request",
    idempotencyKey: newRequestCompanyEmailIdempotencyKey(request.id),
  });

  if (sent.error) {
    return { sent: false, to: recipient, skipped: "send_failed" };
  }

  return { sent: true, to: recipient };
}
