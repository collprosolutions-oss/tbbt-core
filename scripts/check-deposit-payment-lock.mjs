/**
 * Concurrent material-deposit apply: Estimate FOR UPDATE, two distinct
 * paid sessions, same remaining deposit, two real Prisma connections.
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
    "deposit apply takes Estimate FOR UPDATE under ESTIMATE_DEPOSIT_FOR_UPDATE",
    serviceSrc.includes("ESTIMATE_DEPOSIT_FOR_UPDATE") &&
      /FROM "Estimate"\s+WHERE id = \$\{estimateId\} AND "businessId" = \$\{payment\.businessId\}\s+FOR UPDATE/.test(
        serviceSrc,
      ),
  );
  check(
    "deposit apply wraps the locked sequence in isPrismaClient ? $transaction : fn(db)",
    serviceSrc.includes("async function applyVerifiedDepositPayment") &&
      serviceSrc.includes("return isPrismaClient(db) ? db.$transaction(applyLocked) : applyLocked(db);"),
  );
  check(
    "remaining-due read and recordSucceededPayment stay under the same lock",
    /alreadyPaid[\s\S]*invoiceRemainingReadTestHooks\.afterRead\(\);[\s\S]*recordSucceededPayment\(tx,/.test(
      serviceSrc.slice(serviceSrc.indexOf("async function applyVerifiedDepositPayment")),
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
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  invoicePaymentBreakdown,
  invoiceRemainingReadTestHooks,
  listPaymentsForInvoice,
  loadEstimatePaymentSummary,
  requiredDepositFromLines,
} = await import("@/lib/project-payments");

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
  invoiceRemainingReadTestHooks.afterRead = async () => sleep(250);
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

async function raceDistinctDepositSessions(tenant, job, requiredCents) {
  const clientA = createExtraClient();
  const clientB = createExtraClient();
  const paymentA = depositWebhook({
    estimateId: job.estimate.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: requiredCents,
    checkoutSessionId: `cs_test_deposit_a_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_deposit_a_${randomUUID().slice(0, 8)}`,
  });
  const paymentB = depositWebhook({
    estimateId: job.estimate.id,
    businessId: tenant.business.id,
    connectedAccountId: tenant.stripeAccountId,
    amountCents: requiredCents,
    checkoutSessionId: `cs_test_deposit_b_${randomUUID().slice(0, 8)}`,
    paymentReference: `pi_test_deposit_b_${randomUUID().slice(0, 8)}`,
  });
  try {
    const results = await withForcedRemainingOverlap(() =>
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

async function proveLockedRace(tenantA, tenantB) {
  const job = await seedApprovedDepositJob(tenantA);
  const other = await seedApprovedDepositJob(tenantB);
  const requiredCents = 30000;
  check("required deposit from MATERIAL lines is $300", job.required.toFixed(2) === "300.00");

  const raced = await raceDistinctDepositSessions(tenantA, job, requiredCents);
  const rows = await prisma.payment.findMany({
    where: {
      businessId: tenantA.business.id,
      estimateId: job.estimate.id,
      purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    },
    orderBy: { createdAt: "asc" },
  });
  check(
    "concurrent distinct sessions create exactly one MATERIAL_DEPOSIT row",
    raceDidNotDoubleApply(raced.results, rows, job.required),
  );
  check(
    "loser returns already_paid or amount_mismatch",
    raced.results.some(
      (row) =>
        row.applied === false &&
        (row.reason === "already_paid" || row.reason === "amount_mismatch"),
    ),
  );

  const summary = await loadEstimatePaymentSummary(prisma, {
    businessId: tenantA.business.id,
    estimateId: job.estimate.id,
    estimateTotal: "1000.00",
    requiredDeposit: "300.00",
  });
  check("deposit paid equals required $300", summary.depositPaid.toFixed(2) === "300.00");
  check("deposit remaining is $0", summary.depositRemaining.toFixed(2) === "0.00");

  const estimate = await prisma.estimate.findUniqueOrThrow({
    where: { id: job.estimate.id },
  });
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: job.invoice.id },
  });
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
  const otherEstimate = await prisma.estimate.findUniqueOrThrow({
    where: { id: other.estimate.id },
  });
  check(
    "second business estimate is unaffected",
    otherPayments === 0 && otherEstimate.status === "APPROVED",
  );

  const replay = await applyVerifiedCheckoutPayment(prisma, raced.paymentA);
  const afterReplay = await prisma.payment.count({
    where: {
      businessId: tenantA.business.id,
      estimateId: job.estimate.id,
      purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    },
  });
  check(
    "same-session replay returns already_paid with one row",
    replay.applied === false && replay.reason === "already_paid" && afterReplay === 1,
  );

  return { job, rows, raced };
}

try {
  const tenantA = await seedWorkspace("DepositLockA");
  const tenantB = await seedWorkspace("DepositLockB");

  if (MUTATION_KIND === "estimate-deposit-for-update") {
    console.log("\nMUTATION CHILD — concurrent distinct sessions without Estimate FOR UPDATE");
    const job = await seedApprovedDepositJob(tenantA);
    const raced = await raceDistinctDepositSessions(tenantA, job, 30000);
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
  } else {
    console.log("\nTEST — Two connections, two paid sessions, one remaining deposit");
    await proveLockedRace(tenantA, tenantB);

    console.log("\nTEST — Deposit apply waits on Estimate FOR UPDATE");
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
            FOR UPDATE
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
          check("deposit writer waits on Estimate FOR UPDATE", finishedWhileHeld === false);
        },
        { maxWait: 5_000, timeout: 20_000 },
      );
      await pending;
    } finally {
      await holder.$disconnect();
    }

    if (failures === 0) {
      console.log("\nMUTATION — remove the Estimate lock and show the race fails by double-applying");
      const mutation = {
        kind: "estimate-deposit-for-update",
        file: "src/lib/payments/service.ts",
        find: `    // ESTIMATE_DEPOSIT_FOR_UPDATE
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id
      FROM "Estimate"
      WHERE id = \${estimateId} AND "businessId" = \${payment.businessId}
      FOR UPDATE
    \`;`,
        replace: `    // MUTATED_ESTIMATE_DEPOSIT_FOR_UPDATE
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id
      FROM "Estimate"
      WHERE id = \${estimateId} AND "businessId" = \${payment.businessId}
    \`;`,
      };
      const abs = fileURLToPath(new URL(`../${mutation.file}`, import.meta.url));
      const original = readFileSync(abs, "utf8");
      if (!original.includes(mutation.find)) {
        check("mutation estimate-deposit-for-update found its target", false);
      } else {
        writeFileSync(abs, original.replace(mutation.find, mutation.replace));
        try {
          const child = spawnSync(
            process.execPath,
            ["--experimental-strip-types", fileURLToPath(import.meta.url), "--mutation", mutation.kind],
            {
              encoding: "utf8",
              env: { ...process.env, DATABASE_URL: testUrl, TZ: "America/New_York" },
            },
          );
          check(
            "mutation estimate-deposit-for-update makes the matching test fail",
            child.status !== 0,
          );
          if (child.status === 0) {
            console.error(child.stdout);
            console.error(child.stderr);
          } else {
            const childFailedRace = /FAIL - concurrent distinct sessions create exactly one MATERIAL_DEPOSIT row/.test(
              child.stdout + child.stderr,
            );
            check(
              "mutation child failed by double-applying the deposit",
              childFailedRace,
            );
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
