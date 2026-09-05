/**
 * Offline contract check for the communications that exist today:
 * estimate email, invoice-ready email, and team invite email.
 *
 * Does not call Resend or any SMS provider.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-communications.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  estimateEmailIdempotencyKey,
  getMailConfig,
  invoiceReadyIdempotencyKey,
  isMailSendAttemptId,
  teamInviteIdempotencyKey,
  transactionalEmailFailureMessage,
} = await import("@/lib/mail");
const { isEmailDeliveryConfigured } = await import("@/lib/settings");
const { buildEstimateReadyEmail } = await import("@/lib/estimate-mail");
const { buildInvoiceReadyEmail } = await import("@/lib/invoice-mail");
const { buildTeamInviteEmail } = await import("@/lib/team-mail");

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL - ${label}`);
  }
}

const saved = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
};

function setEnv(map) {
  for (const key of Object.keys(saved)) {
    if (map[key] === undefined || map[key] === null || map[key] === "") {
      delete process.env[key];
    } else {
      process.env[key] = map[key];
    }
  }
}

function restore() {
  setEnv(saved);
}

const estimateActionSrc = readFileSync(
  new URL("../src/app/actions/estimate.ts", import.meta.url),
  "utf8",
);
const teamActionSrc = readFileSync(
  new URL("../src/app/actions/team.ts", import.meta.url),
  "utf8",
);
const invoiceNotifySrc = readFileSync(
  new URL("../src/lib/complete-job-invoice.ts", import.meta.url),
  "utf8",
);
const mailSrc = readFileSync(new URL("../src/lib/mail.ts", import.meta.url), "utf8");
const settingsSrc = readFileSync(
  new URL("../src/lib/settings.ts", import.meta.url),
  "utf8",
);
const estimateButtonSrc = readFileSync(
  new URL("../src/components/estimates/email-estimate-button.tsx", import.meta.url),
  "utf8",
);
const sendEstimateSrc = estimateActionSrc.slice(
  estimateActionSrc.indexOf("export async function sendEstimate"),
  estimateActionSrc.indexOf("export async function returnEstimateToDraft"),
);
const emailEstimateSrc = estimateActionSrc.slice(
  estimateActionSrc.indexOf("export async function emailSentEstimate"),
);

console.log("\nSTATIC — Idempotency helpers");
const attemptA = "11111111-1111-4111-8111-111111111111";
const attemptB = "22222222-2222-4222-8222-222222222222";
check("sendAttemptId accepts a UUID", isMailSendAttemptId(attemptA));
check("sendAttemptId rejects empty", isMailSendAttemptId("") === false);
check("sendAttemptId rejects random text", isMailSendAttemptId("retry") === false);
check(
  "same estimate + same attempt is the same key",
  estimateEmailIdempotencyKey("est-1", attemptA) ===
    estimateEmailIdempotencyKey("est-1", attemptA),
);
check(
  "same estimate + different attempt is a different key (intentional resend)",
  estimateEmailIdempotencyKey("est-1", attemptA) !==
    estimateEmailIdempotencyKey("est-1", attemptB),
);
check(
  "team invite key is stable for the same business + email",
  teamInviteIdempotencyKey("biz-1", "Ada@Example.com") ===
    teamInviteIdempotencyKey("biz-1", "ada@example.com"),
);
check(
  "team invite key differs across businesses",
  teamInviteIdempotencyKey("biz-1", "ada@example.com") !==
    teamInviteIdempotencyKey("biz-2", "ada@example.com"),
);
check(
  "invoice-ready key is stable for the invoice",
  invoiceReadyIdempotencyKey("inv-1") === invoiceReadyIdempotencyKey("inv-1"),
);
check(
  "invoice-ready key differs across invoices",
  invoiceReadyIdempotencyKey("inv-1") !== invoiceReadyIdempotencyKey("inv-2"),
);

console.log("\nSTATIC — Source contracts");
check(
  "Email Estimate submits a sendAttemptId",
  estimateButtonSrc.includes('name="sendAttemptId"'),
);
check(
  "estimate email uses the attempt-scoped helper",
  emailEstimateSrc.includes("estimateEmailIdempotencyKey(estimate.id, sendAttemptId)"),
);
check(
  "estimate email does not mint a UUID in the idempotency key",
  !emailEstimateSrc.includes("randomUUID()"),
);
check(
  "Send Estimate does not send email",
  !sendEstimateSrc.includes("sendTransactionalEmail"),
);
check(
  "team invite uses the stable business+email helper",
  teamActionSrc.includes("teamInviteIdempotencyKey(access.businessId, email)"),
);
check(
  "team invite does not mint a UUID in the idempotency key",
  !teamActionSrc.includes("randomUUID()"),
);
check(
  "invoice notify uses the stable invoice helper",
  invoiceNotifySrc.includes("invoiceReadyIdempotencyKey(input.invoiceId)"),
);
check(
  "Settings readiness uses getMailConfig()",
  settingsSrc.includes("return !(\"error\" in getMailConfig())") ||
    settingsSrc.includes("return !('error' in getMailConfig())"),
);
check(
  "Settings no longer uses a keys-only mail check",
  !settingsSrc.includes("function getMailConfigSafe"),
);
check(
  "sendTransactionalEmail requires a kind",
  mailSrc.includes("kind: TransactionalEmailKind"),
);
check(
  "invoice failure is not labeled as an estimate",
  transactionalEmailFailureMessage("invoice") ===
    "The invoice email could not be sent.",
);
check(
  "team failure is not labeled as an estimate",
  transactionalEmailFailureMessage("team") ===
    "The team invitation email could not be sent.",
);
check(
  "estimate failure stays estimate-specific",
  transactionalEmailFailureMessage("estimate") ===
    "The estimate email could not be sent.",
);

console.log("\nSTATIC — Templates and customer-safe content");
const estimateEmail = buildEstimateReadyEmail({
  businessName: "CollPro Reno",
  customerName: "Jordan Rivera",
  total: { toString: () => "300.00" },
  address: "10 Other Ave, Reno, NV 89501",
  approveUrl: "https://www.collproreno.com/e/estimate-token",
});
check(
  "estimate subject uses the business name",
  estimateEmail.subject === "Your estimate from CollPro Reno is ready",
);
check(
  "estimate email links to the public /e/ token URL",
  estimateEmail.text.includes("https://www.collproreno.com/e/estimate-token") &&
    estimateEmail.html.includes("https://www.collproreno.com/e/estimate-token"),
);

const invoiceEmail = buildInvoiceReadyEmail({
  businessName: "CollPro Reno",
  customerName: "Jordan Rivera",
  total: { toString: () => "375.00" },
  address: "10 Other Ave, Reno, NV 89501",
  invoiceUrl: "https://www.collproreno.com/p/project-token/invoice",
});
check(
  "invoice subject uses the business name",
  invoiceEmail.subject === "Your invoice from CollPro Reno is ready",
);
check(
  "invoice email links to the customer portal invoice URL",
  invoiceEmail.text.includes("https://www.collproreno.com/p/project-token/invoice") &&
    invoiceEmail.html.includes("https://www.collproreno.com/p/project-token/invoice"),
);

const teamEmail = buildTeamInviteEmail({
  businessName: "CollPro Reno",
  memberName: "Newt Fieldworker",
  setupUrl: "https://www.collproreno.com/set-password/setup-token",
});
check(
  "team invite links to the password-setup URL",
  teamEmail.text.includes("https://www.collproreno.com/set-password/setup-token"),
);

const leaked = [
  "paymentMethod",
  "paymentReference",
  "internal notes",
  "complexity",
  "customer rating",
  "blob.vercel-storage.com",
  "r2.cloudflarestorage.com",
  "businessId",
  "cost basis",
];
const combined = [
  estimateEmail.html,
  estimateEmail.text,
  invoiceEmail.html,
  invoiceEmail.text,
  teamEmail.html,
  teamEmail.text,
].join("\n");
check(
  "customer-facing templates omit owner-only / private fields",
  leaked.every((needle) => !combined.includes(needle)),
);

console.log("\nSTATIC — Configuration honesty");
setEnv({
  RESEND_API_KEY: null,
  EMAIL_FROM: null,
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "production",
  VERCEL_URL: null,
  VERCEL_BRANCH_URL: null,
});
check("missing credentials is not configured", isEmailDeliveryConfigured() === false);
check(
  "Settings helper matches getMailConfig when unset",
  isEmailDeliveryConfigured() === !("error" in getMailConfig()),
);

setEnv({
  RESEND_API_KEY: "re_test_placeholder",
  EMAIL_FROM: "estimates@example.com",
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "production",
  VERCEL_URL: "collpro-reno.vercel.app",
  VERCEL_BRANCH_URL: null,
});
check(
  "Production keys without NEXT_PUBLIC_APP_URL stay unconfigured",
  isEmailDeliveryConfigured() === false && "error" in getMailConfig(),
);

setEnv({
  RESEND_API_KEY: "re_test_placeholder",
  EMAIL_FROM: "estimates@example.com",
  NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  VERCEL_ENV: "production",
  VERCEL_URL: "collpro-reno.vercel.app",
  VERCEL_BRANCH_URL: null,
});
check(
  "Production keys plus NEXT_PUBLIC_APP_URL are configured",
  isEmailDeliveryConfigured() === true && !("error" in getMailConfig()),
);
check(
  "mail helper and Settings helper stay aligned when configured",
  isEmailDeliveryConfigured() === true,
);

restore();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
