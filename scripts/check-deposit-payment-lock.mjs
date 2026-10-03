/**
 * Concurrent material-deposit apply: Estimate FOR NO KEY UPDATE, two
 * distinct paid sessions, and deposit-vs-invoice-balance lock order.
 *
 * Fake Stripe adapter / cs_test_ fixtures only. No live charge.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-deposit-payment-lock.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
if (process.env.VERCEL_ENV === "production") {
  process.env.VERCEL_ENV = "preview";
}

const MUTATION_KIND = process.argv.includes("--mutation")
  ? process.argv[process.argv.indexOf("--mutation") + 1]
  : null;

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

let failures = 0;
let passes = 0;
function check(label, condition) {
  if (condition) {
    passes += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${label}`);
  }
}

const selfSrc = readRepo("scripts/check-deposit-payment-lock.mjs");
const serviceSrc = readRepo("src/lib/payments/service.ts");
const projectPaymentsSrc = readRepo("src/lib/project-payments.ts");
const depositFnSrc = serviceSrc.slice(serviceSrc.indexOf("async function applyVerifiedDepositPayment"));

if (!MUTATION_KIND) {
  console.log("\nSTATIC — deposit apply locks Estimate for the remaining-due write");
  check(
    "this verifier uses the shared disposable harness",
    selfSrc.includes('from "./disposable-test-database.mjs"') &&
      selfSrc.includes("openDisposableTestDatabase") &&
      selfSrc.includes("assertLocalDatabaseUrl"),
  );
  check("verifier stays on the fake Stripe adapter", selfSrc.includes('TBBT_PAYMENTS_ADAPTER = "fake"'));
  check(
    "verifier never mentions a live Stripe secret",
    !selfSrc.includes("sk_" + "live") && !/STRIPE_SECRET_KEY\s*=/.test(selfSrc),
  );
  check(
    "deposit apply takes Estimate FOR NO KEY UPDATE scoped by id and businessId",
    serviceSrc.includes("ESTIMATE_DEPOSIT_FOR_NO_KEY_UPDATE") &&
      /FROM "Estimate"\s+WHERE id = \$\{estimateId\} AND "businessId" = \$\{payment\.businessId\}\s+FOR NO KEY UPDATE/.test(
        serviceSrc,
      ) &&
      !/^      FOR UPDATE$/m.test(depositFnSrc),
  );
  check(
    "deposit apply wraps the locked sequence in isPrismaClient ? $transaction : fn(db)",
    serviceSrc.includes("async function applyVerifiedDepositPayment") &&
      serviceSrc.includes("return isPrismaClient(db) ? db.$transaction(applyLocked) : applyLocked(db);"),
  );
  check(
    "remaining-due read and recordSucceededPayment stay under the same lock",
    /alreadyPaid[\s\S]*invoiceRemainingReadTestHooks\.afterRead\(\);[\s\S]*recordSucceededPayment\(tx,/.test(
      depositFnSrc,
    ),
  );
  check(
    "session and payment-intent unique-index / P2002 dedupe stays in recordSucceededPayment",
    projectPaymentsSrc.includes("stripeCheckoutSessionId") &&
      projectPaymentsSrc.includes("stripePaymentIntentId") &&
      projectPaymentsSrc.includes('error.code === "P2002"'),
  );
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const require = createRequire(import.meta.url);

let session = null;
let prisma;
let testUrl;

if (MUTATION_KIND) {
  assertLocalDatabaseUrl(baseUrl, "deposit-payment-lock mutation child");
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient({ datasourceUrl: baseUrl });
  testUrl = baseUrl;
} else {
  assertLocalDatabaseUrl(baseUrl, "deposit-payment-lock disposable database");
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_deposit_lock",
    setProcessEnv: true,
  });
  prisma = session.prisma;
  testUrl = session.testUrl;
}

const { Prisma } = await import("@prisma/client");
const { applyVerifiedCheckoutPayment } = await import("@/lib/payments/service");
const {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  invoicePaymentBreakdown,
  invoiceRemainingReadTestHooks,
  listPaymentsForInvoice,
  loadEstimatePaymentSummary,
  recordOwnerInvoiceBalancePayment,
  requiredDepositFromLines,
} = await import("@/lib/project-payments");

function createExtraClient() {
  if (session) return session.createClient();
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasourceUrl: testUrl });
}

function makeAccess(businessId, membershipId, role = "OWNER") {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Deposit Lock Tenant" },
      membership: { id: membershipId },
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeadlockError(error) {
  const code = error?.code ?? error?.meta?.code ?? "";
  const message = String(error?.message ?? error);
  return (
    code === "40P01" ||
    code === "P2034" ||
    message.includes("40P01") ||
    /deadlock/i.test(message)
  );
}

async function withSleepOverlap(delayMs, work) {
  const previous = invoiceRemainingReadTestHooks.afterRead;
  invoiceRemainingReadTestHooks.afterRead = async () => sleep(delayMs);
  try {
    return await work();
  } finally {
    invoiceRemainingReadTestHooks.afterRead = previous;
  }
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
    await opened;
    if (extraDelayMs) await sleep(extraDelayMs);
  };
  try {
    return await work();
  } finally {
    invoiceRemainingReadTestHooks.afterRead = previous;
  }
}

async function seedWorkspace(name) {
  const ownerUser = await prisma.user.create({
    data: {
      name: `${name} Owner`,
      email: `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: { name, slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}` },
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
      addressLine1: "10 Deposit Lock Ave",
    },
  });
  const stripeAccountId = `acct_test_${business.id.slice(0, 12)}`;
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: business.id,
      provider: "stripe",
      stripeAccountId,
    },
  });
  return { business, membership, customer, property, stripeAccountId };
}

async function seedApprovedDepositJob(tenant) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId: tenant.business.id,
      customerId: tenant.customer.id,
      propertyId: tenant.property.id,
      status: "APPROVED",
      total: new Prisma.Decimal("1000.00"),
      publicToken: randomUUID(),
      lineItems: {
        create: [
          {
            businessId: tenant.business.id,
            description: "Install shelves",
            quantity: new Prisma.Decimal("1"),
            unitPrice: new Prisma.Decimal("700.00"),
            total: new Prisma.Decimal("700.00"),
            type: "LABOR",
          },
          {
            businessId: tenant.business.id,
            description: "Lumber and hardware",
            quantity: new Prisma.Decimal("1"),
            unitPrice: new Prisma.Decimal("300.00"),
            total: new Prisma.Decimal("300.00"),
            type: "MATERIAL",
          },
        ],
      },
    },
    include: { lineItems: true },
  });
  const required = requiredDepositFromLines(estimate.lineItems, estimate.total);
  const job = await prisma.job.create({
    data: {
      businessId: tenant.business.id,
      customerId: tenant.customer.id,
      propertyId: tenant.property.id,
      estimateId: estimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: tenant.business.id,
      customerId: tenant.customer.id,
      jobId: job.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: new Prisma.Decimal("1000.00"),
    },
  });
  return { estimate, job, invoice, required };
}

function depositWebhook(input) {
  const stamp = randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    purpose: "material_deposit",
    invoiceId: null,
    estimateId: input.estimateId,
    checkoutSessionId: input.checkoutSessionId ?? `cs_test_${stamp}`,
    businessId: input.businessId,
    connectedAccountId: input.connectedAccountId,
    amountCents: input.amountCents,
    currency: "usd",
    paymentReference: input.paymentReference ?? `pi_test_${stamp}`,
    paymentStatus: "paid",
  };
}

function invoiceWebhook(input) {
  const stamp = randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    purpose: "invoice_balance",
    invoiceId: input.invoiceId,
    estimateId: null,
    checkoutSessionId: input.checkoutSessionId ?? `cs_test_${stamp}`,
    businessId: input.businessId,
    connectedAccountId: input.connectedAccountId,
    amountCents: input.amountCents,
    currency: "usd",
    paymentReference: input.paymentReference ?? `pi_test_${stamp}`,
    paymentStatus: "paid",
  };
}

async function raceDistinctDepositSessions(tenant, seeded, delayMs = 250) {
  const clientA = createExtraClient();
  const clientB = createExtraClient();
  const paymentA = depositWebhook({
    estimateId: seeded.estimate.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: 30000,
    checkoutSessionId: `cs_test_deposit_a_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_deposit_a_${randomUUID().slice(0, 8)}`,
  });
  const paymentB = depositWebhook({
    estimateId: seeded.estimate.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: 30000,
    checkoutSessionId: `cs_test_deposit_b_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_deposit_b_${randomUUID().slice(0, 8)}`,
  });
  try {
    const results = await withSleepOverlap(delayMs, () =>
      Promise.all([
        applyVerifiedCheckoutPayment(clientA, paymentA),
        applyVerifiedCheckoutPayment(clientB, paymentB),
      ]),
    );
    return { results, paymentA, paymentB };
  } finally {
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
}

function raceDidNotDoubleApply(results, rows, required) {
  const applied = results.filter((row) => row.applied === true);
  const rejected = results.filter(
    (row) =>
      row.applied === false &&
      (row.reason === "already_paid" || row.reason === "amount_mismatch"),
  );
  const depositTotal = rows.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
  return (
    rows.length === 1 &&
    applied.length === 1 &&
    applied[0].reason === "paid" &&
    rejected.length === 1 &&
    depositTotal.toFixed(2) === required.toFixed(2)
  );
}

async function listJobPayments(businessId, seeded) {
  return prisma.payment.findMany({
    where: {
      businessId,
      OR: [{ estimateId: seeded.estimate.id }, { invoiceId: seeded.invoice.id }, { jobId: seeded.job.id }],
    },
    orderBy: { createdAt: "asc" },
  });
}

function summarizeSettled(settled) {
  const deadlocks = [];
  const throws = [];
  const values = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      values.push(item.value);
      continue;
    }
    if (isDeadlockError(item.reason)) deadlocks.push(item.reason);
    else throws.push(item.reason);
  }
  return { deadlocks, throws, values };
}

async function raceDepositVsInvoiceBalance(tenant, seeded, extraDelayMs = 0) {
  const clientA = createExtraClient();
  const clientB = createExtraClient();
  const deposit = depositWebhook({
    estimateId: seeded.estimate.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: 30000,
    checkoutSessionId: `cs_test_dep_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_dep_${randomUUID().slice(0, 8)}`,
  });
  const invoicePay = invoiceWebhook({
    invoiceId: seeded.invoice.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: 100000,
    checkoutSessionId: `cs_test_inv_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_inv_${randomUUID().slice(0, 8)}`,
  });
  try {
    const settled = await withArrivalBarrier(
      () =>
        Promise.allSettled([
          applyVerifiedCheckoutPayment(clientA, deposit),
          applyVerifiedCheckoutPayment(clientB, invoicePay),
        ]),
      extraDelayMs,
    );
    return { settled, deposit, invoicePay };
  } finally {
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
}

async function raceDepositVsOwnerBalance(tenant, seeded, extraDelayMs = 0) {
  const clientA = createExtraClient();
  const clientB = createExtraClient();
  const access = makeAccess(tenant.business.id, tenant.membership.id);
  const deposit = depositWebhook({
    estimateId: seeded.estimate.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: 30000,
    checkoutSessionId: `cs_test_own_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_own_${randomUUID().slice(0, 8)}`,
  });
  try {
    const settled = await withArrivalBarrier(
      () =>
        Promise.allSettled([
          applyVerifiedCheckoutPayment(clientA, deposit),
          recordOwnerInvoiceBalancePayment(clientB, access, {
            invoiceId: seeded.invoice.id,
            amount: "1000.00",
            method: "CASH",
          }),
        ]),
      extraDelayMs,
    );
    return { settled, deposit };
  } finally {
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
}

function mixedRaceTotalsOk(rows) {
  const deposits = rows.filter((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT);
  const balances = rows.filter((row) => row.purpose === PAYMENT_PURPOSE_INVOICE_BALANCE);
  const depositTotal = deposits.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
  const balanceTotal = balances.reduce((sum, row) => sum.add(row.amount), new Prisma.Decimal(0));
  return (
    deposits.length === 1 &&
    balances.length === 1 &&
    depositTotal.toFixed(2) === "300.00" &&
    balanceTotal.toFixed(2) === "1000.00"
  );
}

async function proveLockedDepositRace(tenantA, tenantB) {
  const delays = [50, 150, 250, 400];
  for (const delayMs of delays) {
    const job = await seedApprovedDepositJob(tenantA);
    const raced = await raceDistinctDepositSessions(tenantA, job, delayMs);
    const rows = await prisma.payment.findMany({
      where: {
        businessId: tenantA.business.id,
        estimateId: job.estimate.id,
        purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
      },
    });
    check(
      `deposit-vs-deposit delay ${delayMs}ms is one MATERIAL_DEPOSIT row`,
      raceDidNotDoubleApply(raced.results, rows, job.required),
    );
  }

  const job = await seedApprovedDepositJob(tenantA);
  const other = await seedApprovedDepositJob(tenantB);
  check("required deposit from MATERIAL lines is $300", job.required.toFixed(2) === "300.00");
  const raced = await raceDistinctDepositSessions(tenantA, job, 250);
  const rows = await prisma.payment.findMany({
    where: {
      businessId: tenantA.business.id,
      estimateId: job.estimate.id,
      purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    },
  });
  const summary = await loadEstimatePaymentSummary(prisma, {
    businessId: tenantA.business.id,
    estimateId: job.estimate.id,
    estimateTotal: "1000.00",
    requiredDeposit: "300.00",
  });
  const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: job.estimate.id } });
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: job.invoice.id } });
  const invoicePayments = await listPaymentsForInvoice(prisma, {
    businessId: tenantA.business.id,
    invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
  });
  const breakdown = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments: invoicePayments,
    credits: [],
  });
  check("deposit paid equals required $300", summary.depositPaid.toFixed(2) === "300.00");
  check("deposit remaining is $0", summary.depositRemaining.toFixed(2) === "0.00");
  check("estimate stays APPROVED", estimate.status === "APPROVED");
  check(
    "invoice stays SENT with $700 remaining after the deposit",
    invoice.status === "SENT" &&
      invoice.paymentMethod == null &&
      breakdown.amountDue.toFixed(2) === "700.00" &&
      breakdown.amountPaid.toFixed(2) === "300.00",
  );
  const otherPayments = await prisma.payment.count({
    where: { businessId: tenantB.business.id, estimateId: other.estimate.id },
  });
  check("second business estimate is unaffected", otherPayments === 0);
  const replay = await applyVerifiedCheckoutPayment(prisma, raced.paymentA);
  check(
    "same-session replay returns already_paid with one row",
    replay.applied === false && replay.reason === "already_paid" && rows.length === 1,
  );
}

async function runMixedRaceLoop(label, runner, iterations, delays) {
  let deadlocks = 0;
  let throws = 0;
  let badTotals = 0;
  for (let i = 0; i < iterations; i += 1) {
    const extraDelayMs = delays[i % delays.length];
    const tenant = await seedWorkspace(`${label}${i}`);
    const seeded = await seedApprovedDepositJob(tenant);
    const raced = await runner(tenant, seeded, extraDelayMs);
    const summarized = summarizeSettled(raced.settled);
    if (summarized.deadlocks.length) deadlocks += 1;
    if (summarized.throws.length) throws += 1;
    const rows = await listJobPayments(tenant.business.id, seeded);
    if (!mixedRaceTotalsOk(rows)) badTotals += 1;
    if (summarized.throws.length && !summarized.deadlocks.length) {
      console.error(summarized.throws[0]);
    }
  }
  return { deadlocks, throws, badTotals };
}

try {
  const tenantA = await seedWorkspace("DepositLockA");
  const tenantB = await seedWorkspace("DepositLockB");

  if (MUTATION_KIND === "estimate-deposit-no-lock") {
    console.log("\nMUTATION CHILD — concurrent distinct deposit sessions without a lock");
    const job = await seedApprovedDepositJob(tenantA);
    const raced = await raceDistinctDepositSessions(tenantA, job, 250);
    const rows = await prisma.payment.findMany({
      where: {
        businessId: tenantA.business.id,
        estimateId: job.estimate.id,
        purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
      },
    });
    check(
      "concurrent distinct sessions create exactly one MATERIAL_DEPOSIT row",
      raceDidNotDoubleApply(raced.results, rows, job.required),
    );
  } else if (MUTATION_KIND === "estimate-deposit-for-update-deadlock") {
    console.log("\nMUTATION CHILD — deposit vs invoice-balance with Estimate FOR UPDATE");
    const delays = [0, 10, 25, 40];
    const outcome = await runMixedRaceLoop(
      "DeadlockMut",
      raceDepositVsInvoiceBalance,
      8,
      delays,
    );
    check(
      "deposit vs invoice-balance has zero deadlocks or throws",
      outcome.deadlocks === 0 && outcome.throws === 0,
    );
    check(
      "each mixed race records one deposit and one invoice payment",
      outcome.badTotals === 0,
    );
  } else {
    console.log("\nTEST — Two connections, two paid deposit sessions, one remaining deposit");
    await proveLockedDepositRace(tenantA, tenantB);

    console.log("\nTEST — Deposit apply waits on Estimate FOR NO KEY UPDATE");
    const lockJob = await seedApprovedDepositJob(tenantA);
    const holder = createExtraClient();
    let finishedWhileHeld = false;
    let pending = Promise.resolve();
    try {
      await holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id
            FROM "Estimate"
            WHERE id = ${lockJob.estimate.id} AND "businessId" = ${tenantA.business.id}
            FOR NO KEY UPDATE
          `;
          const writer = createExtraClient();
          pending = applyVerifiedCheckoutPayment(
            writer,
            depositWebhook({
              estimateId: lockJob.estimate.id,
              businessId: tenantA.business.id,
              connectedAccountId: tenantA.stripeAccountId,
              amountCents: 30000,
            }),
          ).finally(() => writer.$disconnect());
          pending.then(
            () => {
              finishedWhileHeld = true;
            },
            () => {
              finishedWhileHeld = true;
            },
          );
          await sleep(400);
          check("deposit writer waits on Estimate FOR NO KEY UPDATE", finishedWhileHeld === false);
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
      await pending;
    } finally {
      await holder.$disconnect();
    }

    console.log("\nTEST — Deposit vs invoice-balance webhook, 20 overlapped iterations");
    const invoiceOutcome = await runMixedRaceLoop(
      "DepInv",
      raceDepositVsInvoiceBalance,
      20,
      [0, 5, 15, 30, 50],
    );
    check(
      "deposit vs invoice-balance has zero deadlocks or throws across 20 iterations",
      invoiceOutcome.deadlocks === 0 && invoiceOutcome.throws === 0,
    );
    check(
      "each deposit vs invoice-balance race records $300 deposit and $1000 invoice once",
      invoiceOutcome.badTotals === 0,
    );
    if (invoiceOutcome.deadlocks || invoiceOutcome.throws || invoiceOutcome.badTotals) {
      console.error(
        `  mixed invoice race deadlocks=${invoiceOutcome.deadlocks} throws=${invoiceOutcome.throws} badTotals=${invoiceOutcome.badTotals}`,
      );
    }

    console.log("\nTEST — Deposit vs owner invoice-balance payment, 20 overlapped iterations");
    const ownerOutcome = await runMixedRaceLoop(
      "DepOwn",
      raceDepositVsOwnerBalance,
      20,
      [0, 5, 15, 30, 50],
    );
    check(
      "deposit vs owner-balance has zero deadlocks or throws across 20 iterations",
      ownerOutcome.deadlocks === 0 && ownerOutcome.throws === 0,
    );
    check(
      "each deposit vs owner-balance race records $300 deposit and $1000 cash once",
      ownerOutcome.badTotals === 0,
    );
    if (ownerOutcome.deadlocks || ownerOutcome.throws || ownerOutcome.badTotals) {
      console.error(
        `  mixed owner race deadlocks=${ownerOutcome.deadlocks} throws=${ownerOutcome.throws} badTotals=${ownerOutcome.badTotals}`,
      );
    }

    if (failures === 0) {
      console.log("\nMUTATION — revert lock strength / remove lock and show the matching test fail");
      const abs = fileURLToPath(new URL("../src/lib/payments/service.ts", import.meta.url));
      const original = readFileSync(abs, "utf8");
      const mutations = [
        {
          kind: "estimate-deposit-for-update-deadlock",
          find: `    // ESTIMATE_DEPOSIT_FOR_NO_KEY_UPDATE
    // NO KEY so Payment FK inserts (FOR KEY SHARE on Estimate) from the
    // invoice-balance path cannot deadlock against this lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id
      FROM "Estimate"
      WHERE id = \${estimateId} AND "businessId" = \${payment.businessId}
      FOR NO KEY UPDATE
    \`;`,
          replace: `    // MUTATED_ESTIMATE_DEPOSIT_FOR_UPDATE
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id
      FROM "Estimate"
      WHERE id = \${estimateId} AND "businessId" = \${payment.businessId}
      FOR UPDATE
    \`;`,
          failedHow: (stdout, stderr) =>
            /FAIL - deposit vs invoice-balance has zero deadlocks/.test(stdout + stderr) ||
            /40P01|deadlock|P2034/i.test(stdout + stderr),
          label: "mutation estimate-deposit-for-update-deadlock fails with a deadlock",
        },
        {
          kind: "estimate-deposit-no-lock",
          find: `    // ESTIMATE_DEPOSIT_FOR_NO_KEY_UPDATE
    // NO KEY so Payment FK inserts (FOR KEY SHARE on Estimate) from the
    // invoice-balance path cannot deadlock against this lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id
      FROM "Estimate"
      WHERE id = \${estimateId} AND "businessId" = \${payment.businessId}
      FOR NO KEY UPDATE
    \`;`,
          replace: `    // MUTATED_ESTIMATE_DEPOSIT_NO_LOCK
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id
      FROM "Estimate"
      WHERE id = \${estimateId} AND "businessId" = \${payment.businessId}
    \`;`,
          failedHow: (stdout, stderr) =>
            /FAIL - concurrent distinct sessions create exactly one MATERIAL_DEPOSIT row/.test(
              stdout + stderr,
            ),
          label: "mutation estimate-deposit-no-lock fails by double-applying the deposit",
        },
      ];

      const scriptPath = fileURLToPath(import.meta.url);
      for (const mutation of mutations) {
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
          const output = `${child.stdout}\n${child.stderr}`;
          check(`mutation ${mutation.kind} makes the matching test fail`, child.status !== 0);
          if (child.status === 0) {
            console.error(output);
          } else {
            check(mutation.label, mutation.failedHow(child.stdout, child.stderr));
            if (!mutation.failedHow(child.stdout, child.stderr)) {
              console.error(output);
            }
          }
        } finally {
          writeFileSync(abs, original);
        }
      }
    }
  }
} catch (error) {
  failures += 1;
  console.error("FAIL - deposit-payment-lock proofs crashed");
  console.error(error);
} finally {
  if (MUTATION_KIND) {
    await prisma.$disconnect();
  } else if (session) {
    await session.cleanup();
  }
}

if (failures > 0) {
  console.error(`\n${failures} deposit-payment-lock check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll deposit-payment-lock checks passed (${passes}).`);
