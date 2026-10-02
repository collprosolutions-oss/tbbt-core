/**
 * OWNER-only bank CSV reconciliation proofs.
 *
 * Covers cents/date parse, duplicate and reversed rows, candidate matching
 * to recorded Payment / Expense rows, idempotent import, private source
 * bytes, tenant isolation, and the guarantee that review never creates a
 * Payment, changes an invoice, writes InvoiceCredit, or claims a verified
 * bank balance. Uses the shared disposable Postgres harness. No schema
 * migrate. No live banking connection.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-bank-reconciliation.mjs
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
  console.error("Failed to generate Prisma client for bank reconciliation checks.");
  process.exit(generate.status ?? 1);
}

const featureFiles = [
  "src/lib/bank-reconciliation-copy.ts",
  "src/lib/bank-reconciliation.ts",
  "src/lib/bank-reconciliation-ops.ts",
  "src/app/actions/bank-reconciliation.ts",
  "src/app/(app)/reconciliation/page.tsx",
  "src/app/(app)/reconciliation/[importId]/page.tsx",
  "src/app/(app)/reconciliation/[importId]/source/route.ts",
  "src/components/reconciliation/import-bank-csv-form.tsx",
  "src/components/reconciliation/reconciliation-workspace.tsx",
];
const featureSource = featureFiles.map(readRepo).join("\n");
const opsSrc = readRepo("src/lib/bank-reconciliation-ops.ts");
const actionSrc = readRepo("src/app/actions/bank-reconciliation.ts");
const parseSrc = readRepo("src/lib/bank-reconciliation.ts");
const uiSource = [
  "src/components/reconciliation/import-bank-csv-form.tsx",
  "src/components/reconciliation/reconciliation-workspace.tsx",
  "src/app/(app)/reconciliation/page.tsx",
  "src/app/(app)/reconciliation/[importId]/page.tsx",
].map(readRepo).join("\n");
const selfSrc = readRepo("scripts/check-bank-reconciliation.mjs");
const authSrc = readRepo("src/lib/authorization.ts");
const migrationSrc = readRepo("prisma/migrations/20261002190000_bank_reconciliation/migration.sql");

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { Prisma } = await import("@prisma/client");
const { BANKING_NOT_CONNECTED_MESSAGE } = await import("@/lib/finance-connections");
const { ACTIVE_EXPENSE_WHERE } = await import("@/lib/expenses");
const {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
} = await import("@/lib/project-payments");
const {
  BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE,
  BANK_CSV_REQUIRED_MESSAGE,
  BANK_NO_LIVE_FEED_MESSAGE,
  BANK_NOT_A_BALANCE_MESSAGE,
  BANK_NOT_A_PAYMENT_MESSAGE,
  BANK_RECONCILIATION_ROUTE,
  BankReconciliationError,
  daysBetweenPostedOn,
  decodeCsvBytes,
  flagDuplicateAndReversedRows,
  hashCsvBytes,
  MAX_BANK_CSV_BYTES,
  MAX_BANK_CSV_ROWS,
  moneyToCents,
  OWNER_ONLY_BANK_RECONCILIATION_MESSAGE,
  parseBankCsv,
  parseBankMoneyToCents,
  parseBankPostedOn,
  parseCsv,
  sanitizeSourceFilename,
  suggestBankMatches,
  summarizeBankWorkspace,
} = await import("@/lib/bank-reconciliation");
const {
  acceptBankReconciliationMatch,
  ignoreBankReconciliationRow,
  importBankCsv,
  listOwnedBankReconciliations,
  loadOwnedBankReconciliation,
  loadOwnedBankSourceFile,
  rejectBankReconciliationMatch,
} = await import("@/lib/bank-reconciliation-ops");

console.log("\nSTATIC — migrate-free bank CSV review stays review-only");
check(
  "reserved migration timestamp is 20261002190000_bank_reconciliation",
  migrationSrc.includes("BankReconciliationImport") &&
    migrationSrc.includes("CREATE TABLE IF NOT EXISTS") &&
    !migrationSrc.includes("DROP TABLE"),
);
check(
  "this verifier uses the shared disposable harness",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check("parse/ops do not run prisma migrate", !parseSrc.includes("migrate deploy") && !opsSrc.includes("migrate deploy"));
check(
  "REVIEW_BANK_RECONCILIATION is OWNER-only",
  authSrc.includes("REVIEW_BANK_RECONCILIATION") &&
    authSrc.includes("CAPABILITIES.REVIEW_BANK_RECONCILIATION") &&
    roleHasCapability("OWNER", CAPABILITIES.REVIEW_BANK_RECONCILIATION) &&
    !roleHasCapability("ADMIN", CAPABILITIES.REVIEW_BANK_RECONCILIATION) &&
    !roleHasCapability("MEMBER", CAPABILITIES.REVIEW_BANK_RECONCILIATION),
);
check("Dedicated route is /reconciliation", BANK_RECONCILIATION_ROUTE === "/reconciliation");
check(
  "Global nav does not add a bank-feed destination",
  APP_NAV.every((item) => item.href !== BANK_RECONCILIATION_ROUTE) &&
    !readRepo("src/lib/nav.ts").includes("/reconciliation"),
);
check("File bound is 256 KB", MAX_BANK_CSV_BYTES === 256 * 1024);
check("Row bound is 500", MAX_BANK_CSV_ROWS === 500);
check("Owner-only copy is present", OWNER_ONLY_BANK_RECONCILIATION_MESSAGE.includes("business owner"));
check("No-live-feed copy is present", /does not open a live bank feed/.test(BANK_NO_LIVE_FEED_MESSAGE));
check("Not-a-payment copy is present", /never creates a Payment/.test(BANK_NOT_A_PAYMENT_MESSAGE));
check("Not-a-balance copy is present", /not a verified bank balance/.test(BANK_NOT_A_BALANCE_MESSAGE));
check("Credits-are-not-deposits copy is present", /never match candidates/.test(BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE));
check(
  "Client forms do not import Node crypto modules",
  !uiSource.includes("bank-reconciliation.ts") &&
    uiSource.includes("bank-reconciliation-copy") &&
    !readRepo("src/lib/bank-reconciliation-copy.ts").includes("node:"),
);
check(
  "Ops require the OWNER capability and scope every load by businessId",
  opsSrc.includes("REVIEW_BANK_RECONCILIATION") &&
    opsSrc.includes("businessId: access.businessId") &&
    opsSrc.includes("requireBusinessCapability"),
);
check(
  "Import never writes Payment, Invoice, InvoiceCredit, or finance connection",
  !/payment\.create|invoice\.update|invoiceCredit\.create|businessFinanceConnection/.test(opsSrc) &&
    !/payment\.create|invoice\.update|invoiceCredit\.create|businessFinanceConnection/.test(actionSrc) &&
    !opsSrc.includes("CONNECTED") &&
    !actionSrc.includes("verified bank balance"),
);
check(
  "Matching never treats InvoiceCredit as a deposit candidate",
  !parseSrc.includes("invoiceCredit") &&
    parseSrc.includes("payments") &&
    parseSrc.includes("expenses") &&
    featureSource.includes("BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE"),
);
check(
  "Source bytes are stored privately and downloaded OWNER-only",
  opsSrc.includes("sourceBytes") &&
    readRepo("src/app/(app)/reconciliation/[importId]/source/route.ts").includes("REVIEW_BANK_RECONCILIATION") &&
    readRepo("src/app/(app)/reconciliation/[importId]/source/route.ts").includes("Cache-Control") &&
    !featureSource.includes("visibility: \"PUBLIC\""),
);
check(
  "Banking honesty message is unchanged",
  BANKING_NOT_CONNECTED_MESSAGE.includes("will not invent a cash balance"),
);
check(
  "Active expenses exclude voided rows",
  opsSrc.includes("ACTIVE_EXPENSE_WHERE") && ACTIVE_EXPENSE_WHERE.voidedAt === null,
);
check(
  "CSV URL fetch is disabled",
  !featureSource.includes("fetchOwnerSuppliedCsv") &&
    !featureSource.includes("sourceUrl") &&
    BANK_CSV_REQUIRED_MESSAGE.includes("does not connect to a bank"),
);

console.log("\nUNIT — cents, dates, duplicates, reversals, and workspace totals");
check("$1,234.56 is 123456 cents", parseBankMoneyToCents("$1,234.56") === 123456);
check("(50.00) is -5000 cents", parseBankMoneyToCents("(50.00)") === -5000);
check("50.00 DR is -5000 cents", parseBankMoneyToCents("50.00 DR") === -5000);
check("50.00 CR is 5000 cents", parseBankMoneyToCents("50.00 CR") === 5000);
check("-12.5 is -1250 cents", parseBankMoneyToCents("-12.5") === -1250);
check("three decimal places are rejected", parseBankMoneyToCents("12.345") === null);
check("empty amount is rejected", parseBankMoneyToCents("") === null);
check("Decimal 500.00 is 50000 cents", moneyToCents(new Prisma.Decimal("500.00")) === 50000);
check("Decimal 85.40 is 8540 cents", moneyToCents("85.40") === 8540);
check("3-cent-fraction Decimal is rejected", moneyToCents(new Prisma.Decimal("1.001")) === null);

check("03/15/2026 is 2026-03-15", parseBankPostedOn("03/15/2026") === "2026-03-15");
check("2026-03-01 stays 2026-03-01", parseBankPostedOn("2026-03-01") === "2026-03-01");
check("3/1/26 is 2026-03-01", parseBankPostedOn("3/1/26") === "2026-03-01");
check("Feb 30 is rejected", parseBankPostedOn("02/30/2026") === null);
check("date window math is calendar days", daysBetweenPostedOn("2026-03-15", "2026-03-18") === -3);

const amountCsv = [
  "Date,Description,Amount",
  "03/15/2026,ZELLE FROM JANE DOE,500.00",
  "03/16/2026,HOME DEPOT #1234,-85.40",
  "03/16/2026,HOME DEPOT #1234,-85.40",
  "03/17/2026,HOME DEPOT REFUND,85.40",
  '03/18/2026,CHECK 1044,"1,200.00"',
  "03/19/2026,AMAZON,(12.00)",
  "03/20/2026,BAD ROW,12.345",
].join("\n");
const parsedAmount = parseBankCsv(amountCsv);
check("amount CSV keeps every source row", parsedAmount.length === 7);
check("first row is a $500 deposit", parsedAmount[0].amountCents === 50000 && parsedAmount[0].direction === "DEPOSIT");
check("Home Depot withdrawal is -8540 cents", parsedAmount[1].amountCents === -8540);
check("duplicate Home Depot is flagged", parsedAmount[2].reviewStatus === "DUPLICATE" && parsedAmount[2].duplicateOfRowNumber === 3);
check(
  "refund is paired as a reversal, not a new deposit candidate",
  parsedAmount[1].reviewStatus === "REVERSED" &&
    parsedAmount[3].reviewStatus === "REVERSED" &&
    parsedAmount[3].reversalOfRowNumber === 3,
);
check("quoted 1,200.00 is 120000 cents", parsedAmount[4].amountCents === 120000);
check("parenthetical Amazon is -1200 cents", parsedAmount[5].amountCents === -1200);
check("three-decimal row is invalid", parsedAmount[6].reviewStatus === "INVALID");

const debitCsv = [
  "Posted Date,Payee,Debit,Credit,Balance",
  "03/15/2026,Jane Doe,,500.00,1500.00",
  "03/16/2026,Home Depot,85.40,,1414.60",
].join("\n");
const parsedDebit = parseBankCsv(debitCsv);
check("debit/credit columns parse signed cents", parsedDebit[0].amountCents === 50000 && parsedDebit[1].amountCents === -8540);
check("balance column is ignored", !parsedDebit[0].rawLine.includes("verified") && parsedDebit[0].reviewStatus === "UNMATCHED");

const totals = summarizeBankWorkspace(parsedAmount);
check(
  "duplicates and reversals do not double-count posted money",
  totals.postedDepositCents === 170000 &&
    totals.postedWithdrawalCents === 1200 &&
    totals.netPostedCents === 168800 &&
    totals.duplicateRowCount === 1 &&
    totals.reversedCount === 2 &&
    totals.invalidCount === 1,
);
check(
  "net posted equals unique signed cents",
  totals.netPostedCents === totals.postedDepositCents - totals.postedWithdrawalCents,
);

const isolated = suggestBankMatches(
  flagDuplicateAndReversedRows([
    {
      rowNumber: 2,
      postedOn: "2026-03-15",
      description: "ZELLE FROM JANE DOE",
      amountCents: 50000,
      direction: "DEPOSIT",
      rowFingerprint: "a",
      rawLine: "",
      reviewStatus: "UNMATCHED",
      invalidReason: null,
      reversalOfRowNumber: null,
      duplicateOfRowNumber: null,
    },
  ]),
  {
    timeZone: "America/New_York",
    payments: [
      {
        id: "pay-other-tenant",
        amount: 500,
        receivedAt: new Date("2026-03-15T16:00:00.000Z"),
        note: "ZELLE FROM JANE DOE",
      },
    ],
    expenses: [],
  },
);
check("unit matching can see a same-cent same-day payment", isolated.get(2)?.[0]?.candidateId === "pay-other-tenant");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "bank-reconciliation disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_bank_recon",
  setProcessEnv: true,
});
const prisma = session.prisma;

function makeAccess(business, role, membershipId) {
  return {
    businessId: business.id,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: business.id, timezone: business.timezone ?? "America/New_York" },
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
  const adminMembership = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: business.id, role: "ADMIN" },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${name} Customer` },
  });
  return { business, membership, adminMembership, customer };
}

try {
  console.log("\nDB — dedicated local workspace proves money math and isolation");
  const tenantA = await seedBusiness("Bank A");
  const tenantB = await seedBusiness("Bank B");
  const ownerA = makeAccess(tenantA.business, "OWNER", tenantA.membership.id);
  const adminA = makeAccess(tenantA.business, "ADMIN", tenantA.adminMembership.id);
  const ownerB = makeAccess(tenantB.business, "OWNER", tenantB.membership.id);

  const invoice = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      status: "SENT",
      total: new Prisma.Decimal("1200.00"),
    },
  });
  const payment500 = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal("500.00"),
      method: "ZELLE_BANK_TRANSFER",
      note: "Zelle from Jane Doe",
      receivedAt: new Date("2026-03-15T16:00:00.000Z"),
    },
  });
  const payment1200 = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
      amount: new Prisma.Decimal("1200.00"),
      method: "CHECK",
      note: "Check 1044",
      receivedAt: new Date("2026-03-18T16:00:00.000Z"),
    },
  });
  const expenseHome = await prisma.expense.create({
    data: {
      businessId: tenantA.business.id,
      occurredOn: new Date("2026-03-16T16:00:00.000Z"),
      description: "Home Depot lumber",
      amount: new Prisma.Decimal("85.40"),
      category: "MATERIALS",
      vendor: "Home Depot",
    },
  });
  const expenseAmazon = await prisma.expense.create({
    data: {
      businessId: tenantA.business.id,
      occurredOn: new Date("2026-03-19T16:00:00.000Z"),
      description: "Amazon shop supplies",
      amount: new Prisma.Decimal("12.00"),
      category: "OFFICE_ADMIN",
      vendor: "Amazon",
    },
  });
  const voidedExpense = await prisma.expense.create({
    data: {
      businessId: tenantA.business.id,
      occurredOn: new Date("2026-03-16T16:00:00.000Z"),
      description: "Voided Home Depot",
      amount: new Prisma.Decimal("85.40"),
      category: "MATERIALS",
      vendor: "Home Depot",
      voidedAt: new Date("2026-03-16T18:00:00.000Z"),
    },
  });
  await prisma.invoiceCredit.create({
    data: {
      businessId: tenantA.business.id,
      invoiceId: invoice.id,
      customerId: tenantA.customer.id,
      amount: new Prisma.Decimal("500.00"),
      reason: "Write-down, not a bank deposit",
      recordedByMembershipId: tenantA.membership.id,
      idempotencyKey: `credit-${randomUUID()}`,
    },
  });
  const foreignPayment = await prisma.payment.create({
    data: {
      businessId: tenantB.business.id,
      customerId: tenantB.customer.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal("500.00"),
      method: "ZELLE_BANK_TRANSFER",
      note: "ZELLE FROM JANE DOE",
      receivedAt: new Date("2026-03-15T16:00:00.000Z"),
    },
  });

  let adminDenied = false;
  try {
    await importBankCsv(prisma, adminA, { filename: "bank.csv", bytes: Buffer.from(amountCsv) });
  } catch (error) {
    adminDenied = error instanceof ForbiddenError;
  }
  check("ADMIN cannot import a bank CSV", adminDenied);

  const first = await importBankCsv(prisma, ownerA, {
    filename: "Statement (March).CSV",
    bytes: Buffer.from(amountCsv),
  });
  check("import sanitizes the filename", first.sourceLabel === "Statement__March_.CSV");
  check("source bytes are preserved exactly", Buffer.from((await loadOwnedBankSourceFile(prisma, ownerA, first.id)).bytes).equals(Buffer.from(amountCsv)));
  check("content hash is idempotent key", first.contentSha256 === hashCsvBytes(Buffer.from(amountCsv)));
  check("workspace status stays REVIEW", first.status === "REVIEW");
  check("posted deposits exclude reversals and duplicates", first.postedDepositCents === 170000);
  check("posted withdrawals exclude the reversed Home Depot pair", first.postedWithdrawalCents === 1200);
  check("net posted is 1688.00", first.netPostedCents === 168800);
  check("invalid three-decimal row is kept for review", first.invalidCount === 1);

  const zelleRow = first.rows.find((row) => row.amountCents === 50000);
  const checkRow = first.rows.find((row) => row.amountCents === 120000);
  const amazonRow = first.rows.find((row) => row.amountCents === -1200);
  const homeRow = first.rows.find((row) => row.amountCents === -8540 && row.reviewStatus === "REVERSED");
  check("Zelle deposit suggests the same-business $500 payment", zelleRow?.matches.some((match) => match.candidateId === payment500.id && match.candidateKind === "PAYMENT"));
  check("Check deposit suggests the $1200 payment", checkRow?.matches.some((match) => match.candidateId === payment1200.id));
  check("Amazon withdrawal suggests the $12 expense", amazonRow?.matches.some((match) => match.candidateId === expenseAmazon.id && match.candidateKind === "EXPENSE"));
  check("reversed Home Depot is not a payment/expense candidate", (homeRow?.matches.length ?? 1) === 0);
  check(
    "voided expense is not a candidate",
    first.rows.every((row) => row.matches.every((match) => match.candidateId !== voidedExpense.id)),
  );
  check(
    "invoice credit is not a candidate",
    first.rows.every((row) => row.matches.every((match) => match.candidateKind !== "INVOICE_CREDIT")),
  );
  check(
    "other-tenant payment is not a candidate",
    first.rows.every((row) => row.matches.every((match) => match.candidateId !== foreignPayment.id)),
  );

  const paymentsBefore = await prisma.payment.count({ where: { businessId: tenantA.business.id } });
  const invoicesBefore = await prisma.invoice.findMany({ where: { businessId: tenantA.business.id } });
  const creditsBefore = await prisma.invoiceCredit.count({ where: { businessId: tenantA.business.id } });
  const expensesBefore = await prisma.expense.count({ where: { businessId: tenantA.business.id } });
  const financeBefore = await prisma.businessFinanceConnection.count({ where: { businessId: tenantA.business.id } });

  const zelleMatch = zelleRow.matches.find((match) => match.candidateId === payment500.id);
  const accepted = await acceptBankReconciliationMatch(prisma, ownerA, {
    importId: first.id,
    matchId: zelleMatch.id,
  });
  const replayed = await acceptBankReconciliationMatch(prisma, ownerA, {
    importId: first.id,
    matchId: zelleMatch.id,
  });
  check("accepting a match is idempotent", accepted.rows.find((row) => row.id === zelleRow.id)?.reviewStatus === "ACCEPTED" && replayed.id === accepted.id);
  check("accepted deposit cents equal the Zelle row", accepted.acceptedDepositCents === 50000);

  const amazonMatch = amazonRow.matches.find((match) => match.candidateId === expenseAmazon.id);
  const rejected = await rejectBankReconciliationMatch(prisma, ownerA, {
    importId: first.id,
    matchId: amazonMatch.id,
  });
  check(
    "rejecting the only Amazon candidate returns the row to unmatched",
    rejected.rows.find((row) => row.id === amazonRow.id)?.reviewStatus === "UNMATCHED",
  );
  const ignored = await ignoreBankReconciliationRow(prisma, ownerA, {
    importId: first.id,
    rowId: amazonRow.id,
  });
  check("owner can ignore an unmatched row", ignored.rows.find((row) => row.id === amazonRow.id)?.reviewStatus === "IGNORED");

  const paymentsAfter = await prisma.payment.count({ where: { businessId: tenantA.business.id } });
  const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  const creditsAfter = await prisma.invoiceCredit.count({ where: { businessId: tenantA.business.id } });
  const expensesAfter = await prisma.expense.count({ where: { businessId: tenantA.business.id } });
  const financeAfter = await prisma.businessFinanceConnection.findMany({
    where: { businessId: tenantA.business.id },
  });
  check("accept/reject/ignore did not create a Payment", paymentsAfter === paymentsBefore);
  check("invoice total and status are unchanged", invoiceAfter.total.toFixed(2) === "1200.00" && invoiceAfter.status === "SENT" && invoiceAfter.paidAt == null);
  check("no InvoiceCredit was written by reconciliation", creditsAfter === creditsBefore);
  check("no Expense was created or voided by reconciliation", expensesAfter === expensesBefore);
  check(
    "banking connection was not created or marked CONNECTED",
    financeBefore === 0 &&
      financeAfter.length === 0 &&
      financeAfter.every((row) => row.status !== "CONNECTED"),
  );
  check(
    "expense Home Depot row still exists as recorded truth",
    (await prisma.expense.findUnique({ where: { id: expenseHome.id } }))?.amount.toFixed(2) === "85.40",
  );

  const second = await importBankCsv(prisma, ownerA, {
    filename: "statement-again.csv",
    bytes: Buffer.from(amountCsv),
  });
  check("same-business same-bytes import is idempotent", second.id === first.id);
  check("idempotent replay keeps the accepted Zelle match", second.rows.find((row) => row.id === zelleRow.id)?.reviewStatus === "ACCEPTED");
  check("idempotent replay does not add rows", second.rowCount === first.rowCount);

  const listed = await listOwnedBankReconciliations(prisma, ownerA);
  check("list is tenant-scoped to one workspace", listed.length === 1 && listed[0].id === first.id);

  const tenantBImport = await importBankCsv(prisma, ownerB, {
    filename: "statement.csv",
    bytes: Buffer.from(amountCsv),
  });
  check("same file in another tenant is a separate workspace", tenantBImport.id !== first.id);
  check(
    "tenant B does not see tenant A payments",
    tenantBImport.rows.every((row) => row.matches.every((match) => match.candidateId !== payment500.id)),
  );

  let crossTenant = false;
  try {
    await loadOwnedBankReconciliation(prisma, ownerB, first.id);
  } catch (error) {
    crossTenant = error instanceof BankReconciliationError;
  }
  check("tenant B cannot load tenant A's workspace", crossTenant);

  let crossSource = false;
  try {
    await loadOwnedBankSourceFile(prisma, ownerB, first.id);
  } catch (error) {
    crossSource = error instanceof BankReconciliationError;
  }
  check("tenant B cannot download tenant A's source CSV", crossSource);

  const decoded = decodeCsvBytes(Buffer.from(amountCsv));
  check("decodeCsvBytes round-trips the uploaded text", parseCsv(decoded).length === 8);

  if (failures > 0) {
    throw new Error(`${failures} bank reconciliation check(s) failed.`);
  }
  console.log("\nBank CSV reconciliation checks passed.\n");
} finally {
  await session.cleanup();
}
