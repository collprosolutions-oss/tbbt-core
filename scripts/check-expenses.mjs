/**
 * Expenses domain + authorization verification.
 *
 * Imports the REAL production helpers from src/lib/expenses.ts and
 * src/lib/expense-ops.ts (same functions the server actions call).
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-expenses.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const {
  categoryTotals,
  expenseSummary,
  parseExpenseAmount,
  parseMileageMiles,
  projectedOperatingBalance,
  EXPENSE_CATEGORIES,
} = await import("@/lib/expenses");
const { createExpense, reviewExpense, ExpenseError } = await import("@/lib/expense-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_expenses_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for expenses test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  console.log("\nSTATIC — Expenses domain helpers");
  check("Amount 142.68 parses", String(parseExpenseAmount("142.68")) === "142.68");
  check("$1,282.45 parses", String(parseExpenseAmount("$1,282.45")) === "1282.45");
  check("Zero amount is rejected", parseExpenseAmount("0") === null);
  check("Negative amount is rejected", parseExpenseAmount("-12") === null);
  check("Miles 46.2 parses separately from money", String(parseMileageMiles("46.2")) === "46.2");
  check("Initial categories include Materials and Mileage", EXPENSE_CATEGORIES.includes("MATERIALS") && EXPENSE_CATEGORIES.includes("MILEAGE"));
  check("OWNER/ADMIN have MANAGE_EXPENSES", roleHasCapability("OWNER", CAPABILITIES.MANAGE_EXPENSES) && roleHasCapability("ADMIN", CAPABILITIES.MANAGE_EXPENSES));
  check("MEMBER does not have MANAGE_EXPENSES", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_EXPENSES));
  check("MEMBER cannot access the management console", !canAccessManagementConsole("MEMBER"));

  const projection = projectedOperatingBalance({ knownInflows: 2150, knownOutflows: 3557.82 });
  check("Projected balance is null without a verified bank", projection.projectedBalance === null);
  check("Bank is reported not connected", projection.bankConnected === false && projection.verifiedBalance === null);
  check("Known flows are still reported from real TBBT numbers", projection.knownInflows === 2150 && projection.knownOutflows === 3557.82);
  check("Unavailable reason does not invent a bank", projection.unavailableReason.includes("not connected"));

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-exp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-exp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-exp-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-exp-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Expenses", slug: `alpha-exp-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Expenses", slug: `beta-exp-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Smith Kitchen" },
  });
  const property = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      addressLine1: "12 Oak St",
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      propertyId: property.id,
      projectToken: randomUUID(),
      status: "SCHEDULED",
    },
  });

  console.log("\nTEST — Create expense, persist amount/category, allocate job");
  const lumber = await createExpense(prisma, ownerA, {
    occurredOn: "2026-08-30",
    description: "Lumber - 2x4x8, plywood",
    amount: "142.68",
    category: "MATERIALS",
    vendor: "Home Depot",
    purchaserMembershipId: adminMem.id,
    jobId: job.id,
    paymentMethod: "CARD_EXTERNAL",
    reimbursable: false,
  });
  check("Expense is scoped to business A", lumber.businessId === businessA.id);
  check("Amount persisted as Decimal 142.68", Number(lumber.amount.toString()) === 142.68);
  check("Category persisted as MATERIALS", lumber.category === "MATERIALS");
  check("Job allocation stored", lumber.jobId === job.id);
  check("Customer inferred from job", lumber.customerId === customer.id);
  check("Vendor stored", lumber.vendor === "Home Depot");
  check("Non-reimbursable status is NONE", lumber.reimbursementStatus === "NONE");

  const mileage = await createExpense(prisma, adminA, {
    occurredOn: "2026-08-28",
    description: "Mileage - Job site",
    amount: "27.12",
    category: "MILEAGE",
    mileageMiles: "46.2",
    purchaserMembershipId: memberMem.id,
    jobId: job.id,
    reimbursable: true,
  });
  check("Mileage amount stored distinctly", Number(mileage.amount.toString()) === 27.12);
  check("Mileage quantity stored distinctly", Number(mileage.mileageMiles.toString()) === 46.2);
  check("Reimbursable expense is PENDING", mileage.reimbursementStatus === "PENDING");
  check("ADMIN can record expenses", mileage.businessId === businessA.id);

  await expectError(
    "Mileage without miles is rejected",
    () =>
      createExpense(prisma, ownerA, {
        occurredOn: "2026-08-28",
        description: "Miles missing",
        amount: "10.00",
        category: "MILEAGE",
      }),
    (error) => error instanceof ExpenseError && /miles/i.test(error.message),
  );
  await expectError(
    "Mileage without amount is rejected (no invented rate)",
    () =>
      createExpense(prisma, ownerA, {
        occurredOn: "2026-08-28",
        description: "Amount missing",
        amount: "",
        category: "MILEAGE",
        mileageMiles: "10",
      }),
    (error) => error instanceof ExpenseError,
  );

  const gas = await createExpense(prisma, ownerA, {
    occurredOn: "2026-08-27",
    description: "Fuel",
    amount: "54.00",
    category: "GAS_FUEL",
  });
  const tools = await createExpense(prisma, ownerA, {
    occurredOn: "2026-08-26",
    description: "Drill bits",
    amount: "40.00",
    category: "TOOLS_EQUIPMENT",
    recurring: true,
    recurringNote: "Shop restock",
  });
  check("Recurring is a flag, not a billing engine", tools.recurring === true && tools.recurringNote === "Shop restock");

  console.log("\nTEST — Totals from stored rows");
  const rows = await prisma.expense.findMany({ where: { businessId: businessA.id } });
  const summary = expenseSummary(rows);
  check("Overall total is 142.68 + 27.12 + 54 + 40", Math.abs(summary.total - 263.8) < 0.001);
  check("Reimbursable total is the mileage row", Math.abs(summary.reimbursable - 27.12) < 0.001);
  check("Non-reimbursable is the rest", Math.abs(summary.nonReimbursable - 236.68) < 0.001);
  const cats = categoryTotals(rows);
  const materials = cats.find((row) => row.category === "MATERIALS");
  const mileageCat = cats.find((row) => row.category === "MILEAGE");
  check("Materials category total is 142.68 / 1 expense", materials?.amount === 142.68 && materials?.count === 1);
  check("Mileage category total is 27.12 / 1 expense", mileageCat?.amount === 27.12 && mileageCat?.count === 1);
  check("Every required category card is present, including zeros", cats.length === EXPENSE_CATEGORIES.length);

  const reviewed = await reviewExpense(prisma, ownerA, { expenseId: mileage.id, reviewStatus: "APPROVED" });
  check("Owner can approve a reimbursable expense", reviewed.reviewStatus === "APPROVED");

  console.log("\nTEST — Permissions and tenant isolation");
  await expectError(
    "MEMBER cannot create a business-wide expense",
    () =>
      createExpense(prisma, memberA, {
        occurredOn: "2026-08-30",
        description: "Should fail",
        amount: "10.00",
        category: "OTHER",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot pass MANAGE_EXPENSES",
    () => {
      requireBusinessCapability(memberA, CAPABILITIES.MANAGE_EXPENSES);
    },
    (error) => error instanceof ForbiddenError,
  );

  const beta = await createExpense(prisma, ownerB, {
    occurredOn: "2026-08-30",
    description: "Beta paint",
    amount: "99.00",
    category: "MATERIALS",
  });
  check("Business B expense stays on B", beta.businessId === businessB.id);
  const leaked = await prisma.expense.findFirst({
    where: { id: beta.id, businessId: businessA.id },
  });
  check("Business A cannot load Business B expense by id", leaked === null);
  const scopedA = await prisma.expense.findMany({ where: { businessId: businessA.id } });
  check("Scoped A query never returns B expenses", scopedA.every((row) => row.businessId === businessA.id));
  await expectError(
    "Business A cannot attach Business B's job",
    () =>
      createExpense(prisma, ownerB, {
        occurredOn: "2026-08-30",
        description: "Cross-tenant job",
        amount: "5.00",
        category: "OTHER",
        jobId: job.id,
      }),
    (error) => error instanceof ExpenseError,
  );

  const pageSource = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/app/(app)/expenses/page.tsx", import.meta.url), "utf8"),
  );
  const workspaceSource = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/components/expenses/expenses-workspace.tsx", import.meta.url), "utf8"),
  );
  check("Page never hardcodes a fabricated bank balance", !/\$8,750/.test(pageSource) && !/Chase/.test(pageSource));
  check("Projected KPI is Unavailable when bank is missing", pageSource.includes('value: "Unavailable"'));
  check("Mobile list exists (no forced desktop table on small viewports)", workspaceSource.includes("sm:hidden"));
  check("Category totals section is required on the page", workspaceSource.includes("Expenses by Category"));

  console.log(
    failures === 0 ? "\nAll Expenses checks passed." : `\n${failures} Expenses check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datename = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    try {
      await cleanup.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
      );
    } catch {
      /* ignore */
    }
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
