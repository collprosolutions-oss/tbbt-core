/**
 * Authenticated Connect invoice webhooks that return HTTP 200 while
 * remaining unapplied: tenant-scoped OWNER inbox + retry of the stored
 * verified event. Dedicated disposable Postgres. Fake Stripe only.
 *
 * Proves duplicate, concurrent, wrong-account, and already-applied cases.
 * Invoice FOR UPDATE and Payment unique indexes stay in
 * applyVerifiedCheckoutPayment. Does not edit payments/service.ts
 * (PR #332 deposit Estimate lock).
 *
 * Run with:
 *   npm run test:connect-invoice-webhook-retry
 */
import { createRequire, register } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

const WEBHOOK_SECRET = "whsec_connect_invoice_retry_check";

process.env.TZ = process.env.TZ || "America/New_York";
process.env.NEXT_PUBLIC_APP_URL = "http://connect-invoice-retry.test";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
process.env.STRIPE_SECRET_KEY = "sk_test_connect_invoice_retry";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
delete process.env.VERCEL_ENV;

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "connect-invoice-webhook-retry disposable database");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
  return condition;
}

const inboxSrc = readRepo("src/lib/connect-invoice-webhook.ts");
const dispatchSrc = readRepo("src/lib/stripe-webhook-dispatch.ts");
const routeSrc = readRepo("src/app/api/stripe/webhook/route.ts");
const authSrc = readRepo("src/lib/authorization.ts");
const invoiceActionSrc = readRepo("src/app/actions/invoice.ts");
const invoicePageSrc = readRepo("src/app/(app)/invoices/[invoiceId]/page.tsx");
const invoicesPageSrc = readRepo("src/app/(app)/invoices/page.tsx");
const dashboardSrc = readRepo("src/app/(app)/dashboard/page.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");
const serviceSrc = readRepo("src/lib/payments/service.ts");

console.log("\nSTATIC — persist authenticated Connect invoice events; do not overlap #332");
check(
  "ConnectInvoiceWebhookEvent is distinct from SaaS webhook rows",
  schemaSrc.includes("model ConnectInvoiceWebhookEvent") &&
    schemaSrc.includes("Distinct from") &&
    schemaSrc.includes("SaasBillingWebhookEvent") &&
    schemaSrc.includes("Frozen VerifiedCheckoutPayment"),
);
check(
  "inbox documents #332 overlap and reuses applyVerifiedCheckoutPayment",
  inboxSrc.includes("PR #332") &&
    inboxSrc.includes("applyVerifiedCheckoutPayment") &&
    inboxSrc.includes("Do not edit service.ts") &&
    !inboxSrc.includes("recordSucceededPayment("),
);
check(
  "dispatch persists invoice_balance through the inbox, deposits stay on applyVerifiedCheckoutPayment",
  dispatchSrc.includes("applyRecordedConnectInvoicePayment") &&
    dispatchSrc.includes('payment.purpose === "invoice_balance"') &&
    dispatchSrc.includes("applyVerifiedCheckoutPayment"),
);
check(
  "webhook route still returns JSON 200 after dispatch without checking applied",
  routeSrc.includes("const result = await dispatchStripeWebhookEvent(prisma, event);") &&
    routeSrc.includes("return NextResponse.json(result);") &&
    !routeSrc.includes("if (!result.applied)"),
);
check(
  "OWNER-only retry capability is tenant-scoped",
  authSrc.includes("RETRY_CONNECT_INVOICE_WEBHOOK") &&
    authSrc.includes("CAPABILITIES.RETRY_CONNECT_INVOICE_WEBHOOK") &&
    inboxSrc.includes("CAPABILITIES.RETRY_CONNECT_INVOICE_WEBHOOK") &&
    invoiceActionSrc.includes("retryConnectInvoiceWebhookEvent") &&
    inboxSrc.includes("businessId: access.businessId"),
);
check(
  "owner surfaces list tenant-scoped unapplied events and retry the stored event",
  invoicePageSrc.includes("listUnappliedConnectInvoiceWebhookEvents") &&
    invoicesPageSrc.includes("listUnappliedConnectInvoiceWebhookEvents") &&
    dashboardSrc.includes("listUnappliedConnectInvoiceWebhookEvents") &&
    invoicePageSrc.includes("RetryConnectInvoiceWebhookForm") &&
    inboxSrc.includes("parseStoredVerifiedCheckoutPayment"),
);
check(
  "owner UI does not render connected-account ids",
  !invoicePageSrc.includes("connectedAccountId") &&
    !invoicesPageSrc.includes("connectedAccountId") &&
    !dashboardSrc.includes("acct_"),
);
check(
  "request path fails closed and does not CREATE TABLE",
  inboxSrc.includes("assertRequiredTablesExist") &&
    inboxSrc.includes('["ConnectInvoiceWebhookEvent"]') &&
    !inboxSrc.includes("CREATE TABLE"),
);
check(
  "invoice apply lock stays in service.ts; this change does not rewrite deposit apply",
  serviceSrc.includes('FROM "Invoice"') &&
    serviceSrc.includes("FOR UPDATE") &&
    !inboxSrc.includes("applyVerifiedDepositPayment"),
);

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_connect_invoice_wh",
  setProcessEnv: true,
});
const prisma = session.prisma;
const testUrl = session.testUrl;

