/**
 * OWNER path: public signup → workspace → Founder trial → plan
 * selection → signed Stripe test subscription → cancel → export
 * access → re-entry after a failed payment.
 *
 * Uses a disposable local database and Stripe test fixtures only.
 * Does not call live Stripe or run production migrate.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-owner-signup-billing-path.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { withDisposableTestDatabase } from "./disposable-test-database.mjs";
import {
  applySaasStripeTestEnv,
  dispatchSignedSaasStripeFixture,
  rememberFakeSubscription,
  saasCheckoutCompletedFixture,
  saasInvoicePaidFixture,
  saasSubscriptionFixture,
  STRIPE_TEST_FOUNDER_PRICE_ID,
} from "./fixtures/saas-stripe-test.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

applySaasStripeTestEnv();

const { provisionNewOwnerWithFounderTrial } = await import("@/lib/public-signup-handoff");
const {
  completeFirstRunSetupOp,
  ensureFirstRunSetupSchema,
  postAuthenticationPath,
  resetFirstRunSetupSchemaEnsure,
} = await import("@/lib/first-run-setup");
const {
  ensureStarterServicesSetupSchema,
  installOnboardingStarterServicesOp,
  resetStarterServicesSetupSchemaEnsure,
} = await import("@/lib/starter-services-setup");
const {
  ensureWebsiteSetupSchema,
  resetWebsiteSetupSchemaEnsure,
  skipWebsiteSetupOp,
} = await import("@/lib/website-setup");
const { DEFAULT_TRADE } = await import("@/lib/trades");
const { ForbiddenError } = await import("@/lib/authorization");
const { createExpense } = await import("@/lib/expense-ops");
const { createFakeSaasBillingProvider } = await import("@/lib/saas-billing/fake");
const {
  loadSaasBillingSnapshot,
  loadSaasEntitlement,
  requireSaasOperatingEntitlement,
  resetSaasBillingProvider,
  resetSaasBillingSchemaEnsure,
  SaasSubscriptionRequiredError,
  setSaasBillingProvider,
  startSaasBillingPortal,
  startSaasSubscriptionCheckout,
  TBBT_FOUNDER_TRIAL_MS,
} = await import("@/lib/saas-billing");
const { loadProductEntitlement } = await import("@/lib/product-entitlements");
const { PLAN_CODES, PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");
const {
  buildCustomerRecordsExport,
  recordCustomerRecordsExportAudit,
} = await import("@/lib/customer-records-export");
const { buildBusinessExportZip } = await import("@/lib/business-export");
const { loadSettingsSnapshot } = await import("@/lib/settings-data");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the OWNER signup billing path check.");
  process.exit(1);
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function makeAccess(business, membership, ownerUser, role = "OWNER") {
  return {
    businessId: business.id,
    workspace: {
      role,
      membership: { id: membership.id, userId: ownerUser.id },
      user: { id: ownerUser.id, email: ownerUser.email, name: ownerUser.name },
      business: {
        id: business.id,
        slug: business.slug,
        tradeCode: business.tradeCode ?? DEFAULT_TRADE,
        name: business.name,
      },
    },
    scope: { businessId: business.id },
    assertOwned(record) {
      if (!record || record.businessId !== business.id) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function expenseInput(description) {
  return {
    occurredOn: "2026-09-01",
    description,
    amount: "25.00",
    category: "MATERIALS",
  };
}

const authSrc = readRepo("src/app/actions/auth.ts");
const handoffSrc = readRepo("src/lib/public-signup-handoff.ts");
const enforceSrc = readRepo("src/lib/saas-billing/enforce.ts");
const entitlementSrc = readRepo("src/lib/saas-billing/entitlement.ts");
const exportRouteSrc = readRepo("src/app/(app)/customers/records-export/download/route.ts");
const exportPageSrc = readRepo("src/app/(app)/customers/records-export/page.tsx");
const settingsExportSrc = readRepo("src/app/(app)/settings/export/route.ts");
const settingsWorkspaceSrc = readRepo("src/components/settings/settings-workspace.tsx");
const billingButtonsSrc = readRepo("src/components/settings/saas-billing-buttons.tsx");
const billingActionSrc = readRepo("src/app/actions/saas-billing.ts");
const layoutSrc = readRepo("src/app/(app)/layout.tsx");
const packageSrc = readRepo("package.json");
const fixtureSrc = readRepo("scripts/fixtures/saas-stripe-test.mjs");
const checkSrc = readRepo("scripts/check-owner-signup-billing-path.mjs");

console.log("\nSTATIC — Signup, plan selection, exports, and test fixtures stay off live Stripe");
check(
  "Public signup provisions one OWNER workspace and starts the local Founder trial",
  authSrc.includes("provisionNewOwnerWithFounderTrial") &&
    handoffSrc.includes("provisionOwnerWorkspace") &&
    handoffSrc.includes("startFounderTrialIfEligible") &&
    !handoffSrc.includes("startSaasSubscriptionCheckout") &&
    !authSrc.includes("startSaasSubscriptionCheckout"),
);
check(
  "OWNER plan selection posts a server-owned planCode into Checkout",
  billingButtonsSrc.includes('name="planCode"') &&
    billingButtonsSrc.includes('planCode = "FOUNDER"') &&
    billingActionSrc.includes("startSaasSubscriptionCheckout") &&
    billingActionSrc.includes("planCode") &&
    settingsWorkspaceSrc.includes('SaasSubscribeButton planCode="FOUNDER"'),
);
check(
  "Cancellation and export stay outside the operating-write gate",
  enforceSrc.includes("data export") &&
    entitlementSrc.includes("data export") &&
    exportRouteSrc.includes("requireBusinessAccess") &&
    !exportRouteSrc.includes("requireOperatingBusinessAccess") &&
    exportPageSrc.includes("requireManagementPageAccess") &&
    !exportPageSrc.includes("requireOperatingBusinessAccess") &&
    settingsExportSrc.includes("requireBusinessAccess") &&
    !settingsExportSrc.includes("requireOperatingBusinessAccess") &&
    settingsWorkspaceSrc.includes("Cancellation never deletes them") &&
    layoutSrc.includes("SaasEntitlementBanner") &&
    !layoutSrc.includes('redirect("/settings?section=tbbt-billing")'),
);
check(
  "This proof uses the disposable DB harness and Stripe test fixtures only",
  packageSrc.includes("test:owner-signup-billing-path") &&
    checkSrc.includes("withDisposableTestDatabase") &&
    checkSrc.includes("dispatchSignedSaasStripeFixture") &&
    fixtureSrc.includes("sk_test_") &&
    fixtureSrc.includes("generateTestHeaderString") &&
    fixtureSrc.includes('export const SAAS_CHECKOUT_PURPOSE = "tbbt_saas_subscription"') &&
    !fixtureSrc.includes("sk_live_") &&
    !checkSrc.includes("sk_live_"),
);

const provider = createFakeSaasBillingProvider();
setSaasBillingProvider(provider);

try {
  await withDisposableTestDatabase(
    {
      databaseUrl: baseUrl,
      namePrefix: "tbbt_owner_signup_billing",
      pushSchema: true,
      setProcessEnv: true,
    },
    async (session) => {
      const prisma = session.prisma;
      resetFirstRunSetupSchemaEnsure();
      resetStarterServicesSetupSchemaEnsure();
      resetWebsiteSetupSchemaEnsure();
      resetSaasBillingSchemaEnsure();
      await ensureFirstRunSetupSchema(prisma);
      await ensureStarterServicesSetupSchema(prisma);
      await ensureWebsiteSetupSchema(prisma);

      const now = new Date("2026-09-20T12:00:00.000Z");
      const passwordHash = await bcrypt.hash("password12", 10);

      console.log("\nTEST — Signup creates one tenant, one OWNER, and a card-free Founder trial");
      const signup = await provisionNewOwnerWithFounderTrial(prisma, {
        name: "Path Owner",
        email: `owner-path-${randomUUID().slice(0, 8)}@example.com`,
        passwordHash,
        businessName: "Path Handyman",
        now,
      });
      const ownerAccess = makeAccess(signup.business, signup.membership, signup.user);
      const businesses = await prisma.business.findMany({
        where: { memberships: { some: { userId: signup.user.id } } },
      });
      const memberships = await prisma.membership.findMany({
        where: { userId: signup.user.id },
      });
      const trialRow = await prisma.businessSaasSubscription.findUnique({
        where: { businessId: signup.business.id },
      });
      const trialEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const trialProduct = await loadProductEntitlement(prisma, signup.business.id);
      check(
        "Signup creates exactly one Business and one OWNER membership",
        businesses.length === 1 &&
          memberships.length === 1 &&
          memberships[0].role === "OWNER" &&
          memberships[0].active === true &&
          signup.nextPath === "/setup" &&
          signup.business.tradeCode === DEFAULT_TRADE,
      );
      check(
        "Founder trial starts once without a Stripe customer or Checkout",
        signup.trial.started === true &&
          trialRow?.status === "none" &&
          trialRow?.founderEligible === true &&
          trialRow?.stripeCustomerId == null &&
          trialRow?.stripeSubscriptionId == null &&
          trialEntitlement.state === "trial_active" &&
          trialEntitlement.canOperate === true &&
          trialProduct.planCode === PLAN_CODES.FOUNDER &&
          trialProduct.capabilities.includes(PRODUCT_CAPABILITIES.CRM) &&
          provider.customers.size === 0,
      );

      await completeFirstRunSetupOp(prisma, ownerAccess, {
        name: "Path Handyman",
        phone: "555-222-3333",
        email: "shop@path.example",
        website: "",
      });
      await installOnboardingStarterServicesOp(prisma, ownerAccess);
      await skipWebsiteSetupOp(prisma, ownerAccess);
      const afterSetup = await prisma.business.findUnique({ where: { id: signup.business.id } });
      check(
        "Workspace setup reuses the signup tenant and reaches the operating dashboard",
        afterSetup?.firstRunSetupCompletedAt instanceof Date &&
          afterSetup?.starterServicesSetupCompletedAt instanceof Date &&
          afterSetup?.websiteSetupCompletedAt instanceof Date &&
          postAuthenticationPath({ role: "OWNER", business: afterSetup }) === "/dashboard" &&
          (await prisma.business.count()) === 1 &&
          (await prisma.businessSaasSubscription.count({
            where: { businessId: signup.business.id },
          })) === 1,
      );

      const retainedCustomer = await prisma.customer.create({
        data: { businessId: signup.business.id, name: "Retained Path Customer" },
      });
      const trialExpense = await createExpense(
        prisma,
        ownerAccess,
        expenseInput("Trial lumber"),
      );
      check("Trial OWNER can create operating records", Boolean(trialExpense.id));

      console.log("\nTEST — Plan selection starts Founder Checkout; Stripe test webhooks subscribe the same tenant");
      const checkout = await startSaasSubscriptionCheckout(prisma, ownerAccess, {
        planCode: PLAN_CODES.FOUNDER,
      });
      const checkoutStarted = provider.checkouts.at(-1);
      check(
        "OWNER Founder plan selection opens test Checkout without marking the tenant subscribed",
        checkout.url.includes("checkout.stripe.test") &&
          checkoutStarted?.priceId === STRIPE_TEST_FOUNDER_PRICE_ID &&
          checkoutStarted?.planCode === "tbbt_founder" &&
          checkoutStarted?.mode === "subscription" &&
          (await prisma.businessSaasSubscription.findUnique({
            where: { businessId: signup.business.id },
          }))?.status === "none",
      );

      const businessesBeforeWebhooks = await prisma.business.count();
      const appliedCheckout = await dispatchSignedSaasStripeFixture(
        prisma,
        saasCheckoutCompletedFixture({
          id: "evt_owner_checkout",
          created: 1_700_000_000,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_path",
          sessionId: checkout.checkoutSessionId,
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_path",
        customerId: checkout.customerId,
        status: "incomplete",
      });
      const appliedCreated = await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_created",
          created: 1_700_000_050,
          type: "customer.subscription.created",
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_path",
          status: "trialing",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_path",
        customerId: checkout.customerId,
        status: "trialing",
      });
      const appliedActive = await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_active",
          created: 1_700_000_100,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_path",
          status: "active",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_path",
        customerId: checkout.customerId,
        status: "active",
      });
      const activeRow = await prisma.businessSaasSubscription.findUnique({
        where: { businessId: signup.business.id },
      });
      const activeEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const activeProduct = await loadProductEntitlement(prisma, signup.business.id);
      const activeSnapshot = await loadSaasBillingSnapshot(prisma, signup.business.id);
      check(
        "Signed Stripe test webhooks subscribe the existing tenant",
        appliedCheckout.applied === true &&
          appliedCheckout.system === "saas" &&
          appliedCreated.applied === true &&
          appliedActive.applied === true &&
          activeRow?.status === "active" &&
          activeRow?.planCode === PLAN_CODES.FOUNDER &&
          activeRow?.founderEligible === true &&
          Boolean(activeRow?.founderConvertedAt) &&
          activeEntitlement.state === "subscribed_active" &&
          activeEntitlement.canOperate === true &&
          activeProduct.planCode === PLAN_CODES.FOUNDER &&
          activeSnapshot.catalogPlanCode === PLAN_CODES.FOUNDER &&
          (await prisma.business.count()) === businessesBeforeWebhooks &&
          (await prisma.businessSaasSubscription.count({
            where: { businessId: signup.business.id },
          })) === 1,
      );

      const duplicate = await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_active",
          created: 1_700_000_100,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_path",
          status: "past_due",
        }),
      );
      check(
        "Duplicate signed webhook is idempotent and does not downgrade entitlements",
        duplicate.applied === false &&
          duplicate.reason === "already_processed" &&
          (await prisma.businessSaasSubscription.findUnique({
            where: { businessId: signup.business.id },
          }))?.status === "active" &&
          (await loadSaasEntitlement(prisma, signup.business, now)).state === "subscribed_active",
      );

      const unknown = await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_unknown",
          created: 1_700_000_150,
          businessId: "biz_does_not_exist",
          customerId: "cus_unknown_owner",
          subscriptionId: "sub_unknown_owner",
        }),
      );
      check(
        "Unknown Stripe customer cannot create a tenant",
        unknown.reason === "unknown_business" &&
          (await prisma.business.count({ where: { id: "biz_does_not_exist" } })) === 0 &&
          (await prisma.businessSaasSubscription.count({
            where: { stripeSubscriptionId: "sub_unknown_owner" },
          })) === 0,
      );

      console.log("\nTEST — Scheduled cancel keeps access; actual cancel keeps records and exports");
      await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_cancel_scheduled",
          created: 1_700_000_200,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_path",
          status: "active",
          cancelAtPeriodEnd: true,
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_path",
        customerId: checkout.customerId,
        status: "active",
        cancelAtPeriodEnd: true,
      });
      const scheduledEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const scheduledExport = await buildCustomerRecordsExport(prisma, ownerAccess);
      const scheduledZip = await buildBusinessExportZip(prisma, signup.business.id);
      await requireSaasOperatingEntitlement(prisma, ownerAccess);
      check(
        "cancelAtPeriodEnd stays operable and exportable",
        scheduledEntitlement.state === "subscribed_active" &&
          scheduledEntitlement.canOperate === true &&
          scheduledEntitlement.cancelAtPeriodEnd === true &&
          scheduledExport.customers.some((row) => row.customer.name === "Retained Path Customer") &&
          scheduledZip.bytes.includes(Buffer.from("Retained Path Customer")),
      );

      await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_deleted",
          created: 1_700_000_300,
          type: "customer.subscription.deleted",
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_path",
          status: "canceled",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_path",
        customerId: checkout.customerId,
        status: "canceled",
        cancelAtPeriodEnd: false,
      });
      const canceledRow = await prisma.businessSaasSubscription.findUnique({
        where: { businessId: signup.business.id },
      });
      const canceledEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const canceledSnapshot = await loadSaasBillingSnapshot(prisma, signup.business.id);
      const settingsSnapshot = await loadSettingsSnapshot(prisma, signup.business.id);
      const canceledRecords = await buildCustomerRecordsExport(prisma, ownerAccess);
      const canceledAudit = await recordCustomerRecordsExportAudit(
        prisma,
        ownerAccess,
        canceledRecords,
      );
      const canceledZip = await buildBusinessExportZip(prisma, signup.business.id);
      let operateBlocked = false;
      try {
        await createExpense(prisma, ownerAccess, expenseInput("Should not write"));
      } catch (error) {
        operateBlocked = error instanceof SaasSubscriptionRequiredError;
      }
      check(
        "Actual cancellation ends operating writes but does not trap records or exports",
        canceledRow?.status === "canceled" &&
          canceledRow?.founderEligible === false &&
          canceledEntitlement.state === "subscription_required" &&
          canceledEntitlement.canOperate === false &&
          canceledSnapshot.checkoutPossible === true &&
          settingsSnapshot.customers.some((row) => row.name === "Retained Path Customer") &&
          canceledRecords.customers.some((row) => row.customer.id === retainedCustomer.id) &&
          canceledAudit.settingArea === "data-export" &&
          canceledZip.bytes.includes(Buffer.from("Retained Path Customer")) &&
          (await prisma.customer.findUnique({ where: { id: retainedCustomer.id } }))?.name ===
            "Retained Path Customer" &&
          operateBlocked,
      );

      console.log("\nTEST — Re-entry after a failed payment recovers on the same tenant");
      const reentryCheckout = await startSaasSubscriptionCheckout(prisma, ownerAccess, {
        planCode: PLAN_CODES.FOUNDER,
      });
      check(
        "Canceled OWNER can start Founder Checkout again on the same Stripe customer",
        reentryCheckout.customerId === checkout.customerId &&
          reentryCheckout.url.includes("checkout.stripe.test") &&
          (await prisma.business.count()) === 1,
      );

      await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_reentry_incomplete",
          created: 1_700_000_400,
          type: "customer.subscription.created",
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_reentry",
          status: "incomplete",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_reentry",
        customerId: checkout.customerId,
        status: "incomplete",
      });
      const incompleteEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const retryAfterFail = await startSaasSubscriptionCheckout(prisma, ownerAccess, {
        planCode: PLAN_CODES.FOUNDER,
      });
      check(
        "Failed first payment stays subscription_required and still allows Checkout retry",
        incompleteEntitlement.state === "subscription_required" &&
          incompleteEntitlement.canOperate === false &&
          retryAfterFail.url.includes("checkout.stripe.test") &&
          (await prisma.customer.findUnique({ where: { id: retainedCustomer.id } })) != null,
      );

      await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_reentry_active",
          created: 1_700_000_500,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_reentry",
          status: "active",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_reentry",
        customerId: checkout.customerId,
        status: "active",
      });
      await dispatchSignedSaasStripeFixture(
        prisma,
        saasSubscriptionFixture({
          id: "evt_owner_reentry_past_due",
          created: 1_700_000_600,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_reentry",
          status: "past_due",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_reentry",
        customerId: checkout.customerId,
        status: "past_due",
      });
      const problemEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const problemSnapshot = await loadSaasBillingSnapshot(prisma, signup.business.id);
      const portal = await startSaasBillingPortal(prisma, ownerAccess);
      const problemExport = await buildCustomerRecordsExport(prisma, ownerAccess);
      let secondCheckoutBlocked = false;
      try {
        await startSaasSubscriptionCheckout(prisma, ownerAccess, { planCode: PLAN_CODES.FOUNDER });
      } catch (error) {
        secondCheckoutBlocked = /already has a TBBT subscription/.test(error.message);
      }
      check(
        "past_due stays operable, exportable, and recovers through Billing Portal rather than a second Checkout",
        problemEntitlement.state === "payment_problem" &&
          problemEntitlement.canOperate === true &&
          problemSnapshot.portalPossible === true &&
          problemSnapshot.checkoutPossible === false &&
          portal.url.includes("billing.stripe.test") &&
          problemExport.customers.some((row) => row.customer.name === "Retained Path Customer") &&
          secondCheckoutBlocked,
      );

      const recovered = await dispatchSignedSaasStripeFixture(
        prisma,
        saasInvoicePaidFixture({
          id: "evt_owner_reentry_paid",
          created: 1_700_000_700,
          businessId: signup.business.id,
          customerId: checkout.customerId,
          subscriptionId: "sub_owner_reentry",
        }),
      );
      rememberFakeSubscription(provider, {
        subscriptionId: "sub_owner_reentry",
        customerId: checkout.customerId,
        status: "active",
      });
      const recoveredRow = await prisma.businessSaasSubscription.findUnique({
        where: { businessId: signup.business.id },
      });
      const recoveredEntitlement = await loadSaasEntitlement(prisma, signup.business, now);
      const recoveredExpense = await createExpense(
        prisma,
        ownerAccess,
        expenseInput("Recovered lumber"),
      );
      check(
        "invoice.paid recovery returns subscribed_active without duplicating the tenant",
        recovered.applied === true &&
          recoveredRow?.status === "active" &&
          recoveredRow?.stripeCustomerId === checkout.customerId &&
          recoveredRow?.founderEligible === false &&
          recoveredEntitlement.state === "subscribed_active" &&
          recoveredEntitlement.canOperate === true &&
          Boolean(recoveredExpense.id) &&
          (await prisma.business.count()) === 1 &&
          (await prisma.businessSaasSubscription.count({
            where: { businessId: signup.business.id },
          })) === 1,
      );

      const memberUser = await prisma.user.create({
        data: {
          name: "Path Member",
          email: `path.member.${randomUUID().slice(0, 8)}@example.com`,
          passwordHash,
        },
      });
      const member = await prisma.membership.create({
        data: { userId: memberUser.id, businessId: signup.business.id, role: "MEMBER" },
      });
      const memberAccess = makeAccess(signup.business, member, memberUser, "MEMBER");
      let memberCheckoutBlocked = false;
      try {
        await startSaasSubscriptionCheckout(prisma, memberAccess, { planCode: PLAN_CODES.FOUNDER });
      } catch (error) {
        memberCheckoutBlocked = error instanceof ForbiddenError;
      }
      let memberExportBlocked = false;
      try {
        await buildCustomerRecordsExport(prisma, memberAccess);
      } catch (error) {
        memberExportBlocked = error instanceof ForbiddenError;
      }
      check(
        "MEMBER cannot start Checkout or export customer records",
        memberCheckoutBlocked && memberExportBlocked,
      );
    },
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  resetSaasBillingProvider();
}

if (failures > 0) {
  console.error(`\nOWNER signup billing path check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll OWNER signup billing path checks passed.");
