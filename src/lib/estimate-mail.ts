import { formatAddress, formatMoney } from "@/lib/format";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function customerFirstName(name: string | null | undefined) {
  if (!name) {
    return null;
  }
  const first = name.trim().split(/\s+/)[0];
  return first || null;
}

export function buildEstimateReadyEmail(input: {
  businessName: string;
  customerName: string | null;
  total: { toString(): string };
  address: string | null;
  approveUrl: string;
}) {
  const firstName = customerFirstName(input.customerName);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const total = formatMoney(input.total);
  const addressLine = input.address
    ? `Service address: ${input.address}`
    : null;

  const text = [
    greeting,
    "",
    `${input.businessName} has an estimate ready for you.`,
    `Estimate total: ${total}`,
    addressLine,
    "",
    "View and approve your estimate:",
    input.approveUrl,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your estimate from ${escapeHtml(input.businessName)} is ready</title>
  </head>
  <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(input.businessName)} has an estimate ready for you.</p>
    <p><strong>Estimate total: ${escapeHtml(total)}</strong></p>
    ${
      addressLine
        ? `<p>${escapeHtml(addressLine)}</p>`
        : ""
    }
    <p>
      <a href="${escapeHtml(input.approveUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;">View &amp; Approve Estimate</a>
    </p>
    <p style="font-size:14px;color:#475569;">If the button does not work, open this link:<br />${escapeHtml(input.approveUrl)}</p>
  </body>
</html>`;

  return {
    subject: `Your estimate from ${input.businessName} is ready`,
    html,
    text,
  };
}

export function formatEstimateServiceAddress(property: {
  addressLine1: string;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
} | null) {
  return property ? formatAddress(property) : null;
}
