/**
 * OWNER invoice credits / corrections: remaining-balance arithmetic,
 * duplicate-submit safety, authorization, isolation, concurrency,
 * Stripe webhook lock, stale-checkout review, and mutation proofs.
 *
 * Uses the shared disposable Postgres harness. Does not call Stripe
 * refunds and does not send customer messages.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-invoice-credits.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";

const MUTATION_KIND = process.argv.includes("--mutation")
  ? process.argv[process.argv.indexOf("--mutation") + 1]
  : null;

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function countTopLevelArgs(inner) {
  let depth = 0;
  let args = 1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inSingle) {
      if (ch === "\\") i += 1;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") i += 1;
      else if (ch === "`") inTemplate = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "`") inTemplate = true;
    else if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) args += 1;
  }
  return args;
}

function extractCalls(src, name) {
  const calls = [];
  const needle = `${name}(`;
  let from = 0;
  while (from < src.length) {
    const start = src.indexOf(needle, from);
    if (start < 0) break;
    const before = src.slice(Math.max(0, start - 80), start);
    if (/function\s+$/.test(before) || /export\s+function\s+$/.test(before)) {
      from = start + needle.length;
      continue;
    }
    let i = start + needle.length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    calls.push(src.slice(start + needle.length, i - 1));
    from = i;
  }
  return calls;
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

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Credit Tenant" },
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

const creditLibSrc = readRepo("src/lib/invoice-credits.ts");
const invoiceActionSrc = readRepo("src/app/actions/invoice.ts");
const invoicePageSrc = readRepo("src/app/(app)/invoices/[invoiceId]/page.tsx");
const dashboardSrc = readRepo("src/app/(app)/dashboard/page.tsx");
const formSrc = readRepo("src/components/invoices/record-invoice-credit-form.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");
const authSrc = readRepo("src/lib/authorization.ts");
const projectPaymentsSrc = readRepo("src/lib/project-payments.ts");
const paymentServiceSrc = readRepo("src/lib/payments/service.ts");
const collectedRevenueSrc = readRepo("src/lib/financial-intelligence/collected-revenue.ts");
const selfSrc = readRepo("scripts/check-invoice-credits.mjs");

if (!MUTATION_KIND) {
  console.log("\nSTATIC — Internal credit is additive, OWNER-only, and not a refund");
  check(
    "InvoiceCredit model is additive and documents no rewrite / no refund",
    schemaSrc.includes("model InvoiceCredit") &&
      schemaSrc.includes("Never rewrites Invoice.total") &&
      schemaSrc.includes("Never issues a Stripe refund"),
  );
  check(
    "credit writer is OWNER-only RECORD_INVOICE_CREDIT",
    authSrc.includes("RECORD_INVOICE_CREDIT") &&
      authSrc.includes("CAPABILITIES.RECORD_INVOICE_CREDIT") &&
      creditLibSrc.includes("CAPABILITIES.RECORD_INVOICE_CREDIT") &&
      invoiceActionSrc.includes("recordOwnerInvoiceCredit"),
  );
  check(
    "credit path never calls Stripe, refunds, or customer messaging",
    !creditLibSrc.includes('from "stripe"') &&
      !creditLibSrc.includes("from 'stripe'") &&
      !creditLibSrc.includes("@/lib/payments/stripe") &&
      !creditLibSrc.includes("createRefund") &&
      !creditLibSrc.includes("refunds.create") &&
      !creditLibSrc.includes("sendInvoice") &&
      !creditLibSrc.includes("@/lib/invoice-mail") &&
      !invoiceActionSrc.includes("createRefund") &&
      !invoiceActionSrc.includes('from "stripe"') &&
      invoiceActionSrc.includes("recordInvoiceCredit") &&
      creditLibSrc.includes("never call Stripe"),
  );
  check(
    "remaining-due math subtracts recorded credits without treating them as payments",
    projectPaymentsSrc.includes("recordedCredit") &&
      projectPaymentsSrc.includes("credits?:") &&
      invoicePageSrc.includes("Recorded credit") &&
      invoicePageSrc.includes("listInvoiceCreditsForInvoice"),
  );
  check(
    "owner UI records a credit with a reused idempotency key",
    formSrc.includes('name="idempotencyKey"') &&
      formSrc.includes("does not refund") &&
      formSrc.includes("recordInvoiceCredit"),
  );
  check(
    "invoice lock is shared with payment collection and Stripe apply",
    creditLibSrc.includes("FOR UPDATE") &&
      projectPaymentsSrc.includes("FOR UPDATE") &&
      paymentServiceSrc.includes("FOR UPDATE") &&
      paymentServiceSrc.includes("applyVerifiedInvoicePayment"),
  );
  check(
    "credits stay allowed while a checkout session is open",
    creditLibSrc.includes("Open Stripe Checkout sessions do not block credits") &&
      paymentServiceSrc.includes("Open Checkout sessions do not block OWNER credits"),
  );
  check(
    "full credit closes as PAID without a $0 Payment row",
    creditLibSrc.includes("closes the invoice") &&
      creditLibSrc.includes("No $0 Payment row") &&
      creditLibSrc.includes("INVOICE_CLOSED_BY_CREDIT_METHOD"),
  );
  check(
    "credit amount accepts only a plain decimal with at most 2 fraction digits",
    creditLibSrc.includes("CREDIT_AMOUNT_PATTERN = /^\\d+(\\.\\d{1,2})?$/"),
  );
  check(
    "owner review surfaces a Stripe credit-mismatch on the invoice page and dashboard",
    invoicePageSrc.includes("paymentsNeedingStripeCreditMismatchReview") &&
      invoicePageSrc.includes("STRIPE_CREDIT_MISMATCH_OWNER_TITLE") &&
      invoicePageSrc.includes("resolveInvoiceStripeCreditMismatch") &&
      dashboardSrc.includes("STRIPE_CREDIT_MISMATCH_OWNER_TITLE") &&
      dashboardSrc.includes("listOpenStripeCreditMismatchReviews"),
  );
  check(
    "dashboard attention query excludes resolved credit-mismatch flags",
    paymentServiceSrc.includes("STRIPE_CREDIT_MISMATCH_DASHBOARD_UNRESOLVED") &&
      paymentServiceSrc.includes("stripeCreditMismatchResolvedAt: null"),
  );
  check(
    "credit-closed detection requires OTHER plus an exact Recorded credit <id>",
    collectedRevenueSrc.includes("CREDIT_CLOSED_EXACT_REFERENCE") &&
      collectedRevenueSrc.includes("invoiceHasExactRecordedCreditReference") &&
      !collectedRevenueSrc.includes("startsWith(RECORDED_CREDIT_REFERENCE_PREFIX)"),
  );
  check(
    "this verifier uses the shared disposable harness",
    selfSrc.includes('from "./disposable-test-database.mjs"') &&
      selfSrc.includes("openDisposableTestDatabase") &&
      selfSrc.includes("assertLocalDatabaseUrl"),
  );

  const callerFiles = [
    "src/lib/financial-intelligence/job-profitability.ts",
    "src/lib/financial-intelligence/collected-revenue.ts",
    "src/lib/financial-intelligence/receivables.ts",
    "src/lib/bsos-data.ts",
    "src/lib/job-profitability-closeout.ts",
    "src/lib/owner-scenario-planner.ts",
    "scripts/check-financial-intelligence.mjs",
    "scripts/check-invoice-credits.mjs",
  ];
  console.log("\nSTATIC — every invoiceBalanceDue / outstandingReceivableAmount caller receives credits");
  for (const rel of callerFiles) {
    const src = readRepo(rel);
    for (const name of ["invoiceBalanceDue", "outstandingReceivableAmount"]) {
      for (const inner of extractCalls(src, name)) {
        check(
          `${rel} ${name} receives credits`,
          countTopLevelArgs(inner) >= 3,
        );
      }
    }
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

let session = null;
let prisma;
let testUrl;

if (MUTATION_KIND) {
  assertLocalDatabaseUrl(baseUrl, "invoice-credits mutation child");
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient({ datasourceUrl: baseUrl });
  testUrl = baseUrl;
} else {
  assertLocalDatabaseUrl(baseUrl, "invoice-credits disposable database");
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_invoice_credits",
    setProcessEnv: true,
  });
  prisma = session.prisma;
  testUrl = session.testUrl;
}

const { ForbiddenError, requireBusinessCapability, CAPABILITIES } =
  await import("@/lib/authorization");
const { Prisma } = await import("@prisma/client");
const {
  InvoiceCreditError,
  listInvoiceCreditsForInvoice,
  parseCreditAmount,
  recordOwnerInvoiceCredit,
  invoiceClosedByCreditReference,
} = await import("@/lib/invoice-credits");
const {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  ProjectPaymentError,
  closingTruthFromRecordedPayments,
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
  recordOwnerInvoiceBalancePayment,
  recordSucceededPayment,
  sumInvoiceRemainingDue,
  invoiceRemainingReadTestHooks,
} = await import("@/lib/project-payments");
const {
  applyVerifiedCheckoutPayment,
  STRIPE_CREDIT_MISMATCH_OWNER_TITLE,
  STRIPE_CREDIT_MISMATCH_REASON,
  STRIPE_CREDIT_MISMATCH_REVIEW_NOTE,
  historicalRemainingDueCents,
  listOpenStripeCreditMismatchReviews,
  paymentsNeedingStripeCreditMismatchReview,
  recordInvoiceCheckoutSession,
  resolveStripeCreditMismatchReview,
} = await import("@/lib/payments");
const {
  collectedRevenueForCustomer,
  collectedRevenueForInvoices,
  collectedRevenueForJob,
  invoiceBalanceDue,
  invoiceIsCreditClosed,
  outstandingReceivableAmount,
} = await import("@/lib/financial-intelligence/collected-revenue");
const { resolveCollectedCash } = await import("@/lib/collected-cash");
const { buildKnownCashFlowFromSource } = await import("@/lib/financial-intelligence/cash-flow");
const { collectedRevenueInPeriod, resolveMonthlyGoalPeriod } = await import("@/lib/monthly-goals");

async function seedBusiness(name) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: `${name} Admin`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.admin.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: `${name} Member`,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.member.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}` },
  });
  const membership = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
  });
  const memberMembership = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: business.id, role: "MEMBER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${name} Customer` },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: "10 Credit Ave",
    },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: business.id,
      provider: "stripe",
      stripeAccountId: `acct_${business.id.slice(0, 16)}`,
    },
  });
  return {
    business,
    membership,
    adminMembership,
    memberMembership,
    customer,
    property,
    stripeAccountId: `acct_${business.id.slice(0, 16)}`,
  };
}

async function seedSentInvoice(input) {
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
      total: new Prisma.Decimal(input.total),
    },
  });
  const line = await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      invoiceId: invoice.id,
      description: input.lineDescription ?? "Issued labor snapshot",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal(input.total),
      total: new Prisma.Decimal(input.total),
      type: "LABOR",
    },
  });
  return { job, invoice, line };
}

async function invoiceTruth(businessId, invoiceId) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
    },
  });
  const payments = await listPaymentsForInvoice(prisma, {
    businessId,
    invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
  });
  const credits = await listInvoiceCreditsForInvoice(prisma, {
    businessId,
    invoiceId,
  });
  return {
    invoice,
    payments,
    credits,
    breakdown: invoicePaymentBreakdown({
      status: invoice.status,
      total: invoice.total,
      payments,
      credits,
    }),
  };
}

async function expectRejects(label, fn, isExpected = () => true) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

function webhookPayment(input) {
  const stamp = randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    purpose: "invoice_balance",
    invoiceId: input.invoiceId,
    estimateId: null,
    checkoutSessionId: input.checkoutSessionId ?? `cs_${stamp}`,
    businessId: input.businessId,
    connectedAccountId: input.connectedAccountId,
    amountCents: input.amountCents,
    currency: "usd",
    paymentReference: input.paymentReference ?? `pi_${stamp}`,
    paymentStatus: "paid",
  };
}

function asCollected(invoice, payments, credits) {
  return {
    invoices: [
      {
        id: invoice.id,
        status: invoice.status,
        total: Number(invoice.total.toString()),
        jobId: invoice.jobId,
        customerId: invoice.customerId,
        paidAt: invoice.paidAt,
        paymentMethod: invoice.paymentMethod,
        paymentReference: invoice.paymentReference,
      },
    ],
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount.toString()),
      invoiceId: payment.invoiceId,
      jobId: payment.jobId,
      customerId: payment.customerId,
      receivedAt: payment.receivedAt,
    })),
    credits: credits.map((credit) => ({
      id: credit.id,
      invoiceId: credit.invoiceId,
      amount: Number(credit.amount.toString()),
    })),
  };
}

async function seedCreditCashScenario(owner, tenant) {
  const creditOnly = await seedSentInvoice({
    businessId: tenant.business.id,
    customerId: tenant.customer.id,
    propertyId: tenant.property.id,
    total: "100.00",
  });
  await recordOwnerInvoiceCredit(prisma, owner, {
    invoiceId: creditOnly.invoice.id,
    amount: "100.00",
    reason: "full write-off",
    idempotencyKey: `cash-credit-only-${randomUUID()}`,
  });
  const mixed = await seedSentInvoice({
    businessId: tenant.business.id,
    customerId: tenant.customer.id,
    propertyId: tenant.property.id,
    total: "200.00",
  });
  await recordOwnerInvoiceBalancePayment(prisma, owner, {
    invoiceId: mixed.invoice.id,
    amount: "150.00",
    method: "CASH",
  });
  await recordOwnerInvoiceCredit(prisma, owner, {
    invoiceId: mixed.invoice.id,
    amount: "50.00",
    reason: "remaining write-off",
    idempotencyKey: `cash-mixed-${randomUUID()}`,
  });
  const first = await invoiceTruth(tenant.business.id, creditOnly.invoice.id);
  const second = await invoiceTruth(tenant.business.id, mixed.invoice.id);
  const invoices = [
    ...asCollected(first.invoice, first.payments, first.credits).invoices,
    ...asCollected(second.invoice, second.payments, second.credits).invoices,
  ];
  const payments = [
    ...asCollected(first.invoice, first.payments, first.credits).payments,
    ...asCollected(second.invoice, second.payments, second.credits).payments,
  ];
  const credits = [
    ...asCollected(first.invoice, first.payments, first.credits).credits,
    ...asCollected(second.invoice, second.payments, second.credits).credits,
  ];
  return { first, second, invoices, payments, credits };
}

function collectedCashIs150(invoices, payments, credits, firstJobId, mixedJobId, customerId) {
  const forInvoices = collectedRevenueForInvoices(invoices, payments, credits);
  const forCustomer = collectedRevenueForCustomer({
    customerId,
    invoices,
    payments,
    credits,
  });
  const forFirstJob = collectedRevenueForJob({
    jobId: firstJobId,
    invoices,
    payments,
    credits,
  });
  const forJob = collectedRevenueForJob({
    jobId: mixedJobId,
    invoices,
    payments,
    credits,
  });
  const resolved = resolveCollectedCash({ invoices, payments, credits });
  const reportsCash = buildKnownCashFlowFromSource(
    {
      invoices,
      payments: payments.map((payment) => ({
        ...payment,
        businessId: invoices[0] ? "local" : "local",
        purpose: "INVOICE_BALANCE",
        method: "CASH",
      })),
      invoiceCredits: credits,
      expenses: [],
      payrollRuns: [],
    },
    { start: null, end: null },
  );
  const period = resolveMonthlyGoalPeriod(new Date(), { timezone: "America/New_York" });
  const monthly = collectedRevenueInPeriod(
    {
      businessId: "cash-tenant",
      timeZone: period.timeZone,
      jobCompletions: [],
      completedJobs: [],
      completionEventsForCompletedJobs: [],
      paidInvoices: invoices.map((invoice) => ({
        businessId: "cash-tenant",
        id: invoice.id,
        status: invoice.status,
        total: invoice.total,
        paidAt: invoice.paidAt ?? new Date(),
        paymentMethod: invoice.paymentMethod,
        paymentReference: invoice.paymentReference,
      })),
      payments: payments.map((payment) => ({
        businessId: "cash-tenant",
        id: payment.id,
        amount: payment.amount,
        invoiceId: payment.invoiceId,
        receivedAt: payment.receivedAt,
      })),
      invoiceCredits: credits.map((credit) => ({
        id: credit.id,
        businessId: "cash-tenant",
        invoiceId: credit.invoiceId,
        amount: credit.amount,
      })),
      paymentsOnPaidInvoices: payments
        .filter((payment) => payment.invoiceId)
        .map((payment) => ({ businessId: "cash-tenant", invoiceId: payment.invoiceId })),
      jobCompletionsTruncated: false,
      completedJobsTruncated: false,
      paidInvoicesTruncated: false,
      paymentsTruncated: false,
      paymentsOnPaidInvoicesTruncated: false,
    },
    period,
  );
  return {
    forInvoices,
    forCustomer,
    forFirstJob,
    forJob,
    resolved: resolved.totalCollected,
    reports: reportsCash.collectedCustomerPayments,
    monthly: monthly.actual,
    ok:
      forInvoices === 150 &&
      forCustomer === 150 &&
      forFirstJob === 0 &&
      forJob === 150 &&
      resolved.totalCollected === 150 &&
      reportsCash.collectedCustomerPayments === 150 &&
      monthly.actual === 150,
  };
}

function webhookCreditRaceIsSafe(after) {
  const dueZero = after.breakdown.amountDue.toString() === "0";
  const onlyPayment = after.payments.length === 1 && after.credits.length === 0;
  const onlyCredit = after.payments.length === 0 && after.credits.length === 1;
  const creditThenReviewCharge =
    after.payments.length === 1 &&
    after.credits.length === 1 &&
    paymentsNeedingStripeCreditMismatchReview(after.payments).length === 1;
  return dueZero && (onlyPayment || onlyCredit || creditThenReviewCharge);
}

function createExtraClient() {
  if (session) return session.createClient();
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasourceUrl: testUrl });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withForcedRemainingOverlap(work) {
  const previous = invoiceRemainingReadTestHooks.afterRead;
  invoiceRemainingReadTestHooks.afterRead = async () => sleep(150);
  try {
    return await work();
  } finally {
    invoiceRemainingReadTestHooks.afterRead = previous;
  }
}

async function assertWaitsOnInvoiceLock(label, invoice, writer) {
  const holder = createExtraClient();
  let finishedWhileHeld = false;
  let pending = Promise.resolve();
  try {
    await holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM "Invoice"
          WHERE id = ${invoice.id} AND "businessId" = ${invoice.businessId}
          FOR UPDATE
        `;
        pending = Promise.resolve()
          .then(() => writer())
          .then(
            () => {
              finishedWhileHeld = true;
            },
            () => {
              finishedWhileHeld = true;
            },
          );
        await sleep(500);
        check(label, finishedWhileHeld === false);
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
    await pending;
  } finally {
    await holder.$disconnect();
  }
}

try {
  const tenantA = await seedBusiness("Credit A");
  const tenantB = await seedBusiness("Credit B");
  const ownerA = makeAccess(tenantA.business.id, "OWNER", tenantA.membership.id);
  const adminA = makeAccess(tenantA.business.id, "ADMIN", tenantA.adminMembership.id);
  const memberA = makeAccess(tenantA.business.id, "MEMBER", tenantA.memberMembership.id);
  const ownerB = makeAccess(tenantB.business.id, "OWNER", tenantB.membership.id);

  if (MUTATION_KIND === "cents-validator") {
    let accepted = false;
    try {
      parseCreditAmount("0x10");
      accepted = true;
    } catch {
      accepted = false;
    }
    check("hex credit amount is rejected", accepted === false);
  } else if (MUTATION_KIND === "over-credit-guard") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    let overCredited = false;
    try {
      await recordOwnerInvoiceCredit(prisma, ownerA, {
        invoiceId: invoice.invoice.id,
        amount: "200.00",
        reason: "mutation over-credit",
        idempotencyKey: "mutation-over-credit",
      });
      overCredited = true;
    } catch {
      overCredited = false;
    }
    check("cannot credit more than remaining due", overCredited === false);
  } else if (MUTATION_KIND === "idempotency-lookup") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "40.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "10.00",
      reason: "first",
      idempotencyKey: "mutation-idem",
    });
    let replayedViaLookup = false;
    let replayErrorCode = null;
    try {
      const replay = await recordOwnerInvoiceCredit(prisma, ownerA, {
        invoiceId: invoice.invoice.id,
        amount: "10.00",
        reason: "first",
        idempotencyKey: "mutation-idem",
      });
      replayedViaLookup = replay.replayedViaLookup === true;
    } catch (error) {
      replayErrorCode = error?.code ?? error?.meta?.code ?? String(error?.message ?? error);
      replayedViaLookup = false;
    }
    check(
      "idempotent replay uses the pre-insert lookup",
      replayedViaLookup === true && replayErrorCode !== "25P02",
    );
  } else if (MUTATION_KIND === "credit-for-update") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    const clientA = createExtraClient();
    const clientB = createExtraClient();
    try {
      await withForcedRemainingOverlap(() =>
        Promise.allSettled([
          recordOwnerInvoiceCredit(clientA, ownerA, {
            invoiceId: invoice.invoice.id,
            amount: "100.00",
            reason: "mutation credit A",
            idempotencyKey: "mutation-credit-a",
          }),
          recordOwnerInvoiceCredit(clientB, ownerA, {
            invoiceId: invoice.invoice.id,
            amount: "100.00",
            reason: "mutation credit B",
            idempotencyKey: "mutation-credit-b",
          }),
        ]),
      );
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    check(
      "concurrent credits cannot over-credit remaining due",
      after.credits.length === 1 && after.breakdown.recordedCredit.toString() === "100",
    );
  } else if (MUTATION_KIND === "payment-for-update") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    const clientA = createExtraClient();
    const clientB = createExtraClient();
    try {
      await withForcedRemainingOverlap(() =>
        Promise.allSettled([
          recordOwnerInvoiceCredit(clientA, ownerA, {
            invoiceId: invoice.invoice.id,
            amount: "100.00",
            reason: "mutation mix credit",
            idempotencyKey: "mutation-mix-credit",
          }),
          recordOwnerInvoiceBalancePayment(clientB, ownerA, {
            invoiceId: invoice.invoice.id,
            amount: "100.00",
            method: "CASH",
          }),
        ]),
      );
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    const applied = after.breakdown.amountPaid.add(after.breakdown.recordedCredit);
    check(
      "credit and payment together cannot exceed the invoice total",
      applied.toString() === "100" && after.breakdown.amountDue.toString() === "0",
    );
  } else if (MUTATION_KIND === "webhook-lock") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    const clientA = createExtraClient();
    const clientB = createExtraClient();
    try {
      await withForcedRemainingOverlap(() =>
        Promise.allSettled([
          recordOwnerInvoiceCredit(clientA, ownerA, {
            invoiceId: invoice.invoice.id,
            amount: "100.00",
            reason: "mutation hook credit",
            idempotencyKey: "mutation-hook-credit",
          }),
          applyVerifiedCheckoutPayment(
            clientB,
            webhookPayment({
              invoiceId: invoice.invoice.id,
              businessId: tenantA.business.id,
              connectedAccountId: tenantA.stripeAccountId,
              amountCents: 10000,
            }),
          ),
        ]),
      );
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    check(
      "webhook and credit together cannot over-apply remaining without owner review",
      webhookCreditRaceIsSafe(after),
    );
  } else if (MUTATION_KIND === "credit-closed-cash") {
    const scenario = await seedCreditCashScenario(ownerA, tenantA);
    const cash = collectedCashIs150(
      scenario.invoices,
      scenario.payments,
      scenario.credits,
      scenario.first.invoice.jobId,
      scenario.second.invoice.jobId,
      tenantA.customer.id,
    );
    check("credit-closed invoices contribute $0 collected cash", cash.ok);
  } else if (MUTATION_KIND === "stale-checkout-bound") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "30.00",
      reason: "bound",
      idempotencyKey: "mutation-bound-credit",
    });
    const huge = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 99999999,
      }),
    );
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    check(
      "unbounded stale webhook is amount_mismatch with nothing recorded",
      huge.reason === "amount_mismatch" && after.payments.length === 0,
    );
  } else if (MUTATION_KIND === "stale-checkout-owner-review") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "30.00",
      reason: "review",
      idempotencyKey: "mutation-review-credit",
    });
    await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_mutation_review",
        paymentReference: "pi_mutation_review",
      }),
    );
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    const reviews = paymentsNeedingStripeCreditMismatchReview(after.payments);
    check(
      "accepted stale checkout is visible for owner review",
      reviews.length === 1,
    );
  } else if (MUTATION_KIND === "stale-checkout-after-full-credit") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "100.00",
      reason: "full",
      idempotencyKey: "mutation-full-credit",
    });
    const applied = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_mutation_full",
        paymentReference: "pi_mutation_full",
      }),
    );
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    check(
      "webhook after a full credit records the charge for owner refund review",
      applied.applied === true &&
        applied.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        after.payments.length === 1,
    );
  } else if (MUTATION_KIND === "stale-checkout-session-history") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "30.00",
      reason: "first",
      idempotencyKey: "mutation-history-first",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "20.00",
      reason: "second",
      idempotencyKey: "mutation-history-second",
    });
    const applied = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 7000,
        checkoutSessionId: "cs_mutation_history_70",
        paymentReference: "pi_mutation_history_70",
      }),
    );
    check(
      "session created at net 70 after the first credit is recorded and flagged after a second credit",
      applied.applied === true && applied.reason === STRIPE_CREDIT_MISMATCH_REASON,
    );
  } else if (MUTATION_KIND === "void-status-guard") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "30.00",
      reason: "void",
      idempotencyKey: "mutation-void-credit",
    });
    await prisma.invoice.update({
      where: { id: invoice.invoice.id },
      data: { status: "VOID" },
    });
    const applied = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_mutation_void",
        paymentReference: "pi_mutation_void",
      }),
    );
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    check(
      "matching webhook on a VOID invoice is recorded and flagged without changing VOID",
      applied.applied === true &&
        after.invoice.status === "VOID" &&
        after.payments.length === 1,
    );
  } else if (MUTATION_KIND === "credit-closed-exact-reference") {
    const lookalike = {
      id: "mutation-lookalike",
      status: "PAID",
      total: 30,
      paymentMethod: "OTHER",
      paymentReference: "Recorded credit lookalike typed by hand",
    };
    check(
      "hand-typed Recorded credit lookalike stays legacy cash",
      collectedRevenueForInvoices([lookalike], [], []) === 30,
    );
  } else if (MUTATION_KIND === "dashboard-unresolved-filter") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "30.00",
      reason: "review",
      idempotencyKey: "mutation-dashboard-credit",
    });
    await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_mutation_dash",
        paymentReference: "pi_mutation_dash",
      }),
    );
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    await resolveStripeCreditMismatchReview(prisma, ownerA, after.payments[0].id);
    const open = await listOpenStripeCreditMismatchReviews(prisma, tenantA.business.id);
    check("resolve removes the flag from dashboard and reports surfaces", open.length === 0);
  } else if (MUTATION_KIND === "mismatch-resolve") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "30.00",
      reason: "resolve",
      idempotencyKey: "mutation-resolve-credit",
    });
    await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: invoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_mutation_resolve",
        paymentReference: "pi_mutation_resolve",
      }),
    );
    const after = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    await resolveStripeCreditMismatchReview(prisma, ownerA, after.payments[0].id);
    const open = await listOpenStripeCreditMismatchReviews(prisma, tenantA.business.id);
    const refreshed = await invoiceTruth(tenantA.business.id, invoice.invoice.id);
    check(
      "resolve removes the flag from dashboard and reports surfaces",
      open.length === 0 &&
        paymentsNeedingStripeCreditMismatchReview(refreshed.payments).length === 0,
    );
  } else {
    console.log("\nTEST — Accounting arithmetic: payment plus credit");
    const invoice500 = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "500.00",
    });
    await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: invoice500.invoice.id,
      amount: "200.00",
      method: "CASH",
      note: "cash 200",
    });
    const beforeCredit = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
    const lineBefore = beforeCredit.invoice.lineItems[0];
    const paymentBefore = beforeCredit.payments[0];
    const credit = await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice500.invoice.id,
      amount: "50.00",
      reason: "Price correction for extra trip",
      idempotencyKey: "credit-key-50",
    });
    const afterCredit = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
    const lineAfter = afterCredit.invoice.lineItems[0];
    check("SENT $500 − $200 payment − $50 credit → due $250", afterCredit.breakdown.amountDue.toString() === "250");
    check("amount paid stays the recorded $200 payment", afterCredit.breakdown.amountPaid.toString() === "200");
    check("recorded credit is $50 and is not a payment", afterCredit.breakdown.recordedCredit.toString() === "50" && afterCredit.payments.length === 1);
    check("invoice total stays $500", afterCredit.invoice.total.toString() === "500");
    check("invoice remains SENT after a partial credit", afterCredit.invoice.status === "SENT");
    check(
      "original line snapshot is unchanged",
      afterCredit.invoice.lineItems.length === 1 &&
        lineAfter.id === lineBefore.id &&
        lineAfter.description === lineBefore.description &&
        lineAfter.quantity.toString() === lineBefore.quantity.toString() &&
        lineAfter.unitPrice.toString() === lineBefore.unitPrice.toString() &&
        lineAfter.total.toString() === lineBefore.total.toString(),
    );
    check(
      "recorded payment row is unchanged",
      afterCredit.payments.length === 1 &&
        afterCredit.payments[0].id === paymentBefore.id &&
        afterCredit.payments[0].amount.toString() === "200" &&
        afterCredit.payments[0].purpose === PAYMENT_PURPOSE_INVOICE_BALANCE &&
        afterCredit.payments[0].method === "CASH" &&
        afterCredit.payments[0].note === "cash 200",
    );
    check("credit result reports the new remaining due", credit.created === true && credit.amountDue.toString() === "250");

    const receivable = sumInvoiceRemainingDue(
      [{ id: afterCredit.invoice.id, status: afterCredit.invoice.status, total: afterCredit.invoice.total }],
      new Map([[afterCredit.invoice.id, afterCredit.payments]]),
      new Map([[afterCredit.invoice.id, afterCredit.credits]]),
    );
    check("receivable helper uses remaining after credit", receivable.toString() === "250");
    check(
      "invoiceBalanceDue / outstandingReceivableAmount receive credits",
      invoiceBalanceDue(
        { id: afterCredit.invoice.id, total: 500 },
        afterCredit.payments.map((row) => ({
          id: row.id,
          amount: Number(row.amount),
          invoiceId: afterCredit.invoice.id,
          jobId: afterCredit.invoice.jobId,
          customerId: afterCredit.invoice.customerId,
          receivedAt: row.receivedAt,
        })),
        afterCredit.credits.map((row) => ({ invoiceId: row.invoiceId, amount: Number(row.amount) })),
      ) === 250 &&
        outstandingReceivableAmount(
          [{ id: afterCredit.invoice.id, status: afterCredit.invoice.status, total: 500 }],
          afterCredit.payments.map((row) => ({
            id: row.id,
            amount: Number(row.amount),
            invoiceId: afterCredit.invoice.id,
            jobId: afterCredit.invoice.jobId,
            customerId: afterCredit.invoice.customerId,
            receivedAt: row.receivedAt,
          })),
          afterCredit.credits.map((row) => ({ invoiceId: row.invoiceId, amount: Number(row.amount) })),
        ).amount === 250,
    );

    const audits = await prisma.settingsAuditLog.findMany({
      where: {
        businessId: tenantA.business.id,
        settingArea: "invoices",
        settingKey: "invoiceCredit",
      },
    });
    check(
      "recording a credit writes an audit row",
      audits.length === 1 &&
        audits[0].changedByMembershipId === tenantA.membership.id &&
        (audits[0].newValue ?? "").includes("Price correction") &&
        (audits[0].newValue ?? "").includes('"stripeRefund":false') &&
        (audits[0].newValue ?? "").includes('"customerMessage":false'),
    );

    console.log("\nTEST — Duplicate-submit safety");
    const duplicate = await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice500.invoice.id,
      amount: "50.00",
      reason: "Price correction for extra trip",
      idempotencyKey: "credit-key-50",
    });
    const afterDuplicate = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
    check("same idempotency key does not create a second credit", duplicate.alreadyRecorded === true && duplicate.created === false);
    check("idempotent replay uses the pre-insert lookup", duplicate.replayedViaLookup === true);
    check("idempotent replay did not throw a transaction abort", duplicate.alreadyRecorded === true);
    check("duplicate submit leaves one $50 credit and $250 due", afterDuplicate.credits.length === 1 && afterDuplicate.breakdown.amountDue.toString() === "250");
    check("duplicate submit does not add a payment", afterDuplicate.payments.length === 1);

    console.log("\nTEST — Over-credit and invalid amounts are rejected");
    await expectRejects(
      "cannot credit more than remaining due",
      () =>
        recordOwnerInvoiceCredit(prisma, ownerA, {
          invoiceId: invoice500.invoice.id,
          amount: "251.00",
          reason: "too much",
          idempotencyKey: "credit-too-much",
        }),
      (error) =>
        error instanceof InvoiceCreditError && error.message.includes("remaining balance"),
    );
    await expectRejects(
      "zero credit is rejected",
      () =>
        recordOwnerInvoiceCredit(prisma, ownerA, {
          invoiceId: invoice500.invoice.id,
          amount: "0",
          reason: "zero",
          idempotencyKey: "credit-zero",
        }),
      (error) => error instanceof InvoiceCreditError,
    );
    for (const bad of ["0.001", "0.005", "1e-20", "12.345", "0x10"]) {
      await expectRejects(
        `sub-cent/hex/exponent ${bad} is rejected`,
        () =>
          recordOwnerInvoiceCredit(prisma, ownerA, {
            invoiceId: invoice500.invoice.id,
            amount: bad,
            reason: "bad amount",
            idempotencyKey: `bad-${bad}`,
          }),
        (error) => error instanceof InvoiceCreditError,
      );
      try {
        parseCreditAmount(bad);
        check(`parseCreditAmount rejects ${bad}`, false);
      } catch (error) {
        check(`parseCreditAmount rejects ${bad}`, error instanceof InvoiceCreditError);
      }
    }
    const afterRejects = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
    check(
      "rejected amounts leave lines, payments, and remaining unchanged",
      afterRejects.credits.length === 1 &&
        afterRejects.payments.length === 1 &&
        afterRejects.breakdown.amountDue.toString() === "250" &&
        afterRejects.invoice.lineItems[0].id === lineBefore.id,
    );

    console.log("\nTEST — Later payment uses remaining after credit");
    const leftoverPay = await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: invoice500.invoice.id,
      method: "CHECK",
      note: "closing after credit",
    });
    const afterClose = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
    check(
      "collecting remaining after credit records $250 and marks PAID",
      leftoverPay.recordedAmount.toString() === "250" &&
        afterClose.invoice.status === "PAID" &&
        afterClose.breakdown.amountDue.toString() === "0",
    );
    check(
      "closing payment did not rewrite the credit or the first payment",
      afterClose.credits.length === 1 &&
        afterClose.credits[0].amount.toString() === "50" &&
        afterClose.payments.some((row) => row.id === paymentBefore.id && row.amount.toString() === "200"),
    );

    console.log("\nTEST — Authorization");
    const authInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await expectRejects(
      "ADMIN cannot record an invoice credit",
      () =>
        recordOwnerInvoiceCredit(prisma, adminA, {
          invoiceId: authInvoice.invoice.id,
          amount: "10.00",
          reason: "admin should fail",
          idempotencyKey: "admin-credit",
        }),
      (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
    );
    await expectRejects(
      "MEMBER cannot record an invoice credit",
      () =>
        recordOwnerInvoiceCredit(prisma, memberA, {
          invoiceId: authInvoice.invoice.id,
          amount: "10.00",
          reason: "member should fail",
          idempotencyKey: "member-credit",
        }),
      (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
    );
    requireBusinessCapability(ownerA, CAPABILITIES.RECORD_INVOICE_CREDIT);
    const afterAuth = await invoiceTruth(tenantA.business.id, authInvoice.invoice.id);
    check("unauthorized roles create no credit rows", afterAuth.credits.length === 0 && afterAuth.invoice.status === "SENT");

    console.log("\nTEST — Isolation");
    const foreign = await seedSentInvoice({
      businessId: tenantB.business.id,
      customerId: tenantB.customer.id,
      propertyId: tenantB.property.id,
      total: "90.00",
    });
    const beforeIsoA = await invoiceTruth(tenantA.business.id, authInvoice.invoice.id);
    const beforeIsoB = await invoiceTruth(tenantB.business.id, foreign.invoice.id);
    await expectRejects(
      "tenant B cannot credit tenant A invoice",
      () =>
        recordOwnerInvoiceCredit(prisma, ownerB, {
          invoiceId: authInvoice.invoice.id,
          amount: "10.00",
          reason: "cross tenant",
          idempotencyKey: "cross-tenant",
        }),
      (error) => error instanceof InvoiceCreditError || error instanceof ProjectPaymentError || error instanceof Error,
    );
    await expectRejects(
      "missing invoice fails closed",
      () =>
        recordOwnerInvoiceCredit(prisma, ownerA, {
          invoiceId: "inv_missing",
          amount: "10.00",
          reason: "missing",
          idempotencyKey: "missing-invoice",
        }),
      (error) => error instanceof InvoiceCreditError && error.message.includes("could not be found"),
    );
    const afterIsoA = await invoiceTruth(tenantA.business.id, authInvoice.invoice.id);
    const afterIsoB = await invoiceTruth(tenantB.business.id, foreign.invoice.id);
    check(
      "cross-tenant credit leaves both invoices untouched",
      afterIsoA.credits.length === beforeIsoA.credits.length &&
        afterIsoB.credits.length === beforeIsoB.credits.length &&
        afterIsoA.invoice.total.toString() === beforeIsoA.invoice.total.toString() &&
        afterIsoB.invoice.status === "SENT",
    );

    console.log("\nTEST — Issued-only: DRAFT and PAID refuse credits");
    const draft = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "40.00",
      status: "DRAFT",
    });
    await expectRejects(
      "DRAFT invoice cannot receive a credit",
      () =>
        recordOwnerInvoiceCredit(prisma, ownerA, {
          invoiceId: draft.invoice.id,
          amount: "10.00",
          reason: "draft",
          idempotencyKey: "draft-credit",
        }),
      (error) => error instanceof InvoiceCreditError && error.message.includes("sent invoice"),
    );
    const paidInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "40.00",
    });
    await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: paidInvoice.invoice.id,
      method: "CASH",
    });
    await expectRejects(
      "PAID invoice cannot receive a credit",
      () =>
        recordOwnerInvoiceCredit(prisma, ownerA, {
          invoiceId: paidInvoice.invoice.id,
          amount: "10.00",
          reason: "already paid",
          idempotencyKey: "paid-credit",
        }),
      (error) => error instanceof InvoiceCreditError,
    );

    console.log("\nTEST — Full credit closes as PAID without a $0 payment");
    const fullCreditInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "75.00",
    });
    const fullCredit = await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: fullCreditInvoice.invoice.id,
      amount: "75.00",
      reason: "Write off remaining",
      idempotencyKey: "full-credit",
    });
    const afterFullCredit = await invoiceTruth(tenantA.business.id, fullCreditInvoice.invoice.id);
    check(
      "full credit closes SENT → PAID with due $0 and no payment row",
      fullCredit.created === true &&
        afterFullCredit.invoice.status === "PAID" &&
        afterFullCredit.breakdown.amountDue.toString() === "0" &&
        afterFullCredit.payments.length === 0 &&
        afterFullCredit.invoice.paymentMethod === "OTHER" &&
        afterFullCredit.invoice.paymentReference === invoiceClosedByCreditReference(fullCredit.creditId),
    );
    const closing = closingTruthFromRecordedPayments([], afterFullCredit.credits);
    check(
      "credit-based closingTruth sets OTHER / Recorded credit / paidAt",
      closing.paymentMethod === "OTHER" &&
        closing.paymentReference === invoiceClosedByCreditReference(fullCredit.creditId) &&
        closing.paidAt instanceof Date,
    );
    const markPaidCovered = await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: fullCreditInvoice.invoice.id,
    });
    const afterMarkPaidCovered = await invoiceTruth(tenantA.business.id, fullCreditInvoice.invoice.id);
    check(
      "mark-paid on a fully credited invoice does not create a $0 payment",
      markPaidCovered.created === false &&
        markPaidCovered.recordedAmount.toString() === "0" &&
        afterMarkPaidCovered.payments.length === 0 &&
        afterMarkPaidCovered.invoice.status === "PAID" &&
        Boolean(afterMarkPaidCovered.invoice.paidAt) &&
        Boolean(afterMarkPaidCovered.invoice.paymentMethod),
    );

    console.log("\nTEST — Credit-closed invoices are not collected cash");
    const cashScenario = await seedCreditCashScenario(ownerA, tenantA);
    const cash = collectedCashIs150(
      cashScenario.invoices,
      cashScenario.payments,
      cashScenario.credits,
      cashScenario.first.invoice.jobId,
      cashScenario.second.invoice.jobId,
      tenantA.customer.id,
    );
    check(
      "collected = 150 through invoices, customer, job, resolveCollectedCash, reports, and monthly goals",
      cash.ok,
    );
    check(
      "credit-closed $100 invoice is $0 cash and mixed invoice collects only the $150 payment",
      cash.forFirstJob === 0 && cash.forJob === 150 && cash.resolved === 150,
    );

    console.log("\nTEST — Credit-closed detection stays narrow");
    const lookalikeInvoice = {
      id: "legacy-lookalike",
      status: "PAID",
      total: 30,
      paymentMethod: "OTHER",
      paymentReference: "Recorded credit lookalike typed by hand",
    };
    const unrelatedInvoice = {
      id: "legacy-unrelated",
      status: "PAID",
      total: 30,
      paymentMethod: "OTHER",
      paymentReference: "check 1044",
    };
    const cashPlusCreditInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "40.00",
    });
    await prisma.invoice.update({
      where: { id: cashPlusCreditInvoice.invoice.id },
      data: {
        status: "PAID",
        paidAt: new Date(),
        paymentMethod: "CASH",
        paymentReference: "front counter",
      },
    });
    const insertedCredit = await prisma.invoiceCredit.create({
      data: {
        businessId: tenantA.business.id,
        invoiceId: cashPlusCreditInvoice.invoice.id,
        customerId: tenantA.customer.id,
        amount: new Prisma.Decimal("5.00"),
        reason: "inserted beside legacy cash",
        recordedByMembershipId: tenantA.membership.id,
        idempotencyKey: `legacy-cash-credit-${randomUUID()}`,
      },
    });
    const cashPlusCreditCollected = collectedRevenueForInvoices(
      [
        {
          id: cashPlusCreditInvoice.invoice.id,
          status: "PAID",
          total: 40,
          paymentMethod: "CASH",
          paymentReference: "front counter",
        },
      ],
      [],
      [{ id: insertedCredit.id, invoiceId: cashPlusCreditInvoice.invoice.id, amount: 5 }],
    );
    check(
      "OTHER with an unrelated reference stays legacy cash",
      collectedRevenueForInvoices([unrelatedInvoice], [], []) === 30 &&
        !invoiceIsCreditClosed(unrelatedInvoice, []),
    );
    check(
      "hand-typed Recorded credit lookalike stays legacy cash",
      collectedRevenueForInvoices([lookalikeInvoice], [], []) === 30 &&
        !invoiceIsCreditClosed(lookalikeInvoice, []),
    );
    check(
      "legacy CASH invoice plus a credit row still counts its cash",
      cashPlusCreditCollected === 40,
    );

    console.log("\nTEST — Concurrent remaining-balance credits cannot over-credit");
    const raceInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    const raceClientA = createExtraClient();
    const raceClientB = createExtraClient();
    let raceResults = [];
    let raceErrors = 0;
    try {
      const settled = await withForcedRemainingOverlap(() =>
        Promise.allSettled([
          recordOwnerInvoiceCredit(raceClientA, ownerA, {
            invoiceId: raceInvoice.invoice.id,
            amount: "100.00",
            reason: "race A",
            idempotencyKey: "race-a",
          }),
          recordOwnerInvoiceCredit(raceClientB, ownerA, {
            invoiceId: raceInvoice.invoice.id,
            amount: "100.00",
            reason: "race B",
            idempotencyKey: "race-b",
          }),
        ]),
      );
      raceResults = settled.filter((row) => row.status === "fulfilled").map((row) => row.value);
      raceErrors = settled.filter((row) => row.status === "rejected").length;
    } finally {
      await raceClientA.$disconnect();
      await raceClientB.$disconnect();
    }
    const afterRace = await invoiceTruth(tenantA.business.id, raceInvoice.invoice.id);
    const createdCredits = raceResults.filter((row) => row.created);
    check("concurrent credits create exactly one InvoiceCredit", afterRace.credits.length === 1 && createdCredits.length === 1);
    check("concurrent credits cannot over-credit remaining due", afterRace.breakdown.amountDue.toString() === "0" && afterRace.breakdown.recordedCredit.toString() === "100");
    check("losing racer is a no-op or a remaining-balance rejection", createdCredits.length === 1 && (raceResults.length + raceErrors) === 2);
    check("raced invoice lines and payments stay original", afterRace.invoice.lineItems.length === 1 && afterRace.payments.length === 0);
    check(
      "credit covering remaining closes PAID without inventing a payment",
      afterRace.invoice.status === "PAID" && afterRace.payments.length === 0,
    );

    console.log("\nTEST — Concurrent credit and payment share the invoice lock");
    const mixInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "60.00",
    });
    const mixClientA = createExtraClient();
    const mixClientB = createExtraClient();
    try {
      await withForcedRemainingOverlap(() =>
        Promise.allSettled([
          recordOwnerInvoiceCredit(mixClientA, ownerA, {
            invoiceId: mixInvoice.invoice.id,
            amount: "60.00",
            reason: "mix credit",
            idempotencyKey: "mix-credit",
          }),
          recordOwnerInvoiceBalancePayment(mixClientB, ownerA, {
            invoiceId: mixInvoice.invoice.id,
            amount: "60.00",
            method: "CASH",
          }),
        ]),
      );
    } finally {
      await mixClientA.$disconnect();
      await mixClientB.$disconnect();
    }
    const afterMix = await invoiceTruth(tenantA.business.id, mixInvoice.invoice.id);
    const applied = afterMix.breakdown.amountPaid.add(afterMix.breakdown.recordedCredit);
    check(
      "credit and payment together cannot exceed the invoice total",
      applied.toString() === "60" && afterMix.breakdown.amountDue.toString() === "0",
    );
    check(
      "mixed race did not rewrite issued lines",
      afterMix.invoice.lineItems.length === 1 &&
        afterMix.invoice.lineItems[0].total.toString() === "60",
    );

    console.log("\nTEST — Concurrent webhook payment and owner credit cannot over-apply");
    const hookInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    const hookClientA = createExtraClient();
    const hookClientB = createExtraClient();
    try {
      await withForcedRemainingOverlap(() =>
        Promise.allSettled([
          recordOwnerInvoiceCredit(hookClientA, ownerA, {
            invoiceId: hookInvoice.invoice.id,
            amount: "100.00",
            reason: "webhook race credit",
            idempotencyKey: "hook-credit",
          }),
          applyVerifiedCheckoutPayment(
            hookClientB,
            webhookPayment({
              invoiceId: hookInvoice.invoice.id,
              businessId: tenantA.business.id,
              connectedAccountId: tenantA.stripeAccountId,
              amountCents: 10000,
            }),
          ),
        ]),
      );
    } finally {
      await hookClientA.$disconnect();
      await hookClientB.$disconnect();
    }
    const afterHookRace = await invoiceTruth(tenantA.business.id, hookInvoice.invoice.id);
    check(
      "webhook and credit together cannot over-apply remaining without owner review",
      webhookCreditRaceIsSafe(afterHookRace),
    );
    check(
      "webhook/credit race is one closer, or a credit plus a review-flagged charge",
      webhookCreditRaceIsSafe(afterHookRace),
    );

    console.log("\nTEST — Stale checkout after a credit records the charge for owner review");
    const staleInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: staleInvoice.invoice.id,
      amount: "30.00",
      reason: "stale checkout credit",
      idempotencyKey: "stale-credit",
    });
    const stale = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: staleInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_stale_100",
        paymentReference: "pi_stale_100",
      }),
    );
    const afterStale = await invoiceTruth(tenantA.business.id, staleInvoice.invoice.id);
    check(
      "stale $100 checkout after a $30 credit records the payment for review",
      stale.applied === true &&
        stale.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        afterStale.payments.length === 1 &&
        afterStale.payments[0].amount.toString() === "100" &&
        (afterStale.payments[0].note ?? "").includes(STRIPE_CREDIT_MISMATCH_REVIEW_NOTE),
    );
    check(
      "stale checkout does not drop the succeeded charge",
      afterStale.payments.length === 1 && afterStale.credits.length === 1,
    );
    const mismatchAudit = await prisma.settingsAuditLog.findFirst({
      where: {
        businessId: tenantA.business.id,
        settingKey: "invoiceStripeCreditMismatch",
      },
    });
    check(
      "stale checkout flags owner review without refunding or messaging",
      Boolean(mismatchAudit) &&
        (mismatchAudit.newValue ?? "").includes(STRIPE_CREDIT_MISMATCH_REASON) &&
        (mismatchAudit.newValue ?? "").includes('"stripeRefund":false') &&
        (mismatchAudit.newValue ?? "").includes('"customerMessage":false'),
    );

    const wrongAmount = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: authInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 1,
      }),
    );
    check("non-credit amount mismatch is still rejected without recording", wrongAmount.reason === "amount_mismatch");

    const hugeStale = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: staleInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 99999999,
        checkoutSessionId: "cs_stale_huge",
        paymentReference: "pi_stale_huge",
      }),
    );
    const afterHuge = await invoiceTruth(tenantA.business.id, staleInvoice.invoice.id);
    check(
      "unbounded stale webhook is amount_mismatch with nothing recorded",
      hugeStale.reason === "amount_mismatch" && afterHuge.payments.length === 1,
    );
    check(
      "accepted stale checkout is visible for owner review",
      paymentsNeedingStripeCreditMismatchReview(afterStale.payments).length === 1 &&
        invoicePageSrc.includes("paymentsNeedingStripeCreditMismatchReview") &&
        dashboardSrc.includes("STRIPE_CREDIT_MISMATCH_OWNER_TITLE"),
    );

    console.log("\nTEST — Webhook after a fully credited invoice is recorded for refund review");
    const fullThenCharge = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: fullThenCharge.invoice.id,
      amount: "100.00",
      reason: "close before webhook",
      idempotencyKey: "full-then-charge",
    });
    const afterFullClose = await invoiceTruth(tenantA.business.id, fullThenCharge.invoice.id);
    const closedThenCharge = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: fullThenCharge.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_full_then_100",
        paymentReference: "pi_full_then_100",
      }),
    );
    const afterClosedCharge = await invoiceTruth(tenantA.business.id, fullThenCharge.invoice.id);
    check(
      "webhook after a full credit records the charge for owner refund review",
      afterFullClose.invoice.status === "PAID" &&
        afterFullClose.payments.length === 0 &&
        closedThenCharge.applied === true &&
        closedThenCharge.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        afterClosedCharge.payments.length === 1 &&
        afterClosedCharge.payments[0].amount.toString() === "100" &&
        paymentsNeedingStripeCreditMismatchReview(afterClosedCharge.payments).length === 1,
    );
    const closedHuge = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: fullThenCharge.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 99999999,
        checkoutSessionId: "cs_full_then_huge",
        paymentReference: "pi_full_then_huge",
      }),
    );
    const afterClosedHuge = await invoiceTruth(tenantA.business.id, fullThenCharge.invoice.id);
    check(
      "unbounded webhook after a full credit is amount_mismatch with the bound charge still recorded",
      closedHuge.reason === "amount_mismatch" && afterClosedHuge.payments.length === 1,
    );

    console.log("\nTEST — Checkout session amount and historical remaining-due");
    const sessionHistoryInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: sessionHistoryInvoice.invoice.id,
      amount: "30.00",
      reason: "first credit before session",
      idempotencyKey: "session-history-first",
    });
    await recordInvoiceCheckoutSession(prisma, {
      businessId: tenantA.business.id,
      invoiceId: sessionHistoryInvoice.invoice.id,
      stripeSessionId: "cs_net_70_stored",
      amountCents: 7000,
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: sessionHistoryInvoice.invoice.id,
      amount: "20.00",
      reason: "second credit after session",
      idempotencyKey: "session-history-second",
    });
    const afterTwoCredits = await invoiceTruth(tenantA.business.id, sessionHistoryInvoice.invoice.id);
    const storedSeventy = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: sessionHistoryInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 7000,
        checkoutSessionId: "cs_net_70_stored",
        paymentReference: "pi_net_70_stored",
      }),
    );
    const afterStoredSeventy = await invoiceTruth(tenantA.business.id, sessionHistoryInvoice.invoice.id);
    check(
      "session created at net 70 after the first credit is recorded and flagged after a second credit",
      afterTwoCredits.breakdown.amountDue.toString() === "50" &&
        storedSeventy.applied === true &&
        storedSeventy.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        afterStoredSeventy.payments.length === 1 &&
        afterStoredSeventy.payments[0].amount.toString() === "70" &&
        paymentsNeedingStripeCreditMismatchReview(afterStoredSeventy.payments).length === 1,
    );
    const arbitraryAfterStored = [];
    for (const cents of [99999999, 10001, 9999, 8000]) {
      const rejected = await applyVerifiedCheckoutPayment(
        prisma,
        webhookPayment({
          invoiceId: sessionHistoryInvoice.invoice.id,
          businessId: tenantA.business.id,
          connectedAccountId: tenantA.stripeAccountId,
          amountCents: cents,
          checkoutSessionId: `cs_arb_${cents}`,
          paymentReference: `pi_arb_${cents}`,
        }),
      );
      arbitraryAfterStored.push(rejected.reason === "amount_mismatch");
    }
    const afterArbitraryStored = await invoiceTruth(tenantA.business.id, sessionHistoryInvoice.invoice.id);
    check(
      "arbitrary amounts stay amount_mismatch with nothing extra recorded",
      arbitraryAfterStored.every(Boolean) && afterArbitraryStored.payments.length === 1,
    );

    const historyOnlyInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: historyOnlyInvoice.invoice.id,
      amount: "30.00",
      reason: "history first",
      idempotencyKey: "history-only-first",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: historyOnlyInvoice.invoice.id,
      amount: "20.00",
      reason: "history second",
      idempotencyKey: "history-only-second",
    });
    const historyOnlyTruth = await invoiceTruth(tenantA.business.id, historyOnlyInvoice.invoice.id);
    const historyAmounts = historicalRemainingDueCents({
      invoiceTotal: historyOnlyTruth.invoice.total,
      payments: historyOnlyTruth.payments,
      credits: historyOnlyTruth.credits,
    });
    const historySeventy = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: historyOnlyInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 7000,
        checkoutSessionId: "cs_history_70",
        paymentReference: "pi_history_70",
      }),
    );
    const afterHistorySeventy = await invoiceTruth(tenantA.business.id, historyOnlyInvoice.invoice.id);
    check(
      "session without a stored amount still accepts historical remaining due of 70",
      historyAmounts.includes(7000) &&
        historyAmounts.includes(10000) &&
        historyAmounts.includes(5000) &&
        historySeventy.applied === true &&
        historySeventy.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        afterHistorySeventy.payments.length === 1,
    );

    const payThenCredit = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: payThenCredit.invoice.id,
      amount: "40.00",
      method: "CASH",
    });
    await recordInvoiceCheckoutSession(prisma, {
      businessId: tenantA.business.id,
      invoiceId: payThenCredit.invoice.id,
      stripeSessionId: "cs_pay_then_60",
      amountCents: 6000,
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: payThenCredit.invoice.id,
      amount: "20.00",
      reason: "after payment session",
      idempotencyKey: "pay-then-credit",
    });
    const payThenStored = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: payThenCredit.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 6000,
        checkoutSessionId: "cs_pay_then_60",
        paymentReference: "pi_pay_then_60",
      }),
    );
    const payThenHistoryInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: payThenHistoryInvoice.invoice.id,
      amount: "40.00",
      method: "CASH",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: payThenHistoryInvoice.invoice.id,
      amount: "20.00",
      reason: "history after payment",
      idempotencyKey: "pay-then-history",
    });
    const payThenHistory = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: payThenHistoryInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 6000,
        checkoutSessionId: "cs_pay_then_history_60",
        paymentReference: "pi_pay_then_history_60",
      }),
    );
    check(
      "payment-then-credit histories accept the session amount with and without a stored record",
      payThenStored.applied === true &&
        payThenStored.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        payThenHistory.applied === true &&
        payThenHistory.reason === STRIPE_CREDIT_MISMATCH_REASON,
    );

    console.log("\nTEST — VOID invoice keeps VOID and flags a matching charge");
    const voidInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: voidInvoice.invoice.id,
      amount: "30.00",
      reason: "before void",
      idempotencyKey: "void-credit",
    });
    await prisma.invoice.update({
      where: { id: voidInvoice.invoice.id },
      data: { status: "VOID" },
    });
    const voidCharge = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: voidInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_void_100",
        paymentReference: "pi_void_100",
      }),
    );
    const afterVoid = await invoiceTruth(tenantA.business.id, voidInvoice.invoice.id);
    check(
      "matching webhook on a VOID invoice is recorded and flagged without changing VOID",
      voidCharge.applied === true &&
        voidCharge.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        afterVoid.invoice.status === "VOID" &&
        afterVoid.payments.length === 1 &&
        paymentsNeedingStripeCreditMismatchReview(afterVoid.payments).length === 1,
    );

    console.log("\nTEST — Cash close does not invent a $30 checkout amount");
    const cashCloseInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "100.00",
    });
    await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: cashCloseInvoice.invoice.id,
      amount: "30.00",
      reason: "before cash close",
      idempotencyKey: "cash-close-credit",
    });
    await recordOwnerInvoiceBalancePayment(prisma, ownerA, {
      invoiceId: cashCloseInvoice.invoice.id,
      amount: "70.00",
      method: "CASH",
    });
    const fakeThirty = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: cashCloseInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 3000,
        checkoutSessionId: "cs_fake_30",
        paymentReference: "pi_fake_30",
      }),
    );
    const realHundred = await applyVerifiedCheckoutPayment(
      prisma,
      webhookPayment({
        invoiceId: cashCloseInvoice.invoice.id,
        businessId: tenantA.business.id,
        connectedAccountId: tenantA.stripeAccountId,
        amountCents: 10000,
        checkoutSessionId: "cs_real_100",
        paymentReference: "pi_real_100",
      }),
    );
    const afterCashClose = await invoiceTruth(tenantA.business.id, cashCloseInvoice.invoice.id);
    check(
      "non-session $30 after cash close is amount_mismatch and the genuine $100 session is recorded",
      fakeThirty.reason === "amount_mismatch" &&
        realHundred.applied === true &&
        realHundred.reason === STRIPE_CREDIT_MISMATCH_REASON &&
        afterCashClose.payments.filter((payment) => payment.method === "STRIPE").length === 1 &&
        afterCashClose.payments.find((payment) => payment.method === "STRIPE")?.amount.toString() === "100",
    );

    console.log("\nTEST — OWNER can resolve a credit-mismatch flag");
    const reviewPayment = afterStoredSeventy.payments[0];
    await expectRejects(
      "MEMBER cannot resolve a Stripe credit-mismatch flag",
      () => resolveStripeCreditMismatchReview(prisma, memberA, reviewPayment.id),
      (error) => error instanceof ForbiddenError,
    );
    await expectRejects(
      "tenant B cannot resolve tenant A credit-mismatch flags",
      () => resolveStripeCreditMismatchReview(prisma, ownerB, reviewPayment.id),
      () => true,
    );
    const resolved = await resolveStripeCreditMismatchReview(prisma, ownerA, reviewPayment.id);
    const afterResolve = await invoiceTruth(tenantA.business.id, sessionHistoryInvoice.invoice.id);
    const openForA = await listOpenStripeCreditMismatchReviews(prisma, tenantA.business.id);
    const openForB = await listOpenStripeCreditMismatchReviews(prisma, tenantB.business.id);
    check(
      "resolve removes the flag from dashboard and reports surfaces",
      resolved.resolved === true &&
        paymentsNeedingStripeCreditMismatchReview(afterResolve.payments).length === 0 &&
        openForA.every((row) => row.id !== reviewPayment.id) &&
        openForB.length === 0,
    );

    console.log("\nTEST — Credit and webhook writers wait on the same Invoice lock");
    const lockInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await assertWaitsOnInvoiceLock(
      "credit writer waits on Invoice FOR UPDATE",
      lockInvoice.invoice,
      () =>
        recordOwnerInvoiceCredit(createExtraClient(), ownerA, {
          invoiceId: lockInvoice.invoice.id,
          amount: "10.00",
          reason: "lock wait credit",
          idempotencyKey: "lock-wait-credit",
        }),
    );
    const lockPayInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await assertWaitsOnInvoiceLock(
      "owner payment waits on Invoice FOR UPDATE",
      lockPayInvoice.invoice,
      () =>
        recordOwnerInvoiceBalancePayment(createExtraClient(), ownerA, {
          invoiceId: lockPayInvoice.invoice.id,
          amount: "10.00",
          method: "CASH",
        }),
    );
    const lockHookInvoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await assertWaitsOnInvoiceLock(
      "Stripe apply waits on Invoice FOR UPDATE",
      lockHookInvoice.invoice,
      () =>
        applyVerifiedCheckoutPayment(
          createExtraClient(),
          webhookPayment({
            invoiceId: lockHookInvoice.invoice.id,
            businessId: tenantA.business.id,
            connectedAccountId: tenantA.stripeAccountId,
            amountCents: 8000,
          }),
        ),
    );

    await recordSucceededPayment(prisma, {
      businessId: tenantB.business.id,
      customerId: tenantB.customer.id,
      jobId: foreign.job.id,
      invoiceId: foreign.invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal("20.00"),
      method: "CASH",
    });
    const tenantBAfter = await invoiceTruth(tenantB.business.id, foreign.invoice.id);
    check(
      "tenant B payments stay isolated from tenant A credits",
      tenantBAfter.payments.length === 1 &&
        tenantBAfter.credits.length === 0 &&
        tenantBAfter.breakdown.amountDue.toString() === "70",
    );
  }
  if (!MUTATION_KIND && failures === 0) {
    console.log("\nMUTATION — revert each guard and show the matching test fail");
    const mutations = [
      {
        kind: "credit-for-update",
        file: "src/lib/invoice-credits.ts",
        find: "FOR UPDATE",
        replace: "/* MUTATED_CREDIT_FOR_UPDATE */",
      },
      {
        kind: "payment-for-update",
        file: "src/lib/project-payments.ts",
        find: "FOR UPDATE",
        replace: "/* MUTATED_PAYMENT_FOR_UPDATE */",
      },
      {
        kind: "webhook-lock",
        file: "src/lib/payments/service.ts",
        find: "FOR UPDATE",
        replace: "/* MUTATED_WEBHOOK_FOR_UPDATE */",
      },
      {
        kind: "over-credit-guard",
        file: "src/lib/invoice-credits.ts",
        find: "    // INVOICE_CREDIT_OVER_CREDIT_GUARD\n    if (amount.gt(remaining)) {\n      throw new InvoiceCreditError(\"That amount is more than the remaining balance.\");\n    }",
        replace: "    // MUTATED_OVER_CREDIT_GUARD",
      },
      {
        kind: "idempotency-lookup",
        file: "src/lib/invoice-credits.ts",
        find: "    // INVOICE_CREDIT_IDEMPOTENCY_LOOKUP\n    const existing = await tx.invoiceCredit.findFirst({",
        replace: "    const existing = null; await tx.invoiceCredit.findFirst({",
      },
      {
        kind: "cents-validator",
        file: "src/lib/invoice-credits.ts",
        find: "if (!CREDIT_AMOUNT_PATTERN.test(trimmed))",
        replace: "if (false && !CREDIT_AMOUNT_PATTERN.test(trimmed))",
      },
      {
        kind: "credit-closed-cash",
        file: "src/lib/financial-intelligence/collected-revenue.ts",
        find: "  // CREDIT_CLOSED_NOT_LEGACY_CASH\n  if (invoiceIsCreditClosed(invoice, credits)) return 0;",
        replace: "  // MUTATED_CREDIT_CLOSED_CASH",
      },
      {
        kind: "stale-checkout-bound",
        file: "src/lib/payments/service.ts",
        find: "    // STALE_CHECKOUT_AMOUNT_BOUND\n    const historyMatch = !storedSession && historicalAmounts.includes(payment.amountCents);",
        replace: "    const historyMatch = credits.length > 0 && payment.amountCents > expectedCents;",
      },
      {
        kind: "stale-checkout-session-history",
        file: "src/lib/payments/service.ts",
        find: "    // STALE_CHECKOUT_AMOUNT_BOUND\n    const historyMatch = !storedSession && historicalAmounts.includes(payment.amountCents);",
        replace: "    const historyMatch = credits.length > 0 && payment.amountCents === staleCheckoutBoundCents(invoice.total, breakdown.amountPaid);",
      },
      {
        kind: "void-status-guard",
        file: "src/lib/payments/service.ts",
        find: "    const { breakdown, credits, payments } = await loadInvoicePaymentBreakdown(tx, invoice);",
        replace: "    if (invoice.status === \"VOID\") {\n      return { applied: false, reason: \"not_sent\" };\n    }\n    const { breakdown, credits, payments } = await loadInvoicePaymentBreakdown(tx, invoice);",
      },
      {
        kind: "credit-closed-exact-reference",
        file: "src/lib/financial-intelligence/collected-revenue.ts",
        find: "  // CREDIT_CLOSED_EXACT_REFERENCE\n  if (invoice.paymentMethod !== \"OTHER\") return false;\n  const reference = invoice.paymentReference ?? \"\";\n  return creditsOnInvoice(credits, invoice.id).some(\n    (credit) => credit.id && reference === recordedCreditReferenceFor(credit.id),\n  );",
        replace: "  return invoice.paymentMethod === \"OTHER\" && Boolean(invoice.paymentReference?.startsWith(RECORDED_CREDIT_REFERENCE_PREFIX));",
      },
      {
        kind: "dashboard-unresolved-filter",
        file: "src/lib/payments/service.ts",
        find: "  // STRIPE_CREDIT_MISMATCH_DASHBOARD_UNRESOLVED\n  return {\n    businessId,\n    note: { startsWith: STRIPE_CREDIT_MISMATCH_REVIEW_NOTE },\n    stripeCreditMismatchResolvedAt: null,\n  };",
        replace: "  return {\n    businessId,\n    note: { startsWith: STRIPE_CREDIT_MISMATCH_REVIEW_NOTE },\n  };",
      },
      {
        kind: "mismatch-resolve",
        file: "src/lib/payments/service.ts",
        find: "    data: { stripeCreditMismatchResolvedAt: new Date() },",
        replace: "    data: {},",
      },
      {
        kind: "stale-checkout-owner-review",
        file: "src/lib/payments/service.ts",
        find: "  // STRIPE_CREDIT_MISMATCH_OWNER_REVIEW\n  return payments.filter((payment) => isStripeCreditMismatchReviewNote(payment.note));",
        replace: "  return [];",
      },
      {
        kind: "stale-checkout-after-full-credit",
        file: "src/lib/payments/service.ts",
        find: "    // STALE_CHECKOUT_AFTER_FULL_CREDIT\n    if (!exactMatch && !staleCreditMatch) {",
        replace: "    if (invoice.status === \"PAID\" || breakdown.amountDue.lte(0)) {\n      return { applied: false, reason: \"already_paid\" };\n    }\n    if (!exactMatch && !staleCreditMatch) {",
      },
    ];

    const scriptPath = fileURLToPath(import.meta.url);
    for (const mutation of mutations) {
      const abs = fileURLToPath(new URL(`../${mutation.file}`, import.meta.url));
      const original = readFileSync(abs, "utf8");
      if (!original.includes(mutation.find)) {
        check(`mutation ${mutation.kind} found its target`, false);
        continue;
      }
      writeFileSync(abs, original.replace(mutation.find, mutation.replace));
      try {
        const child = spawnSync(
          process.execPath,
          ["--experimental-strip-types", scriptPath, "--mutation", mutation.kind],
          {
            encoding: "utf8",
            env: { ...process.env, DATABASE_URL: testUrl, TZ: "America/New_York" },
          },
        );
        check(
          `mutation ${mutation.kind} makes the matching test fail`,
          child.status !== 0,
        );
        if (child.status === 0) {
          console.error(child.stdout);
          console.error(child.stderr);
        }
      } finally {
        writeFileSync(abs, original);
      }
    }
  }
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  if (MUTATION_KIND) {
    await prisma.$disconnect();
  } else if (session) {
    await session.cleanup();
  }
}

if (failures > 0) {
  console.error(`\n${failures} invoice credit check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll invoice credit checks passed (${passes}).`);
