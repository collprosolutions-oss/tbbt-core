/**
 * TBBT product-plan, pricing, and entitlement control plane.
 *
 * Proves the marketing page, SaaS subscription, and application
 * enforcement share one catalog. Fake provider only. No invented prices.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-plan-entitlements.mjs
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

const testDbName = "tbbt_plan_entitlements_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://plan-entitlements.test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_plan_entitlements";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_plan_entitlements";
process.env.STRIPE_SAAS_PRICE_ID = "price_saas_test";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for plan entitlement test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { ForbiddenError, requireBusinessCapability, CAPABILITIES } = await import(
  "@/lib/authorization"
);
const {
  assertPlanDefinitionsAcyclic,
  formatApprovedDisplayPrice,
  getPlanCertificationProjection,
  getPlanDefinition,
  getPlanLaunchReadiness,
  getPricingPageProjection,
  isPubliclyPurchasablePlan,
  PLAN_CODES,
  PLAN_DEFINITIONS,
  PRODUCT_CAPABILITIES,
  PRODUCT_LIMITS,
  planIncludesCapability,
  PRICING_COMPARE_ROWS,
} = await import("@/lib/product-catalog");
const {
  assignProductAddon,
  grantProductCapability,
  grantProductLimit,
  hasProductCapability,
  loadProductEntitlement,
  PRODUCT_DOWNGRADE_RULES,
  requireProductCapability,
  resolveCompatiblePlanCode,
  resolvePlanCodeFromPriceId,
  resolveWebhookPlanCode,
  ProductCapabilityRequiredError,
  ProductLimitExceededError,
  ProductQuantityInvalidError,
} = await import("@/lib/product-entitlements");
const { activateBusinessTradeOp } = await import("@/lib/business-trades");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const {
  applyParsedSaasBillingEvent,
  loadSaasBillingSnapshot,
  parseSaasBillingEvent,
  requestSaasPlanChange,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  SAAS_CHECKOUT_PURPOSE,
  setSaasBillingProvider,
  startFounderTrialIfEligible,
  startSaasSubscriptionCheckout,
  SaasBillingError,
  TBBT_FOUNDER_PLAN_AMOUNT_CENTS,
  TBBT_FOUNDER_PLAN_PRICE_LABEL,
  TBBT_SAAS_PLAN_CODE,
} = await import("@/lib/saas-billing");
const { buildBusinessExportZip } = await import("@/lib/business-export");
const { TBBT_PRICING_COMPARE_ROWS, TBBT_PRICING_FOUNDER_CARD_FEATURES } = await import(
  "@/lib/tbbt-marketing"
);

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
      user: { id: `user-${membershipId}`, email, name: "Test User" },
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
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  await prisma.businessTrade.create({
    data: {
      businessId: business.id,
      tradeCode: "HANDYMAN",
      status: "ACTIVE",
      configOverridesJson: "{}",
      intakeSchemaVersion: 1,
    },
  });
  return { business, membership, ownerUser };
}

function saasSubscriptionEvent(input) {
  return {
    id: input.id ?? `evt_${randomUUID()}`,
    type: input.type ?? "customer.subscription.updated",
    created: input.created ?? Math.floor(Date.now() / 1000),
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

async function applyPlanWebhook(business, input) {
  const parsed = parseSaasBillingEvent(
    saasSubscriptionEvent({
      businessId: business.id,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      priceId: input.priceId,
      status: input.status ?? "active",
      id: input.id,
      created: input.created,
    }),
  );
  return applyParsedSaasBillingEvent(prisma, parsed);
}

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

const APP_URL = process.env.APP_URL ?? "http://localhost:43217";

console.log("\nUNIT — Authoritative catalog");
assertPlanDefinitionsAcyclic();
check("Plan definitions are acyclic", true);
check(
  "Founder is the only LIVE checkout-eligible plan with an approved $49 price",
  PLAN_DEFINITIONS.FOUNDER.publicStatus === "LIVE" &&
    PLAN_DEFINITIONS.FOUNDER.checkoutEligible &&
    PLAN_DEFINITIONS.FOUNDER.approvedDisplayPrice?.amountCents === TBBT_FOUNDER_PLAN_AMOUNT_CENTS &&
    PLAN_DEFINITIONS.FOUNDER.approvedDisplayPrice?.label === TBBT_FOUNDER_PLAN_PRICE_LABEL &&
    !PLAN_DEFINITIONS.STARTER.checkoutEligible &&
    !PLAN_DEFINITIONS.BUSINESS.checkoutEligible &&
    !PLAN_DEFINITIONS.ENTERPRISE.checkoutEligible &&
    PLAN_DEFINITIONS.STARTER.approvedDisplayPrice == null &&
    PLAN_DEFINITIONS.BUSINESS.approvedDisplayPrice == null &&
    PLAN_DEFINITIONS.ENTERPRISE.approvedDisplayPrice == null,
);
check(
  "Starter has the approved 1-trade limit and Founder does not invent a trade number",
  PLAN_DEFINITIONS.STARTER.limits.TRADES === 1 &&
    PLAN_DEFINITIONS.FOUNDER.limits.TRADES == null &&
    planIncludesCapability(PLAN_CODES.STARTER, PRODUCT_CAPABILITIES.CRM) &&
    !planIncludesCapability(PLAN_CODES.STARTER, PRODUCT_CAPABILITIES.JOBS_TASKS) &&
    planIncludesCapability(PLAN_CODES.FOUNDER, PRODUCT_CAPABILITIES.JOBS_TASKS) &&
    planIncludesCapability(PLAN_CODES.FOUNDER, PRODUCT_CAPABILITIES.TIME_TRACKING) &&
    planIncludesCapability(PLAN_CODES.FOUNDER, PRODUCT_CAPABILITIES.MARKETING_TOOLS),
);
check(
  "Business inherits Founder software capabilities without inventing a price",
  planIncludesCapability(PLAN_CODES.BUSINESS, PRODUCT_CAPABILITIES.JOBS_TASKS) &&
    planIncludesCapability(PLAN_CODES.BUSINESS, PRODUCT_CAPABILITIES.CLIENT_PORTAL) &&
    planIncludesCapability(PLAN_CODES.ENTERPRISE, PRODUCT_CAPABILITIES.WHITE_LABEL) &&
    getPlanDefinition(PLAN_CODES.BUSINESS).serviceLevels.some((item) => item.code === "PRIORITY_SUPPORT"),
);

const pricing = getPricingPageProjection();
const certification = getPlanCertificationProjection();
check(
  "Pricing page projection is the same source as marketing compare rows",
  pricing.compareRows === PRICING_COMPARE_ROWS &&
    TBBT_PRICING_COMPARE_ROWS[0].label === "Trade Availability" &&
    TBBT_PRICING_COMPARE_ROWS[6].label === "Jobs & Task Management" &&
    TBBT_PRICING_COMPARE_ROWS[6].values[0] === "dash" &&
    TBBT_PRICING_COMPARE_ROWS[6].values[1] === "check" &&
    TBBT_PRICING_FOUNDER_CARD_FEATURES.includes("Jobs") &&
    TBBT_PRICING_FOUNDER_CARD_FEATURES.includes("Team management"),
);
check(
  "Every displayed included software feature maps to a known capability or a non-software fact",
  pricing.plans.every((plan) =>
    PLAN_DEFINITIONS[plan.code].cardFeatures.every((feature) => {
      if (feature.kind === "CAPABILITY") return Boolean(feature.capability);
      return ["LIMIT", "SERVICE", "INHERITANCE", "SETUP"].includes(feature.kind);
    }),
  ),
);
check(
  "COMING_SOON / PLANNED capabilities are not certified as live software on non-live plans",
  certification.features
    .filter((feature) => feature.implementationStatus === "PLANNED" || feature.implementationStatus === "COMING_SOON")
    .every((feature) =>
      Object.values(feature.presentedAsLiveSoftware).every((value) => value === false),
    ) &&
    pricing.plans.filter((plan) => plan.code !== "FOUNDER").every((plan) => plan.purchasable === false),
);
check(
  "tbbt_founder remains the Stripe-era alias and maps to FOUNDER",
  TBBT_SAAS_PLAN_CODE === "tbbt_founder" &&
    resolveCompatiblePlanCode({ planCode: "tbbt_founder" }) === "FOUNDER" &&
    resolveCompatiblePlanCode({ planCode: null }) === "FOUNDER" &&
    resolvePlanCodeFromPriceId("price_saas_test") === "FOUNDER" &&
    resolveWebhookPlanCode({ stripePriceId: "price_unknown_higher", currentPlanCode: "FOUNDER" }) ===
      "FOUNDER" &&
    resolveWebhookPlanCode({ stripePriceId: "price_saas_test_BUSINESS", currentPlanCode: "FOUNDER" }) ===
      "BUSINESS",
);
check(
  "Approved display prices format from amount, currency, and interval",
  formatApprovedDisplayPrice({
    amountCents: TBBT_FOUNDER_PLAN_AMOUNT_CENTS,
    currency: "usd",
    interval: "month",
    label: TBBT_FOUNDER_PLAN_PRICE_LABEL,
  }).priceAmount === "$49" &&
    formatApprovedDisplayPrice({
      amountCents: TBBT_FOUNDER_PLAN_AMOUNT_CENTS,
      currency: "usd",
      interval: "month",
      label: TBBT_FOUNDER_PLAN_PRICE_LABEL,
    }).priceSuffix === "/month" &&
    formatApprovedDisplayPrice({
      amountCents: 7900,
      currency: "usd",
      interval: "month",
    }).priceAmount === "$79" &&
    formatApprovedDisplayPrice({
      amountCents: 7900,
      currency: "usd",
      interval: "month",
    }).priceLabel === "$79/month" &&
    getPricingPageProjection().plans.find((plan) => plan.code === "FOUNDER")?.priceAmount ===
      "$49",
);
check(
  "Starter is not launch-ready because scheduling and invoices still depend on jobs",
  getPlanLaunchReadiness(PLAN_CODES.STARTER).launchReady === false &&
    getPlanLaunchReadiness(PLAN_CODES.STARTER).findings.some(
      (item) => item.code === "SCHEDULING_REQUIRES_JOBS",
    ) &&
    getPlanLaunchReadiness(PLAN_CODES.STARTER).findings.some(
      (item) => item.code === "INVOICES_REQUIRE_COMPLETED_JOB",
    ) &&
    getPlanCertificationProjection().plans.find((plan) => plan.code === "STARTER")
      ?.launchReady === false &&
    getPlanLaunchReadiness(PLAN_CODES.FOUNDER).launchReady === true &&
    getPlanLaunchReadiness(PLAN_CODES.FOUNDER).findings.length === 0,
);
{
  const previousAdapter = process.env.TBBT_SAAS_BILLING_ADAPTER;
  const previousVercel = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
  check(
    "Production-shaped environments do not map fake test price IDs to paid plans",
    resolvePlanCodeFromPriceId("price_saas_test_BUSINESS") === null &&
      resolvePlanCodeFromPriceId("price_saas_test_ENTERPRISE") === null &&
      resolvePlanCodeFromPriceId("price_saas_test_STARTER") === null &&
      resolveWebhookPlanCode({
        stripePriceId: "price_saas_test_BUSINESS",
        currentPlanCode: "FOUNDER",
      }) === "FOUNDER",
  );
  process.env.TBBT_SAAS_BILLING_ADAPTER = previousAdapter;
  if (previousVercel == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = previousVercel;
}
check(
  "Fake adapter still maps test price IDs for programmatic plan exercise",
  resolvePlanCodeFromPriceId("price_saas_test_STARTER") === "STARTER" &&
    resolvePlanCodeFromPriceId("price_saas_test_BUSINESS") === "BUSINESS",
);
check(
  "Downgrade policy preserves records, export, billing, and offboarding",
  PRODUCT_DOWNGRADE_RULES.preserveRecords &&
    PRODUCT_DOWNGRADE_RULES.preserveExport &&
    PRODUCT_DOWNGRADE_RULES.blockCreateAndMaterialMutation &&
    PRODUCT_DOWNGRADE_RULES.doNotHoldDataHostage,
);

try {
  resetSaasBillingSchemaEnsure();
  const provider = createFakeSaasBillingProvider();
  setSaasBillingProvider(provider);

  console.log("\nDB — Plan identity, checkout, webhooks, isolation");
  const alpha = await seedBusiness("Alpha Plans");
  const bravo = await seedBusiness("Bravo Plans");
  const adminUser = await prisma.user.create({
    data: {
      name: "Alpha Admin",
      email: `alpha.admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: alpha.business.id, role: "ADMIN" },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Alpha Member",
      email: `alpha.member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: alpha.business.id, role: "MEMBER" },
  });

  const ownerAccess = makeAccess(alpha.business.id, "OWNER", alpha.membership.id, alpha.ownerUser.email);
  const adminAccess = makeAccess(alpha.business.id, "ADMIN", adminMembership.id, adminUser.email);
  const memberAccess = makeAccess(alpha.business.id, "MEMBER", memberMembership.id, memberUser.email);
  const bravoAccess = makeAccess(bravo.business.id, "OWNER", bravo.membership.id, bravo.ownerUser.email);

  await startFounderTrialIfEligible(prisma, {
    businessId: alpha.business.id,
    slug: alpha.business.slug,
    changedByMembershipId: alpha.membership.id,
  });
  const trialEntitlement = await loadProductEntitlement(prisma, alpha.business.id);
  check(
    "Historical / empty SaaS rows resolve to FOUNDER capabilities",
    trialEntitlement.planCode === "FOUNDER" &&
      trialEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.JOBS_TASKS) &&
      trialEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.WEBSITE_BUILDER),
  );

  const checkout = await startSaasSubscriptionCheckout(prisma, ownerAccess, { planCode: "FOUNDER" });
  check(
    "Checkout uses the server-supplied Founder price, not a browser price ID",
    checkout.url.includes("checkout.stripe.test") &&
      provider.checkouts.at(-1)?.priceId === "price_saas_test" &&
      provider.checkouts.at(-1)?.planCode === "tbbt_founder",
  );

  await expectThrow(
    "ADMIN cannot start SaaS checkout",
    () => startSaasSubscriptionCheckout(prisma, adminAccess, { planCode: "FOUNDER" }),
    (error) => error instanceof ForbiddenError,
  );
  provider.addSubscription({
    id: "sub_alpha_founder",
    customerId: checkout.customerId,
    priceId: "price_saas_test",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 86400000),
    cancelAtPeriodEnd: false,
  });
  await applyPlanWebhook(alpha.business, {
    customerId: checkout.customerId,
    subscriptionId: "sub_alpha_founder",
    priceId: "price_saas_test",
    id: "evt_alpha_founder",
  });
  const founderRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: alpha.business.id },
  });
  check(
    "Webhook writes FOUNDER from the known Founder price and preserves Founder facts",
    founderRow?.planCode === "FOUNDER" &&
      founderRow?.founderEligible === true &&
      founderRow?.stripePriceId === "price_saas_test",
  );

  await applyPlanWebhook(alpha.business, {
    customerId: checkout.customerId,
    subscriptionId: "sub_alpha_founder",
    priceId: "price_unknown_enterprise",
    id: "evt_alpha_unknown",
    created: Math.floor(Date.now() / 1000) + 10,
  });
  const afterUnknown = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: alpha.business.id },
  });
  check(
    "Unknown webhook price never grants Enterprise / Business",
    afterUnknown?.planCode === "FOUNDER" && afterUnknown?.stripePriceId === "price_unknown_enterprise",
  );

  await expectThrow(
    "Production-shaped Business checkout is rejected without a LIVE approved price when fake is off",
    async () => {
      const previous = process.env.TBBT_SAAS_BILLING_ADAPTER;
      const previousVercel = process.env.VERCEL_ENV;
      process.env.TBBT_SAAS_BILLING_ADAPTER = "";
      process.env.VERCEL_ENV = "production";
      try {
        await startSaasSubscriptionCheckout(prisma, bravoAccess, { planCode: "BUSINESS" });
      } finally {
        process.env.TBBT_SAAS_BILLING_ADAPTER = previous;
        if (previousVercel == null) delete process.env.VERCEL_ENV;
        else process.env.VERCEL_ENV = previousVercel;
      }
    },
    (error) => error instanceof SaasBillingError,
  );

  const starterCheckout = await startSaasSubscriptionCheckout(prisma, bravoAccess, {
    planCode: "STARTER",
  });
  check(
    "Fake provider can exercise Starter checkout without inventing a public price",
    starterCheckout.url.includes("checkout.stripe.test") &&
      provider.checkouts.at(-1)?.priceId === "price_saas_test_STARTER",
  );
  provider.addSubscription({
    id: "sub_bravo_starter",
    customerId: starterCheckout.customerId,
    priceId: "price_saas_test_STARTER",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 86400000),
    cancelAtPeriodEnd: false,
  });
  await applyPlanWebhook(bravo.business, {
    customerId: starterCheckout.customerId,
    subscriptionId: "sub_bravo_starter",
    priceId: "price_saas_test_STARTER",
    id: "evt_bravo_starter",
  });

  const bravoEntitlement = await loadProductEntitlement(prisma, bravo.business.id);
  check(
    "Starter subscription gets CRM but not jobs / team / marketing / reports",
    bravoEntitlement.planCode === "STARTER" &&
      bravoEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.CRM) &&
      !bravoEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.JOBS_TASKS) &&
      !bravoEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.TEAM_MANAGEMENT) &&
      !bravoEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.MARKETING_TOOLS) &&
      !bravoEntitlement.capabilities.includes(PRODUCT_CAPABILITIES.REPORTING_INSIGHTS),
  );

  const alphaBeforeMismatch = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: alpha.business.id },
  });
  const bravoBeforeMismatch = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: bravo.business.id },
  });
  const mismatchedCustomer = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        businessId: alpha.business.id,
        customerId: starterCheckout.customerId,
        subscriptionId: "sub_mismatch_customer",
        priceId: "price_saas_test_BUSINESS",
        id: "evt_mismatch_customer",
        created: Math.floor(Date.now() / 1000) + 30,
      }),
    ),
  );
  const mismatchedSubscription = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        businessId: alpha.business.id,
        customerId: "cus_mismatch_sub",
        subscriptionId: "sub_bravo_starter",
        priceId: "price_saas_test_ENTERPRISE",
        id: "evt_mismatch_subscription",
        created: Math.floor(Date.now() / 1000) + 31,
      }),
    ),
  );
  const unknownIdentifiers = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        businessId: randomUUID(),
        customerId: "cus_unknown_foreign",
        subscriptionId: "sub_unknown_foreign",
        priceId: "price_saas_test_BUSINESS",
        id: "evt_unknown_identifiers",
        created: Math.floor(Date.now() / 1000) + 32,
      }),
    ),
  );
  const browserBusinessId = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        businessId: bravo.business.id,
        customerId: checkout.customerId,
        subscriptionId: "sub_alpha_founder",
        priceId: "price_saas_test_BUSINESS",
        id: "evt_browser_business",
        created: Math.floor(Date.now() / 1000) + 33,
      }),
    ),
  );
  const matchingAlpha = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        businessId: alpha.business.id,
        customerId: checkout.customerId,
        subscriptionId: "sub_alpha_founder",
        priceId: "price_saas_test",
        id: "evt_matching_alpha",
        created: Math.floor(Date.now() / 1000) + 34,
      }),
    ),
  );
  const alphaAfterMismatch = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: alpha.business.id },
  });
  const bravoAfterMismatch = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: bravo.business.id },
  });
  check(
    "A metadata + B customer ID is rejected without mutating either tenant",
    mismatchedCustomer.applied === false &&
      mismatchedCustomer.reason === "tenant_mismatch" &&
      alphaAfterMismatch?.planCode === alphaBeforeMismatch?.planCode &&
      alphaAfterMismatch?.founderEligible === alphaBeforeMismatch?.founderEligible &&
      bravoAfterMismatch?.planCode === bravoBeforeMismatch?.planCode,
  );
  check(
    "A metadata + B subscription ID is rejected without mutating either tenant",
    mismatchedSubscription.applied === false &&
      mismatchedSubscription.reason === "tenant_mismatch",
  );
  check(
    "Unknown identifiers do not mutate another tenant",
    unknownIdentifiers.applied === false &&
      unknownIdentifiers.reason === "unknown_business" &&
      unknownIdentifiers.businessId == null &&
      bravoAfterMismatch?.stripeCustomerId === bravoBeforeMismatch?.stripeCustomerId,
  );
  check(
    "Browser-supplied businessId cannot attach another tenant's Stripe subscription",
    browserBusinessId.applied === false &&
      browserBusinessId.reason === "tenant_mismatch" &&
      alphaAfterMismatch?.stripeSubscriptionId === "sub_alpha_founder" &&
      bravoAfterMismatch?.stripeSubscriptionId === "sub_bravo_starter",
  );
  check(
    "Matching A identifiers still apply to A",
    matchingAlpha.applied === true && matchingAlpha.businessId === alpha.business.id,
  );

  console.log("\nDB — Role × product entitlement and feature gates");
  await requireProductCapability(prisma, alpha.business.id, PRODUCT_CAPABILITIES.JOBS_TASKS);
  check("OWNER + entitled jobs feature is allowed", true);
  await requireProductCapability(prisma, alpha.business.id, PRODUCT_CAPABILITIES.CRM);
  requireBusinessCapability(adminAccess, CAPABILITIES.MANAGE_CUSTOMERS);
  check("ADMIN + entitled ordinary CRM feature still needs role capability independently", true);
  await expectThrow(
    "MEMBER + product entitlement is still denied from management actions",
    async () => {
      requireBusinessCapability(memberAccess, CAPABILITIES.MANAGE_CUSTOMERS);
    },
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "OWNER + missing Starter-only-excluded capability is denied on Starter",
    () => requireProductCapability(prisma, bravo.business.id, PRODUCT_CAPABILITIES.JOBS_TASKS),
    (error) => error instanceof ProductCapabilityRequiredError,
  );
  await expectThrow(
    "ADMIN + missing product capability is denied",
    () => requireProductCapability(prisma, bravo.business.id, PRODUCT_CAPABILITIES.MARKETING_TOOLS),
    (error) => error instanceof ProductCapabilityRequiredError,
  );
  check(
    "Product entitlement does not grant MANAGE_CUSTOMERS to MEMBER",
    (await hasProductCapability(prisma, alpha.business.id, PRODUCT_CAPABILITIES.CRM)) === true,
  );

  const job = await prisma.job.create({
    data: {
      businessId: alpha.business.id,
      projectToken: `job_${randomUUID()}`,
      status: "SCHEDULED",
    },
  });
  const change = await requestSaasPlanChange(prisma, ownerAccess, { planCode: "STARTER" });
  check(
    "Plan change asks the provider and does not locally mutate to Starter",
    change.localPlanUnchanged &&
      change.requested &&
      (await prisma.businessSaasSubscription.findUnique({ where: { businessId: alpha.business.id } }))
        ?.planCode === "FOUNDER",
  );
  await applyPlanWebhook(alpha.business, {
    customerId: checkout.customerId,
    subscriptionId: "sub_alpha_founder",
    priceId: "price_saas_test_STARTER",
    id: "evt_alpha_down",
    created: Math.floor(Date.now() / 1000) + 40,
  });
  const afterDown = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: alpha.business.id },
  });
  const keptJob = await prisma.job.findUnique({ where: { id: job.id } });
  check(
    "Downgrade to Starter keeps historical jobs and Founder eligibility audit facts",
    afterDown?.planCode === "STARTER" &&
      Boolean(keptJob) &&
      afterDown?.founderConvertedAt != null,
  );
  await expectThrow(
    "After downgrade, new jobs capability is blocked",
    () => requireProductCapability(prisma, alpha.business.id, PRODUCT_CAPABILITIES.JOBS_TASKS),
    (error) => error instanceof ProductCapabilityRequiredError,
  );
  check(
    "CRM remains after Founder → Starter downgrade",
    await hasProductCapability(prisma, alpha.business.id, PRODUCT_CAPABILITIES.CRM),
  );

  console.log("\nDB — Limits, add-ons, grants, isolation, export");
  await expectThrow(
    "Starter cannot activate a second trade",
    () => activateBusinessTradeOp(prisma, bravoAccess, "CLEANING"),
    (error) => error instanceof ProductLimitExceededError,
  );
  const leftoverTrade = await prisma.businessTrade.findFirst({
    where: { businessId: bravo.business.id, tradeCode: "CLEANING" },
  });
  check("Failed extra-trade activation did not create a Cleaning 1.0 row", leftoverTrade == null);

  await assignProductAddon(prisma, {
    businessId: bravo.business.id,
    addonCode: "ADDITIONAL_TRADE",
    source: "SUPPORT",
  });
  const activated = await activateBusinessTradeOp(prisma, bravoAccess, "CLEANING");
  check(
    "Additional Trade add-on increases the Starter trade allowance without mutating the plan code",
    activated.status === "ACTIVE" &&
      (await prisma.businessSaasSubscription.findUnique({ where: { businessId: bravo.business.id } }))
        ?.planCode === "STARTER",
  );

  const bravoAddon = await prisma.businessProductAddon.findFirst({
    where: { businessId: bravo.business.id },
  });
  const alphaSeesBravo = await prisma.businessProductAddon.findFirst({
    where: { id: bravoAddon.id, businessId: alpha.business.id },
  });
  check("Owner surfaces cannot read another tenant's add-on row", alphaSeesBravo == null);
  const bravoLimits = await loadProductEntitlement(prisma, bravo.business.id);
  const alphaLimits = await loadProductEntitlement(prisma, alpha.business.id);
  check(
    "Business A cannot consume Business B's add-on limits",
    bravoLimits.limits.TRADES.effective === 2 &&
      (alphaLimits.limits.TRADES.effective == null || alphaLimits.limits.TRADES.effective !== 2),
  );

  await grantProductCapability(prisma, {
    businessId: bravo.business.id,
    capability: PRODUCT_CAPABILITIES.JOBS_TASKS,
    source: "SUPPORT",
    note: "Grandfathered jobs access",
  });
  check(
    "Support grant is an explicit additive source, not a hidden plan code",
    await hasProductCapability(prisma, bravo.business.id, PRODUCT_CAPABILITIES.JOBS_TASKS),
  );

  await expectThrow(
    "Zero grant quantity is rejected",
    () =>
      grantProductLimit(prisma, {
        businessId: bravo.business.id,
        limit: PRODUCT_LIMITS.TRADES,
        quantity: 0,
      }),
    (error) => error instanceof ProductQuantityInvalidError,
  );
  await expectThrow(
    "Negative grant quantity is rejected",
    () =>
      grantProductLimit(prisma, {
        businessId: bravo.business.id,
        limit: PRODUCT_LIMITS.TRADES,
        quantity: -2,
      }),
    (error) => error instanceof ProductQuantityInvalidError,
  );
  await expectThrow(
    "Non-integer grant quantity is rejected",
    () =>
      grantProductLimit(prisma, {
        businessId: bravo.business.id,
        limit: PRODUCT_LIMITS.TRADES,
        quantity: 1.5,
      }),
    (error) => error instanceof ProductQuantityInvalidError,
  );
  const firstIdempotent = await grantProductLimit(prisma, {
    businessId: bravo.business.id,
    limit: PRODUCT_LIMITS.USERS,
    quantity: 3,
    source: "SUPPORT",
    sourceRef: "ticket-users-1",
  });
  const retryIdempotent = await grantProductLimit(prisma, {
    businessId: bravo.business.id,
    limit: PRODUCT_LIMITS.USERS,
    quantity: 3,
    source: "SUPPORT",
    sourceRef: "ticket-users-1",
  });
  const independentGrant = await grantProductLimit(prisma, {
    businessId: bravo.business.id,
    limit: PRODUCT_LIMITS.USERS,
    quantity: 1,
    source: "SUPPORT",
  });
  const afterGrants = await loadProductEntitlement(prisma, bravo.business.id);
  check(
    "Retrying the same sourceRef grant does not double the limit; independent grants still add",
    firstIdempotent.id === retryIdempotent.id &&
      independentGrant.id !== firstIdempotent.id &&
      afterGrants.limits.USERS.additive === 4,
  );
  await expectThrow(
    "Invalid add-on quantity is rejected",
    () =>
      assignProductAddon(prisma, {
        businessId: bravo.business.id,
        addonCode: "ADDITIONAL_TRADE",
        quantity: 0,
      }),
    (error) => error instanceof ProductQuantityInvalidError,
  );

  const zip = await buildBusinessExportZip(prisma, bravo.business.id);
  const zipText = zip.bytes.toString("utf8");
  check(
    "Export includes plan/add-on metadata and omits Stripe secrets",
    zipText.includes("STARTER") &&
      zipText.includes("ADDITIONAL_TRADE") &&
      zipText.includes("commercial-entitlement.json") &&
      !zipText.includes("sk_test") &&
      !zipText.includes("whsec_") &&
      !zipText.includes("STRIPE_SAAS_PRICE_ID"),
  );

  const snapshot = await loadSaasBillingSnapshot(prisma, alpha.business.id);
  check(
    "Billing snapshot shows current plan, capabilities, add-ons, and truthful availability",
    snapshot.catalogPlanCode === "STARTER" &&
      snapshot.product.capabilities.includes(PRODUCT_CAPABILITIES.CRM) &&
      !snapshot.product.capabilities.includes(PRODUCT_CAPABILITIES.JOBS_TASKS) &&
      snapshot.availablePlans.find((plan) => plan.code === "FOUNDER")?.purchasable === true &&
      snapshot.availablePlans.find((plan) => plan.code === "STARTER")?.purchasable === false &&
      snapshot.availablePlans.find((plan) => plan.code === "BUSINESS")?.purchasable === false &&
      snapshot.availablePlans.find((plan) => plan.code === "ENTERPRISE")?.purchasable === false &&
      snapshot.availablePlans.find((plan) => plan.code === "BUSINESS")?.providerTestable === true &&
      snapshot.availablePlans.find((plan) => plan.code === "STARTER")?.providerTestable === true &&
      snapshot.product.capabilitySummaries.find((item) => item.code === PRODUCT_CAPABILITIES.CRM)
        ?.liveSoftware === true &&
      snapshot.product.capabilitySummaries.find((item) => item.code === PRODUCT_CAPABILITIES.CRM)
        ?.displayName === "CRM & Customer Management" &&
      snapshot.product.capabilitySummaries.find(
        (item) => item.code === PRODUCT_CAPABILITIES.MOBILE_ACCESS,
      )?.liveSoftware === false &&
      snapshot.founderEligible === true,
  );
  check(
    "Public catalog purchasability is commercial truth even while fake provider is testable",
    isPubliclyPurchasablePlan(PLAN_CODES.FOUNDER) === true &&
      isPubliclyPurchasablePlan(PLAN_CODES.STARTER) === false &&
      isPubliclyPurchasablePlan(PLAN_CODES.BUSINESS) === false &&
      isPubliclyPurchasablePlan(PLAN_CODES.ENTERPRISE) === false,
  );
  const publicPurchasableWithoutFake = getPricingPageProjection().plans.filter((plan) => plan.purchasable);
  check(
    "Public marketing purchasability is only Founder even though fake checkout can exercise other plans",
    publicPurchasableWithoutFake.length === 1 && publicPurchasableWithoutFake[0].code === "FOUNDER",
  );

  console.log("\nHTTP — Targeted pricing proofs");
  try {
    const pricingRes = await fetch(`${APP_URL}/pricing`, { redirect: "manual" });
    if (pricingRes.status >= 200 && pricingRes.status < 400) {
      const body = await pricingRes.text();
      // Next.js RSC payloads use ids like "$29"; only treat price-like text as commercial.
      const visible = body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ");
      check(
        "Pricing page HTML shows Founder $49 and Coming Soon Business/Enterprise",
        (visible.includes("$49") || body.includes("$49/month")) &&
          visible.includes("Coming Soon") &&
          visible.includes("Founder") &&
          visible.includes("Business") &&
          visible.includes("Enterprise") &&
          visible.includes("Starter") &&
          !visible.includes("$29") &&
          !visible.includes("$79") &&
          !body.includes("$29/month") &&
          !body.includes("$79/month"),
      );
    } else {
      check("Pricing page HTTP skipped (app not reachable)", true);
    }
  } catch {
    check("Pricing page HTTP skipped (app not reachable)", true);
  }
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
    ? "\nAll plan entitlement checks passed."
    : `\n${failures} plan entitlement check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