const require = createRequire(import.meta.url);
const { Prisma } = require("@prisma/client");
const Stripe = (await import("stripe")).default;
const { ForbiddenError, requireBusinessCapability, CAPABILITIES } =
  await import("@/lib/authorization");
const { createFakePaymentProvider } = await import("@/lib/payments/fake");
const { dispatchStripeWebhookEvent, verifyStripeWebhookPayload } = await import(
  "@/lib/stripe-webhook-dispatch"
);
const {
  CONNECT_INVOICE_WEBHOOK_NOT_IN_WORKSPACE,
  CONNECT_INVOICE_WEBHOOK_OWNER_TITLE,
  connectInvoiceWebhookInboxWhere,
  listUnappliedConnectInvoiceWebhookEvents,
  parseStoredVerifiedCheckoutPayment,
  retryConnectInvoiceWebhookEvent,
} = await import("@/lib/connect-invoice-webhook");
const { invoiceRemainingReadTestHooks } = await import("@/lib/project-payments");
const { POST } = await import("@/app/api/stripe/webhook/route");

const provider = createFakePaymentProvider();

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Connect Inbox Tenant" },
      membership: { id: membershipId ?? `mem-${businessId}` },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
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
      addressLine1: "10 Inbox Ave",
    },
  });
  const account = await provider.createConnectedAccount({
    businessId: business.id,
    displayName: name,
  });
  provider.setChargesEnabled(account.accountId, true);
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: business.id,
      provider: "stripe",
      stripeAccountId: account.accountId,
    },
  });
  return { business, membership, customer, property, ownerUser, accountId: account.accountId };
}

async function seedInvoice(input) {
  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      jobId: job.id,
      kind: "ORIGINAL",
      status: input.status ?? "SENT",
      total: new Prisma.Decimal(input.total ?? "50.00"),
    },
  });
  return { job, invoice };
}

function connectCheckoutEvent(input) {
  return {
    id: input.id,
    type: "checkout.session.completed",
    account: input.account,
    data: {
      object: {
        object: "checkout.session",
        id: input.sessionId,
        mode: "payment",
        payment_status: "paid",
        amount_total: input.amountCents,
        currency: "usd",
        payment_intent: input.paymentIntent ?? `pi_${input.sessionId}`,
        metadata: {
          purpose: "invoice_balance",
          invoiceId: input.invoiceId,
          businessId: input.businessId,
          connectedAccountId: input.account,
        },
      },
    },
  };
}

function signPayload(event) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

async function dispatchSigned(event) {
  const { payload, signature } = signPayload(event);
  const verified = verifyStripeWebhookPayload(payload, signature);
  const result = await dispatchStripeWebhookEvent(prisma, verified);
  return { verified, result };
}

