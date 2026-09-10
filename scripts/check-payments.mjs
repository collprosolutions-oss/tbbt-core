/**
 * Focused verification for Phase 1 customer electronic payment:
 * per-business Stripe Connect, Pay Invoice, webhook PAID, manual Mark Paid.
 *
 * Uses a fake payment provider. Does not require live Stripe credentials.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-payments.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, requireBusinessCapability, CAPABILITIES } =
  await import("@/lib/authorization");
const { isPaymentMethodValue, paymentMethodLabel, PAYMENT_METHODS } =
  await import("@/lib/invoice-payment");
const { invoiceAmountDue } = await import("@/lib/invoice-document");
const { createFakePaymentProvider } = await import("@/lib/payments/fake");
const { parseCheckoutPaymentEvent } = await import("@/lib/payments/events");
const {
  explainMerchantReadiness,
  isMerchantPaymentReady,
  shouldOfferStripeOnboarding,
} = await import("@/lib/payments/readiness");
const { invoiceAmountToCents, invoiceDueCents, payDepositButtonLabel, payInvoiceButtonLabel } = await import("@/lib/payments/money");
const { INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES } = await import(
  "@/lib/payments/stripe-adapter"
);
const {
  applyVerifiedCheckoutPayment,
  createCustomerInvoiceCheckout,
  getBusinessPaymentStatus,
  PaymentError,
  reconcileProjectTokenCheckoutPayment,
  reconcileStripeCheckoutPayment,
  shouldShowPayDeposit,
  shouldShowPayInvoice,
  startStripeConnectOnboarding,
} = await import("@/lib/payments/service");
const {
  isUnknownConnectedAccountError,
  redactStripeText,
  redactedStripeErrorMessage,
  shouldFallBackToV1AccountLink,
  stripeConnectOnboardingFailureMessage,
} = await import("@/lib/payments/stripe-errors");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_payments_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;
process.env.NEXT_PUBLIC_APP_URL = "http://payments.test";

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for payments test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function checkoutEvent(input) {
  return {
    type: input.type ?? "checkout.session.completed",
    account: input.account,
    data: {
      object: {
        object: "checkout.session",
        id: input.sessionId ?? "cs_test_1",
        payment_status: input.paymentStatus ?? "paid",
        amount_total: input.amountCents,
        currency: input.currency ?? "usd",
        payment_intent: input.paymentIntent ?? "pi_test_1",
        metadata: {
          invoiceId: input.invoiceId,
          estimateId: input.estimateId,
          purpose: input.purpose ?? "invoice_balance",
          businessId: input.businessId,
          ...(input.connectedAccountId
            ? { connectedAccountId: input.connectedAccountId }
            : {}),
        },
      },
    },
  };
}

async function seedBusiness(name) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}` },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${name} Customer` },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: "10 Payment Ave",
    },
  });
  return { business, membership, customer, property, ownerUser };
}

async function seedSentInvoice(input) {
  const token = randomUUID();
  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "COMPLETED",
      projectToken: token,
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      jobId: job.id,
      status: "SENT",
      total: new Prisma.Decimal(input.total),
    },
  });
  return { job, invoice, token };
}

try {
  console.log("\nSTATIC — Vocabulary, helpers, and source contracts");
  check("manual methods still include cash/check/Zelle/external/other", {
    CASH: true,
    CHECK: true,
    ZELLE_BANK_TRANSFER: true,
    CARD_EXTERNAL: true,
    OTHER: true,
  } && PAYMENT_METHODS.every((method) => isPaymentMethodValue(method.value)));
  check("STRIPE is not a manual Mark Paid method", !isPaymentMethodValue("STRIPE"));
  check("STRIPE label is Card (Stripe)", paymentMethodLabel("STRIPE") === "Card (Stripe)");
  check(
    "Pay Invoice hidden without a ready account",
    shouldShowPayInvoice({ invoiceStatus: "SENT", amountDueCents: 37500, paymentReady: false, appUrlConfigured: true }) === false,
  );
  check(
    "Pay Invoice hidden when already PAID",
    shouldShowPayInvoice({ invoiceStatus: "PAID", amountDueCents: 0, paymentReady: true, appUrlConfigured: true }) === false,
  );
  check(
    "Pay Invoice shown only for SENT + due + ready + app URL",
    shouldShowPayInvoice({ invoiceStatus: "SENT", amountDueCents: 37500, paymentReady: true, appUrlConfigured: true }) === true,
  );
  check(
    "Pay Invoice hidden when app URL is missing even if Stripe is ready",
    shouldShowPayInvoice({ invoiceStatus: "SENT", amountDueCents: 37500, paymentReady: true, appUrlConfigured: false }) === false,
  );
  check(
    "Pay Invoice button label includes the server-formatted amount",
    payInvoiceButtonLabel("$300.00") === "Pay Invoice — $300.00",
  );
  check(
    "Pay Deposit button labels cover unpaid and remaining",
    payDepositButtonLabel("$200.00") === "Pay $200.00 Material Deposit" &&
      payDepositButtonLabel("$100.00", true) === "Pay Remaining Deposit",
  );
  check(
    "Pay Deposit is hidden when remaining is 0 or an invoice is already customer-visible",
    shouldShowPayDeposit({
      requiredCents: 20000,
      remainingCents: 20000,
      paymentReady: true,
      appUrlConfigured: true,
      hasCustomerInvoice: false,
    }) &&
      !shouldShowPayDeposit({
        requiredCents: 20000,
        remainingCents: 0,
        paymentReady: true,
        appUrlConfigured: true,
        hasCustomerInvoice: false,
      }) &&
      !shouldShowPayDeposit({
        requiredCents: 20000,
        remainingCents: 20000,
        paymentReady: true,
        appUrlConfigured: true,
        hasCustomerInvoice: true,
      }) &&
      !shouldShowPayDeposit({
        requiredCents: 20000,
        remainingCents: 20000,
        paymentReady: true,
        appUrlConfigured: false,
        hasCustomerInvoice: false,
      }),
  );
  check(
    "v2 card_payments active is payment-ready",
    isMerchantPaymentReady({ cardPaymentsStatus: "active" }) === true,
  );
  check(
    "no capability is not payment-ready",
    isMerchantPaymentReady({ cardPaymentsStatus: null }) === false,
  );
  check(
    "unsupported capability is not payment-ready",
    isMerchantPaymentReady({ cardPaymentsStatus: "unsupported" }) === false,
  );
  check(
    "pending with no user-owed requirements is payment-ready",
    isMerchantPaymentReady({ cardPaymentsStatus: "pending" }) === true,
  );
  check(
    "pending with user currently_due requirements stays Setup Required",
    isMerchantPaymentReady({
      cardPaymentsStatus: "pending",
      requirementEntries: [
        { awaiting_action_from: "user", minimum_deadline: { status: "currently_due" } },
      ],
    }) === false,
  );
  check(
    "restricted pending-verification with no user action is payment-ready",
    isMerchantPaymentReady({
      cardPaymentsStatus: "restricted",
      cardPaymentsStatusDetails: [
        { code: "requirements_pending_verification", resolution: "no_resolution" },
      ],
    }) === true,
  );
  check(
    "restricted past-due / provide_info stays Setup Required",
    isMerchantPaymentReady({
      cardPaymentsStatus: "restricted",
      cardPaymentsStatusDetails: [
        { code: "requirements_past_due", resolution: "provide_info" },
      ],
    }) === false,
  );
  check(
    "v1 charges_enabled is payment-ready even if v2 status has not flipped to active",
    isMerchantPaymentReady({
      cardPaymentsStatus: "pending",
      v1ChargesEnabled: true,
    }) === true,
  );
  check(
    "restricted pending_verification code is ready even if resolution is provide_info",
    explainMerchantReadiness({
      cardPaymentsStatus: "restricted",
      cardPaymentsStatusDetails: [
        { code: "requirements_pending_verification", resolution: "provide_info" },
      ],
    }).branch === "v2_restricted_pending_verification",
  );
  check(
    "details_submitted with empty currently_due and past_due is ready",
    explainMerchantReadiness({
      detailsSubmitted: true,
      currentlyDueKeys: [],
      pastDueKeys: [],
      pendingVerificationKeys: [],
    }).branch === "v1_submitted_no_outstanding",
  );
  check(
    "currently_due keys stay Setup Required",
    explainMerchantReadiness({
      detailsSubmitted: true,
      currentlyDueKeys: ["external_account"],
      pastDueKeys: [],
    }).branch === "user_currently_due",
  );
  check(
    "pending_verification with no outstanding due is ready",
    explainMerchantReadiness({
      detailsSubmitted: true,
      currentlyDueKeys: [],
      pastDueKeys: [],
      pendingVerificationKeys: ["individual.verification.document"],
    }).branch === "v1_submitted_no_outstanding",
  );
  check(
    "v1 disabled_reason pending_verification with no outstanding due is ready",
    explainMerchantReadiness({
      currentlyDueKeys: [],
      pastDueKeys: [],
      disabledReason: "requirements.pending_verification",
    }).branch === "v1_pending_verification_no_outstanding",
  );
  check(
    "Continue Stripe Setup is offered while Setup Required unless Stripe says unsupported",
    shouldOfferStripeOnboarding("setup_required", "v1_submitted_no_outstanding") === true &&
      shouldOfferStripeOnboarding("setup_required", "retrieve_failed") === true &&
      shouldOfferStripeOnboarding("setup_required", "not_ready") === true &&
      shouldOfferStripeOnboarding("setup_required", "user_currently_due") === true &&
      shouldOfferStripeOnboarding("connected", "v1_charges_enabled") === false &&
      shouldOfferStripeOnboarding("setup_required", "unsupported") === false,
  );

  const v2Missing = Object.assign(new Error("No such account: 'acct_TESTLEAK123'"), {
    type: "StripeInvalidRequestError",
    code: "not_found",
    statusCode: 404,
    param: "account",
    requestId: "req_abc",
  });
  const v1Missing = Object.assign(new Error("No such account: 'acct_TESTLEAK123'"), {
    type: "StripeInvalidRequestError",
    code: "resource_missing",
    statusCode: 400,
    param: "account",
  });
  const modeMismatch = Object.assign(
    new Error("No such account: a similar object exists in test mode, but a live mode key was used to make this request."),
    { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 400 },
  );
  const v2Blocked = Object.assign(new Error("Accounts v2 is not enabled for your platform."), {
    type: "StripeInvalidRequestError",
    code: "accounts_v2_access_blocked",
    statusCode: 400,
  });
  const v2Forbidden = Object.assign(
    new Error("The provided key does not have permission to complete this request."),
    {
      type: "StripePermissionError",
      code: "forbidden",
      statusCode: 403,
      requestId: "req_test_forbidden",
      param: null,
    },
  );
  check("v2 Account Link 404 not_found is a stale connected account", isUnknownConnectedAccountError(v2Missing) === true);
  check("v1 resource_missing is a stale connected account", isUnknownConnectedAccountError(v1Missing) === true);
  check("test/live mode mismatch is a stale connected account", isUnknownConnectedAccountError(modeMismatch) === true);
  check(
    "Accounts v2 blocked is not treated as a stale account to replace",
    isUnknownConnectedAccountError(v2Blocked) === false,
  );
  check(
    "v2 Account Link forbidden is not treated as a stale account to replace",
    isUnknownConnectedAccountError(v2Forbidden) === false,
  );
  check(
    "v2 Account Link forbidden falls back to GA v1 Account Links",
    shouldFallBackToV1AccountLink(v2Forbidden) === true &&
      shouldFallBackToV1AccountLink(v2Blocked) === true &&
      shouldFallBackToV1AccountLink({ type: "StripePermissionError", statusCode: 403 }) === true,
  );
  check(
    "missing connected account does not fall back to v1 Account Links",
    shouldFallBackToV1AccountLink(v2Missing) === false &&
      shouldFallBackToV1AccountLink(v1Missing) === false,
  );
  check(
    "owner-facing onboarding error includes the Stripe code and redacts account ids",
    stripeConnectOnboardingFailureMessage(v2Missing) ===
      "Stripe onboarding could not be started. (not_found)" &&
      !redactStripeText("No such account: 'acct_TESTLEAK123'").includes("acct_TESTLEAK123"),
  );
  check(
    "Accounts v2 blocked tells the owner to enable it on the platform",
    stripeConnectOnboardingFailureMessage(v2Blocked).includes("Accounts v2"),
  );
  check(
    "forbidden owner message explains platform key permission without leaking account ids",
    stripeConnectOnboardingFailureMessage(v2Forbidden).includes("platform") &&
      !stripeConnectOnboardingFailureMessage(v2Forbidden).includes("acct_"),
  );
  const v1InvalidNoCode = Object.assign(
    new Error("You cannot create Account Links for this account: 'acct_TESTLEAK123'."),
    {
      type: "StripeInvalidRequestError",
      rawType: "invalid_request_error",
      statusCode: 400,
      param: "type",
      requestId: "req_test_invalid",
    },
  );
  check(
    "v1 Account Link without a Stripe code is not treated as a stale account",
    isUnknownConnectedAccountError(v1InvalidNoCode) === false,
  );
  check(
    "owner-facing onboarding error without a Stripe code includes type, param, and status",
    stripeConnectOnboardingFailureMessage(v1InvalidNoCode) ===
      "Stripe onboarding could not be started. (StripeInvalidRequestError / param=type / status=400)",
  );
  check(
    "onboarding log message redacts connected-account ids",
    redactedStripeErrorMessage(v1InvalidNoCode) ===
      "You cannot create Account Links for this account: '[redacted]'.",
  );
  check("375.00 becomes 37500 cents", invoiceAmountToCents(new Prisma.Decimal("375.00")) === 37500);
  check(
    "SENT amount due is the full total",
    invoiceDueCents("SENT", new Prisma.Decimal("375.00")) === 37500,
  );
  check(
    "PAID amount due is 0",
    invoiceAmountDue("PAID", new Prisma.Decimal("375.00")).toString() === "0",
  );

  const portalSrc = readFileSync(new URL("../src/app/p/[token]/page.tsx", import.meta.url), "utf8");
  const payRouteSrc = readFileSync(new URL("../src/app/p/[token]/pay/route.ts", import.meta.url), "utf8");
  const webhookSrc = readFileSync(new URL("../src/app/api/stripe/webhook/route.ts", import.meta.url), "utf8");
  const adapterSrc = readFileSync(new URL("../src/lib/payments/stripe-adapter.ts", import.meta.url), "utf8");
  const settingsSrc = readFileSync(
    new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
    "utf8",
  );
  check("adapter uses explainMerchantReadiness", adapterSrc.includes("explainMerchantReadiness"));
  check("adapter falls back to v1 retrieve if v2 fails", adapterSrc.includes("stripe.accounts.retrieve"));
  check(
    "adapter falls back to v1 Account Links when v2 returns forbidden",
    adapterSrc.includes("shouldFallBackToV1AccountLink") &&
      adapterSrc.includes("v2.core.accountLinks.create") &&
      adapterSrc.includes("stripe.accountLinks.create") &&
      adapterSrc.includes('operation: "v2.core.accountLinks.create"') &&
      adapterSrc.includes('operation: "v1.accountLinks.create"'),
  );
  check("adapter retrieves requirements with merchant config", adapterSrc.includes('"requirements"'));
  const serviceSrc = readFileSync(new URL("../src/lib/payments/service.ts", import.meta.url), "utf8");
  const payButtonSrc = readFileSync(
    new URL("../src/components/portal/pay-invoice-button.tsx", import.meta.url),
    "utf8",
  );
  const portalInvoiceSrc = readFileSync(
    new URL("../src/app/p/[token]/invoice/page.tsx", import.meta.url),
    "utf8",
  );
  const ownerInvoiceSrc = readFileSync(
    new URL("../src/app/(app)/invoices/[invoiceId]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "customer Pay Invoice CTA is a bright green button with white text",
    payButtonSrc.includes("bg-[#22c55e]") &&
      payButtonSrc.includes("text-white") &&
      !payButtonSrc.includes("bg-emerald-700") &&
      !payButtonSrc.includes("bg-neutral-950") &&
      !payButtonSrc.includes("bg-neutral-900"),
  );
  check("portal uses shouldShowPayInvoice", portalSrc.includes("shouldShowPayInvoice"));
  check("portal renders PayInvoiceButton only when allowed", portalSrc.includes("showPayInvoice ? ("));
  check("portal Pay Invoice label uses remaining amount due", portalSrc.includes("invoiceBreakdown?.amountDue"));
  check(
    "customer invoice page uses shouldShowPayInvoice",
    portalInvoiceSrc.includes("shouldShowPayInvoice"),
  );
  check(
    "customer invoice page renders PayInvoiceButton only when allowed",
    portalInvoiceSrc.includes("showPayInvoice && invoice") &&
      portalInvoiceSrc.includes("<PayInvoiceButton"),
  );
  check(
    "customer invoice page does not read amount from the browser",
    !portalInvoiceSrc.includes("searchParams") &&
      portalInvoiceSrc.includes("invoicePaymentBreakdown") &&
      portalInvoiceSrc.includes("invoiceAmountToCents"),
  );
  check("portal success return does not mark paid", !portalSrc.includes("applyVerifiedCheckoutPayment"));
  check(
    "portal reconciles a paid Stripe checkout server-side",
    portalSrc.includes("reconcileProjectTokenCheckoutPayment"),
  );
  check(
    "portal invoice document reconciles server-side",
    portalInvoiceSrc.includes("reconcileProjectTokenCheckoutPayment"),
  );
  check(
    "owner invoice page reconciles server-side",
    ownerInvoiceSrc.includes("reconcileStripeCheckoutPayment"),
  );
  check(
    "owner invoice page copies the customer invoice URL",
    ownerInvoiceSrc.includes("Copy invoice link") &&
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
    "owner invoice page tells the owner when card pay is not live",
    ownerInvoiceSrc.includes("OwnerPaymentsGoLiveBanner") &&
      ownerInvoiceSrc.includes("Mark Paid"),
  );
  check(
    "customer invoice page does not show owner go-live or Mark Paid",
    !portalInvoiceSrc.includes("OwnerPaymentsGoLiveBanner") &&
      !portalInvoiceSrc.includes("Mark Paid") &&
      !portalInvoiceSrc.includes("STRIPE_SECRET_KEY"),
  );
  check(
    "Pay Invoice and Pay Deposit require an app URL",
    serviceSrc.includes("input.appUrlConfigured") &&
      serviceSrc.includes("onlineCheckoutPossible"),
  );
  check(
    "Connect Stripe stays disabled without an app URL",
    settingsSrc.includes("!snapshot.payment.appUrlConfigured"),
  );
  check(
    "success URL includes Checkout session id for reconcile",
    serviceSrc.includes("session_id={CHECKOUT_SESSION_ID}"),
  );
  check(
    "portal source has no client-supplied businessId identifier",
    portalSrc
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .every((line) => !line.includes("businessId") || line.includes("job.business.id")),
  );
  check("pay route does not read amount from the request", !/searchParams|formData|json\(\)|amount/.test(payRouteSrc.replace(/createCustomerInvoiceCheckout[\s\S]+/, "")));
  check("pay route creates checkout from the token only", payRouteSrc.includes("createCustomerInvoiceCheckout(prisma, token)"));
  check("webhook verifies the Stripe signature", webhookSrc.includes("constructStripeWebhookEvent"));
  check("webhook applies only a parsed checkout payment", webhookSrc.includes("parseCheckoutPaymentEvent"));
  check(
    "invoice checkout uses an explicit card/cashapp/us_bank_account allowlist",
    INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES.join(",") === "card,cashapp,us_bank_account" &&
      adapterSrc.includes("payment_method_types: [...INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES]"),
  );
  check(
    "invoice checkout does not enable Link, Affirm, Klarna, or a payment method configuration",
    !INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES.includes("link") &&
      !INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES.includes("affirm") &&
      !INVOICE_CHECKOUT_PAYMENT_METHOD_TYPES.includes("klarna") &&
      !adapterSrc.includes("payment_method_configuration") &&
      !adapterSrc.includes("paymentMethodConfigurations") &&
      adapterSrc.includes('display: "never"'),
  );
  check(
    "Settings payment card does not render Stripe readiness diagnostics",
    !settingsSrc.includes("formatPaymentReadinessDebug") &&
      !settingsSrc.includes("Stripe readiness") &&
      !settingsSrc.includes("currently_due") &&
      !settingsSrc.includes("charges_enabled") &&
      !settingsSrc.includes("stripeAccountId"),
  );

  const businessA = await seedBusiness("Alpha Payments");
  const businessB = await seedBusiness("Beta Payments");
  const provider = createFakePaymentProvider();
  const accessA = makeAccess(businessA.business.id, "OWNER", businessA.membership.id);
  const accessB = makeAccess(businessB.business.id, "OWNER", businessB.membership.id);

  console.log("\nTEST — Connect onboarding is tenant-scoped");
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
  try {
    await startStripeConnectOnboarding(
      prisma,
      makeAccess(businessA.business.id, "MEMBER", member.id),
      { appUrl: "http://payments.test" },
      provider,
    );
    check("MEMBER cannot start Stripe Connect", false);
  } catch (error) {
    check("MEMBER cannot start Stripe Connect", error instanceof ForbiddenError);
  }

  const onboardA = await startStripeConnectOnboarding(
    prisma,
    accessA,
    { appUrl: "http://payments.test" },
    provider,
  );
  const accountA = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: businessA.business.id },
  });
  check("Business A stores its own Stripe account id", Boolean(accountA?.stripeAccountId));
  check("onboarding URL is Stripe-hosted test setup, not an account-link dump in TBBT", onboardA.url.startsWith("https://connect.stripe.test/setup/"));
  check("Business A is not payment-ready before charges are enabled", (await getBusinessPaymentStatus(prisma, businessA.business.id, provider)).paymentReady === false);

  console.log("\nTEST — Resume onboarding when the stored account is missing on this platform");
  const stale = await seedBusiness("Stale Connect");
  const accessStale = makeAccess(stale.business.id, "OWNER", stale.membership.id);
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: stale.business.id,
      provider: "stripe",
      stripeAccountId: "acct_missing_on_this_platform",
    },
  });
  const staleStatus = await getBusinessPaymentStatus(prisma, stale.business.id, provider);
  check(
    "missing platform account is Setup Required, not fake-ready",
    staleStatus.status === "setup_required" && staleStatus.paymentReady === false,
  );
  check(
    "Setup Required still offers Continue Stripe Setup when retrieve fails",
    shouldOfferStripeOnboarding(staleStatus.status, staleStatus.readinessDebug?.branch) === true,
  );
  const resumed = await startStripeConnectOnboarding(
    prisma,
    accessStale,
    { appUrl: "http://payments.test" },
    provider,
  );
  const replaced = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: stale.business.id },
  });
  check(
    "stale account is replaced with a connected account on this platform",
    Boolean(replaced?.stripeAccountId) &&
      replaced.stripeAccountId !== "acct_missing_on_this_platform",
  );
  check(
    "resume returns a hosted Account Link for the replacement account",
    resumed.url === `https://connect.stripe.test/setup/${replaced.stripeAccountId}`,
  );

  console.log("\nTEST — forbidden Account Link does not mint a second connected account");
  const forbiddenBiz = await seedBusiness("Forbidden Connect");
  const accessForbidden = makeAccess(forbiddenBiz.business.id, "OWNER", forbiddenBiz.membership.id);
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: forbiddenBiz.business.id,
      provider: "stripe",
      stripeAccountId: "acct_existing_on_platform",
    },
  });
  let createdAccounts = 0;
  const forbiddenProvider = {
    id: "stripe",
    async createConnectedAccount() {
      createdAccounts += 1;
      throw new Error("must not create another connected account");
    },
    async createAccountOnboardingLink() {
      throw Object.assign(
        new Error("The provided key does not have permission to complete this request."),
        {
          type: "StripePermissionError",
          code: "forbidden",
          statusCode: 403,
          requestId: "req_test_forbidden",
        },
      );
    },
  };
  try {
    await startStripeConnectOnboarding(
      prisma,
      accessForbidden,
      { appUrl: "http://payments.test" },
      forbiddenProvider,
    );
    check("forbidden Account Link does not start onboarding by replacing the account", false);
  } catch (error) {
    check(
      "forbidden Account Link fails as a platform permission error",
      error instanceof PaymentError &&
        error.message.includes("platform") &&
        !error.message.includes("acct_"),
    );
  }
  const unchangedForbidden = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: forbiddenBiz.business.id },
  });
  check(
    "forbidden Account Link keeps the stored connected account",
    createdAccounts === 0 && unchangedForbidden?.stripeAccountId === "acct_existing_on_platform",
  );

  const invoiceANone = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "375.00",
  });
  try {
    await createCustomerInvoiceCheckout(prisma, invoiceANone.token, provider, {
      appUrl: "http://payments.test",
    });
    check("not-ready Business A cannot create checkout", false);
  } catch (error) {
    check(
      "not-ready Business A cannot create checkout",
      error instanceof PaymentError,
    );
  }
  check(
    "Pay Invoice hidden for connected-but-not-ready Business A",
    shouldShowPayInvoice({
      invoiceStatus: "SENT",
      amountDueCents: 37500,
      paymentReady: (await getBusinessPaymentStatus(prisma, businessA.business.id, provider)).paymentReady,
      appUrlConfigured: true,
    }) === false,
  );

  const invoiceBNone = await seedSentInvoice({
    businessId: businessB.business.id,
    customerId: businessB.customer.id,
    propertyId: businessB.property.id,
    total: "200.00",
  });
  check(
    "Pay Invoice hidden for Business B with no Stripe account",
    shouldShowPayInvoice({
      invoiceStatus: "SENT",
      amountDueCents: 20000,
      paymentReady: (await getBusinessPaymentStatus(prisma, businessB.business.id, provider)).paymentReady,
      appUrlConfigured: true,
    }) === false,
  );

  console.log("\nTEST — Ready accounts create tenant-isolated checkout");
  provider.setChargesEnabled(accountA.stripeAccountId, true);
  const readyA = await getBusinessPaymentStatus(prisma, businessA.business.id, provider);
  check("Business A becomes payment-ready after Stripe charges enable", readyA.paymentReady === true);
  check(
    "ready Business A can start online checkout when app URL is set",
    readyA.appUrlConfigured === true && readyA.onlineCheckoutPossible === true,
  );
  check(
    "Pay Invoice appears for payment-ready Business A SENT invoice",
    shouldShowPayInvoice({
      invoiceStatus: invoiceANone.invoice.status,
      amountDueCents: invoiceDueCents(invoiceANone.invoice.status, invoiceANone.invoice.total),
      paymentReady: readyA.paymentReady,
      appUrlConfigured: readyA.appUrlConfigured,
    }) === true,
  );

  const sessionA = await createCustomerInvoiceCheckout(prisma, invoiceANone.token, provider, {
    appUrl: "http://payments.test",
  });
  check("checkout amount comes from the invoice total", sessionA.amountCents === 37500);
  check("Business A session uses Business A connected account", sessionA.connectedAccountId === accountA.stripeAccountId);
  check("checkout URL is Stripe-hosted", sessionA.url.startsWith("https://checkout.stripe.test/pay/"));
  check("success URL returns to the existing portal", provider.checkouts.at(-1).url.startsWith("https://checkout.stripe.test/pay/"));

  const onboardB = await startStripeConnectOnboarding(
    prisma,
    accessB,
    { appUrl: "http://payments.test" },
    provider,
  );
  const accountB = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: businessB.business.id },
  });
  provider.setChargesEnabled(accountB.stripeAccountId, true);
  const sessionB = await createCustomerInvoiceCheckout(prisma, invoiceBNone.token, provider, {
    appUrl: "http://payments.test",
  });
  check("Business B session uses Business B connected account", sessionB.connectedAccountId === accountB.stripeAccountId);
  check("Business A and B accounts are different", accountA.stripeAccountId !== accountB.stripeAccountId);
  check("onboarding for B does not reuse A's account", onboardB.url.includes(accountB.stripeAccountId));

  console.log("\nTEST — Checkout event parsing");
  check(
    "parse without event.account uses metadata.connectedAccountId",
    parseCheckoutPaymentEvent(
      checkoutEvent({
        invoiceId: "inv_meta",
        businessId: "biz_meta",
        amountCents: 37500,
        connectedAccountId: "acct_from_metadata",
      }),
    )?.connectedAccountId === "acct_from_metadata",
  );
  check(
    "parse without account and without metadata connectedAccountId is ignored",
    parseCheckoutPaymentEvent(
      checkoutEvent({
        invoiceId: "inv_meta",
        businessId: "biz_meta",
        amountCents: 37500,
      }),
    ) === null,
  );
  check(
    "v1. checkout event type is accepted",
    parseCheckoutPaymentEvent({
      ...checkoutEvent({
        account: "acct_v1",
        invoiceId: "inv_v1",
        businessId: "biz_v1",
        amountCents: 37500,
      }),
      type: "v1.checkout.session.completed",
    })?.paymentStatus === "paid",
  );
  check(
    "material deposit checkout event requires estimateId",
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: "acct_dep",
        purpose: "material_deposit",
        businessId: "biz_dep",
        amountCents: 20000,
      }),
    ) === null,
  );
  check(
    "material deposit checkout event parses estimate-scoped payment",
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: "acct_dep",
        purpose: "material_deposit",
        estimateId: "est_dep",
        businessId: "biz_dep",
        amountCents: 20000,
      }),
    )?.purpose === "material_deposit",
  );

  console.log("\nTEST — Webhook reconciliation");
  const paid = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        invoiceId: invoiceANone.invoice.id,
        businessId: businessA.business.id,
        amountCents: 37500,
      }),
    ),
  );
  const afterPay = await prisma.invoice.findUnique({ where: { id: invoiceANone.invoice.id } });
  check("successful payment applies", paid.applied === true);
  check("invoice is PAID", afterPay.status === "PAID");
  check("paidAt is set", afterPay.paidAt instanceof Date);
  check("amount due is $0", invoiceDueCents(afterPay.status, afterPay.total) === 0);
  check("processor reference stored", afterPay.paymentReference === "pi_test_1");
  check("method is STRIPE, not CARD_EXTERNAL", afterPay.paymentMethod === "STRIPE");
  check(
    "Pay Invoice hidden after PAID",
    shouldShowPayInvoice({
      invoiceStatus: afterPay.status,
      amountDueCents: invoiceDueCents(afterPay.status, afterPay.total),
      paymentReady: true,
      appUrlConfigured: true,
    }) === false,
  );

  const duplicate = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        invoiceId: invoiceANone.invoice.id,
        businessId: businessA.business.id,
        amountCents: 37500,
        paymentIntent: "pi_test_duplicate",
      }),
    ),
  );
  const afterDup = await prisma.invoice.findUnique({ where: { id: invoiceANone.invoice.id } });
  check("duplicate webhook is idempotent", duplicate.reason === "already_paid");
  check("duplicate does not overwrite the original reference", afterDup.paymentReference === "pi_test_1");
  check("duplicate remains PAID", afterDup.status === "PAID");

  const cancelledInvoice = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "50.00",
  });
  const unpaidEvent = parseCheckoutPaymentEvent(
    checkoutEvent({
      account: accountA.stripeAccountId,
      invoiceId: cancelledInvoice.invoice.id,
      businessId: businessA.business.id,
      amountCents: 5000,
      paymentStatus: "unpaid",
    }),
  );
  check("cancelled/unpaid checkout event is ignored", unpaidEvent === null);
  const stillSent = await prisma.invoice.findUnique({ where: { id: cancelledInvoice.invoice.id } });
  check("failed/cancelled checkout leaves invoice SENT", stillSent.status === "SENT");

  const returnOnly = await prisma.invoice.findUnique({ where: { id: cancelledInvoice.invoice.id } });
  check("success-page redirect without webhook leaves SENT", returnOnly.status === "SENT");

  const wrongAmount = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        invoiceId: cancelledInvoice.invoice.id,
        businessId: businessA.business.id,
        amountCents: 1,
      }),
    ),
  );
  const afterWrongAmount = await prisma.invoice.findUnique({
    where: { id: cancelledInvoice.invoice.id },
  });
  check("wrong amount is rejected", wrongAmount.reason === "amount_mismatch");
  check("wrong amount leaves invoice SENT", afterWrongAmount.status === "SENT");

  const wrongAccount = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountB.stripeAccountId,
        invoiceId: cancelledInvoice.invoice.id,
        businessId: businessA.business.id,
        amountCents: 5000,
      }),
    ),
  );
  const afterWrongAccount = await prisma.invoice.findUnique({
    where: { id: cancelledInvoice.invoice.id },
  });
  check("wrong connected account is rejected", wrongAccount.reason === "account_mismatch");
  check("wrong account leaves invoice SENT", afterWrongAccount.status === "SENT");

  const wrongBusiness = await applyVerifiedCheckoutPayment(
    prisma,
    parseCheckoutPaymentEvent(
      checkoutEvent({
        account: accountA.stripeAccountId,
        invoiceId: cancelledInvoice.invoice.id,
        businessId: businessB.business.id,
        amountCents: 5000,
      }),
    ),
  );
  check("wrong business metadata is rejected", wrongBusiness.reason === "business_mismatch");

  console.log("\nTEST — Server-side Stripe checkout reconcile");
  const reconcileInvoice = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "375.00",
  });
  const reconcileSession = await createCustomerInvoiceCheckout(
    prisma,
    reconcileInvoice.token,
    provider,
    { appUrl: "http://payments.test" },
  );
  const beforeComplete = await reconcileStripeCheckoutPayment(
    prisma,
    businessA.business.id,
    reconcileInvoice.invoice.id,
    reconcileSession.id,
    provider,
  );
  check(
    "unpaid checkout cannot be reconciled",
    beforeComplete.reason === "no_paid_checkout",
  );
  provider.completeCheckout(reconcileSession.id);
  const reconciled = await reconcileProjectTokenCheckoutPayment(
    prisma,
    reconcileInvoice.token,
    reconcileSession.id,
    provider,
  );
  const afterReconcile = await prisma.invoice.findUnique({
    where: { id: reconcileInvoice.invoice.id },
  });
  check("token reconcile applies a paid Stripe checkout", reconciled.applied === true);
  check("reconciled invoice is PAID", afterReconcile.status === "PAID");
  check("reconciled amount due is $0", invoiceDueCents(afterReconcile.status, afterReconcile.total) === 0);
  check("reconciled method is STRIPE", afterReconcile.paymentMethod === "STRIPE");
  const replayReconcile = await reconcileStripeCheckoutPayment(
    prisma,
    businessA.business.id,
    reconcileInvoice.invoice.id,
    reconcileSession.id,
    provider,
  );
  const afterReplay = await prisma.invoice.findUnique({
    where: { id: reconcileInvoice.invoice.id },
  });
  check("second reconcile is idempotent", replayReconcile.reason === "already_paid");
  check("second reconcile does not create another payment write", afterReplay.paymentReference === afterReconcile.paymentReference);
  check("second reconcile remains PAID", afterReplay.status === "PAID");

  console.log("\nTEST — Manual Mark Paid remains available");
  requireBusinessCapability(accessA, CAPABILITIES.MANAGE_INVOICES);
  const manual = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "80.00",
  });
  const marked = await prisma.invoice.updateMany({
    where: {
      id: manual.invoice.id,
      businessId: accessA.businessId,
      status: "SENT",
    },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paymentMethod: "CASH",
      paymentReference: "Cash in person",
    },
  });
  const afterManual = await prisma.invoice.findUnique({ where: { id: manual.invoice.id } });
  check("manual cash Mark Paid still writes PAID", marked.count === 1 && afterManual.status === "PAID");
  check("manual method remains CASH", afterManual.paymentMethod === "CASH");
  const alreadyPaid = await prisma.invoice.updateMany({
    where: {
      id: afterManual.id,
      businessId: accessA.businessId,
      status: "SENT",
    },
    data: { status: "PAID", paymentMethod: "CHECK" },
  });
  const stillCash = await prisma.invoice.findUnique({ where: { id: afterManual.id } });
  check("already PAID cannot be Mark Paid again", alreadyPaid.count === 0 && stillCash.paymentMethod === "CASH");

  const checkInvoice = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "25.00",
  });
  await prisma.invoice.updateMany({
    where: { id: checkInvoice.invoice.id, businessId: businessA.business.id, status: "SENT" },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "CHECK" },
  });
  const zelleInvoice = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "25.00",
  });
  await prisma.invoice.updateMany({
    where: { id: zelleInvoice.invoice.id, businessId: businessA.business.id, status: "SENT" },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "ZELLE_BANK_TRANSFER" },
  });
  const externalInvoice = await seedSentInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    total: "25.00",
  });
  await prisma.invoice.updateMany({
    where: { id: externalInvoice.invoice.id, businessId: businessA.business.id, status: "SENT" },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "CARD_EXTERNAL" },
  });
  check(
    "check / Zelle / external Mark Paid still persist",
    (await prisma.invoice.findUnique({ where: { id: checkInvoice.invoice.id } })).paymentMethod === "CHECK" &&
      (await prisma.invoice.findUnique({ where: { id: zelleInvoice.invoice.id } })).paymentMethod === "ZELLE_BANK_TRANSFER" &&
      (await prisma.invoice.findUnique({ where: { id: externalInvoice.invoice.id } })).paymentMethod === "CARD_EXTERNAL",
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    // ignore
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } catch {
    // ignore
  }
  await cleanup.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll payment checks passed."
    : `\n${failures} payment check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
