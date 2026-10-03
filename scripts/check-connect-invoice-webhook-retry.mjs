/**
 * Authenticated Connect invoice webhooks that return HTTP 200 while
 * remaining unapplied: tenant-scoped OWNER inbox + retry of the stored
 * verified event. Dedicated disposable Postgres. Fake Stripe only.
 *
 * Proves duplicate, concurrent, wrong-account, already-applied, a second
 * event on the same invoice, and OWNER retry racing deposit apply.
 * Invoice FOR UPDATE and Payment unique indexes stay in
 * applyVerifiedCheckoutPayment. #332 (merged) uses Estimate FOR NO KEY
 * UPDATE so that race cannot deadlock.
 *
 * Run with:
 *   npm run test:connect-invoice-webhook-retry
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

const MUTATION_KIND = process.argv.includes("--mutation")
  ? process.argv[process.argv.indexOf("--mutation") + 1]
  : null;

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

function duplicateMigrationPrefixes(names) {
  const byPrefix = new Map();
  for (const name of names) {
    const prefix = name.slice(0, 14);
    if (!/^\d{14}$/.test(prefix)) continue;
    const list = byPrefix.get(prefix) ?? [];
    list.push(name);
    byPrefix.set(prefix, list);
  }
  return [...byPrefix.entries()].filter(([, dirs]) => dirs.length > 1);
}

let failures = 0;
let passes = 0;
function check(label, condition) {
  if (condition) {
    passes += 1;
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
  inboxSrc.includes("#332") &&
    inboxSrc.includes("FOR NO KEY UPDATE") &&
    inboxSrc.includes("applyVerifiedCheckoutPayment") &&
    inboxSrc.includes("does not reimplement those writes") &&
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
    serviceSrc.includes("ESTIMATE_DEPOSIT_FOR_NO_KEY_UPDATE") &&
    !inboxSrc.includes("applyVerifiedDepositPayment"),
);
check(
  "stored amountCents is narrowed with typeof number before use",
  inboxSrc.includes("typeof value !== \"number\"") &&
    inboxSrc.includes("Number.isInteger(value)") &&
    inboxSrc.includes("readIntegerCents(record.amountCents)"),
);

const CONNECT_INVOICE_WEBHOOK_MIGRATION =
  "20261003150000_connect_invoice_webhook_event";
const migrationDirs = readdirSync(new URL("../prisma/migrations", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const migrationPrefixDups = duplicateMigrationPrefixes(migrationDirs);
check(
  "duplicate 14-digit prefix helper fails a colliding pair",
  duplicateMigrationPrefixes([
    "20261003150000_connect_invoice_webhook_event",
    "20261003150000_email_failed_destination",
  ]).length === 1,
);
check(
  "Connect invoice webhook migration prefix is unique and later than #341",
  existsSync(
    fileURLToPath(
      new URL(`../prisma/migrations/${CONNECT_INVOICE_WEBHOOK_MIGRATION}/migration.sql`, import.meta.url),
    ),
  ) &&
    !existsSync(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20261003120000_connect_invoice_webhook_event/migration.sql",
          import.meta.url,
        ),
      ),
    ) &&
    Number(CONNECT_INVOICE_WEBHOOK_MIGRATION.slice(0, 14)) > 20261003120000 &&
    migrationDirs.filter((name) => name.slice(0, 14) === CONNECT_INVOICE_WEBHOOK_MIGRATION.slice(0, 14))
      .length === 1,
);
check(
  "no two 20261003+ migration directories share a 14-digit prefix",
  migrationPrefixDups.filter(([prefix]) => prefix >= "20261003000000").length === 0,
);
check(
  "applyRecorded falls back to direct apply when the inbox table is missing",
  inboxSrc.includes("isConnectInvoiceWebhookInboxUnavailable") &&
    inboxSrc.includes("Preview shares Production and skips migrate") &&
    inboxSrc.includes("return applyVerifiedCheckoutPayment(db, payment);"),
);

let session = null;
let prisma;
let testUrl;

if (MUTATION_KIND) {
  const { PrismaClient } = createRequire(import.meta.url)("@prisma/client");
  prisma = new PrismaClient({ datasourceUrl: baseUrl });
  testUrl = baseUrl;
} else {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_connect_invoice_wh",
    setProcessEnv: true,
  });
  prisma = session.prisma;
  testUrl = session.testUrl;
}

const require = createRequire(import.meta.url);
const { Prisma } = require("@prisma/client");
const Stripe = (await import("stripe")).default;
const { ForbiddenError } = await import("@/lib/authorization");
const { createFakePaymentProvider } = await import("@/lib/payments/fake");
const { applyVerifiedCheckoutPayment } = await import("@/lib/payments");
const { dispatchStripeWebhookEvent, verifyStripeWebhookPayload } = await import(
  "@/lib/stripe-webhook-dispatch"
);
const { isRequestPathSchemaUnavailableError } = await import("@/lib/request-path-schema");
const {
  CONNECT_INVOICE_WEBHOOK_NOT_IN_WORKSPACE,
  CONNECT_INVOICE_WEBHOOK_OWNER_TITLE,
  connectInvoiceWebhookInboxWhere,
  listUnappliedConnectInvoiceWebhookEvents,
  parseStoredVerifiedCheckoutPayment,
  resetConnectInvoiceWebhookEventTableEnsure,
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

async function seedApprovedEstimateJobInvoice(input) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "APPROVED",
      total: new Prisma.Decimal("1000.00"),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      description: "Labor",
      type: "LABOR",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal("700.00"),
      total: new Prisma.Decimal("700.00"),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      description: "Materials",
      type: "MATERIAL",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal("300.00"),
      total: new Prisma.Decimal("300.00"),
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      estimateId: estimate.id,
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
      status: input.status ?? "DRAFT",
      total: new Prisma.Decimal("1000.00"),
    },
  });
  return { estimate, job, invoice };
}

async function withArrivalBarrier(work, extraDelayMs = 0) {
  const previous = invoiceRemainingReadTestHooks.afterRead;
  let arrived = 0;
  let release = () => {};
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  invoiceRemainingReadTestHooks.afterRead = async () => {
    arrived += 1;
    if (arrived >= 2) release();
    await Promise.race([opened, sleep(3000)]);
    if (extraDelayMs) await sleep(extraDelayMs);
  };
  try {
    return await work();
  } finally {
    invoiceRemainingReadTestHooks.afterRead = previous;
  }
}

function isDeadlockError(error) {
  if (!error) return false;
  const code = error.code ?? error.meta?.code;
  const message = String(error.message ?? error);
  return code === "P2034" || code === "40P01" || /deadlock detected/i.test(message);
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

  const ownerAWrongRetry = await retryConnectInvoiceWebhookEvent(prisma, ownerA, wrongRow.id);
  check(
    "OWNER A retry of the wrong-account event stays unapplied",
    ownerAWrongRetry.applied === false &&
      ownerAWrongRetry.reason === "account_mismatch" &&
      (await prisma.invoice.findUnique({ where: { id: sentA.invoice.id } }))?.status === "SENT",
  );

  console.log("\nTEST — ADMIN, MEMBER, and anonymous must hit the in-function retry guard");
  const guardInvoice = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "DRAFT",
    total: "45.00",
  });
  const guardSession = await provider.createInvoiceCheckoutSession({
    connectedAccountId: businessA.accountId,
    invoiceId: guardInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 4500,
    currency: "usd",
    description: "Guard invoice",
    successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://connect-invoice-retry.test/cancel",
  });
  provider.completeCheckout(guardSession.id);
  const guardEvent = connectCheckoutEvent({
    id: `evt_guard_${randomUUID().slice(0, 8)}`,
    account: businessA.accountId,
    sessionId: guardSession.id,
    invoiceId: guardInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 4500,
  });
  await dispatchSigned(guardEvent);
  await prisma.invoice.update({
    where: { id: guardInvoice.invoice.id },
    data: { status: "SENT" },
  });
  const guardRow = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { stripeEventId: guardEvent.id },
  });
  const memberA = makeAccess(businessA.business.id, "MEMBER", `member-${businessA.business.id}`);
  const anonymousA = makeAccess(businessA.business.id, "MEMBER", "anonymous");
  const deniedCallers = [
    ["ADMIN", adminA],
    ["MEMBER", memberA],
    ["anonymous", anonymousA],
  ];
  const deniedErrors = [];
  for (const [label, access] of deniedCallers) {
    try {
      await retryConnectInvoiceWebhookEvent(prisma, access, guardRow.id);
      deniedErrors.push({ label, error: null });
    } catch (error) {
      deniedErrors.push({ label, error });
    }
  }
  const guardPayments = await prisma.payment.count({
    where: { invoiceId: guardInvoice.invoice.id, businessId: businessA.business.id },
  });
  const guardAfter = await prisma.connectInvoiceWebhookEvent.findUnique({
    where: { id: guardRow.id },
  });
  check(
    "ADMIN, MEMBER, and anonymous retry are denied by the in-function guard with zero side effects",
    deniedErrors.every((row) => row.error instanceof ForbiddenError) &&
      guardPayments === 0 &&
      guardAfter?.applied === false &&
      (await prisma.invoice.findUnique({ where: { id: guardInvoice.invoice.id } }))?.status ===
        "SENT",
  );

  if (!MUTATION_KIND) {
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

  console.log("\nTEST — a distinct second event on the same invoice stays isolated");
  const dual = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "DRAFT",
    total: "80.00",
  });
  const dualSessions = [];
  const dualEvents = [];
  for (const suffix of ["a", "b"]) {
    const checkout = await provider.createInvoiceCheckoutSession({
      connectedAccountId: businessA.accountId,
      invoiceId: dual.invoice.id,
      businessId: businessA.business.id,
      amountCents: 8000,
      currency: "usd",
      description: `Dual ${suffix}`,
      successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://connect-invoice-retry.test/cancel",
    });
    provider.completeCheckout(checkout.id);
    dualSessions.push(checkout);
    const event = connectCheckoutEvent({
      id: `evt_dual_${suffix}_${randomUUID().slice(0, 8)}`,
      account: businessA.accountId,
      sessionId: checkout.id,
      invoiceId: dual.invoice.id,
      businessId: businessA.business.id,
      amountCents: 8000,
    });
    dualEvents.push(event);
    await dispatchSigned(event);
  }
  await prisma.invoice.update({
    where: { id: dual.invoice.id },
    data: { status: "SENT" },
  });
  const dualRows = await prisma.connectInvoiceWebhookEvent.findMany({
    where: { invoiceId: dual.invoice.id, businessId: businessA.business.id },
    orderBy: { createdAt: "asc" },
  });
  const inboxBeforeRetry = await listUnappliedConnectInvoiceWebhookEvents(
    prisma,
    businessA.business.id,
    { invoiceId: dual.invoice.id },
  );
  const firstDual = await retryConnectInvoiceWebhookEvent(prisma, ownerA, dualRows[0].id);
  const dualPayments = await prisma.payment.findMany({
    where: { invoiceId: dual.invoice.id, businessId: businessA.business.id },
  });
  const dualAfter = await prisma.connectInvoiceWebhookEvent.findMany({
    where: { invoiceId: dual.invoice.id, businessId: businessA.business.id },
    orderBy: { createdAt: "asc" },
  });
  const inboxAfterFirst = await listUnappliedConnectInvoiceWebhookEvents(
    prisma,
    businessA.business.id,
    { invoiceId: dual.invoice.id },
  );
  check(
    "distinct second event on the same invoice stays isolated after the first retry",
    dualRows.length === 2 &&
      inboxBeforeRetry.length === 2 &&
      dualRows[0].stripeEventId !== dualRows[1].stripeEventId &&
      dualRows[0].checkoutSessionId !== dualRows[1].checkoutSessionId &&
      firstDual.applied === true &&
      firstDual.reason === "paid" &&
      dualAfter[0].applied === true &&
      dualAfter[0].reason === "paid" &&
      dualAfter[1].applied === false &&
      dualAfter[1].reason === "not_sent" &&
      dualPayments.length === 1 &&
      dualPayments[0].stripeCheckoutSessionId === dualRows[0].checkoutSessionId &&
      inboxAfterFirst.length === 1 &&
      inboxAfterFirst[0].id === dualRows[1].id,
  );

  console.log("\nTEST — OWNER invoice retry races deposit apply on the same job");
  const RACE_ITERS = 20;
  let deadlockCount = 0;
  let raceFailures = 0;
  for (let i = 0; i < RACE_ITERS; i += 1) {
    const fixture = await seedApprovedEstimateJobInvoice({
      businessId: businessA.business.id,
      customerId: businessA.customer.id,
      propertyId: businessA.property.id,
      status: "DRAFT",
    });
    const invoiceCheckout = await provider.createInvoiceCheckoutSession({
      connectedAccountId: businessA.accountId,
      invoiceId: fixture.invoice.id,
      businessId: businessA.business.id,
      amountCents: 100000,
      currency: "usd",
      description: "Invoice balance",
      successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "http://connect-invoice-retry.test/cancel",
    });
    provider.completeCheckout(invoiceCheckout.id);
    const invoiceEvent = connectCheckoutEvent({
      id: `evt_vs_dep_${i}_${randomUUID().slice(0, 8)}`,
      account: businessA.accountId,
      sessionId: invoiceCheckout.id,
      invoiceId: fixture.invoice.id,
      businessId: businessA.business.id,
      amountCents: 100000,
    });
    await dispatchSigned(invoiceEvent);
    await prisma.invoice.update({
      where: { id: fixture.invoice.id },
      data: { status: "SENT" },
    });
    const invoiceRow = await prisma.connectInvoiceWebhookEvent.findUnique({
      where: { stripeEventId: invoiceEvent.id },
    });
    const depositPayment = {
      purpose: "material_deposit",
      invoiceId: null,
      estimateId: fixture.estimate.id,
      checkoutSessionId: `cs_test_dep_${i}_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      businessId: businessA.business.id,
      connectedAccountId: businessA.accountId,
      amountCents: 30000,
      currency: "usd",
      paymentReference: `pi_dep_${i}_${randomUUID().slice(0, 8)}`,
      paymentStatus: "paid",
    };
    const invoiceClient = session.createClient();
    const depositClient = session.createClient();
    let invoiceResult;
    let depositResult;
    try {
      [invoiceResult, depositResult] = await withArrivalBarrier(
        () =>
          Promise.all([
            retryConnectInvoiceWebhookEvent(invoiceClient, ownerA, invoiceRow.id).catch(
              (error) => ({ error }),
            ),
            applyVerifiedCheckoutPayment(depositClient, depositPayment).catch((error) => ({
              error,
            })),
          ]),
        40,
      );
    } finally {
      await Promise.all([invoiceClient.$disconnect(), depositClient.$disconnect()]);
    }
    if (isDeadlockError(invoiceResult?.error) || isDeadlockError(depositResult?.error)) {
      deadlockCount += 1;
    }
    const payments = await prisma.payment.findMany({
      where: {
        businessId: businessA.business.id,
        jobId: fixture.job.id,
      },
    });
    const deposits = payments.filter((row) => row.purpose === "MATERIAL_DEPOSIT");
    const invoicePays = payments.filter((row) => row.purpose === "INVOICE_BALANCE");
    const invoiceOk = invoiceResult?.applied === true && !invoiceResult?.error;
    const depositOk = depositResult?.applied === true && !depositResult?.error;
    if (!(invoiceOk && depositOk && deposits.length === 1 && invoicePays.length === 1)) {
      raceFailures += 1;
      if (raceFailures === 1) {
        console.error("deposit-race debug", {
          invoiceResult,
          depositResult,
          payments: payments.map((row) => ({
            purpose: row.purpose,
            amount: String(row.amount),
          })),
        });
      }
    }
  }
  check(
    "20 OWNER retry vs deposit apply races: zero deadlocks, deposit once, invoice payment once",
    deadlockCount === 0 && raceFailures === 0,
  );

  if (!MUTATION_KIND) {
    const scriptPath = fileURLToPath(import.meta.url);
    const guardFile = fileURLToPath(
      new URL("../src/lib/connect-invoice-webhook.ts", import.meta.url),
    );
    const original = readFileSync(guardFile, "utf8");
    const find =
      "  // RETRY_CONNECT_INVOICE_WEBHOOK_GUARD\n  requireBusinessCapability(access, CAPABILITIES.RETRY_CONNECT_INVOICE_WEBHOOK);";
    const replace = "  // RETRY_CONNECT_INVOICE_WEBHOOK_GUARD";
    check("retry-capability-guard mutation found its target", original.includes(find));
    writeFileSync(guardFile, original.replace(find, replace));
    try {
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", scriptPath, "--mutation", "retry-capability-guard"],
        {
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: testUrl, TZ: "America/New_York" },
        },
      );
      check(
        "removing the in-function retry guard fails ADMIN/MEMBER/anonymous denial",
        child.status !== 0,
      );
      if (child.status === 0) {
        console.error(child.stdout);
        console.error(child.stderr);
      }
    } finally {
      writeFileSync(guardFile, original);
    }
  }

  console.log("\nTEST — Preview without the inbox table still applies the verified payment");
  const previewInvoice = await seedInvoice({
    businessId: businessA.business.id,
    customerId: businessA.customer.id,
    propertyId: businessA.property.id,
    status: "SENT",
    total: "55.00",
  });
  const previewSession = await provider.createInvoiceCheckoutSession({
    connectedAccountId: businessA.accountId,
    invoiceId: previewInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 5500,
    currency: "usd",
    description: "Preview fallback",
    successUrl: "http://connect-invoice-retry.test/ok?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "http://connect-invoice-retry.test/cancel",
  });
  provider.completeCheckout(previewSession.id);
  const previewEvent = connectCheckoutEvent({
    id: `evt_preview_${randomUUID().slice(0, 8)}`,
    account: businessA.accountId,
    sessionId: previewSession.id,
    invoiceId: previewInvoice.invoice.id,
    businessId: businessA.business.id,
    amountCents: 5500,
  });
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "ConnectInvoiceWebhookEvent"`);
  resetConnectInvoiceWebhookEventTableEnsure();
  const previewPosted = await dispatchSigned(previewEvent);
  const previewHttp = await httpSigned(previewEvent);
  const previewHttpBody = await previewHttp.json();
  const previewAfter = await prisma.invoice.findUnique({
    where: { id: previewInvoice.invoice.id },
  });
  const previewPayments = await prisma.payment.count({
    where: { invoiceId: previewInvoice.invoice.id, businessId: businessA.business.id },
  });
  check(
    "missing inbox table applies the verified payment instead of 500",
    previewPosted.result.applied === true &&
      previewPosted.result.reason === "paid" &&
      previewHttp.status === 200 &&
      previewHttpBody.received === true &&
      previewHttpBody.applied === false &&
      previewHttpBody.reason === "already_paid" &&
      previewAfter?.status === "PAID" &&
      previewPayments === 1,
  );
  let missingTableListError = null;
  try {
    await listUnappliedConnectInvoiceWebhookEvents(prisma, businessA.business.id);
  } catch (error) {
    missingTableListError = error;
  }
  check(
    "owner inbox stays fail-closed when the table is missing",
    isRequestPathSchemaUnavailableError(missingTableListError),
  );

  }

  if (failures > 0) {
    throw new Error(`${failures} connect-invoice-webhook-retry check(s) failed.`);
  }
  console.log(`\nconnect-invoice-webhook-retry checks passed (${passes}).`);
} finally {
  if (session) {
    await session.cleanup();
  } else {
    await prisma.$disconnect();
  }
}
