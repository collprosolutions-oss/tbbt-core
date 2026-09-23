function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Transactional password-recovery email. The reset URL contains only the
 * raw one-time token -- never a business, tenant, or user id.
 */
export function buildPasswordResetEmail(input: { resetUrl: string }) {
  const text = [
    "Reset your TBBT password",
    "",
    "We received a request to reset the password for this email address.",
    "",
    "Open this link to choose a new password:",
    input.resetUrl,
    "",
    "This link is single-use and expires in 1 hour.",
    "",
    "If you did not request a password reset, you can ignore this email.",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reset your TBBT password</title>
  </head>
  <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
    <p>We received a request to reset the password for this email address.</p>
    <p>
      <a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;">Reset your password</a>
    </p>
    <p style="font-size:14px;color:#475569;">If the button does not work, open this link:<br />${escapeHtml(input.resetUrl)}</p>
    <p style="font-size:14px;color:#475569;">This link is single-use and expires in 1 hour.</p>
    <p style="font-size:14px;color:#475569;">If you did not request a password reset, you can ignore this email.</p>
  </body>
</html>`;

  return {
    subject: "Reset your TBBT password",
    html,
    text,
  };
}
