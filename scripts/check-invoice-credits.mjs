/**
 * OWNER invoice credits / corrections: remaining-balance arithmetic,
 * duplicate-submit safety, authorization, isolation, and concurrency.
 *
 * Uses a dedicated disposable Postgres database. Does not call Stripe
 * and does not send customer messages.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-invoice-credits.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, requireBusinessCapability, CAPABILITIES } =
  await import("@/lib/authorization");
const { Prisma } = await import("@prisma/client");
const {
  InvoiceCreditError,
  listInvoiceCreditsForInvoice,
  recordOwnerInvoiceCredit,
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

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_invoice_credits_test";
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
  console.error("Failed to push schema for invoice credits test database.");
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
  return {
    business,
    membership,
    adminMembership,
    memberMembership,
    customer,
    property,
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

const creditLibSrc = readRepo("src/lib/invoice-credits.ts");
const invoiceActionSrc = readRepo("src/app/actions/invoice.ts");
const invoicePageSrc = readRepo("src/app/(app)/invoices/[invoiceId]/page.tsx");
const formSrc = readRepo("src/components/invoices/record-invoice-credit-form.tsx");
const schemaSrc = readRepo("prisma/schema.prisma");
const authSrc = readRepo("src/lib/authorization.ts");
const projectPaymentsSrc = readRepo("src/lib/project-payments.ts");

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
  !creditLibSrc.includes("stripe") &&
    !creditLibSrc.includes("refund") &&
    !creditLibSrc.includes("sendInvoice") &&
    !creditLibSrc.includes("resend") &&
    !creditLibSrc.includes("@/lib/invoice-mail") &&
    !invoiceActionSrc.includes("createRefund") &&
    invoiceActionSrc.includes("recordInvoiceCredit"),
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
  "invoice lock is shared with payment collection",
  creditLibSrc.includes("FOR UPDATE") &&
    projectPaymentsSrc.includes("invoiceCredit.findMany"),
);

try {
  const tenantA = await seedBusiness("Credit A");
  const tenantB = await seedBusiness("Credit B");
  const ownerA = makeAccess(tenantA.business.id, "OWNER", tenantA.membership.id);
  const adminA = makeAccess(tenantA.business.id, "ADMIN", tenantA.adminMembership.id);
  const memberA = makeAccess(tenantA.business.id, "MEMBER", tenantA.memberMembership.id);
  const ownerB = makeAccess(tenantB.business.id, "OWNER", tenantB.membership.id);

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

  console.log("\nTEST — Concurrent remaining-balance credits cannot over-credit");
  const raceInvoice = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: tenantA.customer.id,
    propertyId: tenantA.property.id,
    total: "100.00",
  });
  const raceClientA = new PrismaClient({ datasourceUrl: testUrl });
  const raceClientB = new PrismaClient({ datasourceUrl: testUrl });
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
  check("credit covering remaining leaves SENT without inventing a payment", afterRace.invoice.status === "SENT");

  console.log("\nTEST — Concurrent credit and payment share the invoice lock");
  const mixInvoice = await seedSentInvoice({
    businessId: tenantA.business.id,
    customerId: tenantA.customer.id,
    propertyId: tenantA.property.id,
    total: "60.00",
  });
  const mixClientA = new PrismaClient({ datasourceUrl: testUrl });
  const mixClientB = new PrismaClient({ datasourceUrl: testUrl });
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
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} invoice credit check(s) failed.`);
  process.exit(1);
}

console.log("\nAll invoice credit checks passed.");
