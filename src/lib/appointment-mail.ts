import { customerFirstName } from "@/lib/estimate-mail";
import { formatDateTime } from "@/lib/format";
import { formatDurationMinutes } from "@/lib/job-schedule";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function serviceAddressEmail(address: string | null) {
  if (!address) {
    return { text: null, html: "" };
  }
  return {
    text: `Service address:\n${address}`,
    html: `<p>Service address:<br />${escapeHtml(address).replaceAll("\n", "<br />")}</p>`,
  };
}

export function buildAppointmentProposedEmail(input: {
  businessName: string;
  customerName: string | null;
  address: string | null;
  scheduledAt: Date;
  scheduledDurationMinutes: number | null;
  serviceDescription: string | null;
  projectUrl: string;
  rescheduled: boolean;
  timeZone: string;
}) {
  const firstName = customerFirstName(input.customerName);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const when = formatDateTime(input.scheduledAt, input.timeZone);
  const duration = input.scheduledDurationMinutes
    ? formatDurationMinutes(input.scheduledDurationMinutes)
    : null;
  const service = input.serviceDescription?.trim() || "Scheduled service";
  const intro = input.rescheduled
    ? `${input.businessName} has a rescheduled appointment for you.`
    : `${input.businessName} has proposed an appointment for you.`;
  const addressBlock = serviceAddressEmail(input.address);

  const text = [
    greeting,
    "",
    intro,
    `Appointment: ${when}`,
    duration ? `Expected duration: ${duration}` : null,
    `Service: ${service}`,
    addressBlock.text,
    "",
    "Please confirm this appointment, or request a different time, in your project portal:",
    input.projectUrl,
    "",
    "Confirm appointment, request a different time, and view your project are all in your project portal.",
    "Do not include access codes or key locations in replies to this email. Record property access in your project portal.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your appointment with ${escapeHtml(input.businessName)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(intro)}</p>
    <p><strong>Appointment: ${escapeHtml(when)}</strong></p>
    ${duration ? `<p>Expected duration: ${escapeHtml(duration)}</p>` : ""}
    <p>Service: ${escapeHtml(service)}</p>
    ${addressBlock.html}
    <p>
      <a href="${escapeHtml(input.projectUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;">Confirm Appointment</a>
    </p>
    <p>
      <a href="${escapeHtml(input.projectUrl)}" style="display:inline-block;padding:12px 18px;background:#ffffff;color:#0f172a;text-decoration:none;border-radius:8px;border:1px solid #0f172a;">Request Different Time</a>
    </p>
    <p>
      <a href="${escapeHtml(input.projectUrl)}" style="color:#0f172a;">View Your Project</a>
    </p>
    <p style="font-size:14px;color:#475569;">If the buttons do not work, open this link:<br />${escapeHtml(input.projectUrl)}</p>
  </body>
</html>`;

  return {
    subject: input.rescheduled
      ? `Your appointment with ${input.businessName} has been rescheduled`
      : `Your appointment with ${input.businessName} is scheduled`,
    html,
    text,
  };
}
