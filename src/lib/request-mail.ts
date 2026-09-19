import { formatMailingAddress } from "@/lib/format";
import { isUsableEmail } from "@/lib/mail";
import { requestedWorkLabels } from "@/lib/service-request-work";
import { requestNotesText } from "@/lib/work-area-intake";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fieldBlock(label: string, value: string | null | undefined) {
  const trimmed = value?.trim() || null;
  if (!trimmed) {
    return { text: null, html: "" };
  }
  return {
    text: `${label}:\n${trimmed}`,
    html: `<p><strong>${escapeHtml(label)}:</strong><br />${escapeHtml(trimmed).replaceAll("\n", "<br />")}</p>`,
  };
}

/**
 * Owner/company email when a homeowner submits a public service request.
 * Recipient is the tenant's configured business public email, never the
 * customer's address.
 */
export function buildNewRequestCompanyEmail(input: {
  businessName: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  address: string | null;
  requestedWork: string | null;
  notes: string | null;
  requestsUrl: string;
}) {
  const customer = input.customerName?.trim() || "A homeowner";
  const contactEmail = isUsableEmail(input.customerEmail)
    ? input.customerEmail!.trim()
    : null;
  const work = input.requestedWork?.trim() || null;
  const notes = requestNotesText(input.notes);
  const phone = fieldBlock("Phone", input.customerPhone);
  const email = fieldBlock("Customer email", contactEmail);
  const address = fieldBlock("Service address", input.address);
  const workBlock = fieldBlock("Requested work", work);
  const notesBlock = fieldBlock("Notes", notes);

  const text = [
    `${customer} submitted a new service request for ${input.businessName}.`,
    "",
    phone.text,
    email.text,
    address.text,
    workBlock.text,
    notesBlock.text,
    "",
    "Open requests:",
    input.requestsUrl,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>New service request for ${escapeHtml(input.businessName)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
    <p>${escapeHtml(customer)} submitted a new service request for ${escapeHtml(input.businessName)}.</p>
    ${phone.html}
    ${email.html}
    ${address.html}
    ${workBlock.html}
    ${notesBlock.html}
    <p>
      <a href="${escapeHtml(input.requestsUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;">Open Requests</a>
    </p>
    <p style="font-size:14px;color:#475569;">If the button does not work, open this link:<br />${escapeHtml(input.requestsUrl)}</p>
  </body>
</html>`;

  return {
    subject: `New service request for ${input.businessName}`,
    html,
    text,
  };
}

export function formatRequestServiceAddress(property: {
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
} | null) {
  return property ? formatMailingAddress(property) : null;
}

export function requestedWorkForCompanyEmail(request: {
  items?: Array<{
    customDescription?: string | null;
    quantity?: number | null;
    serviceCatalogItem?: { name: string } | null;
  }>;
  serviceCatalogItem?: { name: string } | null;
  summary?: string | null;
}) {
  const labels = requestedWorkLabels(request);
  if (labels.length > 0) {
    return labels.join(", ");
  }
  return request.summary?.trim() || null;
}
