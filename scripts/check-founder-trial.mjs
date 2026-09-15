/**
 * TBBT Founder Plan + 30-day trial (Task 5).
 *
 * Proves explicit local trial state, founder eligibility, centralized
 * entitlement, existing-tenant/CollPro compatibility, Checkout still
 * using STRIPE_SAAS_PRICE_ID, and separation from Stripe Connect.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-founder-trial.mjs
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

const testDbName = "tbbt_founder_trial_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://founder-trial.test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_founder_trial_check";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_founder_trial_check";
process.env.STRIPE_SAAS_PRICE_ID = "price_saas_test";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for Founder trial test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { ForbiddenError } = await import("@/lib/authorization");
const { parseCheckoutPaymentEvent } = await import("@/lib/payments/events");
const { postAuthenticationPath } = await import("@/lib/first-run-setup");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const {
  applyParsedSaasBillingEvent,
  applySaasBillingStripeEvent,
  assertSaasOperatingEntitlement,
  ensureSaasBillingSchema,
  founderFieldsForSubscriptionStatus,
  founderTrialWindow,
  getSaasPriceId,
  inspectConfiguredFounderPrice,
  loadSaasBillingSnapshot,
  loadSaasEntitlement,
  parseSaasBillingEvent,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  resolveSaasEntitlement,
  SAAS_CHECKOUT_PURPOSE,
  SAAS_ENTITLEMENT_STATES,
  SaasSubscriptionRequiredError,
  setSaasBillingProvider,
  startFounderTrialIfEligible,
  startSaasSubscriptionCheckout,
  TBBT_FOUNDER_PLAN_AMOUNT_CENTS,
  TBBT_FOUNDER_PLAN_PRICE_LABEL,
  TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT,
  TBBT_FOUNDER_TRIAL_MS,
  TBBT_SAAS_PLAN_CODE,
  TBBT_SAAS_PLAN_NAME,
} = await import("@/lib/saas-billing");
const {
  completeWebsiteSetupOp,
  skipWebsiteSetupOp,
} = await import("@/lib/website-setup");

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, extra = {}) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: extra.userId ?? "user", email: extra.email ?? "owner@example.com", name: "Test User" },
      business: {
        id: businessId,
        slug: extra.slug ?? "unused",
        tradeCode: "HANDYMAN",
        name: extra.name ?? "Test Business",
      },
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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const websiteLib = readRepo("src/lib/website-setup.ts");
const websiteAction = readRepo("src/app/actions/website-setup.ts");
const firstRunSrc = readRepo("src/lib/first-run-setup.ts");
const starterSrc = readRepo("src/lib/starter-services-setup.ts");
const appLayout = readRepo("src/app/(app)/layout.tsx");
const fieldLayout = readRepo("src/app/field/layout.tsx");
const opsSrc = readRepo("src/lib/saas-billing/ops.ts");
const stripeSrc = readRepo("src/lib/saas-billing/stripe.ts");
const founderPriceSrc = readRepo("src/lib/saas-billing/founder-price.ts");
const settingsWorkspace = readRepo("src/components/settings/settings-workspace.tsx");
const settingsLib = readRepo("src/lib/settings.ts");
const paymentsServiceSrc = readRepo("src/lib/payments/service.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const envExample = readRepo(".env.example");
const bannerSrc = readRepo("src/components/settings/saas-entitlement-banner.tsx");

console.log("\nSTATIC — Founder trial stays local, Checkout stays on STRIPE_SAAS_PRICE_ID");
check(
  "Central entitlement states cover trial, subscribed, payment problem, required, and legacy",
  SAAS_ENTITLEMENT_STATES.join(",") ===
    "trial_active,subscribed_active,payment_problem,subscription_required,legacy_exempt",
);
check(
  "Tasks 1–3 libs still do not import SaaS billing",
  !firstRunSrc.includes("saas") &&
    !starterSrc.includes("saas") &&
    !websiteLib.includes("saas") &&
    !websiteLib.includes("STRIPE_SAAS"),
);
check(
  "Website setup actions start the Founder trial after first completion or skip",
  websiteAction.includes("startFounderTrialIfEligible") &&
    websiteAction.includes("completeWebsiteSetupOp") &&
    websiteAction.includes("skipWebsiteSetupOp") &&
    websiteAction.includes("alreadyComplete"),
);
check(
  "Management console reads centralized entitlement instead of per-page subscription checks",
  appLayout.includes("loadSaasEntitlement") &&
    appLayout.includes("SaasEntitlementBanner") &&
    fieldLayout.includes("loadSaasEntitlement") &&
    fieldLayout.includes("SaasEntitlementBanner") &&
    fieldLayout.includes("saasOperatingUiState"),
);
check(
  "Checkout still uses getSaasPriceId / STRIPE_SAAS_PRICE_ID and does not invent a Price ID",
  opsSrc.includes("getSaasPriceId()") &&
    stripeSrc.includes("price: input.priceId") &&
    !founderPriceSrc.includes("price_1") &&
    !opsSrc.includes("price_1") &&
    getSaasPriceId() === "price_saas_test",
);
check(
  "Founder Plan display is $49/month with a 30-day local trial window",
  TBBT_SAAS_PLAN_CODE === "tbbt_founder" &&
    TBBT_SAAS_PLAN_NAME === "Founder Plan" &&
    TBBT_FOUNDER_PLAN_AMOUNT_CENTS === 4900 &&
    TBBT_FOUNDER_PLAN_PRICE_LABEL === "$49/month" &&
    TBBT_FOUNDER_TRIAL_MS === 30 * 24 * 60 * 60 * 1000,
);
check(
  "OWNER billing UX shows Founder Plan, trial status, and Start subscription",
  settingsWorkspace.includes("TBBT_FOUNDER_PLAN_DESCRIPTION") &&
    settingsWorkspace.includes("Trial status") &&
    settingsWorkspace.includes("Days remaining") &&
    settingsWorkspace.includes("Founder eligibility") &&
    settingsLib.includes("$49/month") &&
    readRepo("src/components/settings/saas-billing-buttons.tsx").includes("Start subscription") &&
    bannerSrc.includes("SaasSubscribeButton") &&
    bannerSrc.includes("Open TBBT Billing"),
);
check(
  "Schema persists explicit trial dates and founder eligibility, not Business.createdAt",
  schemaSrc.includes("trialStartedAt") &&
    schemaSrc.includes("trialEndsAt") &&
    schemaSrc.includes("founderEligible") &&
    schemaSrc.includes("founderConvertedAt") &&
    schemaSrc.includes("founderEligibilityEndedAt") &&
    schemaSrc.includes("legacyExempt") &&
    schemaSrc.includes("Never inferred from Business.createdAt"),
);
check(
  "SaaS remains separate from Connect and data-export stays reachable",
  !paymentsServiceSrc.includes("BusinessSaasSubscription") &&
    settingsLib.includes('"tbbt-billing"') &&
    settingsLib.includes('"data-export"') &&
    envExample.includes("create a recurring $49 USD/month") &&
    envExample.includes("STRIPE_SAAS_PRICE_ID"),
);

console.log("\nUNIT — Entitlement resolver and founder eligibility transitions");
const windowStart = new Date("2026-09-15T12:00:00.000Z");
const window = founderTrialWindow(windowStart);
check(
  "Founder trial window is exactly 30 days",
  window.trialEndsAt.getTime() - window.trialStartedAt.getTime() === TBBT_FOUNDER_TRIAL_MS,
);
const trialRow = {
  status: "none",
  trialStartedAt: window.trialStartedAt,
  trialEndsAt: window.trialEndsAt,
  founderEligible: true,
  founderConvertedAt: null,
  founderEligibilityEndedAt: null,
  legacyExempt: false,
};
check(
  "Active trial receives operating entitlement",
  resolveSaasEntitlement({ slug: "new-co", row: trialRow, now: windowStart }).state === "trial_active" &&
    resolveSaasEntitlement({ slug: "new-co", row: trialRow, now: windowStart }).canOperate === true,
);
check(
  "Expired unpaid trial receives subscription-required entitlement",
  resolveSaasEntitlement({
    slug: "new-co",
    row: trialRow,
    now: new Date(window.trialEndsAt.getTime() + 1000),
  }).state === "subscription_required" &&
    resolveSaasEntitlement({
      slug: "new-co",
      row: trialRow,
      now: new Date(window.trialEndsAt.getTime() + 1000),
    }).canOperate === false,
);
check(
  "Active SaaS subscription receives operating entitlement",
  resolveSaasEntitlement({
    slug: "new-co",
    row: { ...trialRow, status: "active", founderConvertedAt: windowStart },
    now: new Date(window.trialEndsAt.getTime() + 1000),
  }).state === "subscribed_active",
);
check(
  "Payment-problem subscriptions stay operable",
  resolveSaasEntitlement({
    slug: "new-co",
    row: { ...trialRow, status: "past_due" },
    now: new Date(window.trialEndsAt.getTime() + 1000),
  }).state === "payment_problem" &&
    resolveSaasEntitlement({
      slug: "new-co",
      row: { ...trialRow, status: "past_due" },
      now: new Date(window.trialEndsAt.getTime() + 1000),
    }).canOperate === true,
);
check(
  "CollPro is legacy-exempt even with an expired trial row",
  resolveSaasEntitlement({
    slug: "collpro-reno",
    row: trialRow,
    now: new Date(window.trialEndsAt.getTime() + 1000),
  }).state === "legacy_exempt",
);
check(
  "Missing billing row is treated as legacy-exempt, not an expired trial",
  resolveSaasEntitlement({ slug: "older-co", row: null }).state === "legacy_exempt" &&
    resolveSaasEntitlement({ slug: "older-co", row: null }).canOperate === true,
);
try {
  assertSaasOperatingEntitlement(
    resolveSaasEntitlement({
      slug: "new-co",
      row: trialRow,
      now: new Date(window.trialEndsAt.getTime() + 1000),
    }),
  );
  check("Expired trial throws SaasSubscriptionRequiredError when operating is asserted", false);
} catch (error) {
  check(
    "Expired trial throws SaasSubscriptionRequiredError when operating is asserted",
    error instanceof SaasSubscriptionRequiredError,
  );
}
const convert = founderFieldsForSubscriptionStatus({
  current: {
    founderEligible: true,
    founderConvertedAt: null,
    founderEligibilityEndedAt: null,
  },
  nextStatus: "active",
  now: windowStart,
});
const ended = founderFieldsForSubscriptionStatus({
  current: {
    founderEligible: true,
    founderConvertedAt: windowStart,
    founderEligibilityEndedAt: null,
  },
  nextStatus: "canceled",
  now: windowStart,
});
const restart = founderFieldsForSubscriptionStatus({
  current: {
    founderEligible: false,
    founderConvertedAt: windowStart,
    founderEligibilityEndedAt: windowStart,
  },
  nextStatus: "active",
  now: windowStart,
});
check("Converting a Founder trial records founderConvertedAt", Boolean(convert?.founderConvertedAt));
check(
  "Canceling ends founder eligibility without promising the rate on rejoin",
  ended?.founderEligible === false && Boolean(ended?.founderEligibilityEndedAt),
);
check("A later restart does not restore founder eligibility", restart === null);
const scheduledCancelFields = founderFieldsForSubscriptionStatus({
  current: {
    founderEligible: true,
    founderConvertedAt: windowStart,
    founderEligibilityEndedAt: null,
  },
  nextStatus: "active",
  cancelAtPeriodEnd: true,
  now: windowStart,
});
check(
  "Scheduling cancellation at period end does not end Founder eligibility",
  scheduledCancelFields === null,
);

try {
  resetSaasBillingSchemaEnsure();
  const provider = createFakeSaasBillingProvider();
  setSaasBillingProvider(provider);
  const now = new Date("2026-09-15T12:00:00.000Z");

  console.log("\nTEST — New business receives an explicit 30-day Founder trial without Stripe");
  const newbie = await seedBusiness("New Trial Co", {
    firstRunSetupCompletedAt: now,
    starterServicesSetupCompletedAt: now,
  });
  const newbieAccess = makeAccess(newbie.business.id, "OWNER", newbie.membership.id, {
    slug: newbie.business.slug,
    email: newbie.ownerUser.email,
    name: newbie.business.name,
  });
  const saved = await completeWebsiteSetupOp(prisma, newbieAccess, {
    name: "New Trial Co",
    phone: "555-222-3333",
    email: "shop@newtrial.example",
    about: "We help homeowners with everyday repairs.",
    serviceArea: "Reno, NV",
  });
  const started = await startFounderTrialIfEligible(prisma, {
    businessId: newbie.business.id,
    slug: newbie.business.slug,
    changedByMembershipId: newbie.membership.id,
    now,
  });
  const trialRowDb = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: newbie.business.id },
  });
  check("First website save is not already complete", saved.alreadyComplete === false);
  check("Trial start reports started", started.started === true);
  check(
    "Trial dates are explicitly persisted for exactly 30 days",
    Boolean(trialRowDb?.trialStartedAt) &&
      Boolean(trialRowDb?.trialEndsAt) &&
      trialRowDb.trialEndsAt.getTime() - trialRowDb.trialStartedAt.getTime() === TBBT_FOUNDER_TRIAL_MS,
  );
  check("Founder eligibility is explicitly persisted", trialRowDb?.founderEligible === true);
  check(
    "Trial does not require a Stripe Customer or payment method",
    trialRowDb?.stripeCustomerId == null &&
      trialRowDb?.stripeSubscriptionId == null &&
      trialRowDb?.status === "none" &&
      provider.customers.size === 0,
  );
  const trialEntitlement = await loadSaasEntitlement(prisma, newbie.business, now);
  check(
    "Active trial receives operating entitlement from persisted dates",
    trialEntitlement.state === "trial_active" &&
      trialEntitlement.canOperate === true &&
      trialEntitlement.trialDaysRemaining === 30,
  );
  const replay = await startFounderTrialIfEligible(prisma, {
    businessId: newbie.business.id,
    slug: newbie.business.slug,
    now,
  });
  check("Trial start is idempotent", replay.started === false && replay.reason === "trial_already_started");

  const skipper = await seedBusiness("Skip Trial Co", {
    firstRunSetupCompletedAt: now,
    starterServicesSetupCompletedAt: now,
  });
  const skipAccess = makeAccess(skipper.business.id, "OWNER", skipper.membership.id, {
    slug: skipper.business.slug,
    email: skipper.ownerUser.email,
  });
  const skipped = await skipWebsiteSetupOp(prisma, skipAccess);
  const skipStarted = await startFounderTrialIfEligible(prisma, {
    businessId: skipper.business.id,
    slug: skipper.business.slug,
    now,
  });
  check(
    "Skipping website setup also starts a 30-day Founder trial",
    skipped.alreadyComplete === false &&
      skipStarted.started === true &&
      skipStarted.trialEndsAt.getTime() - skipStarted.trialStartedAt.getTime() === TBBT_FOUNDER_TRIAL_MS,
  );

  console.log("\nTEST — Existing businesses and CollPro stay usable");
  resetSaasBillingSchemaEnsure();
  const existingNow = new Date("2026-01-01T00:00:00.000Z");
  const existing = await seedBusiness("Existing Handyman", {
    firstRunSetupCompletedAt: existingNow,
    starterServicesSetupCompletedAt: existingNow,
    websiteSetupCompletedAt: existingNow,
  });
  const collpro = await seedBusiness("CollPro Reno Handyman Services", {
    slug: "collpro-reno",
    firstRunSetupCompletedAt: existingNow,
    starterServicesSetupCompletedAt: existingNow,
    websiteSetupCompletedAt: existingNow,
  });
  const existingCustomer = await prisma.customer.create({
    data: { businessId: existing.business.id, name: "Existing Customer" },
  });
  const collproCustomer = await prisma.customer.create({
    data: { businessId: collpro.business.id, name: "CollPro Customer" },
  });
  await ensureSaasBillingSchema(prisma);
  const existingRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: existing.business.id },
  });
  const collproRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: collpro.business.id },
  });
  const existingEntitlement = await loadSaasEntitlement(prisma, existing.business, now);
  const collproEntitlement = await loadSaasEntitlement(prisma, collpro.business, now);
  check(
    "Existing businesses are marked legacy-exempt without trial dates or Stripe ids",
    existingRow?.legacyExempt === true &&
      existingRow?.trialStartedAt == null &&
      existingRow?.founderEligible === false &&
      existingRow?.stripeCustomerId == null &&
      existingEntitlement.state === "legacy_exempt" &&
      existingEntitlement.canOperate === true,
  );
  check(
    "CollPro remains usable and is not given an expired trial",
    collproRow?.legacyExempt === true &&
      collproRow?.trialStartedAt == null &&
      collproEntitlement.state === "legacy_exempt" &&
      collproEntitlement.canOperate === true &&
      postAuthenticationPath({ role: "OWNER", business: collpro.business }) === "/dashboard",
  );
  const existingTrial = await startFounderTrialIfEligible(prisma, {
    businessId: existing.business.id,
    slug: existing.business.slug,
    now,
  });
  const collproTrial = await startFounderTrialIfEligible(prisma, {
    businessId: collpro.business.id,
    slug: collpro.business.slug,
    now,
  });
  check("Existing completed tenants do not start a Founder trial", existingTrial.reason === "legacy_exempt");
  check("CollPro does not start a Founder trial", collproTrial.reason === "collpro_exempt");
  check(
    "Existing and CollPro customers remain queryable",
    (await prisma.customer.findUnique({ where: { id: existingCustomer.id } }))?.name === "Existing Customer" &&
      (await prisma.customer.findUnique({ where: { id: collproCustomer.id } }))?.name === "CollPro Customer",
  );

  console.log("\nTEST — Expired unpaid trial retains data and can still reach Billing/Checkout");
  const pastStart = new Date(Date.now() - TBBT_FOUNDER_TRIAL_MS - 60_000);
  const pastEnd = new Date(Date.now() - 60_000);
  await prisma.businessSaasSubscription.update({
    where: { businessId: newbie.business.id },
    data: {
      trialStartedAt: pastStart,
      trialEndsAt: pastEnd,
      status: "none",
    },
  });
  const keptCustomer = await prisma.customer.create({
    data: { businessId: newbie.business.id, name: "Retained Customer" },
  });
  const expiredEntitlement = await loadSaasEntitlement(prisma, newbie.business);
  check(
    "Expired unpaid trial is subscription-required and not operable",
    expiredEntitlement.state === "subscription_required" && expiredEntitlement.canOperate === false,
  );
  check(
    "Expired business retains its data",
    (await prisma.customer.findUnique({ where: { id: keptCustomer.id } }))?.name === "Retained Customer" &&
      (await prisma.business.findUnique({ where: { id: newbie.business.id } }))?.name === "New Trial Co",
  );
  const billing = await loadSaasBillingSnapshot(prisma, newbie.business.id);
  check(
    "Expired OWNER can still load TBBT Billing with Founder Plan and a Subscribe action",
    billing.planName === "Founder Plan" &&
      billing.showFounderPrice === true &&
      billing.founderPriceLabel === "$49/month" &&
      billing.entitlement.state === "subscription_required" &&
      billing.checkoutPossible === true &&
      billing.stripeCustomerId == null,
  );
  const memberUser = await prisma.user.create({
    data: {
      name: "Member",
      email: `member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const member = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: newbie.business.id, role: "MEMBER" },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Admin",
      email: `admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const admin = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: newbie.business.id, role: "ADMIN" },
  });
  try {
    await startSaasSubscriptionCheckout(
      prisma,
      makeAccess(newbie.business.id, "MEMBER", member.id, { email: memberUser.email, slug: newbie.business.slug }),
    );
    check("MEMBER cannot start SaaS Checkout", false);
  } catch (error) {
    check("MEMBER cannot start SaaS Checkout", error instanceof ForbiddenError);
  }
  try {
    await startSaasSubscriptionCheckout(
      prisma,
      makeAccess(newbie.business.id, "ADMIN", admin.id, { email: adminUser.email, slug: newbie.business.slug }),
    );
    check("ADMIN cannot start SaaS Checkout", false);
  } catch (error) {
    check("ADMIN cannot start SaaS Checkout", error instanceof ForbiddenError);
  }
  const checkout = await startSaasSubscriptionCheckout(prisma, newbieAccess);
  check(
    "Expired OWNER can start subscription Checkout using the configured Stripe Price ID",
    checkout.url.startsWith("https://checkout.stripe.test/subscribe/") &&
      provider.checkouts.at(-1)?.priceId === "price_saas_test" &&
      provider.checkouts.at(-1)?.mode === "subscription",
  );
  check(
    "Checkout still does not mark the business subscribed from the browser start",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: newbie.business.id },
    }))?.status === "none",
  );

  console.log("\nTEST — Founder conversion, cancel, and Connect isolation");
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: newbie.business.id,
      provider: "stripe",
      stripeAccountId: "acct_connect_newbie",
    },
  });
  check(
    "Connect parser ignores SaaS subscription Checkout",
    parseCheckoutPaymentEvent(
      saasCheckoutEvent({
        businessId: newbie.business.id,
        customerId: checkout.customerId,
        subscriptionId: "sub_founder",
      }),
    ) === null,
  );
  const applied = await applySaasBillingStripeEvent(
    prisma,
    saasCheckoutEvent({
      id: "evt_founder_checkout",
      businessId: newbie.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_founder",
    }),
  );
  const subscribed = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: newbie.business.id },
  });
  const subscribedEntitlement = await loadSaasEntitlement(prisma, newbie.business);
  check("Founder Checkout webhook is applied", applied.applied === true);
  check(
    "Active SaaS subscription receives operating entitlement and keeps founder eligibility",
    subscribed?.status === "active" &&
      Boolean(subscribed?.founderConvertedAt) &&
      subscribed?.founderEligible === true &&
      subscribedEntitlement.state === "subscribed_active" &&
      subscribedEntitlement.canOperate === true,
  );
  await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        id: "evt_founder_canceled",
        type: "customer.subscription.deleted",
        businessId: newbie.business.id,
        customerId: checkout.customerId,
        subscriptionId: "sub_founder",
        status: "canceled",
      }),
    ),
  );
  const canceled = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: newbie.business.id },
  });
  check(
    "Canceling ends founder eligibility so a later restart can use future pricing",
    canceled?.status === "canceled" &&
      canceled?.founderEligible === false &&
      Boolean(canceled?.founderEligibilityEndedAt),
  );
  check(
    "Connect account is unchanged by SaaS trial and subscription",
    (await prisma.businessPaymentAccount.findUnique({
      where: { businessId: newbie.business.id },
    }))?.stripeAccountId === "acct_connect_newbie",
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
    }) === "/setup",
  );

  const priceInspection = await inspectConfiguredFounderPrice();
  check(
    "Fake adapter does not invent a live Stripe Price ID and still displays $49",
    priceInspection.showFounderPrice === true &&
      priceInspection.verified === false &&
      priceInspection.configuredPriceId === "price_saas_test",
  );
  check(
    "Operational Stripe Price requirement is documented for production Checkout",
    TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT.includes("recurring $49 USD/month"),
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
    ? "\nAll Founder trial checks passed."
    : `\n${failures} Founder trial check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
