/**
 * Owner accounting CSV export / data-portability proofs.
 *
 * Covers recorded-truth invoices, Payment rows, and non-voided expenses
 * on the existing tenant ZIP + dedicated accounting ZIP surface.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-accounting-export.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, roleHasCapability } = await import("@/lib/authorization");
const {
  ACCOUNTING_EXPENSE_HEADERS,
  ACCOUNTING_INVOICE_HEADERS,
  ACCOUNTING_PAYMENT_HEADERS,
  accountingExpensesCsv,
  accountingInvoicesCsv,
  accountingPaymentsCsv,
  buildAccountingExportZip,
  canExportBusinessData,
  emptyAccountingExportSource,
  loadAccountingExportSource,
} = await import("@/lib/accounting-export");
const { buildBusinessExportZip } = await import("@/lib/business-export");
const { invoiceNumberFromId, jobReferenceFromId } = await import("@/lib/invoice-document");
const { toCsv, toCsvCell } = await import("@/lib/zip-store");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_accounting_export_test";
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
  console.error("Failed to push schema for accounting export test database.");
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

function parseCsv(text) {
  const src = text.replace(/\r\n/g, "\n");
  const lines = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      lines.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    lines.push(row);
  }
  if (lines.length && lines[lines.length - 1].every((value) => value === "")) {
    lines.pop();
  }
  const headers = lines[0] ?? [];
  const records = lines.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
  return { headers, records };
}

const exportRouteSrc = readFileSync(
  new URL("../src/app/(app)/settings/export/route.ts", import.meta.url),
  "utf8",
);
const accountingRouteSrc = readFileSync(
  new URL("../src/app/(app)/settings/export/accounting/route.ts", import.meta.url),
  "utf8",
);
const accountingSrc = readFileSync(new URL("../src/lib/accounting-export.ts", import.meta.url), "utf8");
const settingsWorkspaceSrc = readFileSync(
  new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
  "utf8",
);
const financialIntelSrc = readFileSync(
  new URL("../src/lib/financial-intelligence/export.ts", import.meta.url),
  "utf8",
);

console.log("\nSTATIC — export surface, authorization, and honesty");
check(
  "OWNER and ADMIN may export; MEMBER is blocked",
  canExportBusinessData("OWNER") &&
    canExportBusinessData("ADMIN") &&
    !canExportBusinessData("MEMBER") &&
    roleHasCapability("OWNER", CAPABILITIES.MANAGE_SETTINGS) &&
    roleHasCapability("ADMIN", CAPABILITIES.MANAGE_SETTINGS) &&
    !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_SETTINGS),
);
check(
  "Existing ZIP route uses the shared export gate",
  exportRouteSrc.includes("canExportBusinessData") &&
    exportRouteSrc.includes("buildBusinessExportZip") &&
    !exportRouteSrc.includes("requireSaasOperatingEntitlement"),
);
check(
  "Accounting ZIP reuses the same export gate and builders",
  accountingRouteSrc.includes("canExportBusinessData") &&
    accountingRouteSrc.includes("buildAccountingExportZip") &&
    !accountingRouteSrc.includes("requireSaasOperatingEntitlement"),
);
check(
  "Settings Data / Export offers the accounting ZIP on the existing surface",
  settingsWorkspaceSrc.includes("/settings/export/accounting") &&
    settingsWorkspaceSrc.includes("Accounting CSVs"),
);
check(
  "Payment CSV builders never select Stripe identifiers",
  !accountingSrc.includes("stripeCheckoutSessionId") &&
    !accountingSrc.includes("stripePaymentIntentId") &&
    !accountingSrc.includes("stripeAccountId"),
);
check(
  "Accounting export does not rebuild financial-intelligence or a ledger",
  accountingSrc.includes("not a general ledger") &&
    accountingSrc.includes("QuickBooks/Xero") &&
    financialIntelSrc.includes("managementReportCsvRows"),
);
check(
  "Empty invoices CSV is valid header-only output",
  (() => {
    const csv = accountingInvoicesCsv(
      emptyAccountingExportSource({
        businessId: "biz_empty",
        businessName: "Empty Co",
        slug: "empty-co",
      }),
    );
    const parsed = parseCsv(csv);
    return (
      csv.endsWith("\n") &&
      parsed.records.length === 0 &&
      ACCOUNTING_INVOICE_HEADERS.every((header, index) => parsed.headers[index] === header)
    );
  })(),
);
check(
  "Empty payments and expenses CSVs are valid header-only output",
  (() => {
    const source = emptyAccountingExportSource({
      businessId: "biz_empty",
      businessName: "Empty Co",
      slug: "empty-co",
    });
    const payments = parseCsv(accountingPaymentsCsv(source));
    const expenses = parseCsv(accountingExpensesCsv(source));
    return (
      payments.records.length === 0 &&
      expenses.records.length === 0 &&
      ACCOUNTING_PAYMENT_HEADERS.every((header, index) => payments.headers[index] === header) &&
      ACCOUNTING_EXPENSE_HEADERS.every((header, index) => expenses.headers[index] === header)
    );
  })(),
);
check(
  "CSV escaping quotes commas, quotes, and newlines",
  toCsvCell('Acme, "Best"\nCo') === '"Acme, ""Best""\nCo"' &&
    toCsv(["Name"], [{ Name: 'Acme, "Best"\nCo' }]).includes('"Acme, ""Best""\nCo"'),
);

try {
  console.log("\nDB — recorded payment truth, voided expenses, tenant isolation");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handy", slug: `alpha-acc-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handy", slug: `beta-acc-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: 'Pat, "Alpha"\nCustomer',
      email: "pat-alpha@example.com",
    },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Only Customer", email: "beta@example.com" },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  const paidWithoutPayments = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "PAID",
      total: new Prisma.Decimal("400.00"),
      paidAt: new Date("2026-09-02T15:00:00.000Z"),
      paymentMethod: "CASH",
    },
  });
  const sentWithPartial = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      status: "SENT",
      total: new Prisma.Decimal("250.00"),
    },
  });
  const stripeSessionId = `cs_test_secret_${randomUUID()}`;
  const stripeIntentId = `pi_secret_${randomUUID()}`;
  const recordedPayment = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      invoiceId: sentWithPartial.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal("50.00"),
      method: "CHECK",
      note: 'Check 12, "office"',
      receivedAt: new Date("2026-09-03T12:00:00.000Z"),
      stripeCheckoutSessionId: stripeSessionId,
      stripePaymentIntentId: stripeIntentId,
    },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      status: "PAID",
      total: new Prisma.Decimal("999.00"),
      paidAt: new Date("2026-09-04T12:00:00.000Z"),
    },
  });
  const paymentB = await prisma.payment.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      invoiceId: invoiceB.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal("999.00"),
      method: "CASH",
    },
  });

  const activeExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      description: 'Lumber, 2x4, "premium"',
      amount: new Prisma.Decimal("142.68"),
      category: "MATERIALS",
      vendor: "Home Depot",
      jobId: jobA.id,
      customerId: customerA.id,
      paymentMethod: "CARD_EXTERNAL",
      taxCategory: "DEDUCTIBLE",
    },
  });
  const voidedExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      description: "Voided fuel should not export",
      amount: new Prisma.Decimal("33.00"),
      category: "GAS_FUEL",
      jobId: jobA.id,
      customerId: customerA.id,
      voidedAt: new Date("2026-09-05T00:00:00.000Z"),
    },
  });
  const expenseB = await prisma.expense.create({
    data: {
      businessId: businessB.id,
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      description: "Beta only fuel",
      amount: new Prisma.Decimal("18.00"),
      category: "GAS_FUEL",
      jobId: jobB.id,
      customerId: customerB.id,
    },
  });

  const sourceA = await loadAccountingExportSource(prisma, businessA.id);
  const invoices = parseCsv(accountingInvoicesCsv(sourceA));
  const payments = parseCsv(accountingPaymentsCsv(sourceA));
  const expenses = parseCsv(accountingExpensesCsv(sourceA));

  const paidRow = invoices.records.find((row) => row["Invoice ID"] === paidWithoutPayments.id);
  const partialRow = invoices.records.find((row) => row["Invoice ID"] === sentWithPartial.id);
  check("Tenant A invoices exclude tenant B", invoices.records.every((row) => row["Invoice ID"] !== invoiceB.id));
  check(
    "PAID invoice without Payment rows does not invent paid cash",
    paidRow?.Status === "PAID" &&
      paidRow.Total === "400.00" &&
      paidRow["Amount Paid"] === "0.00" &&
      paidRow["Amount Remaining"] === "400.00",
  );
  check(
    "Payment rows are not replaced by the PAID invoice total",
    payments.records.every((row) => row["Invoice ID"] !== paidWithoutPayments.id) &&
      payments.records.length === 1 &&
      payments.records[0]["Payment ID"] === recordedPayment.id &&
      payments.records[0].Amount === "50.00",
  );
  check(
    "Partial recorded payment is used for paid/remaining",
    partialRow?.Status === "SENT" &&
      partialRow.Total === "250.00" &&
      partialRow["Amount Paid"] === "50.00" &&
      partialRow["Amount Remaining"] === "200.00",
  );
  check(
    "Invoice CSV includes human-readable identifiers and customer name",
    paidRow?.["Invoice Number"] === invoiceNumberFromId(paidWithoutPayments.id) &&
      paidRow["Job Reference"] === jobReferenceFromId(jobA.id) &&
      paidRow.Customer === 'Pat, "Alpha"\nCustomer',
  );
  check(
    "Payment CSV includes invoice/job relationship, method, purpose, and received date",
    payments.records[0]["Invoice Number"] === invoiceNumberFromId(sentWithPartial.id) &&
      payments.records[0]["Job Reference"] === jobReferenceFromId(jobA.id) &&
      payments.records[0].Method === "CHECK" &&
      payments.records[0].Purpose === "INVOICE_BALANCE" &&
      payments.records[0]["Purpose Label"] === "Invoice Balance" &&
      payments.records[0]["Received At"] === "2026-09-03T12:00:00.000Z",
  );
  check(
    "CSV escaping survives customer names, payment notes, and expense descriptions",
    invoices.records[0].Customer === 'Pat, "Alpha"\nCustomer' &&
      payments.records[0].Note === 'Check 12, "office"' &&
      expenses.records[0].Description === 'Lumber, 2x4, "premium"',
  );
  check(
    "Active expense is exported and voided expense truth is omitted",
    expenses.records.length === 1 &&
      expenses.records[0]["Expense ID"] === activeExpense.id &&
      expenses.records[0].Amount === "142.68" &&
      expenses.records[0].Category === "MATERIALS" &&
      expenses.records[0]["Job Reference"] === jobReferenceFromId(jobA.id) &&
      expenses.records.every((row) => row["Expense ID"] !== voidedExpense.id) &&
      !accountingExpensesCsv(sourceA).includes("Voided fuel should not export"),
  );
  check(
    "Stripe session and payment-intent identifiers are omitted",
    !accountingPaymentsCsv(sourceA).includes(stripeSessionId) &&
      !accountingPaymentsCsv(sourceA).includes(stripeIntentId),
  );

  const sourceB = await loadAccountingExportSource(prisma, businessB.id);
  const invoicesB = parseCsv(accountingInvoicesCsv(sourceB));
  const paymentsB = parseCsv(accountingPaymentsCsv(sourceB));
  const expensesB = parseCsv(accountingExpensesCsv(sourceB));
  check(
    "Tenant B export never includes tenant A invoices, payments, or expenses",
    invoicesB.records.every((row) => row["Invoice ID"] === invoiceB.id) &&
      paymentsB.records.every((row) => row["Payment ID"] === paymentB.id) &&
      expensesB.records.every((row) => row["Expense ID"] === expenseB.id) &&
      !accountingInvoicesCsv(sourceB).includes(customerA.name) &&
      !accountingPaymentsCsv(sourceB).includes(recordedPayment.id) &&
      !accountingExpensesCsv(sourceB).includes(activeExpense.description),
  );

  const zipA = await buildBusinessExportZip(prisma, businessA.id);
  const zipB = await buildBusinessExportZip(prisma, businessB.id);
  const accountingZipA = await buildAccountingExportZip(prisma, businessA.id);
  const zipAText = zipA.bytes.toString("utf8");
  const zipBText = zipB.bytes.toString("utf8");
  const accountingZipAText = accountingZipA.bytes.toString("utf8");
  check(
    "Existing business ZIP reuses the accountant-ready invoice/payment/expense CSVs",
    zipA.filename.startsWith("tbbt-export-") &&
      zipAText.includes("Invoice Number") &&
      zipAText.includes("Amount Paid") &&
      zipAText.includes(sentWithPartial.id) &&
      zipAText.includes(recordedPayment.id) &&
      zipAText.includes(activeExpense.id) &&
      !zipAText.includes("Voided fuel should not export") &&
      !zipAText.includes(stripeSessionId) &&
      !zipAText.includes("Beta Only Customer"),
  );
  check(
    "Dedicated accounting ZIP is the same three CSVs for this tenant only",
    accountingZipA.filename.startsWith("tbbt-accounting-") &&
      accountingZipAText.includes("Invoice Number") &&
      accountingZipAText.includes(recordedPayment.id) &&
      !accountingZipAText.includes("Beta Only Customer") &&
      !accountingZipAText.includes(stripeIntentId),
  );
  check(
    "Another tenant's ZIP never contains this tenant's records",
    !zipBText.includes(customerA.name) &&
      !zipBText.includes(recordedPayment.id) &&
      !zipBText.includes(activeExpense.description) &&
      zipBText.includes("Beta Only Customer"),
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nAll accounting export checks passed."
    : `\n${failures} accounting export check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
