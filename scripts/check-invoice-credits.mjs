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
function check(label, condition) {
  if (condition) {
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
const formSrc = readRepo("src/components/invoices/record-invoice-credit-form.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");
const authSrc = readRepo("src/lib/authorization.ts");
const projectPaymentsSrc = readRepo("src/lib/project-payments.ts");
const paymentServiceSrc = readRepo("src/lib/payments/service.ts");
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
          countTopLevelArgs(inner) >= 3 && /credit/i.test(inner),
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
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
  recordOwnerInvoiceBalancePayment,
  recordSucceededPayment,
  sumInvoiceRemainingDue,
} = await import("@/lib/project-payments");
const {
  applyVerifiedCheckoutPayment,
  STRIPE_CREDIT_MISMATCH_REASON,
  STRIPE_CREDIT_MISMATCH_REVIEW_NOTE,
} = await import("@/lib/payments");
const { invoiceBalanceDue, outstandingReceivableAmount } =
  await import("@/lib/financial-intelligence/collected-revenue");

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

function createExtraClient() {
  if (session) return session.createClient();
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasourceUrl: testUrl });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    const replay = await recordOwnerInvoiceCredit(prisma, ownerA, {
      invoiceId: invoice.invoice.id,
      amount: "10.00",
      reason: "first",
      idempotencyKey: "mutation-idem",
    });
    check("idempotent replay uses the pre-insert lookup", replay.replayedViaLookup === true);
  } else if (MUTATION_KIND === "credit-for-update") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await assertWaitsOnInvoiceLock(
      "credit writer waits on Invoice FOR UPDATE",
      invoice.invoice,
      () =>
        recordOwnerInvoiceCredit(createExtraClient(), ownerA, {
          invoiceId: invoice.invoice.id,
          amount: "10.00",
          reason: "lock wait",
          idempotencyKey: "mutation-credit-lock",
        }),
    );
  } else if (MUTATION_KIND === "payment-for-update") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await assertWaitsOnInvoiceLock(
      "owner payment waits on Invoice FOR UPDATE",
      invoice.invoice,
      () =>
        recordOwnerInvoiceBalancePayment(createExtraClient(), ownerA, {
          invoiceId: invoice.invoice.id,
          amount: "10.00",
          method: "CASH",
        }),
    );
  } else if (MUTATION_KIND === "webhook-lock") {
    const invoice = await seedSentInvoice({
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      total: "80.00",
    });
    await assertWaitsOnInvoiceLock(
      "Stripe apply waits on Invoice FOR UPDATE",
      invoice.invoice,
      () =>
        applyVerifiedCheckoutPayment(
          createExtraClient(),
          webhookPayment({
            invoiceId: invoice.invoice.id,
            businessId: tenantA.business.id,
            connectedAccountId: tenantA.stripeAccountId,
            amountCents: 8000,
          }),
        ),
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
      const settled = await Promise.allSettled([
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
      ]);
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
      await Promise.allSettled([
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
      ]);
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
      await Promise.allSettled([
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
      ]);
    } finally {
      await hookClientA.$disconnect();
      await hookClientB.$disconnect();
    }
    const afterHookRace = await invoiceTruth(tenantA.business.id, hookInvoice.invoice.id);
    const hookApplied = afterHookRace.breakdown.amountPaid.add(afterHookRace.breakdown.recordedCredit);
    check(
      "webhook and credit together cannot exceed the invoice total",
      hookApplied.toString() === "100" && afterHookRace.breakdown.amountDue.toString() === "0",
    );
    check(
      "webhook/credit race has either one payment or one credit, not both",
      (afterHookRace.payments.length === 1 && afterHookRace.credits.length === 0) ||
        (afterHookRace.payments.length === 0 && afterHookRace.credits.length === 1),
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

console.log("\nAll invoice credit checks passed.");
