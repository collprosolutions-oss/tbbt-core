/**
 * TBBT SaaS subscription billing (Task 4).
 *
 * Proves platform SaaS billing is distinct from Stripe Connect, OWNER-only
 * subscription Checkout, webhook source of truth, idempotency, existing
 * tenant compatibility, and unchanged Tasks 1–3 onboarding.
 *
 * Uses a fake SaaS billing provider. Does not require live Stripe credentials
 * except a dummy key for webhook signature tests.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-saas-billing.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_saas_billing_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://saas-billing.test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_saas_billing_check";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_saas_billing_check";
process.env.STRIPE_SAAS_PRICE_ID = "price_saas_test";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for SaaS billing test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const Stripe = (await import("stripe")).default;
const { ForbiddenError } = await import("@/lib/authorization");
const { parseCheckoutPaymentEvent } = await import("@/lib/payments/events");
const { postAuthenticationPath } = await import("@/lib/first-run-setup");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const {
  applyParsedSaasBillingEvent,
  applySaasBillingStripeEvent,
  constructStripeWebhookEventWithSecrets,
  getSaasBillingProvider,
  inspectConfiguredFounderPrice,
  isFakeSaasBillingAdapterEnabled,
  isSaasBillingConfigured,
  loadSaasBillingSnapshot,
  resolveSaasBillingReadiness,
  SAAS_BILLING_APP_URL_OWNER_MESSAGE,
  SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
  loadSaasEntitlement,
  parseSaasBillingEvent,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  saasBillingWebhookSecrets,
  SAAS_CHECKOUT_PURPOSE,
  setSaasBillingProvider,
  startSaasBillingPortal,
  startSaasSubscriptionCheckout,
  SaasBillingError,
  TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT,
} = await import("@/lib/saas-billing");
const {
  dispatchStripeWebhookEvent,
  stripeWebhookSecretsConfigured,
  verifyStripeWebhookPayload,
} = await import("@/lib/stripe-webhook-dispatch");

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, email = "owner@example.com") {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: "user", email, name: "Test User" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function seedBusiness(name, extra = {}) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: {
      name,
      slug: extra.slug ?? `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
      ...("firstRunSetupCompletedAt" in extra
        ? { firstRunSetupCompletedAt: extra.firstRunSetupCompletedAt }
        : {}),
      ...("starterServicesSetupCompletedAt" in extra
        ? { starterServicesSetupCompletedAt: extra.starterServicesSetupCompletedAt }
        : {}),
      ...("websiteSetupCompletedAt" in extra
        ? { websiteSetupCompletedAt: extra.websiteSetupCompletedAt }
        : {}),
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  return { business, membership, ownerUser };
}

function saasCheckoutEvent(input) {
  return {
    id: input.id ?? "evt_checkout_1",
    type: "checkout.session.completed",
    data: {
      object: {
        object: "checkout.session",
        id: input.sessionId ?? "cs_saas_1",
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        customer: input.customerId,
        subscription: input.subscriptionId,
        metadata: {
          purpose: SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
          priceId: input.priceId ?? "price_saas_test",
        },
      },
    },
  };
}

function saasSubscriptionEvent(input) {
  return {
    id: input.id ?? "evt_sub_1",
    type: input.type ?? "customer.subscription.updated",
    data: {
      object: {
        object: "subscription",
        id: input.subscriptionId,
        status: input.status ?? "active",
        customer: input.customerId,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        items: {
          data: [
            {
              current_period_end: input.periodEnd ?? 1_800_000_000,
              price: { id: input.priceId ?? "price_saas_test" },
            },
          ],
        },
        metadata: {
          purpose: SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
        },
      },
    },
  };
}

async function verifyAndDispatch(event, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });
  const verified = verifyStripeWebhookPayload(payload, signature);
  return dispatchStripeWebhookEvent(prisma, verified);
}

const saasDir = readFileSync(new URL("../src/lib/saas-billing/stripe.ts", import.meta.url), "utf8");
const saasConfig = readFileSync(new URL("../src/lib/saas-billing/config.ts", import.meta.url), "utf8");
const saasProviderSrc = readFileSync(
  new URL("../src/lib/saas-billing/provider.ts", import.meta.url),
  "utf8",
);
const paymentsConfigSrc = readFileSync(
  new URL("../src/lib/payments/config.ts", import.meta.url),
  "utf8",
);
const saasOps = readFileSync(new URL("../src/lib/saas-billing/ops.ts", import.meta.url), "utf8");
const saasFounderPriceSrc = readFileSync(
  new URL("../src/lib/saas-billing/founder-price.ts", import.meta.url),
  "utf8",
);
const saasReadinessSrc = readFileSync(
  new URL("../src/lib/saas-billing/readiness.ts", import.meta.url),
  "utf8",
);
const saasBannerSrc = readFileSync(
  new URL("../src/components/settings/saas-entitlement-banner.tsx", import.meta.url),
  "utf8",
);
const marketingHomeSrc = readFileSync(
  new URL("../src/app/(tbbt)/home/page.tsx", import.meta.url),
  "utf8",
);
const signUpSrc = readFileSync(new URL("../src/app/(auth)/sign-up/page.tsx", import.meta.url), "utf8");
const appLayoutSrc = readFileSync(new URL("../src/app/(app)/layout.tsx", import.meta.url), "utf8");
const fieldLayoutSrc = readFileSync(new URL("../src/app/field/layout.tsx", import.meta.url), "utf8");
const saasEvents = readFileSync(new URL("../src/lib/saas-billing/events.ts", import.meta.url), "utf8");
const webhookSrc = readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
const webhookDispatchSrc = readFileSync(
  new URL("../src/lib/stripe-webhook-dispatch.ts", import.meta.url),
  "utf8",
);
const webhookStack = `${webhookSrc}\n${webhookDispatchSrc}`;
const settingsSrc = readFileSync(
  new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
  "utf8",
);
const settingsPageSrc = readFileSync(
  new URL("../src/app/(app)/settings/page.tsx", import.meta.url),
  "utf8",
);
const firstRunSrc = readFileSync(new URL("../src/lib/first-run-setup.ts", import.meta.url), "utf8");
const starterSrc = readFileSync(new URL("../src/lib/starter-services-setup.ts", import.meta.url), "utf8");
const websiteSrc = readFileSync(new URL("../src/lib/website-setup.ts", import.meta.url), "utf8");
const paymentsServiceSrc = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const saasTypesSrc = readFileSync(new URL("../src/lib/saas-billing/types.ts", import.meta.url), "utf8");
const saasFakeSrc = readFileSync(new URL("../src/lib/saas-billing/fake.ts", import.meta.url), "utf8");
const offboardingSrc = readFileSync(new URL("../src/lib/offboarding.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const proxySrc = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");

console.log("\nSTATIC — SaaS billing stays separate from Connect and Tasks 1–3");
check(
  "SaaS Stripe Checkout uses mode subscription without a Connect account",
  saasDir.includes('mode: "subscription"') &&
    !saasDir.includes("stripeAccount") &&
    !saasDir.includes("createConnectedAccount"),
);
check(
  "SaaS ops never write BusinessPaymentAccount or invoice/deposit Checkout",
  !saasOps.includes("BusinessPaymentAccount") &&
    !saasOps.includes("createConnectedAccount") &&
    !saasOps.includes("invoice_balance") &&
    !saasOps.includes("material_deposit") &&
    !saasOps.includes("stripeAccount"),
);
check(
  "Connect payment service does not persist BusinessSaasSubscription",
  !paymentsServiceSrc.includes("BusinessSaasSubscription") &&
    !paymentsServiceSrc.includes("saasSubscription") &&
    !paymentsServiceSrc.includes("tbbt_saas_subscription"),
);
check(
  "Prisma keeps SaaS subscription distinct from BusinessPaymentAccount",
  schemaSrc.includes("model BusinessSaasSubscription") &&
    schemaSrc.includes("model BusinessPaymentAccount") &&
    schemaSrc.includes("saasSubscription") &&
    schemaSrc.includes("paymentAccount"),
);
check(
  "Webhook verifies signatures and dispatches SaaS before Connect",
  webhookStack.includes("constructStripeWebhookEvent") &&
    webhookStack.includes("constructStripeWebhookEventWithSecrets") &&
    webhookStack.includes("parseSaasBillingEvent") &&
    webhookStack.includes("parseCheckoutPaymentEvent") &&
    webhookSrc.includes("Invalid signature.") &&
    webhookDispatchSrc.includes("system: \"saas\"") &&
    saasEvents.includes('"checkout.session.async_payment_succeeded"') &&
    saasEvents.includes('"customer.subscription.resumed"') &&
    saasEvents.includes('"invoice.paid"') &&
    saasEvents.includes('"invoice.payment_succeeded"'),
);
check(
  "Webhook apply path never uses fake Stripe adapters",
  !webhookSrc.includes("createFakeSaasBillingProvider") &&
    !webhookSrc.includes("createFakePaymentProvider") &&
    !webhookDispatchSrc.includes("createFakeSaasBillingProvider") &&
    !webhookDispatchSrc.includes("createFakePaymentProvider") &&
    !webhookDispatchSrc.includes("isFakeSaasBillingAdapterEnabled") &&
    !webhookDispatchSrc.includes("isFakePaymentsAdapterEnabled") &&
    !webhookDispatchSrc.includes("getSaasBillingProvider") &&
    !webhookDispatchSrc.includes("getPaymentProvider"),
);
check(
  "Auth proxy lets Stripe reach /api/stripe/webhook without a session cookie",
  proxySrc.includes("isStripeWebhookPath") &&
    proxySrc.includes("api/stripe/webhook") &&
    proxySrc.includes("isPublicWebsitePath(pathname) || isStripeWebhookPath(pathname)"),
);
check(
  "Success redirect copy does not persist subscription status",
  settingsSrc.includes("TBBT_SAAS_CHECKOUT_SUCCESS_MESSAGE") &&
    !settingsPageSrc.includes("applyParsedSaasBillingEvent") &&
    !settingsPageSrc.includes("applySaasBillingStripeEvent") &&
    !settingsSrc.includes('status: "active"'),
);
check(
  "Tasks 1–3 onboarding modules do not mention SaaS billing or payment gating",
  !firstRunSrc.includes("saas") &&
    !firstRunSrc.includes("STRIPE_SAAS") &&
    !starterSrc.includes("saas") &&
    !websiteSrc.includes("saas") &&
    firstRunSrc.includes('return "/dashboard"') &&
    firstRunSrc.includes("ownerNeedsWebsiteSetup"),
);
check(
  "Environment example documents SaaS Price ID separately from Connect",
  envExample.includes("STRIPE_SAAS_PRICE_ID") &&
    envExample.includes("the trade business pays TBBT") &&
    envExample.includes("This is not Stripe Connect") &&
    envExample.includes("customer.subscription.updated") &&
    envExample.includes("customer.subscription.resumed") &&
    envExample.includes("checkout.session.async_payment_succeeded") &&
    envExample.includes("A signature that matches") &&
    envExample.includes("neither secret is rejected") &&
    envExample.includes("ignores TBBT_SAAS_BILLING_ADAPTER=fake") &&
    envExample.includes("A missing Price ID alone does not") &&
    envExample.includes("block Billing Portal") &&
    envExample.includes("Production Checkout fails closed") &&
    !envExample.includes("Production Checkout and Billing Portal fail closed"),
);
check(
  "SaaS fake adapter uses the same Vercel production guard as Connect payments",
  saasConfig.includes("isFakeSaasBillingAdapterEnabled") &&
    saasConfig.includes('process.env.VERCEL_ENV === "production"') &&
    saasConfig.includes("isFakePaymentsAdapterEnabled") &&
    saasProviderSrc.includes("isFakeSaasBillingAdapterEnabled()") &&
    !saasProviderSrc.includes('process.env.TBBT_SAAS_BILLING_ADAPTER === "fake"') &&
    saasOps.includes("isFakeSaasBillingAdapterEnabled()") &&
    !saasOps.includes('process.env.TBBT_SAAS_BILLING_ADAPTER === "fake"') &&
    saasFounderPriceSrc.includes("isFakeSaasBillingAdapterEnabled()") &&
    !saasFounderPriceSrc.includes('process.env.TBBT_SAAS_BILLING_ADAPTER === "fake"') &&
    saasReadinessSrc.includes("isFakeSaasBillingAdapterEnabled") &&
    !saasReadinessSrc.includes('process.env.TBBT_SAAS_BILLING_ADAPTER === "fake"') &&
    paymentsConfigSrc.includes("isFakePaymentsAdapterEnabled") &&
    paymentsConfigSrc.includes('process.env.VERCEL_ENV === "production"'),
);
check(
  "Offboarding asks the provider to schedule cancel-at-period-end and never writes it locally",
  saasTypesSrc.includes("scheduleCancelAtPeriodEnd") &&
    saasFakeSrc.includes("scheduleCancelAtPeriodEnd") &&
    saasDir.includes("cancel_at_period_end: true") &&
    offboardingSrc.includes("scheduleCancelAtPeriodEnd") &&
    offboardingSrc.includes("billingCancellationScheduled") &&
    !offboardingSrc.includes("cancelAtPeriodEnd: true") &&
    offboardingSrc.includes("Billing cancellation is not yet scheduled."),
);
check(
  "Checkout and Portal use the canonical production readiness check",
  saasReadinessSrc.includes("resolveSaasBillingReadiness") &&
    saasOps.includes("resolveSaasBillingReadiness") &&
    saasOps.includes("checkoutReady") &&
    saasOps.includes("portalReady") &&
    saasReadinessSrc.includes("invalid_founder_price") &&
    saasReadinessSrc.includes("This does not throw at import time"),
);
check(
  "OWNER billing UI shows a configuration problem and hides Checkout that cannot start",
  settingsSrc.includes("billingNotReadyMessage") &&
    settingsSrc.includes("{billing.checkoutPossible ? <SaasSubscribeButton /> : null}") &&
    settingsSrc.includes("{billing.portalPossible ? <SaasBillingPortalButton /> : null}") &&
    saasBannerSrc.includes("readiness.portalReady"),
);
check(
  "global entitlement banner cannot expose Subscribe without Founder Price inspection",
  !saasBannerSrc.includes("SaasSubscribeButton") &&
    !saasBannerSrc.includes("inspectConfiguredFounderPrice") &&
    saasBannerSrc.includes("Open TBBT Billing") &&
    saasBannerSrc.includes("resolveSaasBillingReadiness()") &&
    !saasBannerSrc.includes("founderPrice") &&
    appLayoutSrc.includes("SaasEntitlementBanner") &&
    fieldLayoutSrc.includes("SaasEntitlementBanner") &&
    !appLayoutSrc.includes("inspectConfiguredFounderPrice") &&
    !fieldLayoutSrc.includes("inspectConfiguredFounderPrice"),
);
check(
  "Marketing, signup, and first-run setup do not import SaaS billing readiness",
  !marketingHomeSrc.includes("resolveSaasBillingReadiness") &&
    !signUpSrc.includes("resolveSaasBillingReadiness") &&
    !firstRunSrc.includes("resolveSaasBillingReadiness") &&
    !starterSrc.includes("resolveSaasBillingReadiness") &&
    !websiteSrc.includes("resolveSaasBillingReadiness"),
);
check(
  "SaaS module does not hardcode a production dollar amount",
  !/\$\d/.test(saasDir) && !/\$\d/.test(saasOps) && !/\$\d/.test(saasEvents),
);
check(
  "SaaS events ignore Connect-account payloads",
  saasEvents.includes("Connect-account events belong to customer invoice/deposit"),
);

console.log("\nUNIT — fake SaaS adapter never operates in Vercel production");
const savedSaasEnv = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  TBBT_SAAS_BILLING_ADAPTER: process.env.TBBT_SAAS_BILLING_ADAPTER,
  STRIPE_SAAS_PRICE_ID: process.env.STRIPE_SAAS_PRICE_ID,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
};
function restoreSaasEnv() {
  for (const [key, value] of Object.entries(savedSaasEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSaasBillingProvider();
}
function isInjectedFakeProvider(provider) {
  return Boolean(provider && typeof provider === "object" && "customers" in provider);
}

process.env.VERCEL_ENV = "production";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
delete process.env.STRIPE_SAAS_PRICE_ID;
resetSaasBillingProvider();
check(
  "production ignores TBBT_SAAS_BILLING_ADAPTER=fake",
  isFakeSaasBillingAdapterEnabled() === false,
);
check(
  "production fake adapter does not mark SaaS billing configured",
  isSaasBillingConfigured() === false,
);
check(
  "production selects the Stripe SaaS provider, not the fake",
  isInjectedFakeProvider(getSaasBillingProvider()) === false,
);
const productionFakePrice = await inspectConfiguredFounderPrice();
check(
  "production fake adapter does not skip Founder Price inspection",
  productionFakePrice.warning === TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT &&
    productionFakePrice.configuredPriceId === null,
);

process.env.VERCEL_ENV = "preview";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
resetSaasBillingProvider();
check(
  "preview still allows the fake SaaS adapter for tests",
  isFakeSaasBillingAdapterEnabled() === true && isSaasBillingConfigured() === true,
);
check(
  "non-production still selects the fake SaaS provider",
  isInjectedFakeProvider(getSaasBillingProvider()) === true,
);

delete process.env.VERCEL_ENV;
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
resetSaasBillingProvider();
check(
  "local/test without VERCEL_ENV still allows the fake SaaS adapter",
  isFakeSaasBillingAdapterEnabled() === true &&
    isInjectedFakeProvider(getSaasBillingProvider()) === true,
);

delete process.env.TBBT_SAAS_BILLING_ADAPTER;
process.env.STRIPE_SAAS_PRICE_ID = "price_saas_configured";
resetSaasBillingProvider();
check(
  "real Stripe Price ID still configures SaaS billing without the fake adapter",
  isFakeSaasBillingAdapterEnabled() === false && isSaasBillingConfigured() === true,
);
check(
  "real Stripe configuration still selects the Stripe SaaS provider",
  isInjectedFakeProvider(getSaasBillingProvider()) === false,
);

async function withSaasEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  resetSaasBillingProvider();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetSaasBillingProvider();
  }
}

console.log("\nUNIT — production Founder billing readiness fails closed");
await withSaasEnv(
  {
    VERCEL_ENV: "production",
    TBBT_SAAS_BILLING_ADAPTER: "fake",
    STRIPE_SAAS_PRICE_ID: undefined,
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  },
  () => {
    const ready = resolveSaasBillingReadiness();
    check(
      "production with no STRIPE_SAAS_PRICE_ID is not checkout-ready",
      ready.reason === "missing_price" &&
        ready.checkoutReady === false &&
        ready.configured === false &&
        ready.ownerMessage === SAAS_BILLING_NOT_READY_OWNER_MESSAGE &&
        !String(ready.ownerMessage).includes("sk_"),
    );
  },
);
await withSaasEnv(
  {
    VERCEL_ENV: "production",
    TBBT_SAAS_BILLING_ADAPTER: "fake",
    STRIPE_SAAS_PRICE_ID: "price_saas_configured",
    STRIPE_SECRET_KEY: undefined,
    NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  },
  () => {
    const ready = resolveSaasBillingReadiness();
    check(
      "production with no Stripe secret key is not checkout-ready",
      ready.reason === "missing_secret" &&
        ready.checkoutReady === false &&
        ready.portalReady === false &&
        ready.configured === false &&
        ready.ownerMessage === SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    );
  },
);
await withSaasEnv(
  {
    VERCEL_ENV: "production",
    TBBT_SAAS_BILLING_ADAPTER: "fake",
    STRIPE_SAAS_PRICE_ID: "price_saas_wrong",
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  },
  () => {
    const warning =
      "The configured Stripe Price does not match the approved Founder Plan of $49/month. Checkout still uses STRIPE_SAAS_PRICE_ID and will not pretend the charge is $49.";
    const ready = resolveSaasBillingReadiness({
      founderPrice: { matchesFounderPrice: false, warning },
    });
    check(
      "invalid Founder Price does not pass readiness",
      ready.reason === "invalid_founder_price" &&
        ready.checkoutReady === false &&
        ready.configured === true &&
        ready.ownerMessage === warning,
    );
    const unverified = resolveSaasBillingReadiness({
      founderPrice: { matchesFounderPrice: null, warning: null },
    });
    check(
      "unverified Founder Price retrieve does not fail closed by itself",
      unverified.reason === "ready" && unverified.checkoutReady === true,
    );
    const bannerStyleReady = resolveSaasBillingReadiness();
    check(
      "confirmed-invalid Founder Price cannot leave global banner Checkout ready",
      ready.checkoutReady === false &&
        bannerStyleReady.checkoutReady === false &&
        !saasBannerSrc.includes("SaasSubscribeButton"),
    );
  },
);
await withSaasEnv(
  {
    VERCEL_ENV: "preview",
    TBBT_SAAS_BILLING_ADAPTER: undefined,
    STRIPE_SAAS_PRICE_ID: "price_saas_configured",
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    NEXT_PUBLIC_APP_URL: undefined,
    VERCEL_URL: undefined,
    VERCEL_BRANCH_URL: undefined,
  },
  () => {
    const ready = resolveSaasBillingReadiness({ appUrl: null });
    check(
      "missing application URL is not checkout-ready",
      ready.reason === "missing_app_url" &&
        ready.checkoutReady === false &&
        ready.portalReady === false &&
        ready.ownerMessage === SAAS_BILLING_APP_URL_OWNER_MESSAGE,
    );
  },
);
await withSaasEnv(
  {
    VERCEL_ENV: "production",
    TBBT_SAAS_BILLING_ADAPTER: "fake",
    STRIPE_SAAS_PRICE_ID: "price_saas_configured",
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  },
  () => {
    const ready = resolveSaasBillingReadiness({
      founderPrice: { matchesFounderPrice: true, warning: null },
    });
    check(
      "properly configured production Stripe billing remains usable",
      ready.reason === "ready" &&
        ready.checkoutReady === true &&
        ready.portalReady === true &&
        ready.configured === true &&
        ready.ownerMessage === null &&
        isFakeSaasBillingAdapterEnabled() === false &&
        isSaasBillingConfigured() === true &&
        isInjectedFakeProvider(getSaasBillingProvider()) === false,
    );
    const bannerStyleConfigured = resolveSaasBillingReadiness();
    check(
      "global banner-style readiness without Founder Price inspection is not checkout-ready",
      bannerStyleConfigured.checkoutReady === false &&
        bannerStyleConfigured.portalReady === true &&
        bannerStyleConfigured.configured === true,
    );
  },
);
await withSaasEnv(
  {
    VERCEL_ENV: "preview",
    TBBT_SAAS_BILLING_ADAPTER: "fake",
    STRIPE_SAAS_PRICE_ID: undefined,
    STRIPE_SECRET_KEY: undefined,
    NEXT_PUBLIC_APP_URL: "http://saas-billing.test",
  },
  () => {
    const ready = resolveSaasBillingReadiness();
    check(
      "preview/local fake billing still works for tests",
      ready.reason === "ready" &&
        ready.checkoutReady === true &&
        isFakeSaasBillingAdapterEnabled() === true &&
        isSaasBillingConfigured() === true,
    );
  },
);

console.log("\nUNIT — production webhook secrets verify before any business write");
function signWebhookPayload(payload, secret) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_saas_billing_check");
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}
await withSaasEnv(
  {
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    STRIPE_WEBHOOK_SECRET: "whsec_shared_destination",
    STRIPE_SAAS_WEBHOOK_SECRET: undefined,
  },
  () => {
    const payload = JSON.stringify({ id: "evt_shared_secret", type: "ping" });
    check(
      "one shared destination secret is enough to verify",
      stripeWebhookSecretsConfigured() === true &&
        saasBillingWebhookSecrets().length === 1 &&
        verifyStripeWebhookPayload(payload, signWebhookPayload(payload, "whsec_shared_destination")).id ===
          "evt_shared_secret",
    );
  },
);
await withSaasEnv(
  {
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    STRIPE_WEBHOOK_SECRET: "whsec_connect_destination",
    STRIPE_SAAS_WEBHOOK_SECRET: "whsec_saas_destination",
  },
  () => {
    const payload = JSON.stringify({ id: "evt_dual_secret", type: "ping" });
    check(
      "dedicated SaaS secret verifies when destinations differ",
      stripeWebhookSecretsConfigured() === true &&
        saasBillingWebhookSecrets().length === 2 &&
        verifyStripeWebhookPayload(payload, signWebhookPayload(payload, "whsec_saas_destination")).id ===
          "evt_dual_secret",
    );
    check(
      "Connect destination secret still verifies when a SaaS secret is also set",
      verifyStripeWebhookPayload(payload, signWebhookPayload(payload, "whsec_connect_destination")).id ===
        "evt_dual_secret",
    );
    try {
      verifyStripeWebhookPayload(payload, signWebhookPayload(payload, "whsec_neither_destination"));
      check("signature that matches neither secret is rejected", false);
    } catch {
      check("signature that matches neither secret is rejected", true);
    }
  },
);
await withSaasEnv(
  {
    STRIPE_SECRET_KEY: "sk_test_saas_billing_check",
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_SAAS_WEBHOOK_SECRET: "whsec_saas_only",
  },
  () => {
    const payload = JSON.stringify({ id: "evt_saas_only", type: "ping" });
    check(
      "SaaS-only webhook secret still configures the shared endpoint",
      stripeWebhookSecretsConfigured() === true &&
        verifyStripeWebhookPayload(payload, signWebhookPayload(payload, "whsec_saas_only")).id ===
          "evt_saas_only",
    );
  },
);
await withSaasEnv(
  {
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_SAAS_WEBHOOK_SECRET: undefined,
  },
  () => {
    check(
      "missing both webhook secrets leaves the endpoint unconfigured",
      stripeWebhookSecretsConfigured() === false,
    );
  },
);

restoreSaasEnv();
check(
  "SaaS test harness restores the fake adapter after the production guard",
  isFakeSaasBillingAdapterEnabled() === true && isSaasBillingConfigured() === true,
);

try {
  resetSaasBillingSchemaEnsure();
  const provider = createFakeSaasBillingProvider();
  setSaasBillingProvider(provider);

  const businessA = await seedBusiness("Alpha SaaS");
  const businessB = await seedBusiness("Beta SaaS");
  const accessA = makeAccess(
    businessA.business.id,
    "OWNER",
    businessA.membership.id,
    businessA.ownerUser.email,
  );
  const accessB = makeAccess(
    businessB.business.id,
    "OWNER",
    businessB.membership.id,
    businessB.ownerUser.email,
  );

  const memberUser = await prisma.user.create({
    data: {
      name: "Member",
      email: `member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const member = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.business.id, role: "MEMBER" },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Admin",
      email: `admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const admin = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.business.id, role: "ADMIN" },
  });

  await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessA.business.id,
      provider: "stripe",
      stripeAccountId: "acct_connect_alpha",
    },
  });

  console.log("\nTEST — OWNER Checkout is tenant-scoped and creates/reuses a Stripe Customer");
  const first = await startSaasSubscriptionCheckout(prisma, accessA);
  check("Checkout URL is returned", first.url.startsWith("https://checkout.stripe.test/subscribe/"));
  check("Fake Checkout uses mode subscription", provider.checkouts[0]?.mode === "subscription");
  check("Checkout customer is created for Business A", Boolean(first.customerId));
  const rowAfterFirst = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: businessA.business.id },
  });
  check("SaaS row stores the Stripe Customer id", rowAfterFirst?.stripeCustomerId === first.customerId);
  check(
    "Checkout start does not mark the business subscribed",
    rowAfterFirst?.status === "none" && !rowAfterFirst?.stripeSubscriptionId,
  );
  const connectAfterCheckout = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: businessA.business.id },
  });
  check(
    "Connect account is unchanged by SaaS Checkout",
    connectAfterCheckout?.stripeAccountId === "acct_connect_alpha",
  );

  const second = await startSaasSubscriptionCheckout(prisma, accessA);
  check("Second Checkout reuses the same Stripe Customer", second.customerId === first.customerId);
  check("Only one Stripe Customer was created", provider.customers.size === 1);

  const other = await startSaasSubscriptionCheckout(prisma, accessB);
  check("Business B gets a different Stripe Customer", other.customerId !== first.customerId);
  check(
    "Business A SaaS row was not overwritten by Business B",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: businessA.business.id },
    }))?.stripeCustomerId === first.customerId,
  );

  console.log("\nTEST — MEMBER/ADMIN cannot start an OWNER SaaS subscription");
  try {
    await startSaasSubscriptionCheckout(
      prisma,
      makeAccess(businessA.business.id, "MEMBER", member.id, memberUser.email),
    );
    check("MEMBER cannot start SaaS Checkout", false);
  } catch (error) {
    check("MEMBER cannot start SaaS Checkout", error instanceof ForbiddenError);
  }
  try {
    await startSaasSubscriptionCheckout(
      prisma,
      makeAccess(businessA.business.id, "ADMIN", admin.id, adminUser.email),
    );
    check("ADMIN cannot start SaaS Checkout", false);
  } catch (error) {
    check("ADMIN cannot start SaaS Checkout", error instanceof ForbiddenError);
  }
  check(
    "MEMBER/ADMIN attempts did not create extra Stripe Customers",
    provider.customers.size === 2,
  );

  console.log("\nTEST — production cannot become subscribed_active through the fake provider");
  const prodGuard = await seedBusiness("Prod Guard SaaS");
  const prodAccess = makeAccess(
    prodGuard.business.id,
    "OWNER",
    prodGuard.membership.id,
    prodGuard.ownerUser.email,
  );
  const savedProdVercel = process.env.VERCEL_ENV;
  const savedProdSecret = process.env.STRIPE_SECRET_KEY;
  process.env.VERCEL_ENV = "production";
  process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
  delete process.env.STRIPE_SECRET_KEY;
  resetSaasBillingProvider();
  check(
    "production still rejects the fake adapter during Checkout",
    isFakeSaasBillingAdapterEnabled() === false,
  );
  check(
    "production Checkout still uses the Stripe provider",
    isInjectedFakeProvider(getSaasBillingProvider()) === false,
  );
  const fakeCheckoutsBeforeProd = provider.checkouts.length;
  try {
    await startSaasSubscriptionCheckout(prisma, prodAccess);
    check("production Checkout does not complete through the fake provider", false);
  } catch (error) {
    check(
      "production Checkout does not complete through the fake provider",
      error instanceof SaasBillingError,
    );
  }
  const prodRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: prodGuard.business.id },
  });
  const prodEntitlement = await loadSaasEntitlement(prisma, prodGuard.business);
  const prodSnapshot = await loadSaasBillingSnapshot(prisma, prodGuard.business.id);
  check(
    "production fake Checkout does not mark subscribed_active",
    prodEntitlement.state !== "subscribed_active" &&
      prodSnapshot.entitlement.state !== "subscribed_active" &&
      (prodRow == null || prodRow.status !== "active"),
  );
  check(
    "production fake Checkout does not record a fake provider session",
    provider.checkouts.length === fakeCheckoutsBeforeProd,
  );
  if (savedProdVercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = savedProdVercel;
  if (savedProdSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedProdSecret;
  process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
  resetSaasBillingProvider();
  setSaasBillingProvider(provider);

  console.log("\nTEST — production Checkout/Portal fail closed without live Stripe readiness");
  const failClosed = await seedBusiness("Fail Closed SaaS");
  const failClosedAccess = makeAccess(
    failClosed.business.id,
    "OWNER",
    failClosed.membership.id,
    failClosed.ownerUser.email,
  );
  const savedFailClosed = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    TBBT_SAAS_BILLING_ADAPTER: process.env.TBBT_SAAS_BILLING_ADAPTER,
    STRIPE_SAAS_PRICE_ID: process.env.STRIPE_SAAS_PRICE_ID,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  };
  function restoreFailClosedEnv() {
    for (const [key, value] of Object.entries(savedFailClosed)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSaasBillingProvider();
    setSaasBillingProvider(provider);
  }

  process.env.VERCEL_ENV = "production";
  process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
  delete process.env.STRIPE_SAAS_PRICE_ID;
  process.env.STRIPE_SECRET_KEY = "sk_test_saas_billing_check";
  resetSaasBillingProvider();
  const missingPriceCheckouts = provider.checkouts.length;
  try {
    await startSaasSubscriptionCheckout(prisma, failClosedAccess);
    check("production with no STRIPE_SAAS_PRICE_ID cannot start Checkout", false);
  } catch (error) {
    check(
      "production with no STRIPE_SAAS_PRICE_ID cannot start Checkout",
      error instanceof SaasBillingError &&
        error.message === SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    );
  }
  check(
    "production missing Price ID does not record a fake Checkout session",
    provider.checkouts.length === missingPriceCheckouts,
  );

  process.env.STRIPE_SAAS_PRICE_ID = "price_saas_configured";
  delete process.env.STRIPE_SECRET_KEY;
  resetSaasBillingProvider();
  const missingSecretCheckouts = provider.checkouts.length;
  try {
    await startSaasSubscriptionCheckout(prisma, failClosedAccess);
    check("production with no Stripe secret key cannot start Checkout", false);
  } catch (error) {
    check(
      "production with no Stripe secret key cannot start Checkout",
      error instanceof SaasBillingError &&
        error.message === SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    );
  }
  check(
    "production missing secret does not record a fake Checkout session",
    provider.checkouts.length === missingSecretCheckouts,
  );

  await prisma.businessSaasSubscription.upsert({
    where: { businessId: failClosed.business.id },
    create: {
      businessId: failClosed.business.id,
      stripeCustomerId: "cus_fail_closed",
      status: "none",
    },
    update: { stripeCustomerId: "cus_fail_closed", status: "none" },
  });
  try {
    await startSaasBillingPortal(prisma, failClosedAccess);
    check("production without a Stripe secret cannot open Billing Portal", false);
  } catch (error) {
    check(
      "production without a Stripe secret cannot open Billing Portal",
      error instanceof SaasBillingError &&
        error.message === SAAS_BILLING_NOT_READY_OWNER_MESSAGE,
    );
  }

  const failClosedRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: failClosed.business.id },
  });
  const failClosedEntitlement = await loadSaasEntitlement(prisma, failClosed.business);
  const failClosedSnapshot = await loadSaasBillingSnapshot(prisma, failClosed.business.id);
  check(
    "failed Checkout/readiness cannot transition entitlement to subscribed_active",
    failClosedEntitlement.state !== "subscribed_active" &&
      failClosedSnapshot.entitlement.state !== "subscribed_active" &&
      failClosedSnapshot.checkoutPossible === false &&
      failClosedRow?.status !== "active" &&
      failClosedRow?.stripeSubscriptionId == null,
  );
  check(
    "missing production billing configuration still loads billing and entitlement",
    failClosedSnapshot.billingReadinessReason === "missing_secret" &&
      failClosedSnapshot.billingNotReadyMessage === SAAS_BILLING_NOT_READY_OWNER_MESSAGE &&
      failClosedEntitlement.state !== "subscribed_active" &&
      failClosedEntitlement.canOperate === true,
  );

  const unconfiguredTenant = await seedBusiness("Existing Trial SaaS");
  process.env.VERCEL_ENV = "production";
  process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
  delete process.env.STRIPE_SAAS_PRICE_ID;
  delete process.env.STRIPE_SECRET_KEY;
  resetSaasBillingProvider();
  const unconfiguredSnapshot = await loadSaasBillingSnapshot(prisma, unconfiguredTenant.business.id);
  const unconfiguredEntitlement = await loadSaasEntitlement(prisma, unconfiguredTenant.business);
  check(
    "missing production billing configuration does not break unrelated app routes",
    unconfiguredSnapshot.checkoutPossible === false &&
      unconfiguredSnapshot.entitlement.state !== "subscribed_active" &&
      unconfiguredEntitlement.canOperate === true &&
      postAuthenticationPath({
        role: "OWNER",
        business: {
          slug: "brand-new-unconfigured",
          tradeCode: "HANDYMAN",
          firstRunSetupCompletedAt: null,
          starterServicesSetupCompletedAt: null,
          websiteSetupCompletedAt: null,
        },
      }) === "/setup",
  );

  process.env.STRIPE_SAAS_PRICE_ID = "price_saas_configured";
  process.env.STRIPE_SECRET_KEY = "sk_test_saas_billing_check";
  process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
  resetSaasBillingProvider();
  setSaasBillingProvider(provider);
  const readyProd = await seedBusiness("Ready Prod SaaS");
  const readyProdAccess = makeAccess(
    readyProd.business.id,
    "OWNER",
    readyProd.membership.id,
    readyProd.ownerUser.email,
  );
  const readySnapshot = await loadSaasBillingSnapshot(prisma, readyProd.business.id);
  const readyCheckout = await startSaasSubscriptionCheckout(prisma, readyProdAccess);
  check(
    "properly configured production Stripe billing can still start Checkout",
    readySnapshot.billingReadinessReason === "ready" &&
      readySnapshot.checkoutPossible === true &&
      readyCheckout.url.startsWith("https://checkout.stripe.test/subscribe/") &&
      isFakeSaasBillingAdapterEnabled() === false,
  );
  check(
    "configured production Checkout still does not mark subscribed_active from start",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: readyProd.business.id },
    }))?.status === "none",
  );

  restoreFailClosedEnv();
  check(
    "preview/local fake billing still starts Checkout after the production readiness tests",
    isFakeSaasBillingAdapterEnabled() === true,
  );

  console.log("\nTEST — Duplicate active subscriptions are prevented");
  provider.addSubscription({
    id: "sub_blocking",
    customerId: first.customerId,
    priceId: "price_saas_test",
    status: "active",
    currentPeriodEnd: new Date("2027-01-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
  });
  try {
    await startSaasSubscriptionCheckout(prisma, accessA);
    check("Stripe-side active subscription blocks another Checkout", false);
  } catch (error) {
    check(
      "Stripe-side active subscription blocks another Checkout",
      error instanceof SaasBillingError &&
        error.message.includes("already has a TBBT subscription"),
    );
  }
  provider.subscriptions.delete("sub_blocking");

  const beforeWebhook = await loadSaasBillingSnapshot(prisma, businessA.business.id);
  check(
    "Success redirect state is still not subscribed before webhook",
    beforeWebhook.status === "none",
  );

  console.log("\nTEST — Connect parser ignores SaaS subscription Checkout");
  check(
    "parseCheckoutPaymentEvent returns null for subscription mode",
    parseCheckoutPaymentEvent(saasCheckoutEvent({
      businessId: businessA.business.id,
      customerId: first.customerId,
      subscriptionId: "sub_ignored_by_connect",
    })) === null,
  );
  check(
    "parseSaasBillingEvent accepts platform subscription Checkout",
    parseSaasBillingEvent(saasCheckoutEvent({
      businessId: businessA.business.id,
      customerId: first.customerId,
      subscriptionId: "sub_from_checkout",
    }))?.snapshot.status === "active",
  );
  check(
    "parseSaasBillingEvent ignores Connect-account events",
    parseSaasBillingEvent({
      id: "evt_connect",
      type: "checkout.session.completed",
      account: "acct_connect_alpha",
      data: {
        object: {
          object: "checkout.session",
          mode: "subscription",
          payment_status: "paid",
          customer: first.customerId,
          subscription: "sub_connect",
          metadata: {
            purpose: SAAS_CHECKOUT_PURPOSE,
            businessId: businessA.business.id,
          },
        },
      },
    }) === null,
  );

  console.log("\nTEST — Valid webhook updates the correct tenant; invalid signatures are rejected");
  const invalidPayload = JSON.stringify(saasSubscriptionEvent({
    businessId: businessA.business.id,
    customerId: first.customerId,
    subscriptionId: "sub_should_not_apply",
  }));
  try {
    verifyStripeWebhookPayload(invalidPayload, "t=1,v1=deadbeef");
    check("Invalid webhook signature is rejected", false);
  } catch {
    check("Invalid webhook signature is rejected", true);
  }
  check(
    "Invalid signature does not persist a subscription",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: businessA.business.id },
    }))?.status === "none",
  );

  try {
    constructStripeWebhookEventWithSecrets(
      JSON.stringify({ id: "evt_bad" }),
      "t=1,v1=deadbeef",
      [process.env.STRIPE_WEBHOOK_SECRET],
    );
    check("constructStripeWebhookEventWithSecrets throws on a bad signature", false);
  } catch {
    check("constructStripeWebhookEventWithSecrets throws on a bad signature", true);
  }

  const checkoutWebhook = saasCheckoutEvent({
    id: "evt_checkout_alpha",
    businessId: businessA.business.id,
    customerId: first.customerId,
    subscriptionId: "sub_alpha",
  });
  const appliedCheckout = await verifyAndDispatch(checkoutWebhook);
  check("Valid Checkout webhook is accepted", appliedCheckout.applied === true && appliedCheckout.system === "saas");
  const afterCheckoutWebhook = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: businessA.business.id },
  });
  check(
    "Checkout webhook marks only Business A active",
    afterCheckoutWebhook?.status === "active" &&
      afterCheckoutWebhook?.stripeSubscriptionId === "sub_alpha",
  );
  check(
    "Business B remains unsubscribed after A's webhook",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: businessB.business.id },
    }))?.status === "none",
  );

  const periodEnd = 1_800_000_000;
  const updateEvent = saasSubscriptionEvent({
    id: "evt_sub_update_alpha",
    businessId: businessA.business.id,
    customerId: first.customerId,
    subscriptionId: "sub_alpha",
    status: "active",
    cancelAtPeriodEnd: true,
    periodEnd,
  });
  const appliedUpdate = await applySaasBillingStripeEvent(prisma, updateEvent);
  check("Subscription updated webhook is applied", appliedUpdate.applied === true);
  const afterUpdate = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: businessA.business.id },
  });
  check(
    "Cancel-at-period-end and current period end are persisted",
    afterUpdate?.cancelAtPeriodEnd === true &&
      afterUpdate?.currentPeriodEnd?.getTime() === periodEnd * 1000,
  );

  const replay = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(updateEvent),
  );
  check("Webhook processing is idempotent", replay.reason === "already_processed" && replay.applied === false);
  const afterReplay = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: businessA.business.id },
  });
  check(
    "Idempotent replay does not change subscription state",
    afterReplay?.cancelAtPeriodEnd === true && afterReplay?.status === "active",
  );

  const deleted = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_sub_deleted_alpha",
      type: "customer.subscription.deleted",
      businessId: businessA.business.id,
      customerId: first.customerId,
      subscriptionId: "sub_alpha",
      status: "canceled",
    }),
  );
  check("Subscription deleted webhook is applied", deleted.applied === true);
  check(
    "Cancellation is persisted",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: businessA.business.id },
    }))?.status === "canceled",
  );

  const unknown = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_unknown_biz",
      businessId: "biz_does_not_exist",
      customerId: "cus_unknown",
      subscriptionId: "sub_unknown",
    }),
  );
  check("Unknown-business webhook does not invent a tenant", unknown.reason === "unknown_business");
  check(
    "Unknown-business webhook created no SaaS row",
    (await prisma.businessSaasSubscription.count({
      where: { stripeSubscriptionId: "sub_unknown" },
    })) === 0,
  );

  await prisma.businessSaasSubscription.update({
    where: { businessId: businessA.business.id },
    data: { status: "canceled", cancelAtPeriodEnd: false },
  });
  const portal = await startSaasBillingPortal(prisma, accessA);
  console.log("\nTEST — Provider cancel-at-period-end stays webhook-authoritative");
  const cancelProvider = createFakeSaasBillingProvider();
  cancelProvider.addSubscription({
    id: "sub_cancel_boundary",
    customerId: first.customerId,
    priceId: "price_saas_test",
    status: "active",
    currentPeriodEnd: new Date("2026-10-24T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
  });
  await prisma.businessSaasSubscription.update({
    where: { businessId: businessA.business.id },
    data: {
      status: "active",
      stripeSubscriptionId: "sub_cancel_boundary",
      stripeCustomerId: first.customerId,
      cancelAtPeriodEnd: false,
    },
  });
  const scheduled = await cancelProvider.scheduleCancelAtPeriodEnd({
    subscriptionId: "sub_cancel_boundary",
  });
  const beforeWebhook = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: businessA.business.id },
  });
  check(
    "Fake provider schedules cancel in-memory without writing the local SaaS row",
    scheduled.cancelAtPeriodEnd === true &&
      cancelProvider.subscriptions.get("sub_cancel_boundary").cancelAtPeriodEnd === true &&
      beforeWebhook?.cancelAtPeriodEnd === false,
  );
  const cancelWebhook = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        id: "evt_sub_cancel_boundary",
        businessId: businessA.business.id,
        customerId: first.customerId,
        subscriptionId: "sub_cancel_boundary",
        status: "active",
        cancelAtPeriodEnd: true,
      }),
    ),
  );
  const afterCancelWebhook = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: businessA.business.id },
  });
  check(
    "Webhook snapshot is the only local cancelAtPeriodEnd write",
    cancelWebhook.applied === true && afterCancelWebhook?.cancelAtPeriodEnd === true,
  );
  cancelProvider.failCancel = true;
  let failCancelMessage = "";
  try {
    await cancelProvider.scheduleCancelAtPeriodEnd({ subscriptionId: "sub_cancel_boundary" });
  } catch (error) {
    failCancelMessage = error instanceof SaasBillingError ? error.message : String(error);
  }
  check(
    "Fake provider cancel failure stays a provider error",
    failCancelMessage === "Stripe could not schedule cancellation.",
  );

  check("OWNER can open Billing Portal after a Stripe Customer exists", portal.url.includes("billing.stripe.test"));
  try {
    await startSaasBillingPortal(
      prisma,
      makeAccess(businessA.business.id, "ADMIN", admin.id, adminUser.email),
    );
    check("ADMIN cannot open Billing Portal", false);
  } catch (error) {
    check("ADMIN cannot open Billing Portal", error instanceof ForbiddenError);
  }

  console.log("\nTEST — SaaS and Connect webhook dispatch stay isolated");
  const isolation = await seedBusiness("Webhook Isolation SaaS");
  const isolationCustomer = await prisma.customer.create({
    data: { businessId: isolation.business.id, name: "Isolation Customer" },
  });
  const isolationProperty = await prisma.property.create({
    data: {
      businessId: isolation.business.id,
      customerId: isolationCustomer.id,
      addressLine1: "1 Isolation St",
    },
  });
  const isolationJob = await prisma.job.create({
    data: {
      businessId: isolation.business.id,
      customerId: isolationCustomer.id,
      propertyId: isolationProperty.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const isolationInvoice = await prisma.invoice.create({
    data: {
      businessId: isolation.business.id,
      customerId: isolationCustomer.id,
      jobId: isolationJob.id,
      status: "SENT",
      total: "50.00",
    },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: isolation.business.id,
      provider: "stripe",
      stripeAccountId: "acct_isolation",
    },
  });
  const saasIsolation = await dispatchStripeWebhookEvent(
    prisma,
    saasCheckoutEvent({
      id: "evt_isolation_saas",
      businessId: isolation.business.id,
      customerId: "cus_isolation",
      subscriptionId: "sub_isolation",
    }),
  );
  const invoiceAfterSaas = await prisma.invoice.findUnique({
    where: { id: isolationInvoice.id },
  });
  const paymentsAfterSaas = await prisma.payment.count({
    where: { invoiceId: isolationInvoice.id },
  });
  check(
    "SaaS webhook is routed to the SaaS handler",
    saasIsolation.system === "saas" && saasIsolation.applied === true,
  );
  check(
    "SaaS webhook does not mark a customer invoice paid",
    invoiceAfterSaas?.status === "SENT" && paymentsAfterSaas === 0,
  );
  const saasBeforeConnect = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: isolation.business.id },
  });
  const connectIsolation = await dispatchStripeWebhookEvent(prisma, {
    id: "evt_isolation_connect",
    type: "checkout.session.completed",
    account: "acct_isolation",
    data: {
      object: {
        object: "checkout.session",
        id: "cs_isolation_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 5000,
        currency: "usd",
        payment_intent: "pi_isolation_1",
        metadata: {
          purpose: "invoice_balance",
          businessId: isolation.business.id,
          invoiceId: isolationInvoice.id,
          connectedAccountId: "acct_isolation",
        },
      },
    },
  });
  const saasAfterConnect = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: isolation.business.id },
  });
  const invoiceAfterConnect = await prisma.invoice.findUnique({
    where: { id: isolationInvoice.id },
  });
  check(
    "Connect webhook is routed to the payment handler",
    connectIsolation.system === "connect" && connectIsolation.applied === true,
  );
  check(
    "Connect webhook marks only the customer invoice paid",
    invoiceAfterConnect?.status === "PAID",
  );
  check(
    "Connect webhook does not change TBBT SaaS subscription state",
    saasAfterConnect?.status === saasBeforeConnect?.status &&
      saasAfterConnect?.stripeSubscriptionId === saasBeforeConnect?.stripeSubscriptionId,
  );
  const replaySaas = await dispatchStripeWebhookEvent(
    prisma,
    saasCheckoutEvent({
      id: "evt_isolation_saas",
      businessId: isolation.business.id,
      customerId: "cus_isolation",
      subscriptionId: "sub_isolation",
    }),
  );
  const replayConnect = await dispatchStripeWebhookEvent(prisma, {
    id: "evt_isolation_connect",
    type: "checkout.session.completed",
    account: "acct_isolation",
    data: {
      object: {
        object: "checkout.session",
        id: "cs_isolation_1",
        mode: "payment",
        payment_status: "paid",
        amount_total: 5000,
        currency: "usd",
        payment_intent: "pi_isolation_1",
        metadata: {
          purpose: "invoice_balance",
          businessId: isolation.business.id,
          invoiceId: isolationInvoice.id,
          connectedAccountId: "acct_isolation",
        },
      },
    },
  });
  check(
    "Replayed SaaS event is idempotent",
    replaySaas.applied === false && replaySaas.reason === "already_processed",
  );
  check(
    "Replayed Connect event is idempotent",
    replayConnect.applied === false && replayConnect.reason === "already_paid",
  );

  console.log("\nTEST — Existing tenants remain usable and are not silently subscribed");
  const now = new Date();
  const existing = await seedBusiness("Existing Handyman", {
    firstRunSetupCompletedAt: now,
    starterServicesSetupCompletedAt: now,
    websiteSetupCompletedAt: now,
  });
  const collpro = await seedBusiness("CollPro Reno Handyman Services", {
    slug: "collpro-reno",
    firstRunSetupCompletedAt: now,
    starterServicesSetupCompletedAt: now,
    websiteSetupCompletedAt: now,
  });
  const beforeEnsureCustomers = provider.customers.size;
  const existingSnapshot = await loadSaasBillingSnapshot(prisma, existing.business.id);
  const collproSnapshot = await loadSaasBillingSnapshot(prisma, collpro.business.id);
  check(
    "Existing business without a SaaS row is not subscribed",
    existingSnapshot.status === "none" && existingSnapshot.stripeCustomerId === null,
  );
  check(
    "CollPro without a SaaS row is not subscribed",
    collproSnapshot.status === "none" && collproSnapshot.stripeCustomerId === null,
  );
  check(
    "Loading billing state does not silently create Stripe Customers",
    provider.customers.size === beforeEnsureCustomers,
  );
  check(
    "Existing completed onboarding still lands on the dashboard",
    postAuthenticationPath({ role: "OWNER", business: existing.business }) === "/dashboard",
  );
  check(
    "CollPro still lands on the dashboard",
    postAuthenticationPath({ role: "OWNER", business: collpro.business }) === "/dashboard",
  );
  check(
    "Tasks 1–3 routing is unchanged for a brand-new OWNER",
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "brand-new",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: null,
        starterServicesSetupCompletedAt: null,
        websiteSetupCompletedAt: null,
      },
    }) === "/setup" &&
      postAuthenticationPath({
        role: "OWNER",
        business: {
          slug: "brand-new",
          tradeCode: "HANDYMAN",
          firstRunSetupCompletedAt: now,
          starterServicesSetupCompletedAt: null,
          websiteSetupCompletedAt: null,
        },
      }) === "/setup/services" &&
      postAuthenticationPath({
        role: "OWNER",
        business: {
          slug: "brand-new",
          tradeCode: "HANDYMAN",
          firstRunSetupCompletedAt: now,
          starterServicesSetupCompletedAt: now,
          websiteSetupCompletedAt: null,
        },
      }) === "/setup/website",
  );
  const existingStillThere = await prisma.business.findUnique({
    where: { id: existing.business.id },
  });
  check("Existing business remains queryable after billing tables exist", Boolean(existingStillThere));
  check(
    "Existing tenants were not silently given Stripe Customer or Subscription ids",
    (await prisma.businessSaasSubscription.count({
      where: {
        businessId: { in: [existing.business.id, collpro.business.id] },
        OR: [{ stripeCustomerId: { not: null } }, { stripeSubscriptionId: { not: null } }],
      },
    })) === 0,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  resetSaasBillingProvider();
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nAll SaaS billing checks passed."
    : `\n${failures} SaaS billing check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
