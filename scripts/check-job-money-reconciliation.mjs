/**
 * One-job money reconciliation: estimate snapshot, material deposit,
 * invoice, partial payment, fully credited supplemental, Stripe
 * checkout/webhook, duplicate webhook, stale-checkout refund-review,
 * profitability, and accounting export.
 *
 * Every displayed balance and collected-cash figure is proven against
 * recorded Payment / InvoiceCredit / EstimateVersion rows. Uses the
 * shared disposable Postgres harness and the fake Stripe adapter
 * (cs_test_ / acct_test_ only). Does not call live Stripe, refund, or
 * send customer messages. No schema migrate.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-job-money-reconciliation.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:43217";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
process.env.VERCEL_ENV = process.env.VERCEL_ENV === "production" ? "preview" : process.env.VERCEL_ENV;

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
}

const selfSrc = readRepo("scripts/check-job-money-reconciliation.mjs");
const reconSrc = readRepo("src/lib/job-money-reconciliation.ts");
const collectedSrc = readRepo("src/lib/financial-intelligence/collected-revenue.ts");
const cashSrc = readRepo("src/lib/collected-cash.ts");
const reportsSrc = readRepo("src/lib/reports.ts");

console.log("\nSTATIC — migrate-free one-job proof uses shared attribution");
check(
  "this verifier uses the shared disposable harness",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check("proof module does not run prisma migrate", !reconSrc.includes("migrate deploy") && !reconSrc.includes("db push"));
check("verifier stays on the fake Stripe adapter", selfSrc.includes('TBBT_PAYMENTS_ADAPTER = "fake"'));
check("verifier never mentions a live Stripe secret", !selfSrc.includes("sk_live") && !selfSrc.includes("STRIPE_SECRET_KEY"));
check(
  "collected-revenue remaining due uses paymentBelongsToInvoice",
  collectedSrc.includes('from "@/lib/payment-attribution"') &&
    collectedSrc.includes("paymentBelongsToInvoice"),
);
check(
  "collected-cash per-invoice rows use paymentBelongsToInvoice",
  cashSrc.includes('from "@/lib/payment-attribution"') && cashSrc.includes("paymentBelongsToInvoice"),
);
check(
  "reports outstandingRemaining uses paymentBelongsToInvoice",
  reportsSrc.includes('from "@/lib/payment-attribution"') && reportsSrc.includes("paymentBelongsToInvoice"),
);

const {
  invoiceBalanceDue,
  collectedRevenueForJob,
} = await import("@/lib/financial-intelligence/collected-revenue");
const { resolveCollectedCash, collectedForJob } = await import("@/lib/collected-cash");
const {
  invoicePaymentBreakdown,
  paymentsBelongingToInvoice,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
} = await import("@/lib/project-payments");
const { accountingInvoicePaymentTotals } = await import("@/lib/accounting-export");
const { outstandingRemaining } = await import("@/lib/reports");
const { proveJobMoney, describeJobMoneyMismatches, jobMoneyText } = await import(
  "@/lib/job-money-reconciliation"
);
const { Prisma } = await import("@prisma/client");

console.log("\nUNIT — job-only deposit remaining due matches invoice / export / cash");
const jobOnlyInvoice = {
  id: "inv-original",
  status: "SENT",
  total: 1000,
  jobId: "job-1",
  kind: "ORIGINAL",
  customerId: "c1",
  paymentMethod: null,
  paymentReference: null,
};
const jobOnlyPayment = {
  id: "pay-deposit",
  amount: 300,
  invoiceId: null,
  jobId: "job-1",
  customerId: "c1",
  purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  method: "STRIPE",
  receivedAt: new Date(),
};
const allocated = paymentsBelongingToInvoice(jobOnlyInvoice, [jobOnlyPayment]);
const breakdown = invoicePaymentBreakdown({
  status: jobOnlyInvoice.status,
  total: jobOnlyInvoice.total,
  payments: allocated,
  credits: [],
});
const profitDue = invoiceBalanceDue(jobOnlyInvoice, [jobOnlyPayment], []);
const exportTotals = accountingInvoicePaymentTotals(jobOnlyInvoice, [jobOnlyPayment], []);
const reportOut = outstandingRemaining(
  [{ ...jobOnlyInvoice, businessId: "biz-a", createdAt: new Date(), paidAt: null }],
  [jobOnlyPayment],
  [],
);
const cash = resolveCollectedCash({
  invoices: [jobOnlyInvoice],
  payments: [jobOnlyPayment],
});
const jobCash = collectedForJob({
  jobId: "job-1",
  invoices: [jobOnlyInvoice],
  payments: [jobOnlyPayment],
});
const profitCollected = collectedRevenueForJob({
  jobId: "job-1",
  invoices: [jobOnlyInvoice],
  payments: [jobOnlyPayment],
});
const jobOnlyProof = proveJobMoney({
  businessId: "biz-a",
  jobId: "job-1",
  estimate: {
    id: "est-1",
    status: "APPROVED",
    total: 1000,
    approvedVersion: {
      id: "ver-1",
      total: 1000,
      lineItems: [
        { type: "LABOR", total: 700, description: "Labor" },
        { type: "MATERIAL", total: 300, description: "Materials" },
      ],
    },
  },
  invoices: [jobOnlyInvoice],
  payments: [jobOnlyPayment],
  credits: [],
});
check("job-only $300 deposit belongs to the ORIGINAL invoice", allocated.length === 1);
check("invoice remaining due is $700, not $1000", breakdown.amountDue.toFixed(2) === "700.00");
check("profitability invoiceBalanceDue is the same $700", profitDue === 700);
check("accounting export remaining is $700", exportTotals.amountRemaining.toFixed(2) === "700.00");
check("reports outstandingRemaining is $700", reportOut.amount === 700);
check("collected cash attributes the $300 deposit to the invoice", cash.totalCollected === 300 && cash.byInvoiceId.get("inv-original")?.amount === 300);
check("job collected cash is $300", jobCash.collected === 300 && profitCollected === 300);
check(
  "one-job proof agrees on remaining and collected",
  jobOnlyProof.ok &&
    jobOnlyProof.outstandingReceivable === 700 &&
    jobOnlyProof.collectedCash === 300 &&
    jobOnlyProof.invoices[0].recordedDue === 700,
);
if (!jobOnlyProof.ok) {
  console.error(`  ${describeJobMoneyMismatches(jobOnlyProof)}`);
}

const supplementalIgnored = invoiceBalanceDue(
  { id: "inv-sup", status: "SENT", total: 100, jobId: "job-1", kind: "SUPPLEMENTAL" },
  [jobOnlyPayment],
  [],
);
check("SUPPLEMENTAL does not claim the job-only deposit", supplementalIgnored === 100);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "job-money-reconciliation dedicated database");

const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
const { persistDraftInvoiceFromCompletedJob } = await import("@/lib/invoice-carry-forward");
const { sendDraftInvoiceIfNeeded } = await import("@/lib/complete-job-invoice");
const { recordOwnerInvoiceCredit } = await import("@/lib/invoice-credits");
const { recordOwnerInvoiceBalancePayment } = await import("@/lib/project-payments");
const {
  applyVerifiedCheckoutPayment,
  createCustomerDepositCheckout,
  createCustomerInvoiceCheckout,
  paymentsNeedingStripeCreditMismatchReview,
  STRIPE_CREDIT_MISMATCH_REASON,
} = await import("@/lib/payments");
const { createFakePaymentProvider } = await import("@/lib/payments/fake");
const { loadAccountingExportSource, buildAccountingInvoiceRows, buildAccountingPaymentRows } =
  await import("@/lib/accounting-export");
const { calculateJobProfitability } = await import("@/lib/financial-intelligence/job-profitability");
const { loadFinancialSource } = await import("@/lib/financial-intelligence-data");
const { loadJobMoneyRecords } = await import("@/lib/job-money-reconciliation");

function makeAccess(businessId, role = "OWNER") {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Money Tenant" },
      membership: { id: `mem-${businessId}` },
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

function webhookPayment(input) {
  const stamp = randomUUID().replaceAll("-", "").slice(0, 16);
  return {
    purpose: input.purpose ?? "invoice_balance",
    invoiceId: input.invoiceId ?? null,
    estimateId: input.estimateId ?? null,
    checkoutSessionId: input.checkoutSessionId ?? `cs_test_${stamp}`,
    businessId: input.businessId,
    connectedAccountId: input.connectedAccountId,
    amountCents: input.amountCents,
    currency: "usd",
    paymentReference: input.paymentReference ?? `pi_test_${stamp}`,
    paymentStatus: "paid",
  };
}

let session;
try {
  session = await openDisposableTestDatabase({
    databaseUrl: baseUrl,
    namePrefix: "tbbt_job_money",
    setProcessEnv: true,
  });
  const prisma = session.prisma;
  const ownerA = await seedWorkspace(prisma, "MoneyA");
  const other = await seedWorkspace(prisma, "MoneyB");
  const accessA = makeAccess(ownerA.business.id);
  const provider = createFakePaymentProvider();
  provider.setChargesEnabled(ownerA.stripeAccountId, true);

  console.log("\nTEST — Estimate snapshot + Stripe deposit + duplicate webhook");
  const estimate = await prisma.estimate.create({
    data: {
      businessId: ownerA.business.id,
      customerId: ownerA.customer.id,
      propertyId: ownerA.property.id,
      status: "DRAFT",
      total: new Prisma.Decimal("1000.00"),
      publicToken: randomUUID(),
      lineItems: {
        create: [
          {
            businessId: ownerA.business.id,
            description: "Install shelves",
            quantity: new Prisma.Decimal("1"),
            unitPrice: new Prisma.Decimal("700.00"),
            total: new Prisma.Decimal("700.00"),
            type: "LABOR",
          },
          {
            businessId: ownerA.business.id,
            description: "Lumber and hardware",
            quantity: new Prisma.Decimal("1"),
            unitPrice: new Prisma.Decimal("300.00"),
            total: new Prisma.Decimal("300.00"),
            type: "MATERIAL",
          },
        ],
      },
    },
  });
  const version = await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { status: "SENT" },
    });
    return createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: ownerA.business.id,
    });
  });
  await prisma.estimateVersion.update({
    where: { id: version.id },
    data: { approvedAt: new Date() },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "APPROVED", approvedVersionId: version.id },
  });
  check("approved version snapshot total is $1000", version.total.toFixed(2) === "1000.00");

  const jobResult = await createJobFromApprovedEstimate(prisma, accessA, estimate.id);
  check("approved estimate converts to one job", jobResult.ok === true && Boolean(jobResult.jobId));
  const jobId = jobResult.jobId;
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

  const depositCheckout = await createCustomerDepositCheckout(prisma, estimate.publicToken, provider, {
    appUrl: "http://localhost.stripe.test",
  });
  check("deposit checkout is Stripe test-mode", depositCheckout.id.startsWith("cs_test_"));
  check("deposit checkout charges the $300 snapshot materials", depositCheckout.amountCents === 30000);
  provider.completeCheckout(depositCheckout.id);
  const paidDeposit = await provider.findPaidDepositCheckout({
    connectedAccountId: ownerA.stripeAccountId,
    estimateId: estimate.id,
    businessId: ownerA.business.id,
    amountCents: 30000,
    checkoutSessionId: depositCheckout.id,
  });
  const depositApply = await applyVerifiedCheckoutPayment(prisma, paidDeposit);
  const depositReplay = await applyVerifiedCheckoutPayment(prisma, paidDeposit);
  const depositRows = await prisma.payment.findMany({
    where: { businessId: ownerA.business.id, estimateId: estimate.id },
  });
  check("deposit webhook records one MATERIAL_DEPOSIT payment", depositApply.applied === true && depositRows.length === 1);
  check("duplicate deposit webhook is idempotent", depositReplay.reason === "already_paid" && depositRows.length === 1);
  check("deposit payment is job-linked before the invoice exists", depositRows[0].jobId === jobId && depositRows[0].invoiceId == null);

  console.log("\nTEST — Invoice from snapshot attaches the deposit");
  await prisma.job.update({ where: { id: jobId }, data: { status: "COMPLETED" } });
  const persisted = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: ownerA.business.id,
    jobId,
  });
  check("completed job creates the ORIGINAL invoice", persisted.ok === true && persisted.kind === "ORIGINAL");
  const sent = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: ownerA.business.id,
    invoiceId: persisted.invoiceId,
    businessName: ownerA.business.name,
  });
  check("original invoice is SENT", sent.ok === true && sent.status === "SENT");

  let records = await loadJobMoneyRecords(prisma, { businessId: ownerA.business.id, jobId });
  let proof = proveJobMoney(records);
  check(`after deposit+invoice: ${describeJobMoneyMismatches(proof)}`, proof.ok);
  check("invoice total matches the approved snapshot", proof.invoices[0].recordedTotal === 1000);
  check("attached deposit reduces remaining due to $700", proof.invoices[0].recordedDue === 700);
  check("collected cash is the $300 deposit row", proof.collectedCash === 300);
  check("snapshot deposit required is $300 materials", proof.depositRequired === 300 && proof.depositPaid === 300);

  console.log("\nTEST — Partial payment");
  const partial = await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: persisted.invoiceId,
    amount: "200.00",
    method: "CASH",
  });
  check("partial cash payment records $200", partial.created === true && partial.recordedAmount.toString() === "200");
  records = await loadJobMoneyRecords(prisma, { businessId: ownerA.business.id, jobId });
  proof = proveJobMoney(records);
  check(`after partial: ${describeJobMoneyMismatches(proof)}`, proof.ok);
  check("remaining due is $500 after deposit + partial", proof.invoices[0].recordedDue === 500);
  check("collected cash is $500", proof.collectedCash === 500);
  check("outstanding receivable is $500", proof.outstandingReceivable === 500);

  const finance = await loadFinancialSource(prisma, ownerA.business.id);
  const profit = calculateJobProfitability(jobId, finance);
  check("profitability billed is the $1000 invoice total", profit?.billedRevenue === 1000);
  check("profitability collected matches recorded $500", profit?.collectedRevenue === 500);
  check("profitability outstanding matches remaining $500", profit?.outstandingReceivable === 500);

  const exportSource = await loadAccountingExportSource(prisma, ownerA.business.id);
  const invoiceRows = buildAccountingInvoiceRows(exportSource);
  const paymentRows = buildAccountingPaymentRows(exportSource);
  const originalExport = invoiceRows.find((row) => row["Invoice ID"] === persisted.invoiceId);
  check(
    "accounting export paid/remaining match recorded rows",
    originalExport?.["Amount Paid"] === "500.00" && originalExport?.["Amount Remaining"] === "500.00",
  );
  check(
    "accounting payments.csv lists the two recorded rows",
    paymentRows.length === 2 &&
      paymentRows.some((row) => row.Amount === "300.00") &&
      paymentRows.some((row) => row.Amount === "200.00"),
  );

  console.log("\nTEST — Fully credited supplemental + stale checkout + duplicate webhook");
  const changeOrder = await prisma.changeOrder.create({
    data: {
      businessId: ownerA.business.id,
      jobId,
      title: "Extra hardware",
      status: "APPROVED",
      total: new Prisma.Decimal("100.00"),
      sentAt: new Date(),
      approvedAt: new Date(),
      lineItems: {
        create: [
          {
            businessId: ownerA.business.id,
            description: "Extra hardware",
            quantity: new Prisma.Decimal("1"),
            unitPrice: new Prisma.Decimal("100.00"),
            total: new Prisma.Decimal("100.00"),
            type: "LABOR",
          },
        ],
      },
    },
  });
  const supplementalPersist = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: ownerA.business.id,
    jobId,
  });
  check(
    "approved change order becomes a SUPPLEMENTAL invoice",
    supplementalPersist.ok === true &&
      supplementalPersist.kind === "SUPPLEMENTAL" &&
      supplementalPersist.invoiceId !== persisted.invoiceId,
  );
  await sendDraftInvoiceIfNeeded(prisma, {
    businessId: ownerA.business.id,
    invoiceId: supplementalPersist.invoiceId,
    businessName: ownerA.business.name,
  });
  const fullCredit = await recordOwnerInvoiceCredit(prisma, accessA, {
    invoiceId: supplementalPersist.invoiceId,
    amount: "100.00",
    reason: "Write off extra hardware",
    idempotencyKey: "full-credit-supplemental",
  });
  check("full credit closes the supplemental without a payment row", fullCredit.created === true);
  records = await loadJobMoneyRecords(prisma, { businessId: ownerA.business.id, jobId });
  proof = proveJobMoney(records);
  const supplementalProof = proof.invoices.find((row) => row.invoiceId === supplementalPersist.invoiceId);
  check(`after full credit: ${describeJobMoneyMismatches(proof)}`, proof.ok);
  check("fully credited supplemental remaining due is $0", supplementalProof?.recordedDue === 0);
  check("fully credited supplemental is not collected cash", supplementalProof?.recordedCollected === 0);
  check("job collected cash stays the original $500", proof.collectedCash === 500);
  check("credit-closed flag is set on the supplemental", supplementalProof?.creditClosed === true);

  const staleSessionId = "cs_test_stale_supplemental";
  const staleFirst = await applyVerifiedCheckoutPayment(
    prisma,
    webhookPayment({
      invoiceId: supplementalPersist.invoiceId,
      businessId: ownerA.business.id,
      connectedAccountId: ownerA.stripeAccountId,
      amountCents: 10000,
      checkoutSessionId: staleSessionId,
      paymentReference: "pi_test_stale_supplemental",
    }),
  );
  const staleDup = await applyVerifiedCheckoutPayment(
    prisma,
    webhookPayment({
      invoiceId: supplementalPersist.invoiceId,
      businessId: ownerA.business.id,
      connectedAccountId: ownerA.stripeAccountId,
      amountCents: 10000,
      checkoutSessionId: staleSessionId,
      paymentReference: "pi_test_stale_supplemental",
    }),
  );
  records = await loadJobMoneyRecords(prisma, { businessId: ownerA.business.id, jobId });
  proof = proveJobMoney(records);
  const afterStale = proof.invoices.find((row) => row.invoiceId === supplementalPersist.invoiceId);
  const flagged = paymentsNeedingStripeCreditMismatchReview(records.payments);
  check("stale checkout after a full credit is recorded for refund review", staleFirst.applied === true && staleFirst.reason === STRIPE_CREDIT_MISMATCH_REASON);
  check("duplicate stale webhook does not create a second payment", staleDup.reason === "already_paid");
  check(`after stale checkout: ${describeJobMoneyMismatches(proof)}`, proof.ok);
  check("refund-review flag is open on the succeeded charge", flagged.length === 1 && afterStale?.refundReviewCount === 1);
  check("stale charge becomes collected cash; remaining stays $0", proof.collectedCash === 600 && afterStale?.recordedDue === 0);
  check("job billed revenue is original + supplemental totals", proof.billedRevenue === 1100);

  console.log("\nTEST — Original remaining stale checkout after a later credit");
  const remainingCheckout = await createCustomerInvoiceCheckout(prisma, job.projectToken, provider, {
    appUrl: "http://localhost.stripe.test",
  });
  check("remaining-due checkout is $500 in test mode", remainingCheckout.id.startsWith("cs_test_") && remainingCheckout.amountCents === 50000);
  await recordOwnerInvoiceCredit(prisma, accessA, {
    invoiceId: persisted.invoiceId,
    amount: "100.00",
    reason: "Courtesy discount after checkout opened",
    idempotencyKey: "original-stale-credit",
  });
  provider.completeCheckout(remainingCheckout.id);
  const paidRemaining = await provider.findPaidInvoiceCheckout({
    connectedAccountId: ownerA.stripeAccountId,
    invoiceId: persisted.invoiceId,
    businessId: ownerA.business.id,
    amountCents: 50000,
    checkoutSessionId: remainingCheckout.id,
  });
  const staleOriginal = await applyVerifiedCheckoutPayment(prisma, paidRemaining);
  const staleOriginalDup = await applyVerifiedCheckoutPayment(prisma, paidRemaining);
  records = await loadJobMoneyRecords(prisma, { businessId: ownerA.business.id, jobId });
  proof = proveJobMoney(records);
  const originalProof = proof.invoices.find((row) => row.invoiceId === persisted.invoiceId);
  check("stale $500 checkout after a $100 credit is flagged for review", staleOriginal.applied === true && staleOriginal.reason === STRIPE_CREDIT_MISMATCH_REASON);
  check("duplicate remaining-due webhook is idempotent", staleOriginalDup.reason === "already_paid");
  check(`after original stale checkout: ${describeJobMoneyMismatches(proof)}`, proof.ok);
  check("original remaining due is $0 after deposit, partial, credit, and stale charge", originalProof?.recordedDue === 0);
  check(
    "collected cash is deposit + partial + supplemental stale + original stale",
    proof.collectedCash === 1100,
  );
  check("two refund-review flags stay open", proof.refundReviewCount === 2);

  const otherPayments = await prisma.payment.count({ where: { businessId: other.business.id } });
  const otherCredits = await prisma.invoiceCredit.count({ where: { businessId: other.business.id } });
  check("other tenant received no payments or credits", otherPayments === 0 && otherCredits === 0);
  check("change order row stayed on this job", changeOrder.jobId === jobId);

  const finalExport = buildAccountingInvoiceRows(
    await loadAccountingExportSource(prisma, ownerA.business.id),
  );
  const finalOriginal = finalExport.find((row) => row["Invoice ID"] === persisted.invoiceId);
  const finalSupplemental = finalExport.find((row) => row["Invoice ID"] === supplementalPersist.invoiceId);
  check(
    "final export remaining is $0 on both invoices",
    finalOriginal?.["Amount Remaining"] === "0.00" && finalSupplemental?.["Amount Remaining"] === "0.00",
  );
  check(
    "final export amount paid is recorded Stripe/cash, not credits",
    finalOriginal?.["Amount Paid"] === "1000.00" && finalSupplemental?.["Amount Paid"] === "100.00",
  );
  console.log(`  recorded collected=${jobMoneyText(proof.collectedCash)} billed=${jobMoneyText(proof.billedRevenue)} reviews=${proof.refundReviewCount}`);
} catch (error) {
  failures += 1;
  console.error("FAIL - job-money-reconciliation proofs crashed");
  console.error(error);
} finally {
  if (session) await session.cleanup();
}

async function seedWorkspace(prisma, name) {
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
  await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${name} Customer` },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: "10 Money Ave",
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
  return { business, customer, property, stripeAccountId };
}

console.log(
  failures === 0
    ? "\nAll job-money-reconciliation checks passed."
    : `\n${failures} job-money-reconciliation check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
