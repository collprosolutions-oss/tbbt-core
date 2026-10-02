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
const acceptedUniqueMigrationSrc = readRepo(
  "prisma/migrations/20261002196000_bank_reconciliation_accepted_unique/migration.sql",
);

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
  BANK_CANDIDATE_ALREADY_ACCEPTED_MESSAGE,
  BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE,
  BANK_CSV_NUL_MESSAGE,
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
  markAlreadySeenBankRows,
  MAX_BANK_AMOUNT_CENTS,
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
  "accepted-match unique indexes are additive 20261002196000",
  acceptedUniqueMigrationSrc.includes("BankReconciliationMatch_accepted_candidate_key") &&
    acceptedUniqueMigrationSrc.includes("BankReconciliationMatch_accepted_row_key") &&
    acceptedUniqueMigrationSrc.includes("WHERE status = 'ACCEPTED'") &&
    acceptedUniqueMigrationSrc.includes("CREATE UNIQUE INDEX IF NOT EXISTS") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(acceptedUniqueMigrationSrc),
);
check(
  "original bank reconciliation migration was not rewritten for the indexes",
  !migrationSrc.includes("BankReconciliationMatch_accepted_candidate_key") &&
    !migrationSrc.includes("BankReconciliationMatch_accepted_row_key"),
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
  !/\.payment\.create|\.invoice\.update|\.invoiceCredit\.create|\.businessFinanceConnection/.test(
    opsSrc + actionSrc,
  ) &&
    !/status:\s*"CONNECTED"/.test(opsSrc + actionSrc),
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
check(
  "accept locks the match and row, checks inside the transaction, and maps P2002",
  opsSrc.includes("FOR UPDATE OF m, r") &&
    opsSrc.includes("$transaction") &&
    opsSrc.includes('error.code === "P2002"') &&
    /alreadyAccepted[\s\S]{0,220}businessId: access\.businessId/.test(opsSrc) &&
    !/alreadyAccepted[\s\S]{0,220}importId: workspace\.id/.test(opsSrc),
);
check(
  "overlapping files reuse rowFingerprint as ALREADY_SEEN",
  parseSrc.includes("markAlreadySeenBankRows") &&
    opsSrc.includes("markAlreadySeenBankRows") &&
    parseSrc.includes("ALREADY_SEEN") &&
    opsSrc.includes("ALREADY_SEEN"),
);
check(
  "comma thousands must be \\d{1,3}(,\\d{3})+",
  parseSrc.includes("/^\\d{1,3}(,\\d{3})+$/") &&
    parseSrc.includes("normalizeBankMoneyDigits"),
);
check(
  "Int32 overflow and NUL bytes are rejected before Postgres",
  parseSrc.includes("MAX_BANK_AMOUNT_CENTS") &&
    parseSrc.includes("2_147_483_647") &&
    parseSrc.includes("BANK_CSV_NUL_MESSAGE") &&
    parseSrc.includes('view.includes(0)'),
);

console.log("\nUNIT — cents, dates, duplicates, reversals, and workspace totals");
check("$1,234.56 is 123456 cents", parseBankMoneyToCents("$1,234.56") === 123456);
check("(50.00) is -5000 cents", parseBankMoneyToCents("(50.00)") === -5000);
check("50.00 DR is -5000 cents", parseBankMoneyToCents("50.00 DR") === -5000);
check("50.00 CR is 5000 cents", parseBankMoneyToCents("50.00 CR") === 5000);
check("-12.5 is -1250 cents", parseBankMoneyToCents("-12.5") === -1250);
check("three decimal places are rejected", parseBankMoneyToCents("12.345") === null);
check("empty amount is rejected", parseBankMoneyToCents("") === null);
check("European 12,50 is not $1,250.00", parseBankMoneyToCents("12,50") === null);
check("1,5 is not $15.00", parseBankMoneyToCents("1,5") === null);
check("1,2,3 is not $123.00", parseBankMoneyToCents("1,2,3") === null);
check("1,234 stays a thousands separator", parseBankMoneyToCents("1,234") === 123400);
check("Int32 max 21474836.47 is accepted", parseBankMoneyToCents("21474836.47") === MAX_BANK_AMOUNT_CENTS);
check("Int32 overflow 21474836.48 is rejected", parseBankMoneyToCents("21474836.48") === null);
check("negative Int32 overflow is rejected", parseBankMoneyToCents("(21474836.48)") === null);
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

const commaTrapCsv = [
  "Date,Description,Amount",
  '03/15/2026,EURO COMMA,"12,50"',
  '03/16/2026,SHORT COMMA,"1,5"',
  '03/17/2026,MULTI COMMA,"1,2,3"',
  "03/18/2026,OVERFLOW,21474836.48",
].join("\n");
const parsedCommaTrap = parseBankCsv(commaTrapCsv);
check(
  "false thousands commas and Int32 overflow are INVALID rows",
  parsedCommaTrap.length === 4 && parsedCommaTrap.every((row) => row.reviewStatus === "INVALID"),
);

let nulRejected = false;
try {
  decodeCsvBytes(Buffer.from("Date,Description,Amount\n03/15/2026,ZELLE\u0000,500.00"));
} catch (error) {
  nulRejected = error instanceof BankReconciliationError && error.message === BANK_CSV_NUL_MESSAGE;
}
check("UTF-8 text with an embedded NUL is rejected", nulRejected);

const utf16le = Buffer.from("Date,Description,Amount\n03/15/2026,ZELLE,500.00", "utf16le");
let utf16Rejected = false;
try {
  decodeCsvBytes(utf16le);
} catch (error) {
  utf16Rejected = error instanceof BankReconciliationError && error.message === BANK_CSV_NUL_MESSAGE;
}
check("UTF-16/NUL CSV bytes are rejected before Postgres", utf16Rejected);

const alreadySeenMarked = markAlreadySeenBankRows(
  parsedAmount.map((row) => ({ ...row })),
  new Set([parsedAmount[0].rowFingerprint]),
);
check(
  "prior fingerprint marks the matching row ALREADY_SEEN",
  alreadySeenMarked[0].reviewStatus === "ALREADY_SEEN" &&
    alreadySeenMarked[2].reviewStatus === "DUPLICATE",
);

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
await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationMatch_accepted_candidate_key"
  ON "BankReconciliationMatch" ("businessId", "candidateKind", "candidateId")
  WHERE status = 'ACCEPTED'
`);
await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "BankReconciliationMatch_accepted_row_key"
  ON "BankReconciliationMatch" ("rowId")
  WHERE status = 'ACCEPTED'
`);

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

  const overlapCsv = [
    "Date,Description,Amount",
    "03/15/2026,ZELLE FROM JANE DOE,500.00",
    "03/21/2026,NEW DEPOSIT,75.00",
  ].join("\n");
  const overlap = await importBankCsv(prisma, ownerA, {
    filename: "statement-overlap.csv",
    bytes: Buffer.from(overlapCsv),
  });
  const overlapZelle = overlap.rows.find((row) => row.amountCents === 50000);
  const overlapNew = overlap.rows.find((row) => row.amountCents === 7500);
  check("overlapping statement is a new workspace", overlap.id !== first.id);
  check(
    "overlapping Zelle row is ALREADY_SEEN and not re-suggested",
    overlapZelle?.reviewStatus === "ALREADY_SEEN" && (overlapZelle?.matches.length ?? 1) === 0,
  );
  check(
    "new overlap row is still reviewable",
    overlapNew?.reviewStatus === "UNMATCHED" && overlapNew?.amountCents === 7500,
  );
  check(
    "already-seen overlap rows do not double-count posted deposits",
    overlap.postedDepositCents === 7500,
  );

  const crlfBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(amountCsv.replace(/\n/g, "\r\n")),
  ]);
  check("CRLF/BOM copy is not the same SHA-256", hashCsvBytes(crlfBom) !== first.contentSha256);
  const crlfCopy = await importBankCsv(prisma, ownerA, {
    filename: "statement-crlf.csv",
    bytes: crlfBom,
  });
  check("CRLF/BOM copy opens a second workspace", crlfCopy.id !== first.id);
  check(
    "CRLF/BOM copy marks previously imported unique rows ALREADY_SEEN",
    crlfCopy.rows
      .filter((row) => ["UNMATCHED", "CANDIDATE"].includes(row.reviewStatus) === false)
      .length === crlfCopy.rows.length &&
      crlfCopy.rows.some((row) => row.reviewStatus === "ALREADY_SEEN") &&
      crlfCopy.rows.every((row) => row.matches.length === 0),
  );

  const sameAmountNewDesc = [
    "Date,Description,Amount",
    "03/15/2026,OTHER ZELLE,500.00",
  ].join("\n");
  const otherZelle = await importBankCsv(prisma, ownerA, {
    filename: "other-zelle.csv",
    bytes: Buffer.from(sameAmountNewDesc),
  });
  const otherZelleRow = otherZelle.rows.find((row) => row.amountCents === 50000);
  const otherZelleMatch = otherZelleRow?.matches.find((match) => match.candidateId === payment500.id);
  check("different-text $500 still suggests the already-accepted payment", Boolean(otherZelleMatch));
  let businessWideGuard = false;
  try {
    await acceptBankReconciliationMatch(prisma, ownerA, {
      importId: otherZelle.id,
      matchId: otherZelleMatch.id,
    });
  } catch (error) {
    businessWideGuard =
      error instanceof BankReconciliationError &&
      error.message === BANK_CANDIDATE_ALREADY_ACCEPTED_MESSAGE;
  }
  check("accepted-candidate guard is business-wide", businessWideGuard);

  let nulImportRejected = false;
  try {
    await importBankCsv(prisma, ownerA, {
      filename: "utf16.csv",
      bytes: Buffer.from("Date,Description,Amount\n03/15/2026,ZELLE,500.00", "utf16le"),
    });
  } catch (error) {
    nulImportRejected =
      error instanceof BankReconciliationError && error.message === BANK_CSV_NUL_MESSAGE;
  }
  check("NUL/UTF-16 import fails with a BankReconciliationError", nulImportRejected);

  const overflowCsv = [
    "Date,Description,Amount",
    "03/25/2026,TOO BIG,21474836.48",
  ].join("\n");
  const overflowImport = await importBankCsv(prisma, ownerA, {
    filename: "overflow.csv",
    bytes: Buffer.from(overflowCsv),
  });
  check(
    "Int32 overflow persists as INVALID instead of throwing",
    overflowImport.rows[0]?.reviewStatus === "INVALID" && overflowImport.invalidCount === 1,
  );

  const racePayment = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal("250.00"),
      method: "ZELLE_BANK_TRANSFER",
      note: "Race deposit",
      receivedAt: new Date("2026-03-22T16:00:00.000Z"),
    },
  });
  const twoRowRaceCsv = [
    "Date,Description,Amount",
    "03/22/2026,RACE DEPOSIT A,250.00",
    "03/23/2026,RACE DEPOSIT B,250.00",
  ].join("\n");
  const twoRowRace = await importBankCsv(prisma, ownerA, {
    filename: "race-two-rows.csv",
    bytes: Buffer.from(twoRowRaceCsv),
  });
  const raceRowA = twoRowRace.rows.find((row) => row.description.includes("RACE DEPOSIT A"));
  const raceRowB = twoRowRace.rows.find((row) => row.description.includes("RACE DEPOSIT B"));
  const raceMatchA = raceRowA?.matches.find((match) => match.candidateId === racePayment.id);
  const raceMatchB = raceRowB?.matches.find((match) => match.candidateId === racePayment.id);
  check("two-row race has the same payment on both rows", Boolean(raceMatchA && raceMatchB));

  const clientA = session.createClient();
  const clientB = session.createClient();
  const twoRowSettled = await Promise.allSettled([
    acceptBankReconciliationMatch(clientA, ownerA, {
      importId: twoRowRace.id,
      matchId: raceMatchA.id,
    }),
    acceptBankReconciliationMatch(clientB, ownerA, {
      importId: twoRowRace.id,
      matchId: raceMatchB.id,
    }),
  ]);
  const twoRowAccepted = twoRowSettled.filter((result) => result.status === "fulfilled");
  const twoRowRejected = twoRowSettled.filter((result) => result.status === "rejected");
  const twoRowError = twoRowRejected[0]?.reason;
  const acceptedForRacePayment = await prisma.bankReconciliationMatch.count({
    where: {
      businessId: tenantA.business.id,
      candidateKind: "PAYMENT",
      candidateId: racePayment.id,
      status: "ACCEPTED",
    },
  });
  check(
    "concurrent accepts of one payment against two rows leave one ACCEPTED",
    twoRowAccepted.length === 1 &&
      twoRowRejected.length === 1 &&
      twoRowError instanceof BankReconciliationError &&
      acceptedForRacePayment === 1,
  );

  const oneRowPayA = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal("300.00"),
      method: "CHECK",
      note: "Race one row A",
      receivedAt: new Date("2026-03-24T16:00:00.000Z"),
    },
  });
  const oneRowPayB = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal("300.00"),
      method: "CHECK",
      note: "Race one row B",
      receivedAt: new Date("2026-03-24T16:00:00.000Z"),
    },
  });
  const oneRowRace = await importBankCsv(prisma, ownerA, {
    filename: "race-one-row.csv",
    bytes: Buffer.from("Date,Description,Amount\n03/24/2026,RACE ONE ROW,300.00\n"),
  });
  const oneRow = oneRowRace.rows.find((row) => row.description.includes("RACE ONE ROW"));
  const oneRowMatchA = oneRow?.matches.find((match) => match.candidateId === oneRowPayA.id);
  const oneRowMatchB = oneRow?.matches.find((match) => match.candidateId === oneRowPayB.id);
  check("one-row race has two payment candidates", Boolean(oneRowMatchA && oneRowMatchB));

  const clientC = session.createClient();
  const clientD = session.createClient();
  const oneRowSettled = await Promise.allSettled([
    acceptBankReconciliationMatch(clientC, ownerA, {
      importId: oneRowRace.id,
      matchId: oneRowMatchA.id,
    }),
    acceptBankReconciliationMatch(clientD, ownerA, {
      importId: oneRowRace.id,
      matchId: oneRowMatchB.id,
    }),
  ]);
  const oneRowAccepted = oneRowSettled.filter((result) => result.status === "fulfilled");
  const oneRowRejected = oneRowSettled.filter((result) => result.status === "rejected");
  const oneRowError = oneRowRejected[0]?.reason;
  const acceptedOnOneRow = await prisma.bankReconciliationMatch.count({
    where: { businessId: tenantA.business.id, rowId: oneRow.id, status: "ACCEPTED" },
  });
  check(
    "concurrent accepts on one row map the unique violation to BankReconciliationError",
    oneRowAccepted.length === 1 &&
      oneRowRejected.length === 1 &&
      oneRowError instanceof BankReconciliationError &&
      !(oneRowError instanceof Prisma.PrismaClientKnownRequestError) &&
      acceptedOnOneRow === 1,
  );

  if (failures > 0) {
    throw new Error(`${failures} bank reconciliation check(s) failed.`);
  }
  console.log("\nBank CSV reconciliation checks passed.\n");
} finally {
  await session.cleanup();
}
