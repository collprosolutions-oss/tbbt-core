/**
 * TBBT SaaS subscription lifecycle + recovery (Task 7).
 *
 * Reuses Tasks 4–6 billing, Founder trial, entitlement, and operating
 * enforcement. Does not create a parallel billing system.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-saas-subscription-lifecycle.mjs
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

const testDbName = "tbbt_saas_lifecycle_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://saas-lifecycle.test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_saas_lifecycle_check";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_saas_lifecycle_check";
process.env.STRIPE_SAAS_PRICE_ID = "price_saas_test";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for SaaS lifecycle test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const Stripe = (await import("stripe")).default;
const { ForbiddenError } = await import("@/lib/authorization");
const { parseCheckoutPaymentEvent } = await import("@/lib/payments/events");
const { createExpense } = await import("@/lib/expense-ops");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const {
  applyParsedSaasBillingEvent,
  applySaasBillingStripeEvent,
  founderFieldsForSubscriptionStatus,
  isStaleSaasStripeEvent,
  loadSaasBillingSnapshot,
  loadSaasEntitlement,
  parseSaasBillingEvent,
  requireSaasOperatingEntitlement,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  resolveNextSaasStatus,
  resolveSaasEntitlement,
  SAAS_CHECKOUT_PURPOSE,
  setSaasBillingProvider,
  startSaasBillingPortal,
  startSaasSubscriptionCheckout,
  startFounderTrialIfEligible,
  TBBT_FOUNDER_TRIAL_MS,
} = await import("@/lib/saas-billing");
const { dispatchStripeWebhookEvent, verifyStripeWebhookPayload } = await import(
  "@/lib/stripe-webhook-dispatch"
);
const { loadSettingsSnapshot } = await import("@/lib/settings-data");

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
      business: extra.business,
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
      websiteSetupCompletedAt: extra.websiteSetupCompletedAt,
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: extra.role ?? "OWNER" },
  });
  return { business, membership, ownerUser };
}

function saasCheckoutEvent(input) {
  return {
    id: input.id ?? "evt_checkout_1",
    created: input.created ?? 1_700_000_000,
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
    created: input.created ?? 1_700_000_100,
    type: input.type ?? "customer.subscription.updated",
    account: input.account,
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

function saasInvoicePaidEvent(input) {
  return {
    id: input.id ?? "evt_invoice_paid_1",
    created: input.created ?? 1_700_000_200,
    type: input.type ?? "invoice.paid",
    account: input.account,
    data: {
      object: {
        object: "invoice",
        id: input.invoiceId ?? "in_saas_1",
        customer: input.customerId,
        subscription: input.subscriptionId,
        paid: true,
        status: "paid",
        lines: {
          data: [
            {
              period: { end: input.periodEnd ?? 1_800_000_000 },
              price: { id: input.priceId ?? "price_saas_test" },
            },
          ],
        },
        metadata: {
          purpose: input.purpose ?? SAAS_CHECKOUT_PURPOSE,
          businessId: input.businessId,
        },
      },
    },
  };
}

async function verifyAndDispatch(event, secret = process.env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const verified = verifyStripeWebhookPayload(payload, signature);
  return dispatchStripeWebhookEvent(prisma, verified);
}

function expenseInput(description) {
  return {
    occurredOn: "2026-09-01",
    description,
    amount: "25.00",
    category: "MATERIALS",
  };
}

const saasEvents = readFileSync(new URL("../src/lib/saas-billing/events.ts", import.meta.url), "utf8");
const saasOps = readFileSync(new URL("../src/lib/saas-billing/ops.ts", import.meta.url), "utf8");
const trialSrc = readFileSync(new URL("../src/lib/saas-billing/trial.ts", import.meta.url), "utf8");
const entitlementSrc = readFileSync(new URL("../src/lib/saas-billing/entitlement.ts", import.meta.url), "utf8");
const settingsSrc = readFileSync(
  new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
  "utf8",
);
const settingsButtonsSrc = readFileSync(
  new URL("../src/components/settings/saas-billing-buttons.tsx", import.meta.url),
  "utf8",
);
const bannerSrc = readFileSync(
  new URL("../src/components/settings/saas-entitlement-banner.tsx", import.meta.url),
  "utf8",
);
const paymentsServiceSrc = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const settingsDataSrc = readFileSync(new URL("../src/lib/settings-data.ts", import.meta.url), "utf8");

console.log("\nSTATIC — Lifecycle reuses Tasks 4–6 and stays separate from Connect");
check(
  "Webhook parser handles subscription lifecycle and invoice recovery",
  saasEvents.includes("customer.subscription.created") &&
    saasEvents.includes("customer.subscription.updated") &&
    saasEvents.includes("customer.subscription.deleted") &&
    saasEvents.includes("customer.subscription.paused") &&
    saasEvents.includes("invoice.paid") &&
    saasEvents.includes("invoice.payment_succeeded") &&
    saasEvents.includes("Connect-account events belong to customer invoice/deposit"),
);
check(
  "Stale Stripe events are ignored using persisted event timestamps",
  saasOps.includes("isStaleSaasStripeEvent") &&
    saasOps.includes("lastStripeEventCreatedAt") &&
    schemaSrc.includes("lastStripeEventCreatedAt") &&
    schemaSrc.includes("stripeEventCreatedAt"),
);
check(
  "Scheduled cancellation does not end Founder eligibility in trial transitions",
  trialSrc.includes("Scheduling cancellation for period end is not termination") &&
    trialSrc.includes("cancelAtPeriodEnd"),
);
check(
  "Entitlement stays subscribed_active while cancelAtPeriodEnd is true",
  entitlementSrc.includes("Cancellation is scheduled at period end") &&
    entitlementSrc.includes("isSaasTerminatedStatus"),
);
check(
  "OWNER Billing UI covers lifecycle states without raw Stripe IDs",
  settingsSrc.includes("Founder eligibility") &&
    settingsSrc.includes("Cancellation scheduled") &&
    settingsSrc.includes("Access through") &&
    settingsSrc.includes("SaasSubscribeButton") &&
    settingsSrc.includes("SaasBillingPortalButton") &&
    settingsButtonsSrc.includes("Start subscription") &&
    settingsButtonsSrc.includes("Manage billing") &&
    !settingsSrc.includes("stripeCustomerId") &&
    !settingsSrc.includes("stripeSubscriptionId") &&
    settingsDataSrc.includes("stripeCustomerId: null") &&
    bannerSrc.includes("SAAS_PAYMENT_PROBLEM_OWNER_MESSAGE") &&
    bannerSrc.includes("SAAS_PAYMENT_PROBLEM_TEAM_MESSAGE"),
);
check(
  "Connect payment service still does not persist BusinessSaasSubscription",
  !paymentsServiceSrc.includes("BusinessSaasSubscription") &&
    !paymentsServiceSrc.includes("tbbt_saas_subscription"),
);
check(
  "Stale-event helper does not treat missing timestamps as stale",
  isStaleSaasStripeEvent(null, new Date()) === false &&
    isStaleSaasStripeEvent(new Date("2026-01-02"), new Date("2026-01-01")) === true &&
    isStaleSaasStripeEvent(new Date("2026-01-01"), new Date("2026-01-02")) === false,
);
check(
  "Invoice recovery upgrades payment_problem without resurrecting canceled",
  resolveNextSaasStatus({
    eventType: "invoice.paid",
    incomingStatus: "active",
    currentStatus: "past_due",
  }) === "active" &&
    resolveNextSaasStatus({
      eventType: "invoice.paid",
      incomingStatus: "active",
      currentStatus: "canceled",
    }) === "canceled",
);

try {
  resetSaasBillingSchemaEnsure();
  const provider = createFakeSaasBillingProvider();
  setSaasBillingProvider(provider);
  const now = new Date("2026-09-15T12:00:00.000Z");
  const trialStart = new Date(now.getTime() - TBBT_FOUNDER_TRIAL_MS - 60_000);

  console.log("\nTEST — Trial converts to an operable active subscription");
  const shop = await seedBusiness("Lifecycle Shop");
  const ownerAccess = makeAccess(shop.business.id, "OWNER", shop.membership.id, {
    email: shop.ownerUser.email,
    business: shop.business,
  });
  await startFounderTrialIfEligible(prisma, {
    businessId: shop.business.id,
    slug: shop.business.slug,
    now: trialStart,
  });
  await prisma.businessSaasSubscription.update({
    where: { businessId: shop.business.id },
    data: { trialStartedAt: trialStart, trialEndsAt: new Date(trialStart.getTime() + TBBT_FOUNDER_TRIAL_MS) },
  });
  const checkout = await startSaasSubscriptionCheckout(prisma, ownerAccess);
  const businessesBefore = await prisma.business.count();
  const saasRowsBefore = await prisma.businessSaasSubscription.count({
    where: { businessId: shop.business.id },
  });
  const appliedCheckout = await verifyAndDispatch(
    saasCheckoutEvent({
      id: "evt_life_checkout",
      created: 1_700_000_000,
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
    }),
  );
  const trialing = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_trialing",
      created: 1_700_000_050,
      type: "customer.subscription.created",
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
      status: "trialing",
    }),
  );
  const activated = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_active",
      created: 1_700_000_100,
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
      status: "active",
    }),
  );
  const activeRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: shop.business.id },
  });
  const activeEntitlement = await loadSaasEntitlement(prisma, shop.business, now);
  const activeExpense = await createExpense(prisma, ownerAccess, expenseInput("Active lumber"));
  check("Checkout webhook is applied", appliedCheckout.applied === true && appliedCheckout.system === "saas");
  check("trialing webhook is applied", trialing.applied === true);
  check("active webhook is applied", activated.applied === true);
  check(
    "trial → active subscription is subscribed_active and Founder-eligible",
    activeRow?.status === "active" &&
      activeRow?.founderEligible === true &&
      Boolean(activeRow?.founderConvertedAt) &&
      activeEntitlement.state === "subscribed_active" &&
      activeEntitlement.canOperate === true &&
      Boolean(activeExpense.id),
  );
  check(
    "Converting does not create a duplicate Business or SaaS row",
    (await prisma.business.count()) === businessesBefore &&
      (await prisma.businessSaasSubscription.count({ where: { businessId: shop.business.id } })) ===
        saasRowsBefore,
  );

  console.log("\nTEST — cancelAtPeriodEnd stays operable and displays scheduled cancellation");
  const periodEnd = 1_800_000_000;
  await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_cancel_scheduled",
      created: 1_700_000_200,
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
      status: "active",
      cancelAtPeriodEnd: true,
      periodEnd,
    }),
  );
  const scheduledRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: shop.business.id },
  });
  const scheduledEntitlement = await loadSaasEntitlement(prisma, shop.business, now);
  const scheduledSnapshot = await loadSaasBillingSnapshot(prisma, shop.business.id);
  const scheduledExpense = await createExpense(prisma, ownerAccess, expenseInput("Scheduled cancel lumber"));
  await requireSaasOperatingEntitlement(prisma, ownerAccess);
  check(
    "cancelAtPeriodEnd remains operable until actual termination",
    scheduledRow?.status === "active" &&
      scheduledRow?.cancelAtPeriodEnd === true &&
      scheduledRow?.founderEligible === true &&
      scheduledEntitlement.state === "subscribed_active" &&
      scheduledEntitlement.canOperate === true &&
      scheduledEntitlement.cancelAtPeriodEnd === true &&
      Boolean(scheduledExpense.id),
  );
  check(
    "Scheduled cancellation displays access-through date without Stripe IDs",
    scheduledSnapshot.cancelAtPeriodEnd === true &&
      scheduledSnapshot.currentPeriodEnd === new Date(periodEnd * 1000).toISOString() &&
      scheduledSnapshot.entitlement.label === "Cancellation scheduled" &&
      scheduledSnapshot.planName === "Founder Plan" &&
      scheduledSnapshot.showFounderPrice === true,
  );
  const settingsSnapshot = await loadSettingsSnapshot(prisma, shop.business.id);
  check(
    "Settings Billing snapshot redacts raw Stripe IDs",
    settingsSnapshot.saasBilling.stripeCustomerId === null &&
      settingsSnapshot.saasBilling.stripeSubscriptionId === null &&
      settingsSnapshot.saasBilling.stripePriceId === null &&
      settingsSnapshot.saasBilling.cancelAtPeriodEnd === true,
  );

  console.log("\nTEST — Reversing scheduled cancellation preserves continuous Founder eligibility");
  await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_cancel_reversed",
      created: 1_700_000_250,
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd,
    }),
  );
  const reversed = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: shop.business.id },
  });
  check(
    "Reversing scheduled cancellation keeps Founder eligibility and the same Stripe customer",
    reversed?.cancelAtPeriodEnd === false &&
      reversed?.founderEligible === true &&
      reversed?.founderEligibilityEndedAt == null &&
      reversed?.stripeCustomerId === checkout.customerId &&
      reversed?.stripeSubscriptionId === "sub_life" &&
      (await loadSaasEntitlement(prisma, shop.business, now)).state === "subscribed_active",
  );

  console.log("\nTEST — Actual termination ends paid entitlement and Founder eligibility");
  await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_deleted",
      created: 1_700_000_400,
      type: "customer.subscription.deleted",
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
      status: "canceled",
    }),
  );
  const canceled = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: shop.business.id },
  });
  const canceledEntitlement = await loadSaasEntitlement(prisma, shop.business, now);
  const retainedCustomer = await prisma.customer.create({
    data: { businessId: shop.business.id, name: "Retained Lifecycle Customer" },
  });
  check(
    "Actual cancellation ends paid entitlement",
    canceled?.status === "canceled" &&
      canceledEntitlement.state === "subscription_required" &&
      canceledEntitlement.canOperate === false,
  );
  check(
    "Actual termination ends Founder eligibility",
    canceled?.founderEligible === false && Boolean(canceled?.founderEligibilityEndedAt),
  );
  check(
    "Expired/canceled business retains records",
    (await prisma.customer.findUnique({ where: { id: retainedCustomer.id } }))?.name ===
      "Retained Lifecycle Customer" &&
      (await prisma.business.findUnique({ where: { id: shop.business.id } }))?.name === "Lifecycle Shop",
  );

  console.log("\nTEST — A later restart does not automatically restore Founder eligibility");
  const restart = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_restart",
      created: 1_700_000_500,
      type: "customer.subscription.created",
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life_restart",
      status: "active",
    }),
  );
  const restarted = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: shop.business.id },
  });
  const restartFields = founderFieldsForSubscriptionStatus({
    current: {
      founderEligible: false,
      founderConvertedAt: restarted?.founderConvertedAt ?? null,
      founderEligibilityEndedAt: restarted?.founderEligibilityEndedAt ?? null,
    },
    nextStatus: "active",
  });
  check("Restart webhook is applied on the existing tenant", restart.applied === true);
  check(
    "Restarting later does not restore Founder eligibility or duplicate the tenant",
    restarted?.status === "active" &&
      restarted?.founderEligible === false &&
      Boolean(restarted?.founderEligibilityEndedAt) &&
      restarted?.stripeCustomerId === checkout.customerId &&
      restartFields === null &&
      (await prisma.businessSaasSubscription.count({ where: { businessId: shop.business.id } })) === 1 &&
      (await loadSaasEntitlement(prisma, shop.business, now)).state === "subscribed_active",
  );

  console.log("\nTEST — Payment problems stay operable; recovery returns subscribed_active");
  const problemShop = await seedBusiness("Payment Problem Shop");
  const problemAccess = makeAccess(problemShop.business.id, "OWNER", problemShop.membership.id, {
    email: problemShop.ownerUser.email,
    business: problemShop.business,
  });
  await startFounderTrialIfEligible(prisma, {
    businessId: problemShop.business.id,
    slug: problemShop.business.slug,
    now: trialStart,
  });
  const problemCheckout = await startSaasSubscriptionCheckout(prisma, problemAccess);
  await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_problem_active",
      created: 1_700_001_000,
      businessId: problemShop.business.id,
      customerId: problemCheckout.customerId,
      subscriptionId: "sub_problem",
      status: "active",
    }),
  );
  let problemCreated = 1_700_001_100;
  for (const status of ["past_due", "unpaid", "paused"]) {
    problemCreated += 10;
    await applySaasBillingStripeEvent(
      prisma,
      saasSubscriptionEvent({
        id: `evt_problem_${status}`,
        created: problemCreated,
        type: status === "paused" ? "customer.subscription.paused" : "customer.subscription.updated",
        businessId: problemShop.business.id,
        customerId: problemCheckout.customerId,
        subscriptionId: "sub_problem",
        status,
      }),
    );
    const entitlement = await loadSaasEntitlement(prisma, problemShop.business, now);
    const snapshot = await loadSaasBillingSnapshot(prisma, problemShop.business.id);
    check(
      `${status} → payment_problem remains operable`,
      entitlement.state === "payment_problem" &&
        entitlement.canOperate === true &&
        snapshot.status === status &&
        snapshot.portalPossible === true &&
        snapshot.checkoutPossible === false,
    );
  }
  const recovered = await applySaasBillingStripeEvent(
    prisma,
    saasInvoicePaidEvent({
      id: "evt_problem_recovered",
      created: 1_700_001_400,
      businessId: problemShop.business.id,
      customerId: problemCheckout.customerId,
      subscriptionId: "sub_problem",
    }),
  );
  const recoveredRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: problemShop.business.id },
  });
  const recoveredEntitlement = await loadSaasEntitlement(prisma, problemShop.business, now);
  const recoveredSnapshot = await loadSaasBillingSnapshot(prisma, problemShop.business.id);
  const recoveredExpense = await createExpense(prisma, problemAccess, expenseInput("Recovered lumber"));
  check("invoice.paid recovery webhook is applied", recovered.applied === true);
  check(
    "Payment recovery returns subscribed_active without duplicating billing records",
    recoveredRow?.status === "active" &&
      recoveredEntitlement.state === "subscribed_active" &&
      recoveredEntitlement.canOperate === true &&
      recoveredSnapshot.entitlement.state === "subscribed_active" &&
      recoveredRow?.stripeCustomerId === problemCheckout.customerId &&
      (await prisma.businessSaasSubscription.count({ where: { businessId: problemShop.business.id } })) === 1 &&
      Boolean(recoveredExpense.id),
  );

  console.log("\nTEST — incomplete / incomplete_expired and webhook correctness");
  await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_problem_incomplete",
      created: 1_700_001_500,
      businessId: problemShop.business.id,
      customerId: problemCheckout.customerId,
      subscriptionId: "sub_problem",
      status: "incomplete",
    }),
  );
  check(
    "incomplete after an ended trial is subscription_required",
    (await loadSaasEntitlement(prisma, problemShop.business, now)).state === "subscription_required",
  );
  await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_problem_incomplete_expired",
      created: 1_700_001_600,
      businessId: problemShop.business.id,
      customerId: problemCheckout.customerId,
      subscriptionId: "sub_problem",
      status: "incomplete_expired",
    }),
  );
  check(
    "incomplete_expired is a terminated subscription",
    (await prisma.businessSaasSubscription.findUnique({ where: { businessId: problemShop.business.id } }))
      ?.status === "incomplete_expired" &&
      (await loadSaasEntitlement(prisma, problemShop.business, now)).state === "subscription_required",
  );

  const duplicate = await applyParsedSaasBillingEvent(
    prisma,
    parseSaasBillingEvent(
      saasSubscriptionEvent({
        id: "evt_life_active",
        created: 1_700_000_100,
        businessId: shop.business.id,
        customerId: checkout.customerId,
        subscriptionId: "sub_life",
        status: "past_due",
      }),
    ),
  );
  check(
    "Duplicate webhook event is idempotent",
    duplicate.reason === "already_processed" && duplicate.applied === false,
  );

  const stale = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_life_stale_past_due",
      created: 1_699_000_000,
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life_restart",
      status: "past_due",
    }),
  );
  check("Stale webhook is ignored", stale.reason === "stale_event" && stale.applied === false);
  check(
    "Stale past_due does not downgrade a newer active subscription",
    (await prisma.businessSaasSubscription.findUnique({ where: { businessId: shop.business.id } }))
      ?.status === "active",
  );

  const unknown = await applySaasBillingStripeEvent(
    prisma,
    saasSubscriptionEvent({
      id: "evt_unknown_lifecycle",
      created: 1_700_002_000,
      businessId: "biz_does_not_exist",
      customerId: "cus_unknown_life",
      subscriptionId: "sub_unknown_life",
    }),
  );
  check("Unknown Stripe customer/subscription cannot create a tenant", unknown.reason === "unknown_business");
  check(
    "Unknown Stripe data created no Business or SaaS row",
    (await prisma.business.count({ where: { id: "biz_does_not_exist" } })) === 0 &&
      (await prisma.businessSaasSubscription.count({
        where: { stripeSubscriptionId: "sub_unknown_life" },
      })) === 0,
  );
  check(
    "Connect parser ignores SaaS invoice.paid and subscription events",
    parseCheckoutPaymentEvent(saasInvoicePaidEvent({
      businessId: shop.business.id,
      customerId: checkout.customerId,
      subscriptionId: "sub_life",
    })) === null &&
      parseSaasBillingEvent(
        saasSubscriptionEvent({
          id: "evt_connect_account",
          account: "acct_connect_life",
          businessId: shop.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_life",
        }),
      ) === null,
  );

  console.log("\nTEST — OWNER Billing/Portal; MEMBER/ADMIN stay authorization-safe");
  const portal = await startSaasBillingPortal(prisma, ownerAccess);
  check("OWNER can reach Billing Portal", portal.url.includes("billing.stripe.test"));
  const memberUser = await prisma.user.create({
    data: {
      name: "Lifecycle Member",
      email: `life.member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const member = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: shop.business.id, role: "MEMBER" },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Lifecycle Admin",
      email: `life.admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const admin = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: shop.business.id, role: "ADMIN" },
  });
  try {
    await startSaasSubscriptionCheckout(
      prisma,
      makeAccess(shop.business.id, "MEMBER", member.id, { email: memberUser.email }),
    );
    check("MEMBER cannot start SaaS Checkout", false);
  } catch (error) {
    check("MEMBER cannot start SaaS Checkout", error instanceof ForbiddenError);
  }
  try {
    await startSaasBillingPortal(
      prisma,
      makeAccess(shop.business.id, "ADMIN", admin.id, { email: adminUser.email }),
    );
    check("ADMIN cannot open Billing Portal", false);
  } catch (error) {
    check("ADMIN cannot open Billing Portal", error instanceof ForbiddenError);
  }

  console.log("\nTEST — CollPro and existing tenants stay legacy_exempt");
  const existing = await seedBusiness("Existing Lifecycle Handyman", {
    websiteSetupCompletedAt: now,
  });
  const collpro = await seedBusiness("CollPro Reno Handyman Services", {
    slug: "collpro-reno",
    websiteSetupCompletedAt: now,
  });
  const customersBefore = provider.customers.size;
  const existingSnapshot = await loadSaasBillingSnapshot(prisma, existing.business.id);
  const collproSnapshot = await loadSaasBillingSnapshot(prisma, collpro.business.id);
  const collproEntitlement = await loadSaasEntitlement(prisma, collpro.business, now);
  check(
    "Existing tenants are not subscribed, trialed, or given Stripe Customers",
    existingSnapshot.status === "none" &&
      existingSnapshot.stripeCustomerId === null &&
      existingSnapshot.entitlement.state === "legacy_exempt" &&
      existingSnapshot.entitlement.canOperate === true,
  );
  check(
    "CollPro remains legacy_exempt and operational",
    collproSnapshot.status === "none" &&
      collproSnapshot.stripeCustomerId === null &&
      collproEntitlement.state === "legacy_exempt" &&
      collproEntitlement.canOperate === true,
  );
  check(
    "Loading lifecycle billing does not create Stripe Customers for exempt tenants",
    provider.customers.size === customersBefore,
  );
  check(
    "resolveSaasEntitlement still treats CollPro as exempt even with a canceled row",
    resolveSaasEntitlement({
      slug: "collpro-reno",
      row: {
        status: "canceled",
        trialStartedAt: null,
        trialEndsAt: null,
        founderEligible: false,
        founderConvertedAt: null,
        founderEligibilityEndedAt: null,
        legacyExempt: true,
      },
    }).state === "legacy_exempt",
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
    ? "\nAll SaaS subscription lifecycle checks passed."
    : `\n${failures} SaaS subscription lifecycle check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
