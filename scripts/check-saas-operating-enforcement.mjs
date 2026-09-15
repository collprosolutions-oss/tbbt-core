/**
 * TBBT SaaS operating entitlement enforcement (Task 6).
 *
 * Proves centralized load/resolve/assert gates operating writes, that
 * trial_active / subscribed_active / payment_problem / legacy_exempt can
 * operate, that subscription_required cannot create or materially change
 * operating records even when the lib op is called directly, and that
 * billing, data export, public/webhook/Connect paths stay unblocked.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-saas-operating-enforcement.mjs
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

const testDbName = "tbbt_saas_operating_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://saas-operating.test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_saas_operating_check";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_saas_operating_check";
process.env.STRIPE_SAAS_PRICE_ID = "price_saas_test";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for SaaS operating test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const { ForbiddenError } = await import("@/lib/authorization");
const { parseCheckoutPaymentEvent } = await import("@/lib/payments/events");
const { createExpense, updateExpense } = await import("@/lib/expense-ops");
const { setOwnedServiceCatalogItemActive } = await import("@/lib/catalog-ops");
const {
  updateBusinessProfileOp,
  updateLaborMinimumSettingsOp,
} = await import("@/lib/settings-ops");
const { loadSettingsSnapshot } = await import("@/lib/settings-data");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const {
  assertSaasOperatingEntitlement,
  ensureSaasBillingSchema,
  loadSaasBillingSnapshot,
  loadSaasEntitlement,
  requireSaasOperatingEntitlement,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  resolveSaasEntitlement,
  SAAS_CHECKOUT_PURPOSE,
  SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  SaasSubscriptionRequiredError,
  setSaasBillingProvider,
  startSaasSubscriptionCheckout,
  TBBT_FOUNDER_TRIAL_MS,
} = await import("@/lib/saas-billing");
const { dispatchStripeWebhookEvent } = await import("@/lib/stripe-webhook-dispatch");

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
      ...(extra.includeBusiness === false
        ? {}
        : {
            business: {
              id: businessId,
              slug: extra.slug ?? "unused",
              tradeCode: "HANDYMAN",
              name: extra.name ?? "Test Business",
            },
          }),
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
  return { business, membership, ownerUser };
}

async function persistSaas(businessId, data) {
  await ensureSaasBillingSchema(prisma);
  return prisma.businessSaasSubscription.upsert({
    where: { businessId },
    create: {
      businessId,
      status: data.status ?? "none",
      cancelAtPeriodEnd: false,
      ...data,
    },
    update: data,
  });
}

async function expectSaasBlock(label, fn, expectedMessage) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(
      label,
      error instanceof SaasSubscriptionRequiredError &&
        error.name === "SaasSubscriptionRequiredError" &&
        error.message === expectedMessage,
    );
  }
}

function expenseInput(description) {
  return {
    occurredOn: "2026-09-01",
    description,
    amount: "25.00",
    category: "MATERIALS",
  };
}

const enforceSrc = readFileSync(new URL("../src/lib/saas-billing/enforce.ts", import.meta.url), "utf8");
const entitlementSrc = readFileSync(new URL("../src/lib/saas-billing/entitlement.ts", import.meta.url), "utf8");
const webhookSrc = readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
const webhookDispatchSrc = readFileSync(new URL("../src/lib/stripe-webhook-dispatch.ts", import.meta.url), "utf8");
const paymentsServiceSrc = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const paymentsActionSrc = readFileSync(new URL("../src/app/actions/payments.ts", import.meta.url), "utf8");
const intakeSrc = readFileSync(new URL("../src/app/actions/intake.ts", import.meta.url), "utf8");
const publicEstimateSrc = readFileSync(new URL("../src/app/actions/public-estimate.ts", import.meta.url), "utf8");
const publicAppointmentSrc = readFileSync(new URL("../src/app/actions/public-appointment.ts", import.meta.url), "utf8");
const saasBillingActionSrc = readFileSync(new URL("../src/app/actions/saas-billing.ts", import.meta.url), "utf8");
const authActionSrc = readFileSync(new URL("../src/app/actions/auth.ts", import.meta.url), "utf8");
const accessSrc = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");
const customerActionSrc = readFileSync(new URL("../src/app/actions/customer.ts", import.meta.url), "utf8");
const expenseOpsSrc = readFileSync(new URL("../src/lib/expense-ops.ts", import.meta.url), "utf8");
const catalogOpsSrc = readFileSync(new URL("../src/lib/catalog-ops.ts", import.meta.url), "utf8");
const settingsOpsSrc = readFileSync(new URL("../src/lib/settings-ops.ts", import.meta.url), "utf8");
const payrollRefreshSrc = readFileSync(new URL("../src/lib/payroll-ops.ts", import.meta.url), "utf8");

console.log("\nSTATIC — Centralized operating gate, not a second subscription system");
check(
  "Enforcement reuses loadSaasEntitlement / resolveSaasEntitlement / assertSaasOperatingEntitlement",
  entitlementSrc.includes("export async function loadSaasEntitlement") &&
    entitlementSrc.includes("export function resolveSaasEntitlement") &&
    entitlementSrc.includes("export function assertSaasOperatingEntitlement") &&
    entitlementSrc.includes("export async function requireSaasOperatingEntitlement") &&
    enforceSrc.includes("requireSaasOperatingEntitlement") &&
    enforceSrc.includes("requireBusinessAccess()"),
);
check(
  "Operating gate is not inside requireBusinessAccess (billing/auth/export stay reachable)",
  !accessSrc.includes("requireSaasOperatingEntitlement") &&
    !accessSrc.includes("assertSaasOperatingEntitlement") &&
    saasBillingActionSrc.includes("requireBusinessAccess") &&
    !saasBillingActionSrc.includes("requireOperatingBusinessAccess") &&
    authActionSrc.includes("signOutAction") &&
    !authActionSrc.includes("requireOperatingBusinessAccess"),
);
check(
  "Customer/expense/catalog/settings operating writes call the centralized assertion",
  customerActionSrc.includes("requireOperatingBusinessAccessForForm") &&
    expenseOpsSrc.includes("requireSaasOperatingEntitlement") &&
    catalogOpsSrc.includes("requireSaasOperatingEntitlement") &&
    settingsOpsSrc.includes("await requireSaasOperatingEntitlement(db, access)") &&
    settingsOpsSrc.includes("export async function updateBusinessProfileOp") &&
    !settingsOpsSrc.slice(
      settingsOpsSrc.indexOf("export async function updateBusinessProfileOp"),
      settingsOpsSrc.indexOf("export async function updateBusinessPublicContactOp"),
    ).includes("requireSaasOperatingEntitlement"),
);
check(
  "Webhook, Connect payments, and public customer flows are not wrapped in the operating gate",
  !webhookSrc.includes("requireOperatingBusinessAccess") &&
    !webhookSrc.includes("requireSaasOperatingEntitlement") &&
    !webhookDispatchSrc.includes("requireOperatingBusinessAccess") &&
    !webhookDispatchSrc.includes("requireSaasOperatingEntitlement") &&
    !paymentsServiceSrc.includes("requireSaasOperatingEntitlement") &&
    !paymentsActionSrc.includes("requireOperatingBusinessAccess") &&
    !intakeSrc.includes("requireOperatingBusinessAccess") &&
    !publicEstimateSrc.includes("requireOperatingBusinessAccess") &&
    !publicAppointmentSrc.includes("requireOperatingBusinessAccess"),
);
check(
  "Payroll system refresh helpers are not gated (user mutations are)",
  payrollRefreshSrc.includes("export async function refreshPayrollAfterTimesheetChange") &&
    !payrollRefreshSrc
      .slice(payrollRefreshSrc.indexOf("export async function refreshPayrollAfterTimesheetChange"))
      .includes("await requireSaasOperatingEntitlement(db, access);\n  const week") &&
    payrollRefreshSrc.includes("await requireSaasOperatingEntitlement(db, access);\n  requireBusinessCapability(access, CAPABILITIES.MANAGE_PAYROLL)"),
);

try {
  resetSaasBillingSchemaEnsure();
  const provider = createFakeSaasBillingProvider();
  setSaasBillingProvider(provider);
  const now = new Date("2026-09-15T12:00:00.000Z");
  const pastStart = new Date(now.getTime() - TBBT_FOUNDER_TRIAL_MS - 60_000);
  const pastEnd = new Date(now.getTime() - 60_000);
  const futureEnd = new Date(now.getTime() + TBBT_FOUNDER_TRIAL_MS);

  console.log("\nTEST — Operating states can create records; subscription_required cannot");
  const trialBiz = await seedBusiness("Trial Operator");
  const subscribedBiz = await seedBusiness("Subscribed Operator");
  const problemBiz = await seedBusiness("Payment Problem Operator");
  const legacyBiz = await seedBusiness("Legacy Operator");
  const blockedBiz = await seedBusiness("Blocked Operator");
  const collpro = await seedBusiness("CollPro Reno Handyman Services", { slug: "collpro-reno" });

  await persistSaas(trialBiz.business.id, {
    status: "none",
    trialStartedAt: now,
    trialEndsAt: futureEnd,
    founderEligible: true,
    legacyExempt: false,
  });
  await persistSaas(subscribedBiz.business.id, {
    status: "active",
    founderEligible: false,
    legacyExempt: false,
  });
  await persistSaas(problemBiz.business.id, {
    status: "past_due",
    founderEligible: false,
    legacyExempt: false,
  });
  await persistSaas(legacyBiz.business.id, {
    status: "none",
    founderEligible: false,
    legacyExempt: true,
  });
  await persistSaas(blockedBiz.business.id, {
    status: "none",
    trialStartedAt: pastStart,
    trialEndsAt: pastEnd,
    founderEligible: true,
    legacyExempt: false,
  });

  const trialAccess = makeAccess(trialBiz.business.id, "OWNER", trialBiz.membership.id, {
    slug: trialBiz.business.slug,
    email: trialBiz.ownerUser.email,
  });
  const subscribedAccess = makeAccess(subscribedBiz.business.id, "OWNER", subscribedBiz.membership.id, {
    slug: subscribedBiz.business.slug,
  });
  const problemAccess = makeAccess(problemBiz.business.id, "OWNER", problemBiz.membership.id, {
    slug: problemBiz.business.slug,
  });
  const legacyAccess = makeAccess(legacyBiz.business.id, "OWNER", legacyBiz.membership.id, {
    slug: legacyBiz.business.slug,
  });
  const blockedAccess = makeAccess(blockedBiz.business.id, "OWNER", blockedBiz.membership.id, {
    slug: blockedBiz.business.slug,
    email: blockedBiz.ownerUser.email,
    name: blockedBiz.business.name,
  });
  const blockedDirectAccess = makeAccess(blockedBiz.business.id, "OWNER", blockedBiz.membership.id, {
    slug: blockedBiz.business.slug,
    includeBusiness: false,
  });
  const collproAccess = makeAccess(collpro.business.id, "OWNER", collpro.membership.id, {
    slug: collpro.business.slug,
  });

  check(
    "trial_active is operable",
    (await loadSaasEntitlement(prisma, trialBiz.business, now)).state === "trial_active" &&
      (await loadSaasEntitlement(prisma, trialBiz.business, now)).canOperate === true,
  );
  check(
    "subscribed_active is operable",
    (await loadSaasEntitlement(prisma, subscribedBiz.business, now)).state === "subscribed_active",
  );
  check(
    "payment_problem remains operable with no invented grace duration",
    (await loadSaasEntitlement(prisma, problemBiz.business, now)).state === "payment_problem" &&
      (await loadSaasEntitlement(prisma, problemBiz.business, now)).canOperate === true &&
      !entitlementSrc.includes("grace") &&
      !enforceSrc.includes("grace"),
  );
  check(
    "legacy_exempt is operable",
    (await loadSaasEntitlement(prisma, legacyBiz.business, now)).state === "legacy_exempt",
  );
  check(
    "subscription_required is not operable",
    (await loadSaasEntitlement(prisma, blockedBiz.business, now)).state === "subscription_required" &&
      (await loadSaasEntitlement(prisma, blockedBiz.business, now)).canOperate === false,
  );
  check(
    "CollPro remains legacy_exempt without a Founder trial",
    (await loadSaasEntitlement(prisma, collpro.business, now)).state === "legacy_exempt" &&
      (await loadSaasEntitlement(prisma, collpro.business, now)).canOperate === true,
  );

  const trialExpense = await createExpense(prisma, trialAccess, expenseInput("Trial lumber"));
  const subscribedExpense = await createExpense(prisma, subscribedAccess, expenseInput("Subscribed lumber"));
  const problemExpense = await createExpense(prisma, problemAccess, expenseInput("Past due lumber"));
  const legacyExpense = await createExpense(prisma, legacyAccess, expenseInput("Legacy lumber"));
  const collproExpense = await createExpense(prisma, collproAccess, expenseInput("CollPro lumber"));
  check("trial_active can create a protected operating record", Boolean(trialExpense.id));
  check("subscribed_active can create a protected operating record", Boolean(subscribedExpense.id));
  check("payment_problem can create a protected operating record", Boolean(problemExpense.id));
  check("legacy_exempt can create a protected operating record", Boolean(legacyExpense.id));
  check("CollPro can create a protected operating record", Boolean(collproExpense.id));

  const retainedCustomer = await prisma.customer.create({
    data: { businessId: blockedBiz.business.id, name: "Retained Customer" },
  });
  const retainedCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: blockedBiz.business.id,
      name: "Retained patch",
      pricingMode: "FIXED",
      price: 40,
    },
  });
  const preBlockExpense = await prisma.expense.create({
    data: {
      businessId: blockedBiz.business.id,
      occurredOn: new Date("2026-08-01"),
      description: "Existing paint",
      amount: new Prisma.Decimal("18.00"),
      category: "MATERIALS",
      reviewStatus: "RECORDED",
    },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: blockedBiz.business.id,
      provider: "stripe",
      stripeAccountId: "acct_connect_blocked",
    },
  });

  await expectSaasBlock(
    "subscription_required cannot create a protected operating record",
    () => createExpense(prisma, blockedAccess, expenseInput("Blocked lumber")),
    SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  );
  await expectSaasBlock(
    "Blocking occurs server-side even when the lib op is called directly without workspace.business",
    () => createExpense(prisma, blockedDirectAccess, expenseInput("Direct lumber")),
    SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  );
  await expectSaasBlock(
    "subscription_required cannot materially modify a protected record",
    () =>
      updateExpense(prisma, blockedAccess, {
        ...expenseInput("Changed paint"),
        expenseId: preBlockExpense.id,
      }),
    SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  );
  await expectSaasBlock(
    "subscription_required cannot change the service catalog",
    () =>
      setOwnedServiceCatalogItemActive(prisma, blockedAccess, {
        id: retainedCatalog.id,
        active: false,
      }),
    SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  );
  await expectSaasBlock(
    "subscription_required cannot change labor pricing rules",
    () =>
      updateLaborMinimumSettingsOp(prisma, blockedAccess, {
        enabled: true,
        amount: new Prisma.Decimal("75"),
        confirmed: true,
      }),
    SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE,
  );

  check(
    "Existing records remain readable after subscription is required",
    (await prisma.customer.findUnique({ where: { id: retainedCustomer.id } }))?.name === "Retained Customer" &&
      (await prisma.expense.findUnique({ where: { id: preBlockExpense.id } }))?.description === "Existing paint" &&
      (await prisma.serviceCatalogItem.findUnique({ where: { id: retainedCatalog.id } }))?.active === true,
  );

  const profile = await updateBusinessProfileOp(prisma, blockedAccess, {
    name: "Blocked Operator Recovered",
    confirmed: true,
  });
  check(
    "Account/business identity needed for recovery remains writable",
    profile.unchanged === false &&
      (await prisma.business.findUnique({ where: { id: blockedBiz.business.id } }))?.name ===
        "Blocked Operator Recovered",
  );

  const snapshot = await loadSettingsSnapshot(prisma, blockedBiz.business.id);
  check(
    "Data / Export remains accessible and still lists retained customers",
    snapshot.customers.some((row) => row.name === "Retained Customer") &&
      snapshot.saasBilling.entitlement.state === "subscription_required",
  );

  const billing = await loadSaasBillingSnapshot(prisma, blockedBiz.business.id);
  check(
    "TBBT Billing remains accessible while subscription is required",
    billing.entitlement.state === "subscription_required" && billing.checkoutPossible === true,
  );

  const memberUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked.member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const member = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: blockedBiz.business.id, role: "MEMBER" },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Blocked Admin",
      email: `blocked.admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const admin = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: blockedBiz.business.id, role: "ADMIN" },
  });
  const memberAccess = makeAccess(blockedBiz.business.id, "MEMBER", member.id, {
    slug: blockedBiz.business.slug,
    email: memberUser.email,
  });
  const adminAccess = makeAccess(blockedBiz.business.id, "ADMIN", admin.id, {
    slug: blockedBiz.business.slug,
    email: adminUser.email,
  });

  await expectSaasBlock(
    "MEMBER receives the team blocked message instead of an OWNER Checkout prompt",
    () => requireSaasOperatingEntitlement(prisma, memberAccess),
    SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  await expectSaasBlock(
    "ADMIN receives the team blocked message instead of an OWNER Checkout prompt",
    () => requireSaasOperatingEntitlement(prisma, adminAccess),
    SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  try {
    await startSaasSubscriptionCheckout(prisma, memberAccess);
    check("MEMBER cannot start SaaS Checkout", false);
  } catch (error) {
    check("MEMBER cannot start SaaS Checkout", error instanceof ForbiddenError);
  }
  try {
    await startSaasSubscriptionCheckout(prisma, adminAccess);
    check("ADMIN cannot start SaaS Checkout", false);
  } catch (error) {
    check("ADMIN cannot start SaaS Checkout", error instanceof ForbiddenError);
  }

  const checkout = await startSaasSubscriptionCheckout(prisma, blockedAccess);
  check(
    "OWNER can start subscription Checkout while operating writes are blocked",
    checkout.url.startsWith("https://checkout.stripe.test/subscribe/") &&
      provider.checkouts.at(-1)?.mode === "subscription",
  );
  check(
    "Checkout start does not mark the business subscribed",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: blockedBiz.business.id },
    }))?.status === "none",
  );

  console.log("\nTEST — Connect, webhooks, and public-flow safety");
  const connectBefore = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: blockedBiz.business.id },
  });
  await requireSaasOperatingEntitlement(prisma, trialAccess);
  const connectAfter = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: blockedBiz.business.id },
  });
  check(
    "SaaS entitlement checks do not alter Connect account records",
    connectBefore?.stripeAccountId === "acct_connect_blocked" &&
      connectAfter?.stripeAccountId === "acct_connect_blocked",
  );
  check(
    "Connect payment parser ignores TBBT SaaS Checkout",
    parseCheckoutPaymentEvent({
      id: "evt_saas_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          object: "checkout.session",
          id: "cs_saas_op",
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          metadata: { purpose: SAAS_CHECKOUT_PURPOSE, businessId: blockedBiz.business.id },
        },
      },
    }) === null,
  );
  const ignored = await dispatchStripeWebhookEvent(prisma, {
    id: "evt_unknown_operating",
    type: "customer.updated",
    data: { object: { id: "cus_ignore" } },
  });
  check(
    "Stripe webhook dispatch is not blocked by operating entitlement",
    ignored.received === true && ignored.applied === false,
  );

  const unpaidEntitlement = resolveSaasEntitlement({
    slug: "any-new-shop",
    row: {
      status: "unpaid",
      trialStartedAt: null,
      trialEndsAt: null,
      founderEligible: false,
      founderConvertedAt: null,
      founderEligibilityEndedAt: null,
      legacyExempt: false,
    },
  });
  const pausedEntitlement = resolveSaasEntitlement({
    slug: "any-new-shop",
    row: {
      status: "paused",
      trialStartedAt: null,
      trialEndsAt: null,
      founderEligible: false,
      founderConvertedAt: null,
      founderEligibilityEndedAt: null,
      legacyExempt: false,
    },
  });
  check(
    "unpaid and paused Stripe statuses stay payment_problem / operable",
    unpaidEntitlement.state === "payment_problem" &&
      unpaidEntitlement.canOperate === true &&
      pausedEntitlement.state === "payment_problem" &&
      pausedEntitlement.canOperate === true,
  );
  try {
    assertSaasOperatingEntitlement(unpaidEntitlement, "OWNER");
    check("assertSaasOperatingEntitlement allows payment_problem", true);
  } catch {
    check("assertSaasOperatingEntitlement allows payment_problem", false);
  }

  check(
    "CollPro subscription row was not given Stripe ids by operating enforcement",
    (await prisma.businessSaasSubscription.findUnique({
      where: { businessId: collpro.business.id },
    }))?.stripeCustomerId == null &&
      (await prisma.businessSaasSubscription.findUnique({
        where: { businessId: collpro.business.id },
      }))?.stripeSubscriptionId == null,
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
    ? "\nAll SaaS operating enforcement checks passed."
    : `\n${failures} SaaS operating enforcement check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