async function httpSigned(event) {
  const { payload, signature } = signPayload(event);
  return POST(
    new Request("http://connect-invoice-retry.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    }),
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const businessA = await seedBusiness("Inbox A");
  const businessB = await seedBusiness("Inbox B");
  const ownerA = makeAccess(businessA.business.id, "OWNER", businessA.membership.id);
  const ownerB = makeAccess(businessB.business.id, "OWNER", businessB.membership.id);
  const adminA = makeAccess(businessA.business.id, "ADMIN", `admin-${businessA.business.id}`);

  console.log("\nTEST — authenticated HTTP 200 stays unapplied and is tenant-visible");
  const draft = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "DRAFT",
    total: "50.00",
  });
  const draftSession = await provider.createInvoiceCheckoutSession({
    connectedAccountId: businessA.accountId,
    invoiceId: draft.invoice.id,
    businessId: businessA.business.id,
    amountCents: 5000,
    currency: "usd",
    description: "Draft invoice",
    successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://connect-invoice-retry.test/cancel",
  });
  provider.completeCheckout(draftSession.id);
  const draftEvent = connectCheckoutEvent({
    id: `evt_unapplied_${randomUUID().slice(0, 8)}`,
    account: businessA.accountId,
    sessionId: draftSession.id,
    invoiceId: draft.invoice.id,
    businessId: businessA.business.id,
    amountCents: 5000,
  });
  const posted = await httpSigned(draftEvent);
  const postedBody = await posted.json();
  check(
    "signed Connect invoice webhook returns HTTP 200 while unapplied",
    posted.status === 200 &&
      postedBody.system === "connect" &&
      postedBody.applied === false &&
      postedBody.reason === "not_sent",
  );
  const storedDraft = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { stripeEventId: draftEvent.id },
  });
  const inboxA = await listUnappliedConnectInvoiceWebhookEvents(prisma, businessA.business.id);
  const inboxB = await listUnappliedConnectInvoiceWebhookEvents(prisma, businessB.business.id);
  check(
    "unapplied verified event is stored and shown only to that business",
    storedDraft?.businessId === businessA.business.id &&
      storedDraft?.applied === false &&
      storedDraft?.reason === "not_sent" &&
      inboxA.length === 1 &&
      inboxA[0].id === storedDraft.id &&
      inboxA[0].reason === "not_sent" &&
      inboxB.length === 0,
  );
  const storedPayment = parseStoredVerifiedCheckoutPayment(storedDraft.verifiedPaymentJson);
  check(
    "stored verified event is the fake Stripe checkout, not a live retrieve",
    storedPayment?.checkoutSessionId === draftSession.id &&
      storedPayment?.businessId === businessA.business.id &&
      storedPayment?.amountCents === 5000 &&
      storedPayment?.purpose === "invoice_balance",
  );
  check(
    "OWNER title is the unapplied-card copy",
    CONNECT_INVOICE_WEBHOOK_OWNER_TITLE.includes("not applied"),
  );

  console.log("\nTEST — OWNER retry uses the stored event after the invoice is sent");
  await prisma.invoice.update({
    where: { id: draft.invoice.id },
    data: { status: "SENT" },
  });
  const retried = await retryConnectInvoiceWebhookEvent(prisma, ownerA, storedDraft.id);
  const afterRetry = await prisma.invoice.findUnique({ where: { id: draft.invoice.id } });
  const paymentsAfterRetry = await prisma.payment.findMany({
    where: { businessId: businessA.business.id, invoiceId: draft.invoice.id },
  });
  const storedAfterRetry = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { id: storedDraft.id },
  });
  const inboxAfterRetry = await listUnappliedConnectInvoiceWebhookEvents(
    prisma,
    businessA.business.id,
  );
  check(
    "OWNER retry applies the stored verified event",
    retried.applied === true &&
      retried.reason === "paid" &&
      afterRetry?.status === "PAID" &&
      paymentsAfterRetry.length === 1 &&
      paymentsAfterRetry[0].stripeCheckoutSessionId === draftSession.id &&
      storedAfterRetry?.applied === true &&
      inboxAfterRetry.length === 0,
  );

  console.log("\nTEST — duplicate webhook and already-applied retry stay idempotent");
  const originalReference = afterRetry?.paymentReference;
  const duplicatePost = await httpSigned(draftEvent);
  const duplicateBody = await duplicatePost.json();
  const alreadyApplied = await retryConnectInvoiceWebhookEvent(prisma, ownerA, storedDraft.id);
  const afterDupInvoice = await prisma.invoice.findUnique({ where: { id: draft.invoice.id } });
  const paymentsAfterDup = await prisma.payment.count({
    where: { businessId: businessA.business.id, invoiceId: draft.invoice.id },
  });
  check(
    "duplicate signed webhook is already_paid and HTTP 200",
    duplicatePost.status === 200 &&
      duplicateBody.applied === false &&
      duplicateBody.reason === "already_paid",
  );
  check(
    "already-applied OWNER retry does not add a second payment",
    alreadyApplied.applied === false &&
      alreadyApplied.reason === "already_applied" &&
      paymentsAfterDup === 1 &&
      afterDupInvoice?.paymentReference === originalReference,
  );

  console.log("\nTEST — wrong connected account stays unapplied; other owner cannot retry");
  const sentA = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "SENT",
    total: "75.00",
  });
  const wrongAccountSession = await provider.createInvoiceCheckoutSession({
    connectedAccountId: businessA.accountId,
    invoiceId: sentA.invoice.id,
    businessId: businessA.business.id,
    amountCents: 7500,
    currency: "usd",
    description: "Wrong account",
    successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://connect-invoice-retry.test/cancel",
  });
  provider.completeCheckout(wrongAccountSession.id);
  const wrongAccountEvent = connectCheckoutEvent({
    id: `evt_wrong_acct_${randomUUID().slice(0, 8)}`,
    account: businessB.accountId,
    sessionId: wrongAccountSession.id,
    invoiceId: sentA.invoice.id,
    businessId: businessA.business.id,
    amountCents: 7500,
  });
  const wrongPosted = await dispatchSigned(wrongAccountEvent);
  const wrongRow = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { stripeEventId: wrongAccountEvent.id },
  });
  const inboxWrongA = await listUnappliedConnectInvoiceWebhookEvents(
    prisma,
    businessA.business.id,
  );
  const inboxWrongB = await listUnappliedConnectInvoiceWebhookEvents(
    prisma,
    businessB.business.id,
  );
  check(
    "wrong connected account is received / account_mismatch and stays on business A",
    wrongPosted.result.reason === "account_mismatch" &&
      wrongRow?.businessId === businessA.business.id &&
      wrongRow?.applied === false &&
      inboxWrongA.some((row) => row.id === wrongRow.id) &&
      !inboxWrongB.some((row) => row.id === wrongRow.id) &&
      (await prisma.invoice.findUnique({ where: { id: sentA.invoice.id } }))?.status === "SENT",
  );

  let ownerBRetryError = null;
  try {
    await retryConnectInvoiceWebhookEvent(prisma, ownerB, wrongRow.id);
  } catch (error) {
    ownerBRetryError = error;
  }
  check(
    "OWNER B cannot retry business A's stored event",
    ownerBRetryError instanceof Error &&
      ownerBRetryError.message === CONNECT_INVOICE_WEBHOOK_NOT_IN_WORKSPACE &&
      (await prisma.payment.count({
        where: { invoiceId: sentA.invoice.id },
      })) === 0,
  );

  let adminRetryError = null;
  try {
    requireBusinessCapability(adminA, CAPABILITIES.RETRY_CONNECT_INVOICE_WEBHOOK);
    await retryConnectInvoiceWebhookEvent(prisma, adminA, wrongRow.id);
  } catch (error) {
    adminRetryError = error;
  }
  check(
    "ADMIN cannot retry a Connect invoice webhook event",
    adminRetryError instanceof ForbiddenError,
  );

  const ownerAWrongRetry = await retryConnectInvoiceWebhookEvent(prisma, ownerA, wrongRow.id);
  check(
    "OWNER A retry of the wrong-account event stays unapplied",
    ownerAWrongRetry.applied === false &&
      ownerAWrongRetry.reason === "account_mismatch" &&
      (await prisma.invoice.findUnique({ where: { id: sentA.invoice.id } }))?.status === "SENT",
  );

  console.log("\nTEST — concurrent retries of one stored event keep the invoice lock");
  const raceInvoice = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "DRAFT",
    total: "40.00",
  });
  const raceSession = await provider.createInvoiceCheckoutSession({
    connectedAccountId: businessA.accountId,
    invoiceId: raceInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 4000,
    currency: "usd",
    description: "Race invoice",
    successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://connect-invoice-retry.test/cancel",
  });
  provider.completeCheckout(raceSession.id);
  const raceEvent = connectCheckoutEvent({
    id: `evt_race_${randomUUID().slice(0, 8)}`,
    account: businessA.accountId,
    sessionId: raceSession.id,
    invoiceId: raceInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 4000,
  });
  const racePosted = await dispatchSigned(raceEvent);
  check(
    "race setup is an authenticated unapplied event",
    racePosted.result.applied === false && racePosted.result.reason === "not_sent",
  );
  await prisma.invoice.update({
    where: { id: raceInvoice.invoice.id },
    data: { status: "SENT" },
  });
  const raceRow = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { stripeEventId: raceEvent.id },
  });

  const holder = session.createClient();
  let finishedWhileHeld = false;
  let pendingLock = Promise.resolve();
  try {
    await holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM "Invoice"
          WHERE id = ${raceInvoice.invoice.id} AND "businessId" = ${businessA.business.id}
          FOR UPDATE
        `;
        pendingLock = Promise.resolve()
          .then(() => retryConnectInvoiceWebhookEvent(prisma, ownerA, raceRow.id))
          .then(
            () => {
              finishedWhileHeld = true;
            },
            () => {
              finishedWhileHeld = true;
            },
          );
        await sleep(500);
        check("retry waits on the existing Invoice FOR UPDATE", finishedWhileHeld === false);
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
    await pendingLock;
  } finally {
    await holder.$disconnect();
  }

  const overlapInvoice = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "DRAFT",
    total: "60.00",
  });
  const overlapSession = await provider.createInvoiceCheckoutSession({
    connectedAccountId: businessA.accountId,
    invoiceId: overlapInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 6000,
    currency: "usd",
    description: "Overlap invoice",
    successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://connect-invoice-retry.test/cancel",
  });
  provider.completeCheckout(overlapSession.id);
  const overlapEvent = connectCheckoutEvent({
    id: `evt_overlap_${randomUUID().slice(0, 8)}`,
    account: businessA.accountId,
    sessionId: overlapSession.id,
    invoiceId: overlapInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 6000,
  });
  const overlapPosted = await dispatchSigned(overlapEvent);
  check(
    "overlap setup is an authenticated unapplied event",
    overlapPosted.result.applied === false && overlapPosted.result.reason === "not_sent",
  );
  await prisma.invoice.update({
    where: { id: overlapInvoice.invoice.id },
    data: { status: "SENT" },
  });
  const overlapRow = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { stripeEventId: overlapEvent.id },
  });

  const previousHook = invoiceRemainingReadTestHooks.afterRead;
  invoiceRemainingReadTestHooks.afterRead = async () => sleep(200);
  const raceClientA = session.createClient();
  const raceClientB = session.createClient();
  let raceResults;
  try {
    raceResults = await Promise.all([
      retryConnectInvoiceWebhookEvent(
        raceClientA,
        ownerA,
        overlapRow.id,
      ).catch((error) => ({ error: String(error) })),
      retryConnectInvoiceWebhookEvent(
        raceClientB,
        ownerA,
        overlapRow.id,
      ).catch((error) => ({ error: String(error) })),
    ]);
  } finally {
    invoiceRemainingReadTestHooks.afterRead = previousHook;
    await Promise.all([raceClientA.$disconnect(), raceClientB.$disconnect()]);
  }
  const racePayments = await prisma.payment.findMany({
    where: { invoiceId: overlapInvoice.invoice.id, businessId: businessA.business.id },
  });
  const raceInvoiceAfter = await prisma.invoice.findUnique({
    where: { id: overlapInvoice.invoice.id },
  });
  const appliedCount = raceResults.filter((row) => row.applied === true).length;
  const duplicateCount = raceResults.filter(
    (row) => row.reason === "already_paid" || row.reason === "already_applied",
  ).length;
  check(
    "concurrent retries create one payment and one apply",
    racePayments.length === 1 &&
      appliedCount === 1 &&
      duplicateCount === 1 &&
      raceInvoiceAfter?.status === "PAID" &&
      raceResults.every((row) => !row.error),
  );

  const bPayments = await prisma.payment.count({
    where: { businessId: businessB.business.id },
  });
  const bEvents = await prisma.connectInvoiceWebhookEvent.count({
    where: { businessId: businessB.business.id },
  });
  check("tenant B stayed untouched", bPayments === 0 && bEvents === 0);

  const scopedWhere = connectInvoiceWebhookInboxWhere(businessA.business.id);
  check(
    "inbox where is tenant-scoped and hides already-applied reasons",
    scopedWhere.businessId === businessA.business.id &&
      scopedWhere.applied === false &&
      Array.isArray(scopedWhere.reason.notIn),
  );

  if (failures > 0) {
    throw new Error(`${failures} connect-invoice-webhook-retry check(s) failed.`);
  }
  console.log("\nconnect-invoice-webhook-retry checks passed.");
} finally {
  await session.cleanup();
}
