/**
 * First-release payment go-live honesty:
 * card checkout is live only with platform Stripe + app URL + Connect ready.
 * Manual Mark Paid stays the collection path until then.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-payments-go-live.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  isFakePaymentsAdapterEnabled,
  isStripePlatformConfigured,
} = await import("@/lib/payments/config");
const { explainPaymentsGoLive } = await import("@/lib/payments/go-live");
const { stripeConnectActionLabel } = await import("@/lib/payments/readiness");
const { shouldShowPayDeposit, shouldShowPayInvoice } = await import(
  "@/lib/payments/service"
);

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

console.log("\nUNIT — explainPaymentsGoLive");

const live = explainPaymentsGoLive({
  platformConfigured: true,
  appUrlConfigured: true,
  paymentReady: true,
  status: "connected",
});
check("fully ready hides the owner banner", live.showOwnerBanner === false);
check("fully ready allows online checkout", live.onlineCheckoutPossible === true);
check("fully ready has no blocker", live.blocker === null);

const noPlatform = explainPaymentsGoLive({
  platformConfigured: false,
  appUrlConfigured: true,
  paymentReady: false,
  status: "not_connected",
});
check("missing platform keys is the platform blocker", noPlatform.blocker === "platform");
check("missing platform keys shows the owner banner", noPlatform.showOwnerBanner === true);
check(
  "platform blocker tells the owner to Mark Paid",
  noPlatform.detail.includes("Mark Paid") &&
    noPlatform.detail.includes("STRIPE_SECRET_KEY"),
);

const noAppUrl = explainPaymentsGoLive({
  platformConfigured: true,
  appUrlConfigured: false,
  paymentReady: true,
  status: "connected",
});
check(
  "missing app URL outranks a connected Stripe account",
  noAppUrl.blocker === "app_url" && noAppUrl.onlineCheckoutPossible === false,
);
check(
  "app URL blocker names NEXT_PUBLIC_APP_URL and Mark Paid",
  noAppUrl.detail.includes("NEXT_PUBLIC_APP_URL") &&
    noAppUrl.detail.includes("www.collproreno.com") &&
    noAppUrl.detail.includes("Mark Paid"),
);

const notConnected = explainPaymentsGoLive({
  platformConfigured: true,
  appUrlConfigured: true,
  paymentReady: false,
  status: "not_connected",
});
check("unconnected Stripe is the connect blocker", notConnected.blocker === "connect");
check(
  "connect blocker points at Settings",
  notConnected.settingsHref === "/settings?section=estimates-payments",
);

const setupRequired = explainPaymentsGoLive({
  platformConfigured: true,
  appUrlConfigured: true,
  paymentReady: false,
  status: "setup_required",
});
check("incomplete onboarding is the setup blocker", setupRequired.blocker === "setup");

console.log("\nUNIT — fake adapter never counts as live Stripe in production");
const savedPaymentsEnv = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  TBBT_PAYMENTS_ADAPTER: process.env.TBBT_PAYMENTS_ADAPTER,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
};
function restorePaymentsEnv() {
  for (const [key, value] of Object.entries(savedPaymentsEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
process.env.VERCEL_ENV = "production";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
delete process.env.STRIPE_SECRET_KEY;
check(
  "production ignores TBBT_PAYMENTS_ADAPTER=fake",
  isFakePaymentsAdapterEnabled() === false,
);
check(
  "production fake adapter does not mark the platform configured",
  isStripePlatformConfigured() === false,
);
process.env.VERCEL_ENV = "preview";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
check(
  "preview still allows the fake adapter for tests",
  isFakePaymentsAdapterEnabled() === true && isStripePlatformConfigured() === true,
);
restorePaymentsEnv();

console.log("\nUNIT — customer Pay CTAs stay hidden without an app URL");
check(
  "Pay Invoice requires app URL even when Stripe is ready",
  shouldShowPayInvoice({
    invoiceStatus: "SENT",
    amountDueCents: 10000,
    paymentReady: true,
    appUrlConfigured: false,
  }) === false,
);
check(
  "Pay Deposit requires app URL even when Stripe is ready",
  shouldShowPayDeposit({
    requiredCents: 20000,
    remainingCents: 20000,
    paymentReady: true,
    appUrlConfigured: false,
    hasCustomerInvoice: false,
  }) === false,
);
check(
  "Pay Invoice still appears when Stripe and app URL are ready",
  shouldShowPayInvoice({
    invoiceStatus: "SENT",
    amountDueCents: 10000,
    paymentReady: true,
    appUrlConfigured: true,
  }) === true,
);

console.log("\nSTATIC — owner vs customer surfaces");

const dashboardSrc = readFileSync(
  new URL("../src/app/(app)/dashboard/page.tsx", import.meta.url),
  "utf8",
);
const ownerInvoiceSrc = readFileSync(
  new URL("../src/app/(app)/invoices/[invoiceId]/page.tsx", import.meta.url),
  "utf8",
);
const settingsSrc = readFileSync(
  new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
  "utf8",
);
const copyBtnSrc = readFileSync(
  new URL("../src/components/jobs/copy-project-link-button.tsx", import.meta.url),
  "utf8",
);
const portalInvoiceSrc = readFileSync(
  new URL("../src/app/p/[token]/invoice/page.tsx", import.meta.url),
  "utf8",
);
const publicEstimateSrc = readFileSync(
  new URL("../src/app/e/[token]/page.tsx", import.meta.url),
  "utf8",
);
const approveSrc = readFileSync(
  new URL("../src/components/estimates/approve-estimate-button.tsx", import.meta.url),
  "utf8",
);
const goLiveSrc = readFileSync(
  new URL("../src/lib/payments/go-live.ts", import.meta.url),
  "utf8",
);
const envExampleSrc = readFileSync(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const serviceSrc = readFileSync(
  new URL("../src/lib/payments/service.ts", import.meta.url),
  "utf8",
);
const adapterSrc = readFileSync(
  new URL("../src/lib/payments/stripe-adapter.ts", import.meta.url),
  "utf8",
);
const providerSrc = readFileSync(
  new URL("../src/lib/payments/provider.ts", import.meta.url),
  "utf8",
);
const configSrc = readFileSync(
  new URL("../src/lib/payments/config.ts", import.meta.url),
  "utf8",
);

check(
  "dashboard shows owner go-live honesty",
  dashboardSrc.includes("OwnerPaymentsGoLiveBanner") &&
    dashboardSrc.includes("explainPaymentsGoLiveFromStatus"),
);
check(
  "Settings Estimates & Payments shows go-live honesty",
  settingsSrc.includes("OwnerPaymentsGoLiveBanner") &&
    settingsSrc.includes("PAYMENT_PROVIDER_APP_URL_UNCONFIGURED_MESSAGE"),
);
check(
  "Connect Stripe is disabled when the app URL is missing",
  settingsSrc.includes("!snapshot.payment.platformConfigured") &&
    settingsSrc.includes("!snapshot.payment.appUrlConfigured"),
);
check(
  "not created shows Connect Stripe",
  stripeConnectActionLabel("not_connected") === "Connect Stripe",
);
check(
  "incomplete onboarding shows Continue Stripe setup",
  stripeConnectActionLabel("setup_required", "retrieve_failed") === "Continue Stripe setup" &&
    stripeConnectActionLabel("setup_required", "not_ready") === "Continue Stripe setup",
);
check(
  "complete onboarding hides the setup action",
  stripeConnectActionLabel("connected", "v1_charges_enabled") === null,
);
check(
  "Settings Setup Required has Continue Stripe setup instead of a circular Open Estimates link",
  settingsSrc.includes("stripeConnectActionLabel") &&
    settingsSrc.includes("ConnectStripeButton") &&
    settingsSrc.includes("snapshot.payment.offerOnboarding") &&
    settingsSrc.includes("showSettingsLink={false}"),
);
check(
  "hosted Checkout still charges the business connected account",
  readFileSync(new URL("../src/lib/payments/stripe-adapter.ts", import.meta.url), "utf8").includes(
    "{ stripeAccount: input.connectedAccountId }",
  ) &&
    readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8").includes(
      "verifyStripeWebhookPayload",
    ) &&
    readFileSync(new URL("../src/lib/stripe-webhook-dispatch.ts", import.meta.url), "utf8").includes(
      "constructStripeWebhookEvent",
    ) &&
    readFileSync(new URL("../src/lib/stripe-webhook-dispatch.ts", import.meta.url), "utf8").includes(
      "applyVerifiedCheckoutPayment",
    ),
);
check(
  "Connect onboarding logs a redacted Stripe type/code instead of swallowing the failure",
  readFileSync(new URL("../src/app/actions/payments.ts", import.meta.url), "utf8").includes(
    "logStripeConnectOnboardingError",
  ) &&
    readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8").includes(
      "isUnknownConnectedAccountError",
    ) &&
    readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      '"not_found"',
    ) &&
    !readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      "acct_",
    ),
);
check(
  "v2 Account Link forbidden falls back to v1 instead of replacing the stored account",
  readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
    "shouldFallBackToV1AccountLink",
  ) &&
    readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      '"forbidden"',
    ) &&
    readFileSync(new URL("../src/lib/payments/stripe-adapter.ts", import.meta.url), "utf8").includes(
      "stripe.accountLinks.create",
    ) &&
    !readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      "acct_",
    ),
);
check(
  "Connect onboarding UI includes type/param/status when Stripe omits a code",
  readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
    "stripeConnectOnboardingFailureIdentifier",
  ) &&
    readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      "redactedStripeErrorMessage",
    ) &&
    readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      "param=${",
    ),
);
check(
  "v1 Account Link for an account not on this platform is treated as stale",
  readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
    "not connected to your platform or does not exist",
  ) &&
    readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8").includes(
      "isUnknownConnectedAccountError",
    ) &&
    readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8").includes(
      "replaceAccountId",
    ),
);
check(
  "stale-account replacement allows cs_test_ history and blocks cs_live_ or unknown sessions",
  readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
    "connectedAccountReplacementBlockReason",
  ) &&
    readFileSync(new URL("../src/lib/payments/stripe-errors.ts", import.meta.url), "utf8").includes(
      '"cs_live_"',
    ) &&
    readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8").includes(
      "connectedAccountReplacementBlockReason",
    ) &&
    readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8").includes(
      "live Stripe payments already exist",
    ),
);
check(
  "owner invoice ops copies /p/{token}/invoice",
  ownerInvoiceSrc.includes('label="Copy invoice link"') &&
    ownerInvoiceSrc.includes("/invoice"),
);
check(
  "owner invoice link copy does not claim customers can pay online",
  ownerInvoiceSrc.includes(
    "Customers can view this invoice from the link. Online card payment will be available when payment processing is connected.",
  ) &&
    !ownerInvoiceSrc.includes("Customers can pay this invoice online from the link."),
);
check(
  "copy button can target an explicit customer path",
  copyBtnSrc.includes("hrefPath") && copyBtnSrc.includes("window.location.origin"),
);
check(
  "customer invoice has no owner go-live banner or Mark Paid",
  !portalInvoiceSrc.includes("OwnerPaymentsGoLiveBanner") &&
    !portalInvoiceSrc.includes("Mark Paid") &&
    !portalInvoiceSrc.includes("STRIPE_SECRET_KEY"),
);
check(
  "public estimate Pay Deposit uses onlineCheckoutPossible",
  publicEstimateSrc.includes("onlineCheckoutPossible"),
);
check(
  "approve-and-pay does not auto-redirect unless checkout can start",
  approveSrc.includes("paymentReady") && approveSrc.includes("form.action"),
);
check(
  "approve CTA only promises Pay Deposit when checkout can start",
  approveSrc.includes("needsDeposit && paymentReady") &&
    approveSrc.includes("Approve Estimate & Pay") &&
    approveSrc.includes("Online deposit payment is not available yet") &&
    approveSrc.includes("material deposit is still due"),
);
check(
  "go-live helper does not invent a fake payment provider",
  !goLiveSrc.includes("TBBT_PAYMENTS_ADAPTER") && !goLiveSrc.includes("fake"),
);
check(
  "production webhook destination is documented",
  envExampleSrc.includes("https://www.collproreno.com/api/stripe/webhook") &&
    envExampleSrc.includes("checkout.session.completed") &&
    envExampleSrc.includes("Connected accounts"),
);
check(
  "hosted Checkout does not require a publishable key",
  !adapterSrc.includes("NEXT_PUBLIC_STRIPE") &&
    !adapterSrc.includes("publishable") &&
    envExampleSrc.includes("never a publishable key"),
);
check(
  "deposit apply rejects amount mismatches against remaining due",
  serviceSrc.includes("async function applyVerifiedDepositPayment") &&
    serviceSrc.includes('reason: "amount_mismatch"') &&
    serviceSrc.includes("requiredDepositFromLines"),
);
check(
  "production never enables the fake payments adapter",
  configSrc.includes('process.env.VERCEL_ENV === "production"') &&
    providerSrc.includes("isFakePaymentsAdapterEnabled") &&
    envExampleSrc.includes("Never set TBBT_PAYMENTS_ADAPTER=fake"),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
