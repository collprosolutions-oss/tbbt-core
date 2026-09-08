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

const { explainPaymentsGoLive } = await import("@/lib/payments/go-live");
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
