/**
 * One Handyman job’s recorded money plus OWNER bank CSV review.
 *
 * Seeds material deposit, invoice, partial payment, invoice credit, and
 * expense through the real write paths, then imports bank CSV rows for
 * the real inflow and outflow. Proves #310’s workspace suggests only
 * eligible Payment / Expense rows, never treats an InvoiceCredit as cash,
 * never creates a Payment, and never changes invoice due or collected-cash
 * reports from #274’s attribution rule. Covers in-file duplicates, exact-bytes
 * replay, and a second tenant with identical amounts.
 *
 * Uses the shared disposable Postgres harness (db push, no migrate) and
 * applies the accepted-match unique indexes from 20261002190100. Fake
 * Stripe adapter only. No live bank feed.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-bank-reconciliation.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
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

const generate = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generate.status !== 0) {
  console.error("Failed to generate Prisma client for handyman bank reconciliation checks.");
  process.exit(generate.status ?? 1);
}

const selfSrc = readRepo("scripts/check-handyman-bank-reconciliation.mjs");
const opsSrc = readRepo("src/lib/bank-reconciliation-ops.ts");
const parseSrc = readRepo("src/lib/bank-reconciliation.ts");
const attributionSrc = readRepo("src/lib/payment-attribution.ts");
const reportsSrc = readRepo("src/lib/reports.ts");
const acceptedUniqueMigrationSrc = readRepo(
  "prisma/migrations/20261002190100_bank_reconciliation_accepted_unique/migration.sql",
);

console.log("\nSTATIC — Handyman job money plus #310 workspace stays review-only");
check(
  "this verifier uses the shared disposable harness",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check(
  "parse/ops do not run prisma migrate",
  !parseSrc.includes("migrate deploy") && !opsSrc.includes("migrate deploy"),
);
check("verifier stays on the fake Stripe adapter", selfSrc.includes('TBBT_PAYMENTS_ADAPTER = "fake"'));
check(
  "verifier applies the accepted-unique migration SQL",
  selfSrc.includes("20261002190100_bank_reconciliation_accepted_unique") &&
    selfSrc.includes("applyMigrationStatements(acceptedUniqueMigrationSrc)"),
);
check(
  "reuses #274 paymentBelongsToInvoice fail-closed ORIGINAL rule",
  attributionSrc.includes("paymentBelongsToInvoice") &&
    attributionSrc.includes("INVOICE_KIND_ORIGINAL") &&
    attributionSrc.includes("invoice.kind !== INVOICE_KIND_ORIGINAL") &&
    selfSrc.includes("paymentBelongsToInvoice") &&
    selfSrc.includes("proveJobMoney"),
);
check(
  "reuses #310 import/accept workspace",
  selfSrc.includes("importBankCsv") &&
    selfSrc.includes("acceptBankReconciliationMatch") &&
    opsSrc.includes("REVIEW_BANK_RECONCILIATION") &&
    !parseSrc.includes("invoiceCredit"),
);
check(
  "import/accept never write Payment, Invoice, or InvoiceCredit",
  !/\.payment\.create|\.invoice\.update|\.invoiceCredit\.create/.test(opsSrc),
);
check(
  "reports outstandingRemaining coerces Prisma Decimal money with asNumber",
  /function outstandingRemaining[\s\S]{0,500}asNumber\(invoice\.total\)/.test(reportsSrc) &&
    reportsSrc.includes("asNumber(payment.amount)") &&
    reportsSrc.includes("asNumber(credit.amount)"),
);

const { Prisma } = await import("@prisma/client");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { paymentBelongsToInvoice } = await import("@/lib/payment-attribution");
const { proveJobMoney, describeJobMoneyMismatches, loadJobMoneyRecords } = await import(
  "@/lib/job-money-reconciliation"
);
const { resolveCollectedCash } = await import("@/lib/collected-cash");
const { outstandingRemaining, buildReport, resolveReportRange } = await import("@/lib/reports");
const { loadFinancialSource } = await import("@/lib/financial-intelligence-data");
const { buildFinancialIntelligence } = await import("@/lib/financial-intelligence");
const { loadAccountingExportSource, buildAccountingInvoiceRows, buildAccountingPaymentRows } =
  await import("@/lib/accounting-export");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
const { persistDraftInvoiceFromCompletedJob } = await import("@/lib/invoice-carry-forward");
const { sendDraftInvoiceIfNeeded } = await import("@/lib/complete-job-invoice");
const { recordOwnerInvoiceCredit } = await import("@/lib/invoice-credits");
const { recordOwnerInvoiceBalancePayment, PAYMENT_PURPOSE_MATERIAL_DEPOSIT } =
  await import("@/lib/project-payments");
const { applyVerifiedCheckoutPayment, createCustomerDepositCheckout } = await import("@/lib/payments");
const { createFakePaymentProvider } = await import("@/lib/payments/fake");
const { createExpense } = await import("@/lib/expense-ops");
const { INVOICE_KIND_ORIGINAL, INVOICE_KIND_SUPPLEMENTAL } = await import("@/lib/revenue-integrity");
const { BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE, hashCsvBytes } = await import("@/lib/bank-reconciliation");
const { acceptBankReconciliationMatch, importBankCsv } = await import("@/lib/bank-reconciliation-ops");

check(
  "credits-are-not-deposits copy is the #310 rule",
  /never match candidates/.test(BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE),
);

console.log("\nUNIT — job-money Decimal rows still report $400 remaining due");
const decimalDue = outstandingRemaining(
  [
    {
      id: "inv-original",
      businessId: "biz-a",
      status: "SENT",
      total: new Prisma.Decimal("1000.00"),
      paidAt: null,
      createdAt: new Date("2026-03-15T16:00:00.000Z"),
      customerId: "c1",
      jobId: "job-1",
      kind: INVOICE_KIND_ORIGINAL,
      paymentMethod: null,
      paymentReference: null,
    },
  ],
  [
    {
      id: "pay-deposit",
      invoiceId: "inv-original",
      jobId: "job-1",
      customerId: "c1",
      amount: new Prisma.Decimal("300.00"),
      receivedAt: new Date("2026-03-15T16:00:00.000Z"),
    },
    {
      id: "pay-partial",
      invoiceId: "inv-original",
      jobId: "job-1",
      customerId: "c1",
      amount: new Prisma.Decimal("200.00"),
      receivedAt: new Date("2026-03-15T16:00:00.000Z"),
    },
  ],
  [{ id: "credit-1", invoiceId: "inv-original", amount: new Prisma.Decimal("100.00") }],
);
check(
  "Decimal deposit + partial + credit leaves $400 due, not $0",
  decimalDue.amount === 400 && decimalDue.count === 1,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "handyman-bank-reconciliation disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_handyman_bank",
  setProcessEnv: true,
});
const prisma = session.prisma;

function applyMigrationStatements(sql) {
  return sql
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}
for (const statement of applyMigrationStatements(acceptedUniqueMigrationSrc)) {
  await prisma.$executeRawUnsafe(statement);
}

function makeAccess(business, membershipId, role = "OWNER") {
  return {
    businessId: business.id,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: business.id, name: business.name, timezone: business.timezone ?? "America/New_York" },
    },
    scope: businessScope(business.id),
    assertOwned(record) {
      return assertBusinessRecord(record, business.id);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, business.id);
    },
  };
}

async function seedHandymanWorkspace(name) {
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
      slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`,
      timezone: "America/New_York",
    },
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
      addressLine1: "10 Handyman Ave",
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

const POSTED_IN = "2026-03-15T16:00:00.000Z";

function handymanBankCsv() {
  return [
    "Date,Description,Amount",
    "03/15/2026,STRIPE MATERIAL DEPOSIT,300.00",
    "03/15/2026,CASH PARTIAL PAYMENT,200.00",
    "03/15/2026,INVOICE CREDIT WRITE DOWN,100.00",
    "03/16/2026,HOME DEPOT LUMBER,-85.40",
    "03/15/2026,STRIPE MATERIAL DEPOSIT,300.00",
  ].join("\n");
}

async function snapshotMoney(businessId, jobId, invoiceId) {
  const records = await loadJobMoneyRecords(prisma, { businessId, jobId });
  const proof = proveJobMoney(records);
  const cash = resolveCollectedCash({
    invoices: records.invoices,
    payments: records.payments,
    credits: records.credits,
  });
  const due = outstandingRemaining(records.invoices, records.payments, records.credits);
  const finance = await loadFinancialSource(prisma, businessId);
  const report = buildReport(finance, resolveReportRange("all", undefined, undefined, new Date(), "America/New_York"));
  const intelligence = buildFinancialIntelligence(finance, report);
  const exportSource = await loadAccountingExportSource(prisma, businessId);
  const invoiceExport = buildAccountingInvoiceRows(exportSource).find((row) => row["Invoice ID"] === invoiceId);
  const paymentExport = buildAccountingPaymentRows(exportSource);
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  return {
    proof,
    cash,
    due,
    reportOutstanding: report.outstanding.current,
    collectedCustomerPayments: intelligence.cashFlow.collectedCustomerPayments,
    invoiceExport,
    paymentExport,
    paymentCount: await prisma.payment.count({ where: { businessId } }),
    creditCount: await prisma.invoiceCredit.count({ where: { businessId } }),
    expenseCount: await prisma.expense.count({ where: { businessId } }),
    invoice: {
      id: invoice.id,
      status: invoice.status,
      total: invoice.total.toFixed(2),
      paidAt: invoice.paidAt,
      paymentMethod: invoice.paymentMethod,
      paymentReference: invoice.paymentReference,
    },
  };
}

function moneyUnchanged(before, after) {
  return (
    before.proof.ok &&
    after.proof.ok &&
    before.proof.collectedCash === after.proof.collectedCash &&
    before.proof.outstandingReceivable === after.proof.outstandingReceivable &&
    before.cash.totalCollected === after.cash.totalCollected &&
    before.due.amount === after.due.amount &&
    before.reportOutstanding === after.reportOutstanding &&
    before.collectedCustomerPayments === after.collectedCustomerPayments &&
    before.invoiceExport?.["Amount Paid"] === after.invoiceExport?.["Amount Paid"] &&
    before.invoiceExport?.["Amount Remaining"] === after.invoiceExport?.["Amount Remaining"] &&
    before.paymentCount === after.paymentCount &&
    before.creditCount === after.creditCount &&
    before.expenseCount === after.expenseCount &&
    before.invoice.status === after.invoice.status &&
    before.invoice.total === after.invoice.total &&
    String(before.invoice.paidAt) === String(after.invoice.paidAt) &&
    before.invoice.paymentMethod === after.invoice.paymentMethod &&
    before.invoice.paymentReference === after.invoice.paymentReference
  );
}

async function seedHandymanJob(workspace, access, provider) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId: workspace.business.id,
      customerId: workspace.customer.id,
      propertyId: workspace.property.id,
      status: "DRAFT",
      total: new Prisma.Decimal("1000.00"),
      publicToken: randomUUID(),
      lineItems: {
        create: [
          {
            businessId: workspace.business.id,
            description: "Install shelves",
            quantity: new Prisma.Decimal("1"),
            unitPrice: new Prisma.Decimal("700.00"),
            total: new Prisma.Decimal("700.00"),
            type: "LABOR",
          },
          {
            businessId: workspace.business.id,
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
    await tx.estimate.update({ where: { id: estimate.id }, data: { status: "SENT" } });
    return createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: workspace.business.id,
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

  const jobResult = await createJobFromApprovedEstimate(prisma, access, estimate.id);
  if (!jobResult.ok) {
    throw new Error(jobResult.error ?? "approved estimate did not become a job");
  }
  const jobId = jobResult.jobId;

  provider.setChargesEnabled(workspace.stripeAccountId, true);
  const depositCheckout = await createCustomerDepositCheckout(prisma, estimate.publicToken, provider, {
    appUrl: "http://localhost.stripe.test",
  });
  provider.completeCheckout(depositCheckout.id);
  const paidDeposit = await provider.findPaidDepositCheckout({
    connectedAccountId: workspace.stripeAccountId,
    estimateId: estimate.id,
    businessId: workspace.business.id,
    amountCents: 30000,
    checkoutSessionId: depositCheckout.id,
  });
  await applyVerifiedCheckoutPayment(prisma, paidDeposit);

  await prisma.job.update({ where: { id: jobId }, data: { status: "COMPLETED" } });
  const persisted = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: workspace.business.id,
    jobId,
  });
  if (!persisted.ok) {
    throw new Error("completed job did not create the ORIGINAL invoice");
  }
  await sendDraftInvoiceIfNeeded(prisma, {
    businessId: workspace.business.id,
    invoiceId: persisted.invoiceId,
    businessName: workspace.business.name,
  });

  const partial = await recordOwnerInvoiceBalancePayment(prisma, access, {
    invoiceId: persisted.invoiceId,
    amount: "200.00",
    method: "CASH",
    note: "Cash partial payment",
  });
  const credit = await recordOwnerInvoiceCredit(prisma, access, {
    invoiceId: persisted.invoiceId,
    amount: "100.00",
    reason: "Courtesy write-down, not a bank deposit",
    idempotencyKey: `credit-${workspace.business.id}`,
  });
  const expense = await createExpense(prisma, access, {
    occurredOn: "2026-03-16",
    description: "Home Depot lumber",
    amount: "85.40",
    category: "MATERIALS",
    vendor: "Home Depot",
    jobId,
  });

  const payments = await prisma.payment.findMany({
    where: { businessId: workspace.business.id },
    orderBy: { createdAt: "asc" },
  });
  for (const payment of payments) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { receivedAt: new Date(POSTED_IN) },
    });
  }

  return {
    jobId,
    invoiceId: persisted.invoiceId,
    depositPayment: payments.find((row) => row.purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT) ?? payments[0],
    partialPayment: payments.find((row) => row.id === partial.paymentId) ?? payments[1],
    creditId: credit.creditId,
    expenseId: expense.id,
    payments,
  };
}

function workspaceRow(workspace, cents) {
  return workspace.rows.find((row) => row.amountCents === cents);
}

try {
  console.log("\nTEST — one Handyman job money, then bank CSV review");
  const tenantA = await seedHandymanWorkspace("Handyman A");
  const tenantB = await seedHandymanWorkspace("Handyman B");
  const accessA = makeAccess(tenantA.business, tenantA.membership.id);
  const accessB = makeAccess(tenantB.business, tenantB.membership.id);
  const provider = createFakePaymentProvider();

  const jobA = await seedHandymanJob(tenantA, accessA, provider);
  const before = await snapshotMoney(tenantA.business.id, jobA.jobId, jobA.invoiceId);
  const invoiceA = before.proof.invoices.find((row) => row.invoiceId === jobA.invoiceId);

  check(`seeded job money reconciles: ${describeJobMoneyMismatches(before.proof)}`, before.proof.ok);
  check("invoice remaining due is $400 after deposit, partial, and credit", invoiceA?.recordedDue === 400);
  check("collected cash is the $500 Payment rows, not the $100 credit", before.proof.collectedCash === 500);
  check("outstanding receivable is $400", before.proof.outstandingReceivable === 400);
  check("resolveCollectedCash is $500", before.cash.totalCollected === 500);
  check("reports outstandingRemaining is $400", before.due.amount === 400);
  check("reports KPI outstanding is $400", before.reportOutstanding === 400);
  check("cash-flow collected customer payments is $500", before.collectedCustomerPayments === 500);
  check(
    "accounting export paid/remaining are recorded cash, not the credit",
    before.invoiceExport?.["Amount Paid"] === "500.00" &&
      before.invoiceExport?.["Amount Remaining"] === "400.00",
  );
  check(
    "accounting payments.csv lists only the two Payment rows",
    before.paymentExport.length === 2 &&
      before.paymentExport.some((row) => row.Amount === "300.00") &&
      before.paymentExport.some((row) => row.Amount === "200.00"),
  );
  check(
    "#274 rule: deposit belongs to the ORIGINAL invoice",
    paymentBelongsToInvoice(
      { invoiceId: jobA.depositPayment.invoiceId, jobId: jobA.depositPayment.jobId },
      { id: jobA.invoiceId, jobId: jobA.jobId, kind: INVOICE_KIND_ORIGINAL },
    ),
  );
  check(
    "#274 rule: SUPPLEMENTAL cannot claim the deposit",
    !paymentBelongsToInvoice(
      { invoiceId: jobA.depositPayment.invoiceId, jobId: jobA.depositPayment.jobId },
      { id: "inv-supplemental", jobId: jobA.jobId, kind: INVOICE_KIND_SUPPLEMENTAL },
    ),
  );
  check("seeded one InvoiceCredit and one Expense", before.creditCount === 1 && before.expenseCount === 1);

  const csv = handymanBankCsv();
  const imported = await importBankCsv(prisma, accessA, {
    filename: "handyman-march.csv",
    bytes: Buffer.from(csv),
  });
  check("workspace status stays REVIEW", imported.status === "REVIEW");
  check("exact source bytes are stored", imported.contentSha256 === hashCsvBytes(Buffer.from(csv)));
  check(
    "first $300 bank row is a Payment candidate",
    workspaceRow(imported, 30000)?.reviewStatus === "CANDIDATE",
  );
  const duplicateRow = imported.rows.find((row) => row.amountCents === 30000 && row.reviewStatus === "DUPLICATE");
  check("second identical $300 bank row is DUPLICATE, not a second candidate", Boolean(duplicateRow) && duplicateRow.matches.length === 0);

  const depositRow = imported.rows.find((row) => row.amountCents === 30000 && row.reviewStatus !== "DUPLICATE");
  const partialRow = workspaceRow(imported, 20000);
  const creditLookalike = workspaceRow(imported, 10000);
  const expenseRow = workspaceRow(imported, -8540);

  check(
    "$300 inflow suggests only the recorded material-deposit Payment",
    depositRow?.reviewStatus === "CANDIDATE" &&
      depositRow.matches.length === 1 &&
      depositRow.matches[0].candidateKind === "PAYMENT" &&
      depositRow.matches[0].candidateId === jobA.depositPayment.id,
  );
  check(
    "$200 inflow suggests only the recorded partial Payment",
    partialRow?.reviewStatus === "CANDIDATE" &&
      partialRow.matches.length === 1 &&
      partialRow.matches[0].candidateKind === "PAYMENT" &&
      partialRow.matches[0].candidateId === jobA.partialPayment.id,
  );
  check(
    "$100 credit-amount bank row has no Payment or InvoiceCredit candidate",
    creditLookalike?.reviewStatus === "UNMATCHED" && (creditLookalike?.matches.length ?? 1) === 0,
  );
  check(
    "$85.40 outflow suggests only the recorded Home Depot Expense",
    expenseRow?.reviewStatus === "CANDIDATE" &&
      expenseRow.matches.length === 1 &&
      expenseRow.matches[0].candidateKind === "EXPENSE" &&
      expenseRow.matches[0].candidateId === jobA.expenseId,
  );
  check(
    "no suggested match is an InvoiceCredit",
    imported.rows.every((row) => row.matches.every((match) => match.candidateKind !== "INVOICE_CREDIT")),
  );
  check(
    "every suggested candidate is this tenant's Payment or Expense",
    imported.rows.every((row) =>
      row.matches.every(
        (match) =>
          (match.candidateKind === "PAYMENT" &&
            (match.candidateId === jobA.depositPayment.id || match.candidateId === jobA.partialPayment.id)) ||
          (match.candidateKind === "EXPENSE" && match.candidateId === jobA.expenseId),
      ),
    ),
  );

  const afterImport = await snapshotMoney(tenantA.business.id, jobA.jobId, jobA.invoiceId);
  check("import does not change invoice due or collected-cash reports", moneyUnchanged(before, afterImport));

  const acceptedDeposit = await acceptBankReconciliationMatch(prisma, accessA, {
    importId: imported.id,
    matchId: depositRow.matches[0].id,
  });
  const acceptedPartial = await acceptBankReconciliationMatch(prisma, accessA, {
    importId: imported.id,
    matchId: partialRow.matches[0].id,
  });
  const acceptedExpense = await acceptBankReconciliationMatch(prisma, accessA, {
    importId: imported.id,
    matchId: expenseRow.matches[0].id,
  });
  check(
    "accepted review links stay on the recorded rows",
    acceptedDeposit.rows.find((row) => row.id === depositRow.id)?.reviewStatus === "ACCEPTED" &&
      acceptedPartial.rows.find((row) => row.id === partialRow.id)?.reviewStatus === "ACCEPTED" &&
      acceptedExpense.rows.find((row) => row.id === expenseRow.id)?.reviewStatus === "ACCEPTED",
  );
  check(
    "credit-amount row stays unmatched after accept",
    acceptedExpense.rows.find((row) => row.id === creditLookalike.id)?.reviewStatus === "UNMATCHED",
  );

  const afterAccept = await snapshotMoney(tenantA.business.id, jobA.jobId, jobA.invoiceId);
  check("accept never creates a Payment", afterAccept.paymentCount === 2);
  check("accept never writes InvoiceCredit", afterAccept.creditCount === 1);
  check(
    "accept never changes invoice due or collected-cash reports",
    moneyUnchanged(before, afterAccept) && afterAccept.proof.collectedCash === 500 && afterAccept.due.amount === 400,
  );

  console.log("\nTEST — replay and another tenant with identical amounts");
  const replay = await importBankCsv(prisma, accessA, {
    filename: "handyman-march-again.csv",
    bytes: Buffer.from(csv),
  });
  check("exact-bytes replay reopens the same workspace", replay.id === imported.id);
  check(
    "replay keeps accepted matches and does not add rows",
    replay.rowCount === imported.rowCount &&
      replay.rows.find((row) => row.id === depositRow.id)?.reviewStatus === "ACCEPTED",
  );
  const afterReplay = await snapshotMoney(tenantA.business.id, jobA.jobId, jobA.invoiceId);
  check("replay does not change invoice due or collected cash", moneyUnchanged(before, afterReplay));

  const jobB = await seedHandymanJob(tenantB, accessB, provider);
  const beforeB = await snapshotMoney(tenantB.business.id, jobB.jobId, jobB.invoiceId);
  check("tenant B seeded the same $500 collected / $400 due", beforeB.proof.collectedCash === 500 && beforeB.due.amount === 400);

  const importedB = await importBankCsv(prisma, accessB, {
    filename: "handyman-march.csv",
    bytes: Buffer.from(csv),
  });
  check("identical CSV in the other tenant is a separate workspace", importedB.id !== imported.id);
  check(
    "tenant B is not marked ALREADY_SEEN by tenant A's fingerprints",
    importedB.rows.every((row) => row.reviewStatus !== "ALREADY_SEEN"),
  );
  check(
    "tenant B $300 suggests tenant B's deposit, never tenant A's",
    importedB.rows.some(
      (row) =>
        row.amountCents === 30000 &&
        row.reviewStatus === "CANDIDATE" &&
        row.matches.some((match) => match.candidateId === jobB.depositPayment.id),
    ) &&
      importedB.rows.every((row) => row.matches.every((match) => match.candidateId !== jobA.depositPayment.id)),
  );
  check(
    "tenant B $200 suggests tenant B's partial, never tenant A's",
    importedB.rows.some(
      (row) =>
        row.amountCents === 20000 &&
        row.matches.some((match) => match.candidateId === jobB.partialPayment.id),
    ) &&
      importedB.rows.every((row) => row.matches.every((match) => match.candidateId !== jobA.partialPayment.id)),
  );
  check(
    "tenant B $85.40 suggests tenant B's expense, never tenant A's",
    importedB.rows.some(
      (row) =>
        row.amountCents === -8540 &&
        row.matches.some((match) => match.candidateId === jobB.expenseId),
    ) &&
      importedB.rows.every((row) => row.matches.every((match) => match.candidateId !== jobA.expenseId)),
  );
  check(
    "tenant B credit-amount row stays unmatched",
    importedB.rows.some((row) => row.amountCents === 10000 && row.reviewStatus === "UNMATCHED" && row.matches.length === 0),
  );
  check(
    "tenant B duplicate $300 is DUPLICATE",
    importedB.rows.some((row) => row.amountCents === 30000 && row.reviewStatus === "DUPLICATE"),
  );

  const afterBImport = await snapshotMoney(tenantB.business.id, jobB.jobId, jobB.invoiceId);
  const afterAIsolation = await snapshotMoney(tenantA.business.id, jobA.jobId, jobA.invoiceId);
  check("tenant B import does not change tenant B money reports", moneyUnchanged(beforeB, afterBImport));
  check("tenant B import does not change tenant A money reports", moneyUnchanged(afterAccept, afterAIsolation));
  check(
    "tenant A still has exactly two payments after tenant B's identical amounts",
    afterAIsolation.paymentCount === 2 && afterBImport.paymentCount === 2,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - handyman-bank-reconciliation proofs crashed");
  console.error(error);
} finally {
  if (session) await session.cleanup();
}

console.log(
  failures === 0
    ? "\nAll handyman-bank-reconciliation checks passed."
    : `\n${failures} handyman-bank-reconciliation check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
