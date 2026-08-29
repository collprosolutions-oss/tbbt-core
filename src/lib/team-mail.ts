function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Best-effort email for a brand-new team member's one-time password-setup
 * link (see addTeamMember() in src/app/actions/team.ts). Only ever sent
 * when transactional email is fully configured (getMailConfig() succeeds);
 * the owner/admin always also sees this same link on the Team page so
 * onboarding works even when email is not configured.
 */
export function buildTeamInviteEmail(input: {
  businessName: string;
  memberName: string;
  setupUrl: string;
}) {
  const text = [
    `Hi ${input.memberName},`,
    "",
    `${input.businessName} added you as a team member on TBBT.`,
    "",
    "Set your password to finish setting up your account:",
    input.setupUrl,
    "",
    "This link is single-use and expires soon for your security.",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>You've been added to ${escapeHtml(input.businessName)} on TBBT</title>
  </head>
  <body style="margin:0;padding:24px;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
    <p>Hi ${escapeHtml(input.memberName)},</p>
    <p>${escapeHtml(input.businessName)} added you as a team member on TBBT.</p>
    <p>
      <a href="${escapeHtml(input.setupUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;">Set Your Password</a>
    </p>
    <p style="font-size:14px;color:#475569;">If the button does not work, open this link:<br />${escapeHtml(input.setupUrl)}</p>
    <p style="font-size:14px;color:#475569;">This link is single-use and expires soon for your security.</p>
  </body>
</html>`;

  return {
    subject: `You've been added to ${input.businessName} on TBBT`,
    html,
    text,
  };
}
