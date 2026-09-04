import { formatAddress, formatMoney } from "@/lib/format";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildInvoiceReadyEmail(input: {
  businessName: string;
  customerName: string | null;
  total: { toString(): string };
  address: string | null;
  invoiceUrl: string;
}) {
  const first = input.customerName?.trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : "Hi,";
  const total = formatMoney(input.total);
  const addressLine = input.address ? `Service address: ${input.address}` : null;

  const text = [
    greeting,
    "",
    `${input.businessName} has sent your invoice.`,
    `Invoice total: ${total}`,
    addressLine,
    "",
    "View your invoice and payment options:",
    input.invoiceUrl,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your invoice from ${escapeHtml(input.businessName)} is ready</title>
  </head>
  <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(input.businessName)} has sent your invoice.</p>
    <p><strong>Invoice total: ${escapeHtml(total)}</strong></p>
    ${addressLine ? `<p>${escapeHtml(addressLine)}</p>` : ""}
    <p>
      <a href="${escapeHtml(input.invoiceUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;">View Invoice</a>
    </p>
    <p style="font-size:14px;color:#475569;">If the button does not work, open this link:<br />${escapeHtml(input.invoiceUrl)}</p>
  </body>
</html>`;

  return {
    subject: `Your invoice from ${input.businessName} is ready`,
    html,
    text,
  };
}

export function formatInvoiceServiceAddress(property: {
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
} | null) {
  return property ? formatAddress(property) : null;
}
