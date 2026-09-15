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
  loadSaasBillingSnapshot,
  parseSaasBillingEvent,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  SAAS_CHECKOUT_PURPOSE,
  setSaasBillingProvider,
  startSaasBillingPortal,
  startSaasSubscriptionCheckout,
  SaasBillingError,
} = await import("@/lib/saas-billing");
const {
  dispatchStripeWebhookEvent,
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
const saasOps = readFileSync(new URL("../src/lib/saas-billing/ops.ts", import.meta.url), "utf8");
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
const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

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
    webhookDispatchSrc.includes("system: \"saas\""),
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
    envExample.includes("customer.subscription.updated"),
);
check(
  "SaaS module does not hardcode a production dollar amount",
  !/\$\d/.test(saasDir) && !/\$\d/.test(saasOps) && !/\$\d/.test(saasEvents),
);
check(
  "SaaS events ignore Connect-account payloads",
  saasEvents.includes("Connect-account events belong to customer invoice/deposit"),
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
    "No silent Stripe subscription rows were created for existing tenants",
    (await prisma.businessSaasSubscription.count({
      where: { businessId: { in: [existing.business.id, collpro.business.id] } },
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
