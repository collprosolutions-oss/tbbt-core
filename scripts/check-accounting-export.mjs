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
  ACCOUNTING_EXPORT_AUDIT_AREA,
  ACCOUNTING_EXPORT_AUDIT_KEY,
  ACCOUNTING_INVOICE_HEADERS,
  ACCOUNTING_PAYMENT_HEADERS,
  PAYMENT_BASIS,
  accountingExpensesCsv,
  accountingExportAuditPayload,
  accountingInvoicesCsv,
  accountingPaymentsCsv,
  accountingInvoicePaymentTotals,
  buildAccountingExportZip,
  canExportBusinessData,
  emptyAccountingExportSource,
  exportAccountingText,
  exportMoney,
  invoiceCountByJobId,
  loadAccountingExportSource,
  paymentsAllocatedToInvoice,
  recordAccountingExportAudit,
  runAccountingExportDownload,
} = await import("@/lib/accounting-export");
const { ForbiddenError } = await import("@/lib/authorization");
const { isSecretSettingKey } = await import("@/lib/settings");
const { buildBusinessExportZip } = await import("@/lib/business-export");
const { invoiceNumberFromId, jobReferenceFromId } = await import("@/lib/invoice-document");
const { attachEstimatePaymentsToInvoice } = await import("@/lib/project-payments");
const { INVOICE_KIND_ORIGINAL, INVOICE_KIND_SUPPLEMENTAL } = await import("@/lib/revenue-integrity");
const {
  ZIP_UTF8_NAME_FLAG,
  buildZipStore,
  neutralizeCsvFormulaPrefix,
  toCsv,
  toCsvCell,
  zipNameGeneralPurposeFlag,
} = await import("@/lib/zip-store");
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
const businessExportSrc = readFileSync(new URL("../src/lib/business-export.ts", import.meta.url), "utf8");
check(
  "Existing ZIP route uses the shared export download helper",
  exportRouteSrc.includes("runBusinessExportDownload") &&
    !exportRouteSrc.includes("requireSaasOperatingEntitlement") &&
    businessExportSrc.includes("canExportBusinessData") &&
    businessExportSrc.includes("buildBusinessExportZip") &&
    businessExportSrc.includes("recordBusinessExportAudit"),
);
check(
  "Business ZIP jobs, estimates, and time cards keep property, total, and activity fields",
  businessExportSrc.includes("propertyId: true") &&
    businessExportSrc.includes("total: true") &&
    businessExportSrc.includes("activityType: true") &&
    businessExportSrc.includes("exportEstimateTotal") &&
    businessExportSrc.includes("prisma.invoiceCredit.findMany") &&
    businessExportSrc.includes("invoice-credits.csv") &&
    businessExportSrc.includes("credits:"),
);
check(
  "Accounting ZIP reuses the same export gate and builders",
  accountingRouteSrc.includes("runAccountingExportDownload") &&
    accountingSrc.includes("export async function runAccountingExportDownload") &&
    accountingSrc.includes("canExportBusinessData") &&
    accountingSrc.includes("buildAccountingExportZip") &&
    !accountingRouteSrc.includes("requireSaasOperatingEntitlement"),
);
check(
  "Successful accounting download writes one SettingsAuditLog row; the route does not write a second",
  accountingSrc.includes("recordAccountingExportAudit") &&
    accountingSrc.includes("writeSettingsAuditLog") &&
    accountingSrc.includes("await recordAccountingExportAudit") &&
    ACCOUNTING_EXPORT_AUDIT_AREA === "data-export" &&
    ACCOUNTING_EXPORT_AUDIT_KEY === "accountingExport" &&
    !isSecretSettingKey(ACCOUNTING_EXPORT_AUDIT_KEY) &&
    accountingExportAuditPayload({ filename: "tbbt-accounting-demo-2026-10-02.zip" }).filename ===
      "tbbt-accounting-demo-2026-10-02.zip" &&
    Object.keys(accountingExportAuditPayload({ filename: "tbbt-accounting-demo-2026-10-02.zip" })).join(",") ===
      "filename" &&
    accountingRouteSrc.includes("runAccountingExportDownload") &&
    !accountingRouteSrc.includes("recordAccountingExportAudit") &&
    !accountingRouteSrc.includes("writeSettingsAuditLog") &&
    !accountingRouteSrc.includes("buildAccountingExportZip"),
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
const zipStoreSrc = readFileSync(new URL("../src/lib/zip-store.ts", import.meta.url), "utf8");
check(
  "Accounting and ZIP CSV formula prefixes include tab and CR",
  accountingSrc.includes("/^[=+\\-@\\t\\r]/") &&
    zipStoreSrc.includes("/^[=+\\-@\\t\\r]/") &&
    zipStoreSrc.includes("/[\",\\n\\r]/") &&
    zipStoreSrc.includes("neutralizeCsvFormulaPrefix") &&
    accountingSrc.includes("exportAccountingText"),
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
  "CSV escaping quotes commas, quotes, newlines, and CR",
  toCsvCell('Acme, "Best"\nCo') === '"Acme, ""Best""\nCo"' &&
    toCsv(["Name"], [{ Name: 'Acme, "Best"\nCo' }]).includes('"Acme, ""Best""\nCo"') &&
    toCsvCell("Line1\rLine2") === `"Line1\rLine2"` &&
    toCsv(["Note"], [{ Note: "Line1\rLine2" }]).includes(`"Line1\rLine2"`),
);
check(
  "Formula-like text is prefixed so spreadsheet cells stay literal",
  exportAccountingText('=HYPERLINK("https://example.invalid","x")') ===
    `'=HYPERLINK("https://example.invalid","x")` &&
    exportAccountingText("+SUM(1,1)") === "'+SUM(1,1)" &&
    exportAccountingText("@anything") === "'@anything" &&
    exportAccountingText("-CMD") === "'-CMD" &&
    exportAccountingText("\t=1+1") === "'\t=1+1" &&
    exportAccountingText("\r=1+1") === "'\r=1+1" &&
    neutralizeCsvFormulaPrefix("\t=1+1") === "'\t=1+1" &&
    neutralizeCsvFormulaPrefix("\r=1+1") === "'\r=1+1" &&
    toCsvCell("\t=1+1") === "'\t=1+1" &&
    toCsvCell("\r=1+1") === `"'\r=1+1"` &&
    exportAccountingText("Home Depot") === "Home Depot" &&
    exportAccountingText("") === "",
);
check(
  "Money columns keep a leading minus numeric",
  exportMoney("-12.50") === "-12.50" &&
    exportAccountingText("-12.50") === "'-12.50" &&
    neutralizeCsvFormulaPrefix("-70.00") === "-70.00" &&
    neutralizeCsvFormulaPrefix("-1") === "-1" &&
    neutralizeCsvFormulaPrefix("-0.5") === "-0.5" &&
    toCsvCell("-70.00") === "-70.00" &&
    toCsvCell("-1") === "-1" &&
    toCsvCell("-0.5") === "-0.5" &&
    toCsvCell("-12.50") === "-12.50",
);

const formulaSource = {
  businessId: "biz_formula",
  businessName: "Formula Co",
  slug: "formula-co",
  invoices: [
    {
      id: "inv_formula",
      customerId: "cust_formula",
      jobId: "job_formula",
      status: "SENT",
      total: "100.00",
      paidAt: null,
      paymentMethod: "CHECK",
      paymentReference: '=HYPERLINK("https://example.invalid","x")',
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  ],
  payments: [
    {
      id: "pay_formula",
      customerId: "cust_formula",
      invoiceId: "inv_formula",
      jobId: "job_formula",
      purpose: "INVOICE_BALANCE",
      amount: "25.00",
      method: "CASH",
      receivedAt: new Date("2026-09-01T12:00:00.000Z"),
      note: "@anything",
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
    },
  ],
  expenses: [
    {
      id: "exp_formula",
      vendor: "+SUM(1,1)",
      description: "-CMD",
      amount: "-12.50",
      category: "OTHER",
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      jobId: "job_formula",
      customerId: "cust_formula",
      paymentMethod: "CASH",
      taxCategory: null,
      reimbursementStatus: "NONE",
      reviewStatus: "RECORDED",
      voidedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  ],
  customers: [{ id: "cust_formula", name: '=HYPERLINK("https://example.invalid","x")' }],
  jobs: [{ id: "job_formula" }],
};
const formulaInvoices = parseCsv(accountingInvoicesCsv(formulaSource));
const formulaPayments = parseCsv(accountingPaymentsCsv(formulaSource));
const formulaExpenses = parseCsv(accountingExpensesCsv(formulaSource));
check(
  "Accounting CSV formula prefixes survive quoting and leave money numeric",
  formulaInvoices.records[0].Customer === `'=HYPERLINK("https://example.invalid","x")` &&
    formulaInvoices.records[0]["Payment Reference"] ===
      `'=HYPERLINK("https://example.invalid","x")` &&
    formulaPayments.records[0].Note === "'@anything" &&
    formulaExpenses.records[0].Vendor === "'+SUM(1,1)" &&
    formulaExpenses.records[0].Description === "'-CMD" &&
    formulaExpenses.records[0].Amount === "-12.50" &&
    formulaInvoices.records[0].Total === "100.00" &&
    !formulaInvoices.records[0].Customer.startsWith("=") &&
    !formulaExpenses.records[0].Vendor.startsWith("+") &&
    !formulaExpenses.records[0].Description.startsWith("-"),
);

const controlSource = {
  businessId: "biz_control",
  businessName: "Control Co",
  slug: "control-co",
  invoices: [
    {
      id: "inv_tab",
      customerId: "cust_tab",
      jobId: null,
      status: "SENT",
      total: "70.00",
      paidAt: null,
      paymentMethod: null,
      paymentReference: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    {
      id: "inv_cr",
      customerId: "cust_cr",
      jobId: null,
      status: "SENT",
      total: "-1",
      paidAt: null,
      paymentMethod: null,
      paymentReference: null,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    },
  ],
  payments: [
    {
      id: "pay_cr",
      customerId: "cust_cr",
      invoiceId: "inv_cr",
      jobId: null,
      purpose: "INVOICE_BALANCE",
      amount: "-0.5",
      method: "CASH",
      receivedAt: new Date("2026-09-02T12:00:00.000Z"),
      note: "Line1\rLine2",
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
    },
  ],
  expenses: [
    {
      id: "exp_cr",
      vendor: "\t=1+1",
      description: "Line1\rLine2",
      amount: "-70.00",
      category: "OTHER",
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      jobId: null,
      customerId: "cust_tab",
      paymentMethod: "CASH",
      taxCategory: null,
      reimbursementStatus: "NONE",
      reviewStatus: "RECORDED",
      voidedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  ],
  customers: [
    { id: "cust_tab", name: "\t=1+1" },
    { id: "cust_cr", name: "\r=1+1" },
  ],
  jobs: [],
};
const controlInvoicesCsv = accountingInvoicesCsv(controlSource);
const controlPaymentsCsv = accountingPaymentsCsv(controlSource);
const controlExpensesCsv = accountingExpensesCsv(controlSource);
const controlInvoices = parseCsv(controlInvoicesCsv);
const controlPayments = parseCsv(controlPaymentsCsv);
const controlExpenses = parseCsv(controlExpensesCsv);
check(
  "Tab-leading, CR-leading, and embedded-CR cells are neutralized and quoted",
  controlInvoices.records.find((row) => row["Invoice ID"] === "inv_tab")?.Customer === "'\t=1+1" &&
    controlInvoices.records.find((row) => row["Invoice ID"] === "inv_cr")?.Customer === "'\r=1+1" &&
    controlInvoicesCsv.includes("'\t=1+1") &&
    controlInvoicesCsv.includes(`"'${"\r"}=1+1"`) &&
    controlPayments.records[0].Note === "Line1\rLine2" &&
    controlPaymentsCsv.includes(`"Line1\rLine2"`) &&
    controlExpenses.records[0].Vendor === "'\t=1+1" &&
    controlExpenses.records[0].Description === "Line1\rLine2" &&
    controlExpensesCsv.includes(`"Line1\rLine2"`) &&
    controlInvoices.records.find((row) => row["Invoice ID"] === "inv_tab")?.Total === "70.00" &&
    controlInvoices.records.find((row) => row["Invoice ID"] === "inv_cr")?.Total === "-1.00" &&
    controlPayments.records[0].Amount === "-0.50" &&
    controlExpenses.records[0].Amount === "-70.00" &&
    !controlInvoices.records.some((row) => row.Customer === "\t=1+1" || row.Customer === "\r=1+1"),
);

const invoiceA = {
  id: "inv_a",
  customerId: "cust_multi",
  jobId: "job_multi",
  kind: INVOICE_KIND_ORIGINAL,
  status: "SENT",
  total: "300.00",
  paidAt: null,
  paymentMethod: null,
  paymentReference: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};
const invoiceB = {
  id: "inv_b",
  customerId: "cust_multi",
  jobId: "job_multi",
  kind: INVOICE_KIND_SUPPLEMENTAL,
  status: "SENT",
  total: "60.00",
  paidAt: null,
  paymentMethod: null,
  paymentReference: null,
  createdAt: new Date("2026-09-01T01:00:00.000Z"),
  updatedAt: new Date("2026-09-01T01:00:00.000Z"),
};
const jobOnlyPayment = {
  id: "pay_job_only",
  customerId: "cust_multi",
  invoiceId: null,
  jobId: "job_multi",
  purpose: "INVOICE_BALANCE",
  amount: "50.00",
  method: "CASH",
  receivedAt: new Date("2026-09-02T00:00:00.000Z"),
  note: null,
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
};
const directPaymentA = {
  id: "pay_direct_a",
  customerId: "cust_multi",
  invoiceId: "inv_a",
  jobId: "job_multi",
  purpose: "INVOICE_BALANCE",
  amount: "40.00",
  method: "CHECK",
  receivedAt: new Date("2026-09-02T01:00:00.000Z"),
  note: null,
  createdAt: new Date("2026-09-02T01:00:00.000Z"),
};
const directPaymentB = {
  id: "pay_direct_b",
  customerId: "cust_multi",
  invoiceId: "inv_b",
  jobId: "job_multi",
  purpose: "INVOICE_BALANCE",
  amount: "15.00",
  method: "CASH",
  receivedAt: new Date("2026-09-02T02:00:00.000Z"),
  note: null,
  createdAt: new Date("2026-09-02T02:00:00.000Z"),
};
const multiSource = {
  businessId: "biz_multi",
  businessName: "Multi Invoice Co",
  slug: "multi-invoice",
  invoices: [invoiceA, invoiceB],
  payments: [jobOnlyPayment, directPaymentA, directPaymentB],
  expenses: [],
  customers: [{ id: "cust_multi", name: "Multi Customer" }],
  jobs: [{ id: "job_multi" }],
};
const multiInvoices = parseCsv(accountingInvoicesCsv(multiSource));
const multiPayments = parseCsv(accountingPaymentsCsv(multiSource));
const multiA = multiInvoices.records.find((row) => row["Invoice ID"] === "inv_a");
const multiB = multiInvoices.records.find((row) => row["Invoice ID"] === "inv_b");
const jobCounts = invoiceCountByJobId(multiSource.invoices);
check("Two invoices on the same job are counted as a multi-invoice job", jobCounts.get("job_multi") === 2);
check(
  "Legacy job-only payment attributes to ORIGINAL A only, never SUPPLEMENTAL B",
  paymentsAllocatedToInvoice(invoiceA, multiSource.payments).some((row) => row.id === "pay_job_only") &&
    paymentsAllocatedToInvoice(invoiceB, multiSource.payments).every((row) => row.id !== "pay_job_only") &&
    multiA?.["Amount Paid"] === "90.00" &&
    multiA["Amount Remaining"] === "210.00" &&
    multiB?.["Amount Paid"] === "15.00" &&
    multiB["Amount Remaining"] === "45.00",
);
check(
  "Direct Payment.invoiceId=A counts only on A",
  paymentsAllocatedToInvoice(invoiceA, multiSource.payments).some((row) => row.id === "pay_direct_a") &&
    paymentsAllocatedToInvoice(invoiceB, multiSource.payments).every((row) => row.id !== "pay_direct_a") &&
    multiA?.["Payment Basis"] === PAYMENT_BASIS.RECORDED_PAYMENTS,
);
check(
  "Direct Payment.invoiceId=B counts only on B",
  paymentsAllocatedToInvoice(invoiceB, multiSource.payments).some((row) => row.id === "pay_direct_b") &&
    paymentsAllocatedToInvoice(invoiceA, multiSource.payments).every((row) => row.id !== "pay_direct_b") &&
    multiB?.["Payment Basis"] === PAYMENT_BASIS.RECORDED_PAYMENTS,
);
check(
  "Job-only payment appears once in payments.csv with a blank Invoice ID",
  multiPayments.records.filter((row) => row["Payment ID"] === "pay_job_only").length === 1 &&
    multiPayments.records.find((row) => row["Payment ID"] === "pay_job_only")?.["Invoice ID"] === "" &&
    multiPayments.records.find((row) => row["Payment ID"] === "pay_job_only")?.["Job ID"] === "job_multi",
);

const singleInvoice = {
  id: "inv_single",
  customerId: "cust_single",
  jobId: "job_single",
  kind: INVOICE_KIND_ORIGINAL,
  status: "SENT",
  total: "500.00",
  paidAt: null,
  paymentMethod: null,
  paymentReference: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
};
const singleJobPayment = {
  id: "pay_single_job",
  customerId: "cust_single",
  invoiceId: null,
  jobId: "job_single",
  purpose: "MATERIAL_DEPOSIT",
  amount: "75.00",
  method: "CASH",
  receivedAt: new Date("2026-09-02T00:00:00.000Z"),
  note: null,
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
};
const singleSource = {
  businessId: "biz_single",
  businessName: "Single Invoice Co",
  slug: "single-invoice",
  invoices: [singleInvoice],
  payments: [singleJobPayment],
  expenses: [],
  customers: [{ id: "cust_single", name: "Single Customer" }],
  jobs: [{ id: "job_single" }],
};
const singleRow = parseCsv(accountingInvoicesCsv(singleSource)).records[0];
check(
  "Single-invoice job still allocates a legacy job-only Payment",
  paymentsAllocatedToInvoice(singleInvoice, singleSource.payments).some((row) => row.id === "pay_single_job") &&
    singleRow["Amount Paid"] === "75.00" &&
    singleRow["Amount Remaining"] === "425.00" &&
    singleRow["Payment Basis"] === PAYMENT_BASIS.RECORDED_PAYMENTS,
);

const paidPartial = accountingInvoicePaymentTotals(
  { id: "inv_paid_partial", jobId: "job_pp", kind: INVOICE_KIND_ORIGINAL, status: "PAID", total: "400.00" },
  [
    {
      id: "pay_partial",
      customerId: null,
      invoiceId: "inv_paid_partial",
      jobId: "job_pp",
      purpose: "INVOICE_BALANCE",
      amount: "50.00",
      method: "CASH",
      receivedAt: new Date(),
      note: null,
      createdAt: new Date(),
    },
  ],
);
check(
  "PAID invoice with recorded Payment rows follows Payment truth, not the invoice total",
  paidPartial.paymentBasis === PAYMENT_BASIS.RECORDED_PAYMENTS &&
    paidPartial.legacyFullyPaid === false &&
    paidPartial.amountPaid.toFixed(2) === "50.00" &&
    paidPartial.amountRemaining.toFixed(2) === "350.00",
);
check(
  "Accounting export uses invoicePaymentBreakdown instead of a second paid-cash rule",
  accountingSrc.includes("invoicePaymentBreakdown") &&
    accountingSrc.includes("legacyFullyPaid") &&
    accountingSrc.includes("paymentsAllocatedToInvoice") &&
    accountingSrc.includes("paymentsBelongingToInvoice") &&
    accountingSrc.includes("ORIGINAL invoice only") &&
    accountingSrc.includes("kind: true") &&
    readFileSync(new URL("../src/lib/business-export.ts", import.meta.url), "utf8").includes("kind: true"),
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
  const tabCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "\t=1+1" },
  });
  const crCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "\r=1+1" },
  });
  const embeddedCrCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Line1\rLine2" },
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
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: tabCustomer.id,
      status: "SENT",
      total: new Prisma.Decimal("10.00"),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: crCustomer.id,
      status: "SENT",
      total: new Prisma.Decimal("11.00"),
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: embeddedCrCustomer.id,
      status: "SENT",
      total: new Prisma.Decimal("12.00"),
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
  const crExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-09-06T00:00:00.000Z"),
      description: "Line1\rLine2",
      amount: new Prisma.Decimal("8.00"),
      category: "OTHER",
      vendor: "\t=1+1",
      customerId: tabCustomer.id,
      paymentMethod: "CASH",
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

  const supplementJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const supplementInvoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: supplementJob.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "SENT",
      total: new Prisma.Decimal("300.00"),
    },
  });
  const supplementInvoiceB = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: supplementJob.id,
      kind: INVOICE_KIND_SUPPLEMENTAL,
      status: "SENT",
      total: new Prisma.Decimal("60.00"),
    },
  });
  const unallocatedJobPayment = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: supplementJob.id,
      invoiceId: null,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal("50.00"),
      method: "CASH",
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
    "PAID invoice without Payment rows uses the legacy fully-paid fallback",
    paidRow?.Status === "PAID" &&
      paidRow.Total === "400.00" &&
      paidRow["Amount Paid"] === "400.00" &&
      paidRow["Amount Remaining"] === "0.00" &&
      paidRow["Payment Basis"] === PAYMENT_BASIS.LEGACY_PAID_STATUS,
  );
  check(
    "Legacy PAID fallback never invents a Payment row",
    payments.records.every((row) => row["Invoice ID"] !== paidWithoutPayments.id) &&
      payments.records.some((row) => row["Payment ID"] === recordedPayment.id && row.Amount === "50.00"),
  );
  check(
    "Partial recorded payment is used for paid/remaining",
    partialRow?.Status === "SENT" &&
      partialRow.Total === "250.00" &&
      partialRow["Amount Paid"] === "50.00" &&
      partialRow["Amount Remaining"] === "200.00" &&
      partialRow["Payment Basis"] === PAYMENT_BASIS.RECORDED_PAYMENTS,
  );
  check(
    "Invoice CSV includes human-readable identifiers and customer name",
    paidRow?.["Invoice Number"] === invoiceNumberFromId(paidWithoutPayments.id) &&
      paidRow["Job Reference"] === jobReferenceFromId(jobA.id) &&
      paidRow.Customer === 'Pat, "Alpha"\nCustomer',
  );
  const recordedPaymentRow = payments.records.find((row) => row["Payment ID"] === recordedPayment.id);
  check(
    "Payment CSV includes invoice/job relationship, method, purpose, and received date",
    recordedPaymentRow?.["Invoice Number"] === invoiceNumberFromId(sentWithPartial.id) &&
      recordedPaymentRow["Job Reference"] === jobReferenceFromId(jobA.id) &&
      recordedPaymentRow.Method === "CHECK" &&
      recordedPaymentRow.Purpose === "INVOICE_BALANCE" &&
      recordedPaymentRow["Purpose Label"] === "Invoice Balance" &&
      recordedPaymentRow["Received At"] === "2026-09-03T12:00:00.000Z",
  );
  check(
    "CSV escaping survives customer names, payment notes, and expense descriptions",
    invoices.records.some((row) => row.Customer === 'Pat, "Alpha"\nCustomer') &&
      recordedPaymentRow.Note === 'Check 12, "office"' &&
      expenses.records[0].Description === 'Lumber, 2x4, "premium"',
  );
  const dbSupplementA = invoices.records.find((row) => row["Invoice ID"] === supplementInvoiceA.id);
  const dbSupplementB = invoices.records.find((row) => row["Invoice ID"] === supplementInvoiceB.id);
  check(
    "Before attach, invoices.csv attributes the $50 job-only payment to ORIGINAL A only",
    dbSupplementA?.["Amount Paid"] === "50.00" &&
      dbSupplementA.Total === "300.00" &&
      dbSupplementA["Payment Basis"] === PAYMENT_BASIS.RECORDED_PAYMENTS &&
      dbSupplementB?.["Amount Paid"] === "0.00" &&
      dbSupplementB.Total === "60.00" &&
      dbSupplementB["Payment Basis"] === PAYMENT_BASIS.NO_RECORDED_PAYMENT &&
      payments.records.filter((row) => row["Payment ID"] === unallocatedJobPayment.id).length === 1 &&
      payments.records.find((row) => row["Payment ID"] === unallocatedJobPayment.id)?.["Invoice ID"] === "",
  );

  const attachedCount = await attachEstimatePaymentsToInvoice(prisma, {
    businessId: businessA.id,
    jobId: supplementJob.id,
    invoiceId: supplementInvoiceA.id,
  });
  check("attachEstimatePaymentsToInvoice assigns the legacy payment to ORIGINAL A", attachedCount === 1);
  const afterAttachPayment = await prisma.payment.findUniqueOrThrow({
    where: { id: unallocatedJobPayment.id },
  });
  check("after attach, Payment.invoiceId is ORIGINAL A", afterAttachPayment.invoiceId === supplementInvoiceA.id);
  const sourceAfterAttach = await loadAccountingExportSource(prisma, businessA.id);
  const invoicesAfterAttach = parseCsv(accountingInvoicesCsv(sourceAfterAttach));
  const paymentsAfterAttach = parseCsv(accountingPaymentsCsv(sourceAfterAttach));
  const afterA = invoicesAfterAttach.records.find((row) => row["Invoice ID"] === supplementInvoiceA.id);
  const afterB = invoicesAfterAttach.records.find((row) => row["Invoice ID"] === supplementInvoiceB.id);
  check(
    "After attach, invoice totals stay the same and payments.csv records A explicitly",
    afterA?.["Amount Paid"] === "50.00" &&
      afterB?.["Amount Paid"] === "0.00" &&
      paymentsAfterAttach.records.filter((row) => row["Payment ID"] === unallocatedJobPayment.id).length === 1 &&
      paymentsAfterAttach.records.find((row) => row["Payment ID"] === unallocatedJobPayment.id)?.["Invoice ID"] ===
        supplementInvoiceA.id,
  );
  check(
    "Active expense is exported and voided expense truth is omitted",
    expenses.records.length === 2 &&
      expenses.records.some(
        (row) =>
          row["Expense ID"] === activeExpense.id &&
          row.Amount === "142.68" &&
          row.Category === "MATERIALS" &&
          row["Job Reference"] === jobReferenceFromId(jobA.id),
      ) &&
      expenses.records.some((row) => row["Expense ID"] === crExpense.id) &&
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
      zipAText.includes("Payment Basis") &&
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
  check(
    "Business and accounting ZIP CSVs neutralize tab/CR formulas and quote embedded CR",
    zipAText.includes("'\t=1+1") &&
      zipAText.includes(`"'${"\r"}=1+1"`) &&
      zipAText.includes(`"Line1\rLine2"`) &&
      accountingZipAText.includes("'\t=1+1") &&
      accountingZipAText.includes(`"'${"\r"}=1+1"`) &&
      accountingZipAText.includes(`"Line1\rLine2"`) &&
      !zipAText.includes(`,${"\t"}=1+1,`) &&
      !accountingZipAText.includes(`,${"\t"}=1+1,`) &&
      expenses.records.some(
        (row) =>
          row["Expense ID"] === crExpense.id &&
          row.Vendor === "'\t=1+1" &&
          row.Description === "Line1\rLine2",
      ) &&
      invoices.records.some((row) => row["Customer ID"] === tabCustomer.id && row.Customer === "'\t=1+1") &&
      invoices.records.some((row) => row["Customer ID"] === crCustomer.id && row.Customer === "'\r=1+1"),
  );
  const unicodeEntryName = "vault-documents/id-résumé-日本.pdf";
  const unicodeZip = buildZipStore([{ name: unicodeEntryName, data: "vault-bytes" }]);
  check(
    "Non-ASCII ZIP entry names set UTF-8 general-purpose flag bit 11",
    ZIP_UTF8_NAME_FLAG === 0x0800 &&
      zipNameGeneralPurposeFlag(unicodeEntryName) === ZIP_UTF8_NAME_FLAG &&
      zipNameGeneralPurposeFlag("invoices.csv") === 0 &&
      unicodeZip.readUInt16LE(6) === ZIP_UTF8_NAME_FLAG &&
      unicodeZip.includes(Buffer.from(unicodeEntryName, "utf8")),
  );

  console.log("\nDB — accounting download audit is metadata-only and success-only");
  const ownerUserA = await prisma.user.create({
    data: { name: "Olivia", email: `owner-acc-${randomUUID()}@example.com`, passwordHash: "hashed-owner" },
  });
  const adminUserA = await prisma.user.create({
    data: { name: "Ada", email: `admin-acc-${randomUUID()}@example.com`, passwordHash: "hashed-admin" },
  });
  const memberUserA = await prisma.user.create({
    data: { name: "Mia", email: `member-acc-${randomUUID()}@example.com`, passwordHash: "hashed-member" },
  });
  const ownerUserB = await prisma.user.create({
    data: { name: "Bea", email: `beta-acc-${randomUUID()}@example.com`, passwordHash: "hashed-beta" },
  });
  const ownerMemA = await prisma.membership.create({
    data: { userId: ownerUserA.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMemA = await prisma.membership.create({
    data: { userId: adminUserA.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMemA = await prisma.membership.create({
    data: { userId: memberUserA.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerMemB = await prisma.membership.create({
    data: { userId: ownerUserB.id, businessId: businessB.id, role: "OWNER" },
  });
  const makeAccess = (businessId, role, membershipId) => ({
    businessId,
    workspace: { role, membership: { id: membershipId } },
  });
  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id);
  const missingAccess = makeAccess(`missing-${randomUUID()}`, "OWNER", ownerMemA.id);

  const previewCount = await prisma.settingsAuditLog.count({
    where: { settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  await buildAccountingExportZip(prisma, businessA.id);
  await loadAccountingExportSource(prisma, businessA.id);
  const afterPreview = await prisma.settingsAuditLog.count({
    where: { settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  check(
    "Preview/build writes no accountingExport audit row and is not a download",
    previewCount === 0 && afterPreview === 0,
  );

  const memberDownload = await runAccountingExportDownload(prisma, memberAccessA);
  const afterMember = await prisma.settingsAuditLog.count({
    where: { businessId: businessA.id, settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  check(
    "MEMBER download is 403, returns no ZIP, and writes no audit",
    memberDownload.ok === false &&
      memberDownload.status === 403 &&
      memberDownload.error === "Forbidden" &&
      !("bytes" in memberDownload) &&
      !("filename" in memberDownload) &&
      afterMember === 0,
  );
  let memberAuditThrew = false;
  try {
    await recordAccountingExportAudit(prisma, memberAccessA, { filename: "tbbt-accounting-blocked.zip" });
  } catch (error) {
    memberAuditThrew = error instanceof ForbiddenError;
  }
  check("MEMBER cannot record an accounting export audit", memberAuditThrew && afterMember === 0);

  const failedDownload = await runAccountingExportDownload(prisma, missingAccess);
  const afterFailed = await prisma.settingsAuditLog.count({
    where: { settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  check(
    "Failed generation is 500, returns no ZIP, and writes no audit",
    failedDownload.ok === false &&
      failedDownload.status === 500 &&
      failedDownload.error === "Export failed" &&
      !("bytes" in failedDownload) &&
      !("filename" in failedDownload) &&
      afterFailed === 0,
  );

  const ownerDownload = await runAccountingExportDownload(prisma, ownerAccessA);
  const adminDownload = await runAccountingExportDownload(prisma, adminAccessA);
  const otherDownload = await runAccountingExportDownload(prisma, ownerAccessB);
  check(
    "OWNER and ADMIN downloads succeed on the runAccountingExportDownload path",
    ownerDownload.ok === true &&
      ownerDownload.status === 200 &&
      Buffer.isBuffer(ownerDownload.bytes) &&
      ownerDownload.filename.startsWith("tbbt-accounting-") &&
      adminDownload.ok === true &&
      otherDownload.ok === true,
  );
  const auditsA = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
    orderBy: { changedAt: "asc" },
  });
  const auditsB = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessB.id, settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  const ownerRow = auditsA.find((row) => row.changedByMembershipId === ownerMemA.id);
  const adminRow = auditsA.find((row) => row.changedByMembershipId === adminMemA.id);
  const ownerPayload = ownerRow ? JSON.parse(ownerRow.newValue) : null;
  const adminPayload = adminRow ? JSON.parse(adminRow.newValue) : null;
  const forbiddenAuditText = [
    customerA.name,
    customerA.email,
    customerB.name,
    "Beta Only Customer",
    stripeSessionId,
    stripeIntentId,
    recordedPayment.note,
    activeExpense.description,
    "142.68",
    "Home Depot",
    "invoices.csv",
    "PK\u0003\u0004",
  ];
  check(
    "Each successful download writes exactly one tenant-scoped accountingExport row",
    auditsA.length === 2 &&
      Boolean(ownerRow) &&
      Boolean(adminRow) &&
      !auditsA.some((row) => row.changedByMembershipId === memberMemA.id) &&
      auditsB.length === 1 &&
      auditsB[0].changedByMembershipId === ownerMemB.id &&
      ownerRow.settingArea === ACCOUNTING_EXPORT_AUDIT_AREA &&
      ownerRow.previousValue === "null" &&
      adminRow.settingArea === ACCOUNTING_EXPORT_AUDIT_AREA,
  );
  check(
    "Accounting download audit stores filename metadata only — no customer, account, or file contents",
    ownerDownload.ok === true &&
      adminDownload.ok === true &&
      ownerPayload?.filename === ownerDownload.filename &&
      adminPayload?.filename === adminDownload.filename &&
      Object.keys(ownerPayload ?? {}).join(",") === "filename" &&
      Object.keys(adminPayload ?? {}).join(",") === "filename" &&
      JSON.stringify(ownerPayload) ===
        JSON.stringify(accountingExportAuditPayload({ filename: ownerDownload.filename })) &&
      auditsA.every((row) => forbiddenAuditText.every((value) => !row.newValue.includes(value))) &&
      !auditsB[0].newValue.includes(customerA.name) &&
      !auditsB[0].newValue.includes(customerA.email),
  );

  const secondOwner = await runAccountingExportDownload(prisma, ownerAccessA);
  const afterSecond = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: ACCOUNTING_EXPORT_AUDIT_KEY },
  });
  check(
    "A second successful OWNER download writes exactly one additional audit row",
    secondOwner.ok === true &&
      afterSecond.length === 3 &&
      afterSecond.filter((row) => row.changedByMembershipId === ownerMemA.id).length === 2,
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
