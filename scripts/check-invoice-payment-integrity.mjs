/**
 * Invoice payment integrity: remaining-balance collection, partial
 * offline payments, receivable totals, collect-payment copy, and
 * dashboard request links.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-invoice-payment-integrity.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, requireBusinessCapability, CAPABILITIES } =
  await import("@/lib/authorization");
const { emitAndProcessBusinessEvent } = await import("@/lib/automation/events");
const { ownerInvoiceOnlineCheckoutCopy } = await import("@/lib/payments/go-live");
const { Prisma } = await import("@prisma/client");
const {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  ProjectPaymentError,
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
  listPaymentsGroupedByInvoiceId,
  recordOwnerInvoiceBalancePayment,
  recordSucceededPayment,
  sumInvoiceRemainingDue,
  sumSentInvoiceRemainingDue,
} = await import("@/lib/project-payments");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_invoice_payment_integrity_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for invoice payment integrity test database.");
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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role = "OWNER") {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Integrity Tenant" },
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
      addressLine1: "10 Integrity Ave",
    },
  });
  return { business, membership, customer, property, ownerUser };
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
      status: "SENT",
      total: new Prisma.Decimal(input.total),
    },
  });
  return { job, invoice };
}

async function invoiceTruth(businessId, invoiceId) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
  });
  const payments = await listPaymentsForInvoice(prisma, {
    businessId,
    invoice: { id: invoice.id, jobId: invoice.jobId, kind: invoice.kind },
  });
  return {
    invoice,
    payments,
    breakdown: invoicePaymentBreakdown({
      status: invoice.status,
      total: invoice.total,
      payments,
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

const invoiceActionSrc = readRepo("src/app/actions/invoice.ts");
const projectPaymentsSrc = readRepo("src/lib/project-payments.ts");
const customersSrc = readRepo("src/app/(app)/customers/page.tsx");
const dashboardSrc = readRepo("src/app/(app)/dashboard/page.tsx");
const invoicesSrc = readRepo("src/app/(app)/invoices/page.tsx");
const invoicePageSrc = readRepo("src/app/(app)/invoices/[invoiceId]/page.tsx");
const formSrc = readRepo("src/components/invoices/mark-invoice-paid-form.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");

console.log("\nSTATIC — Canonical payment APIs, copy, receivable pages, request links");
check(
  "markInvoicePaid uses recordOwnerInvoiceBalancePayment",
  invoiceActionSrc.includes("recordOwnerInvoiceBalancePayment") &&
    !invoiceActionSrc.includes("recordSucceededPayment("),
);
check(
  "owner collection locks the Invoice row",
  projectPaymentsSrc.includes("FOR UPDATE") &&
    projectPaymentsSrc.includes("recordOwnerInvoiceBalancePayment"),
);
check(
  "customers Balance uses remaining due on SENT invoices",
  customersSrc.includes("sumInvoiceRemainingDue") &&
    customersSrc.includes('invoice.status === "SENT"') &&
    customersSrc.includes("listPaymentsGroupedByInvoiceId"),
);
check(
  "dashboard Outstanding uses remaining due",
  dashboardSrc.includes("sumInvoiceRemainingDue") &&
    dashboardSrc.includes("Outstanding is remaining due on SENT invoices") &&
    dashboardSrc.includes("listPaymentsGroupedByInvoiceId"),
);
check(
  "invoices SENT KPI uses remaining due",
  invoicesSrc.includes("sumInvoiceRemainingDue") &&
    invoicesSrc.includes("sentRemainingDue") &&
    invoicesSrc.includes('label: "Sent"'),
);
check(
  "online card copy matches onlineCheckoutPossible",
  invoicePageSrc.includes("ownerInvoiceOnlineCheckoutCopy") &&
    invoicePageSrc.includes("paymentsGoLive.onlineCheckoutPossible") &&
    !invoicePageSrc.includes(
      "Online card payment will be available when payment processing is connected.",
    ) &&
    ownerInvoiceOnlineCheckoutCopy(true).includes("pay the remaining balance by card online") &&
    ownerInvoiceOnlineCheckoutCopy(false).includes("not available"),
);
check(
  "offline Record Payment is available on SENT invoices without Stripe",
  invoicePageSrc.includes("MarkInvoicePaidForm") &&
    !invoicePageSrc.includes("onlineCheckoutPossible === true") &&
    formSrc.includes('name="amount"') &&
    formSrc.includes("paymentMethod"),
);
check(
  "dashboard request links use selected request IDs",
  dashboardSrc.includes("Requests without an estimate") &&
    dashboardSrc.includes("Recent requests") &&
    dashboardSrc.includes("`/requests?selected=${request.id}`") &&
    dashboardSrc.includes("requestsWithoutEstimate.map") &&
    dashboardSrc.includes("recentRequests.map"),
);
check(
  "no schema or migration change is required for this lane",
  schemaSrc.includes('model Payment') &&
    schemaSrc.includes('model Invoice'),
);

try {
  const tenantA = await seedBusiness("Integrity A");
  const tenantB = await seedBusiness("Integrity B");
  const accessA = makeAccess(tenantA.business.id);
  const accessB = makeAccess(tenantB.business.id);

  console.log("\nTEST — SENT $500 with no payments is due $500");
  const invoice500 = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: tenantA.customer.id,
    propertyId: tenantA.property.id,
    total: "500.00",
  });
  const dueNone = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  check("SENT $500, no payments → due $500", dueNone.breakdown.amountDue.toString() === "500");
  check("invoice remains SENT before any payment", dueNone.invoice.status === "SENT");

  console.log("\nTEST — Partial $200 cash leaves SENT with $300 due");
  const partial = await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: invoice500.invoice.id,
    amount: "200.00",
    method: "CASH",
    note: "cash deposit at job",
  });
  const afterPartial = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  const invoiceBalanceRows = afterPartial.payments.filter(
    (row) => row.purpose === PAYMENT_PURPOSE_INVOICE_BALANCE,
  );
  check("partial creates one INVOICE_BALANCE Payment of $200", invoiceBalanceRows.length === 1 && invoiceBalanceRows[0].amount.toString() === "200");
  check("invoice remains SENT after partial", afterPartial.invoice.status === "SENT");
  check("amount due recomputes to $300", afterPartial.breakdown.amountDue.toString() === "300");
  check("payment reference is stored on the Payment row", invoiceBalanceRows[0].note === "cash deposit at job");
  check("partial did not mark the invoice PAID", partial.invoicePaid === false && partial.created === true);

  console.log("\nTEST — Amount greater than current due is rejected server-side");
  await expectRejects(
    "cannot record $301 when due is $300",
    () =>
      recordOwnerInvoiceBalancePayment(prisma, accessA, {
        invoiceId: invoice500.invoice.id,
        amount: "301.00",
        method: "CASH",
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message.includes("remaining balance"),
  );
  await expectRejects(
    "payment amount <= 0 is rejected",
    () =>
      recordOwnerInvoiceBalancePayment(prisma, accessA, {
        invoiceId: invoice500.invoice.id,
        amount: "0",
        method: "CASH",
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message.includes("greater than zero"),
  );
  await expectRejects(
    "negative payment is rejected",
    () =>
      recordOwnerInvoiceBalancePayment(prisma, accessA, {
        invoiceId: invoice500.invoice.id,
        amount: "-1",
        method: "CHECK",
      }),
    (error) => error instanceof ProjectPaymentError,
  );
  const stale = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  check(
    "current due is recomputed server-side after rejected stale amounts",
    stale.breakdown.amountDue.toString() === "300" &&
      stale.payments.length === 1 &&
      stale.invoice.status === "SENT",
  );

  console.log("\nTEST — Final remaining payment transitions to PAID");
  const finalPay = await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: invoice500.invoice.id,
    amount: "300.00",
    method: "CHECK",
    note: "check 1044",
  });
  const afterFinal = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  check("final $300 marks invoice PAID", afterFinal.invoice.status === "PAID" && finalPay.transitionedToPaid === true);
  check("final payment leaves due $0", afterFinal.breakdown.amountDue.toString() === "0");
  check(
    "two legitimate invoice-balance payments remain",
    afterFinal.payments.filter((row) => row.purpose === PAYMENT_PURPOSE_INVOICE_BALANCE).length === 2,
  );
  check("invoice payment reference is the closing payment", afterFinal.invoice.paymentReference === "check 1044");
  check("invoice payment method is the closing method", afterFinal.invoice.paymentMethod === "CHECK");

  const paidEvents = await prisma.businessEvent.findMany({
    where: {
      businessId: tenantA.business.id,
      type: "INVOICE_PAID",
      subjectId: invoice500.invoice.id,
    },
  });
  check("INVOICE_PAID event was written once on final payment", paidEvents.length === 1);

  console.log("\nTEST — Already PAID / retry is a no-op");
  const retry = await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: invoice500.invoice.id,
    amount: "300.00",
    method: "CASH",
  });
  const afterRetry = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  check("already PAID cannot create a second payment", retry.alreadyPaid === true && retry.created === false);
  check(
    "retry after success is idempotent / no duplicate payments",
    afterRetry.payments.length === afterFinal.payments.length &&
      afterRetry.invoice.status === "PAID" &&
      afterRetry.invoice.paymentMethod === "CHECK",
  );
  await emitAndProcessBusinessEvent(prisma, {
    businessId: tenantA.business.id,
    type: "INVOICE_PAID",
    subjectType: "INVOICE",
    subjectId: invoice500.invoice.id,
    payload: { customerId: tenantA.customer.id },
    idempotencyKey: `INVOICE_PAID:${invoice500.invoice.id}`,
  });
  const paidEventsAfterRetry = await prisma.businessEvent.findMany({
    where: {
      businessId: tenantA.business.id,
      type: "INVOICE_PAID",
      subjectId: invoice500.invoice.id,
    },
  });
  check("INVOICE_PAID event remains once / idempotent", paidEventsAfterRetry.length === 1);

  console.log("\nTEST — Concurrent remaining-balance submissions cannot overpay");
  const raceInvoice = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: tenantA.customer.id,
    propertyId: tenantA.property.id,
    total: "500.00",
  });
  const raceClientA = new PrismaClient({ datasourceUrl: testUrl });
  const raceClientB = new PrismaClient({ datasourceUrl: testUrl });
  let raceResults;
  try {
    raceResults = await Promise.all([
      recordOwnerInvoiceBalancePayment(raceClientA, accessA, {
        invoiceId: raceInvoice.invoice.id,
        amount: "500.00",
        method: "CASH",
      }),
      recordOwnerInvoiceBalancePayment(raceClientB, accessA, {
        invoiceId: raceInvoice.invoice.id,
        amount: "500.00",
        method: "CHECK",
      }),
    ]);
  } finally {
    await raceClientA.$disconnect();
    await raceClientB.$disconnect();
  }
  const afterRace = await invoiceTruth(tenantA.business.id, raceInvoice.invoice.id);
  const raceBalancePayments = afterRace.payments.filter(
    (row) => row.purpose === PAYMENT_PURPOSE_INVOICE_BALANCE,
  );
  const raceCreated = raceResults.filter((row) => row.created);
  const raceNoops = raceResults.filter((row) => row.alreadyPaid || (!row.created && row.invoicePaid));
  check("double submission cannot create duplicate remaining-balance payments", raceBalancePayments.length === 1);
  check("concurrent submissions cannot overpay", afterRace.breakdown.amountDue.toString() === "0" && afterRace.breakdown.amountPaid.toString() === "500");
  check("exactly one concurrent remaining-balance payment was created", raceCreated.length === 1);
  check("the losing concurrent submission is a no-op", raceNoops.length === 1);
  check("raced invoice is PAID once", afterRace.invoice.status === "PAID");
  const raceEvents = await prisma.businessEvent.findMany({
    where: {
      businessId: tenantA.business.id,
      type: "INVOICE_PAID",
      subjectId: raceInvoice.invoice.id,
    },
  });
  check("concurrent INVOICE_PAID event remains once", raceEvents.length === 1);

  console.log("\nTEST — Material deposit associated with the invoice reduces remaining due");
  const depositInvoice = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: tenantA.customer.id,
    propertyId: tenantA.property.id,
    total: "500.00",
  });
  await recordSucceededPayment(prisma, {
    businessId: tenantA.business.id,
    customerId: tenantA.customer.id,
    jobId: depositInvoice.job.id,
    invoiceId: depositInvoice.invoice.id,
    purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    amount: new Prisma.Decimal("150.00"),
    method: "CASH",
    note: "material deposit",
  });
  const afterDeposit = await invoiceTruth(tenantA.business.id, depositInvoice.invoice.id);
  check(
    "material deposit already associated with invoice is reflected correctly",
    afterDeposit.breakdown.depositPaid.toString() === "150" &&
      afterDeposit.breakdown.amountDue.toString() === "350" &&
      afterDeposit.invoice.status === "SENT",
  );
  const leftover = await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: depositInvoice.invoice.id,
    method: "CASH",
  });
  const afterDepositClose = await invoiceTruth(tenantA.business.id, depositInvoice.invoice.id);
  check(
    "collecting remaining after deposit records $350 and marks PAID",
    leftover.recordedAmount.toString() === "350" &&
      afterDepositClose.invoice.status === "PAID" &&
      afterDepositClose.breakdown.amountDue.toString() === "0",
  );

  console.log("\nTEST — Receivable totals use remaining due");
  const recvCustomer = await prisma.customer.create({
    data: { businessId: tenantA.business.id, name: "Receivable Customer" },
  });
  const recvProperty = await prisma.property.create({
    data: {
      businessId: tenantA.business.id,
      customerId: recvCustomer.id,
      addressLine1: "20 Receivable Rd",
    },
  });
  const sentPartialRecv = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: recvCustomer.id,
    propertyId: recvProperty.id,
    total: "400.00",
  });
  await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: sentPartialRecv.invoice.id,
    amount: "100.00",
    method: "CASH",
  });
  const sentOpenRecv = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: recvCustomer.id,
    propertyId: recvProperty.id,
    total: "200.00",
  });
  const paidRecv = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: recvCustomer.id,
    propertyId: recvProperty.id,
    total: "900.00",
  });
  await recordOwnerInvoiceBalancePayment(prisma, accessA, {
    invoiceId: paidRecv.invoice.id,
    method: "ZELLE_BANK_TRANSFER",
  });
  const recvInvoices = await prisma.invoice.findMany({
    where: { businessId: tenantA.business.id, customerId: recvCustomer.id },
    select: { id: true, status: true, total: true, jobId: true, kind: true },
  });
  const recvPayments = await listPaymentsGroupedByInvoiceId(
    prisma,
    tenantA.business.id,
    recvInvoices,
  );
  const customerBalance = sumInvoiceRemainingDue(
    recvInvoices.filter((invoice) => invoice.status === "SENT"),
    recvPayments,
  );
  const dashboardOutstanding = sumSentInvoiceRemainingDue(recvInvoices, recvPayments);
  const sentKpi = sumInvoiceRemainingDue(
    recvInvoices.filter((invoice) => invoice.status === "SENT"),
    recvPayments,
  );
  check(
    "Customers Balance uses remaining due",
    customerBalance.toString() === "500",
  );
  check(
    "Dashboard Outstanding uses remaining due",
    dashboardOutstanding.toString() === "500",
  );
  check(
    "Invoices SENT KPI uses remaining due",
    sentKpi.toString() === "500",
  );
  check(
    "paid invoices are excluded from outstanding",
    recvInvoices.some((invoice) => invoice.id === paidRecv.invoice.id && invoice.status === "PAID") &&
      !recvInvoices
        .filter((invoice) => invoice.status === "SENT")
        .some((invoice) => invoice.id === paidRecv.invoice.id) &&
      Number(recvInvoices.find((invoice) => invoice.id === paidRecv.invoice.id)?.total) === 900,
  );
  check(
    "face-value SENT totals would have been wrong ($600 vs $500 remaining)",
    recvInvoices
      .filter((invoice) => invoice.status === "SENT")
      .reduce((sum, invoice) => sum + Number(invoice.total), 0) === 600 &&
      sentOpenRecv.invoice.total.toString() === "200",
  );

  console.log("\nTEST — Tenant isolation and foreign invoice fail closed");
  const foreignB = await seedSentInvoice({
    businessId: tenantB.business.id,
    customerId: tenantB.customer.id,
    propertyId: tenantB.property.id,
    total: "80.00",
  });
  const beforeA = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  const beforeB = await invoiceTruth(tenantB.business.id, foreignB.invoice.id);
  await expectRejects(
    "tenant B cannot record a payment on tenant A invoice",
    () =>
      recordOwnerInvoiceBalancePayment(prisma, accessB, {
        invoiceId: invoice500.invoice.id,
        amount: "50.00",
        method: "CASH",
      }),
    (error) => error instanceof ProjectPaymentError,
  );
  await expectRejects(
    "foreign invoice fails closed",
    () =>
      recordOwnerInvoiceBalancePayment(prisma, accessA, {
        invoiceId: "inv_does_not_exist",
        amount: "10.00",
        method: "CASH",
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message.includes("could not be found"),
  );
  const afterIsoA = await invoiceTruth(tenantA.business.id, invoice500.invoice.id);
  const afterIsoB = await invoiceTruth(tenantB.business.id, foreignB.invoice.id);
  check(
    "tenant B invoice/payment cannot affect tenant A",
    afterIsoA.payments.length === beforeA.payments.length &&
      afterIsoA.invoice.status === beforeA.invoice.status &&
      afterIsoB.invoice.status === "SENT" &&
      afterIsoB.payments.length === beforeB.payments.length,
  );
  await expectRejects(
    "MEMBER cannot record an invoice payment",
    () =>
      recordOwnerInvoiceBalancePayment(prisma, makeAccess(tenantA.business.id, "MEMBER"), {
        invoiceId: invoice500.invoice.id,
        method: "CASH",
      }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );
  requireBusinessCapability(accessA, CAPABILITIES.MANAGE_INVOICES);
  check("OWNER retains MANAGE_INVOICES", true);

  console.log("\nTEST — Offline payment works without Stripe Connect");
  const offline = await seedSentInvoice({
    businessId: tenantB.business.id,
    customerId: tenantB.customer.id,
    propertyId: tenantB.property.id,
    total: "75.00",
  });
  const stripeAccount = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: tenantB.business.id },
  });
  const offlinePay = await recordOwnerInvoiceBalancePayment(prisma, accessB, {
    invoiceId: offline.invoice.id,
    amount: "25.00",
    method: "ZELLE_BANK_TRANSFER",
    note: "zelle 25",
  });
  const afterOffline = await invoiceTruth(tenantB.business.id, offline.invoice.id);
  check("tenant B has no Stripe Connect account", stripeAccount === null);
  check(
    "offline payment works without Stripe Connect",
    offlinePay.created === true &&
      afterOffline.invoice.status === "SENT" &&
      afterOffline.breakdown.amountDue.toString() === "50",
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} invoice payment integrity check(s) failed.`);
  process.exit(1);
}

console.log("\nAll invoice payment integrity checks passed.");
