/**
 * OWNER-only read-only Plaid bank connection proofs.
 *
 * Covers token encryption, two tenants, connect/sync into the existing
 * reconciliation workspace, reconnect, disconnect, concurrent sync, and
 * webhook replay. Fake adapter only. Never creates a Payment, never
 * changes an invoice, never claims a verified cash balance, never moves
 * money. Uses the shared disposable Postgres harness (db push, no migrate).
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-bank-connect.mjs
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:43217";
process.env.TBBT_PLAID_ADAPTER = "fake";
process.env.PLAID_WEBHOOK_SECRET = "sandbox-test";
process.env.PLAID_TOKEN_ENCRYPTION_KEY =
  process.env.PLAID_TOKEN_ENCRYPTION_KEY || randomBytes(32).toString("hex");
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
  console.error("Failed to generate Prisma client for bank-connect checks.");
  process.exit(generate.status ?? 1);
}

const featureFiles = [
  "src/lib/bank-connect.ts",
  "src/lib/bank-connect-copy.ts",
  "src/lib/plaid-provider.ts",
  "src/lib/plaid-token-crypto.ts",
  "src/lib/plaid-webhook.ts",
  "src/app/actions/bank-connect.ts",
  "src/app/api/plaid/webhook/route.ts",
];
const featureSource = featureFiles.map(readRepo).join("\n");
const opsSrc = readRepo("src/lib/bank-connect.ts");
const actionSrc = readRepo("src/app/actions/bank-connect.ts");
const proxySrc = readRepo("src/proxy.ts");
const authSrc = readRepo("src/lib/authorization.ts");
const financeSrc = readRepo("src/lib/finance-connections/provider.ts");
const migrationSrc = readRepo("prisma/migrations/20261003013000_bank_plaid_connection/migration.sql");
const selfSrc = readRepo("scripts/check-bank-connect.mjs");

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { Prisma } = await import("@prisma/client");
const { BANKING_NOT_CONNECTED_MESSAGE, getFinanceConnectionProvider } = await import(
  "@/lib/finance-connections"
);
const { PAYMENT_PURPOSE_INVOICE_BALANCE } = await import("@/lib/project-payments");
const {
  decryptPlaidAccessToken,
  encryptPlaidAccessToken,
} = await import("@/lib/plaid-token-crypto");
const {
  fakePlaidResetLogin,
  queueFakePlaidSync,
  resetFakePlaidProvider,
} = await import("@/lib/plaid-provider");
const { verifyPlaidWebhookRequest, PlaidWebhookVerificationError } = await import(
  "@/lib/plaid-webhook"
);
const { isPlaidWebhookPath, PLAID_WEBHOOK_PATH } = await import("@/lib/plaid-webhook-path");
const {
  BankConnectError,
  createOwnedBankLinkToken,
  disconnectOwnedBankPlaidItem,
  exchangeOwnedBankPublicToken,
  handlePlaidWebhookPayload,
  loadOwnedBankPlaidStatus,
  syncOwnedBankPlaidItem,
} = await import("@/lib/bank-connect");
const { loadOwnedBankReconciliation } = await import("@/lib/bank-reconciliation-ops");
const {
  BANK_CONNECT_ALREADY_CONNECTED_MESSAGE,
  BANK_CONNECT_NEEDS_REAUTH_MESSAGE,
  OWNER_ONLY_BANK_CONNECT_MESSAGE,
} = await import("@/lib/bank-connect-copy");

console.log("\nSTATIC — read-only Plaid feed never claims cash or moves money");
check(
  "reserved migration timestamp is 20261003013000_bank_plaid_connection",
  migrationSrc.includes("Reserved timestamp 20261003013000") &&
    migrationSrc.includes("CREATE TABLE IF NOT EXISTS") &&
    migrationSrc.includes("BankPlaidItem") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc),
);
check(
  "REVIEW_BANK_RECONCILIATION remains OWNER-only",
  roleHasCapability("OWNER", CAPABILITIES.REVIEW_BANK_RECONCILIATION) &&
    !roleHasCapability("ADMIN", CAPABILITIES.REVIEW_BANK_RECONCILIATION) &&
    authSrc.includes("Never creates a Payment"),
);
check(
  "ops and actions require OWNER capability",
  opsSrc.includes("REVIEW_BANK_RECONCILIATION") &&
    actionSrc.includes("workspace.role !== \"OWNER\"") &&
    actionSrc.includes(OWNER_ONLY_BANK_CONNECT_MESSAGE.slice(0, 24)),
);
check(
  "tokens are AES-256-GCM encrypted",
  readRepo("src/lib/plaid-token-crypto.ts").includes("aes-256-gcm") &&
    opsSrc.includes("encryptPlaidAccessToken") &&
    opsSrc.includes("decryptPlaidAccessToken"),
);
check(
  "sync uses Transactions Sync and locks the item",
  opsSrc.includes("transactionsSync") &&
    opsSrc.includes("FOR UPDATE") &&
    opsSrc.includes("syncCursor"),
);
check(
  "webhook path is session-exempt and verified",
  PLAID_WEBHOOK_PATH === "/api/plaid/webhook" &&
    isPlaidWebhookPath("/api/plaid/webhook") &&
    !isPlaidWebhookPath("/api/plaid/webhook/extra") &&
    proxySrc.includes("api/plaid/webhook") &&
    proxySrc.includes("isPlaidWebhookPath") &&
    readRepo("src/app/api/plaid/webhook/route.ts").includes("verifyPlaidWebhookRequest"),
);
check(
  "connect never writes Payment, Invoice, Expense, or InvoiceCredit",
  !opsSrc.includes("payment.create") &&
    !opsSrc.includes("invoice.update") &&
    !opsSrc.includes("expense.create") &&
    !opsSrc.includes("invoiceCredit") &&
    !actionSrc.includes("payment.create"),
);
check(
  "finance-connections cash provider stays disconnected",
  financeSrc.includes("DisconnectedFinanceProvider") &&
    BANKING_NOT_CONNECTED_MESSAGE.includes("will not invent a cash balance"),
);
check(
  "this verifier uses the shared disposable harness and fake adapter",
  selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes('TBBT_PLAID_ADAPTER = "fake"') &&
    selfSrc.includes("two tenants") &&
    selfSrc.includes("concurrent sync") &&
    selfSrc.includes("webhook replay"),
);
check(
  "copy never asks for a bank login in chat or git",
  !featureSource.includes("username") &&
    !featureSource.includes("password") &&
    readRepo(".env.example").includes("Never a bank username"),
);

console.log("\nUNIT — token encryption and webhook verification");
const sampleToken = "access-sandbox-unit-token";
const cipher = encryptPlaidAccessToken(sampleToken);
check("ciphertext is not the plaintext token", cipher !== sampleToken && cipher.startsWith("v1."));
check("decrypt round-trips the access token", decryptPlaidAccessToken(cipher) === sampleToken);
try {
  await verifyPlaidWebhookRequest("{}", new Headers());
  check("fake webhook without secret is rejected", false);
} catch (error) {
  check(
    "fake webhook without secret is rejected",
    error instanceof PlaidWebhookVerificationError,
  );
}
await verifyPlaidWebhookRequest("{}", new Headers({ "x-tbbt-plaid-webhook": "sandbox-test" }));
check("fake webhook secret is accepted", true);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "bank-connect disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_bank_connect",
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

async function expectForbidden(label, run) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, error instanceof ForbiddenError || error instanceof BankConnectError);
  }
}

try {
  resetFakePlaidProvider();
  console.log("\nDB — two tenants, sync, reconnect, disconnect, concurrency, webhook replay");
  const tenantA = await seedBusiness("Plaid A");
  const tenantB = await seedBusiness("Plaid B");
  const ownerA = makeAccess(tenantA.business, "OWNER", tenantA.membership.id);
  const adminA = makeAccess(tenantA.business, "ADMIN", tenantA.adminMembership.id);
  const ownerB = makeAccess(tenantB.business, "OWNER", tenantB.membership.id);

  const invoice = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      status: "SENT",
      total: new Prisma.Decimal("500.00"),
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
  const paymentsBefore = await prisma.payment.count();
  const invoicesBefore = await prisma.invoice.findMany({ select: { id: true, status: true, total: true } });

  await expectForbidden("ADMIN cannot create a Plaid link token", () =>
    createOwnedBankLinkToken(prisma, adminA),
  );
  await expectForbidden("ADMIN cannot load Plaid status", () =>
    loadOwnedBankPlaidStatus(prisma, adminA),
  );
  check(
    "ADMIN cannot pass REVIEW_BANK_RECONCILIATION",
    !roleHasCapability("ADMIN", CAPABILITIES.REVIEW_BANK_RECONCILIATION),
  );
  try {
    requireBusinessCapability(adminA, CAPABILITIES.REVIEW_BANK_RECONCILIATION);
    check("ADMIN capability gate throws", false);
  } catch (error) {
    check("ADMIN capability gate throws", error instanceof ForbiddenError);
  }

  const linkA = await createOwnedBankLinkToken(prisma, ownerA);
  check("OWNER can create a Plaid link token", Boolean(linkA.linkToken) && !linkA.updateMode);

  const connectedA = await exchangeOwnedBankPublicToken(prisma, ownerA, {
    publicToken: `public-sandbox-a-${randomUUID()}`,
  });
  check("OWNER connect status is ACTIVE", connectedA.status === "ACTIVE" && Boolean(connectedA.importId));
  check(
    "institution is recorded without claiming a cash balance",
    connectedA.institutionName === "First Platypus Bank" &&
      connectedA.reviewOnlyMessage.includes("never moves money"),
  );

  const itemA = await prisma.bankPlaidItem.findFirst({
    where: { businessId: tenantA.business.id },
  });
  check("access token is stored encrypted", Boolean(itemA?.accessTokenCipher) && !itemA.accessTokenCipher.includes("access-sandbox"));
  const accessTokenA = decryptPlaidAccessToken(itemA.accessTokenCipher);
  check("encrypted token decrypts to a sandbox access token", accessTokenA.startsWith("access-sandbox-"));

  queueFakePlaidSync(accessTokenA, {
    added: [
      {
        transactionId: "txn-zelle",
        accountId: "fake-checking",
        date: "2026-03-15",
        name: "ZELLE FROM JANE DOE",
        amount: -500,
        pending: false,
      },
      {
        transactionId: "txn-depot",
        accountId: "fake-checking",
        date: "2026-03-16",
        name: "HOME DEPOT #1234",
        amount: 85.4,
        pending: false,
      },
      {
        transactionId: "txn-pending",
        accountId: "fake-checking",
        date: "2026-03-17",
        name: "PENDING HOLD",
        amount: 20,
        pending: true,
      },
    ],
  });
  await syncOwnedBankPlaidItem(prisma, ownerA);
  const workspaceA = await loadOwnedBankReconciliation(prisma, ownerA, connectedA.importId);
  const zelleRow = workspaceA.rows.find((row) => row.externalTransactionId === "txn-zelle");
  const depotRow = workspaceA.rows.find((row) => row.externalTransactionId === "txn-depot");
  const pendingRow = workspaceA.rows.find((row) => row.externalTransactionId === "txn-pending");
  check("Plaid deposit is +50000 cents", zelleRow?.amountCents === 50000 && zelleRow.direction === "DEPOSIT");
  check("Plaid withdrawal is -8540 cents", depotRow?.amountCents === -8540 && depotRow.direction === "WITHDRAWAL");
  check("pending transactions are not imported", pendingRow == null);
  check(
    "synced rows suggest recorded Payment and Expense matches",
    zelleRow?.matches.some((match) => match.candidateId === payment500.id && match.status === "SUGGESTED") &&
      depotRow?.matches.some((match) => match.candidateId === expenseHome.id && match.status === "SUGGESTED"),
  );
  check("PLAID_SYNC workspace sourceKind is set", workspaceA.sourceKind === "PLAID_SYNC");

  const connectedB = await exchangeOwnedBankPublicToken(prisma, ownerB, {
    publicToken: `public-sandbox-b-${randomUUID()}`,
  });
  const itemB = await prisma.bankPlaidItem.findFirst({
    where: { businessId: tenantB.business.id },
  });
  const accessTokenB = decryptPlaidAccessToken(itemB.accessTokenCipher);
  queueFakePlaidSync(accessTokenB, {
    added: [
      {
        transactionId: "txn-zelle",
        accountId: "fake-checking",
        date: "2026-03-15",
        name: "ZELLE FROM JANE DOE",
        amount: -500,
        pending: false,
      },
    ],
  });
  await syncOwnedBankPlaidItem(prisma, ownerB);
  const workspaceB = await loadOwnedBankReconciliation(prisma, ownerB, connectedB.importId);
  check(
    "tenant B has its own feed and cannot see tenant A rows",
    workspaceB.businessId === tenantB.business.id &&
      workspaceB.rows.length === 1 &&
      workspaceB.rows[0].externalTransactionId === "txn-zelle" &&
      workspaceA.businessId === tenantA.business.id,
  );
  let crossTenant = false;
  try {
    await loadOwnedBankReconciliation(prisma, ownerB, connectedA.importId);
  } catch {
    crossTenant = true;
  }
  check("tenant B cannot open tenant A's Plaid workspace", crossTenant);

  let alreadyConnected = false;
  try {
    await exchangeOwnedBankPublicToken(prisma, ownerA, {
      publicToken: `public-sandbox-a2-${randomUUID()}`,
    });
  } catch (error) {
    alreadyConnected =
      error instanceof BankConnectError &&
      error.message === BANK_CONNECT_ALREADY_CONNECTED_MESSAGE;
  }
  check("second connect on the same tenant is rejected", alreadyConnected);

  fakePlaidResetLogin(accessTokenA);
  let needsReauth = false;
  try {
    await syncOwnedBankPlaidItem(prisma, ownerA);
  } catch (error) {
    needsReauth =
      error instanceof BankConnectError && error.message === BANK_CONNECT_NEEDS_REAUTH_MESSAGE;
  }
  const afterReset = await loadOwnedBankPlaidStatus(prisma, ownerA);
  check("ITEM_LOGIN_REQUIRED maps to NEEDS_REAUTH", needsReauth && afterReset.status === "NEEDS_REAUTH");
  const updateToken = await createOwnedBankLinkToken(prisma, ownerA, { updateMode: true });
  check("OWNER can create an update-mode link token", updateToken.updateMode === true);
  const reconnected = await exchangeOwnedBankPublicToken(prisma, ownerA, {
    publicToken: `public-sandbox-update-${randomUUID()}`,
    updateMode: true,
  });
  check("reconnect restores ACTIVE without minting a new Item", reconnected.status === "ACTIVE");
  const itemAfterReconnect = await prisma.bankPlaidItem.findFirst({
    where: { businessId: tenantA.business.id },
  });
  check("reconnect keeps the same Plaid item_id", itemAfterReconnect.itemId === itemA.itemId);

  queueFakePlaidSync(accessTokenA, {
    added: [
      {
        transactionId: "txn-extra",
        accountId: "fake-checking",
        date: "2026-03-20",
        name: "EXTRA DEPOSIT",
        amount: -25,
        pending: false,
      },
    ],
    removed: ["txn-depot"],
  });
  const clientA = session.createClient();
  const clientB = session.createClient();
  const concurrent = await Promise.allSettled([
    syncOwnedBankPlaidItem(clientA, ownerA),
    syncOwnedBankPlaidItem(clientB, ownerA),
  ]);
  const concurrentOk = concurrent.filter((result) => result.status === "fulfilled");
  check("concurrent sync settles without crashing", concurrentOk.length >= 1);
  const afterConcurrent = await loadOwnedBankReconciliation(prisma, ownerA, connectedA.importId);
  const extraRows = afterConcurrent.rows.filter((row) => row.externalTransactionId === "txn-extra");
  const depotAfter = afterConcurrent.rows.find((row) => row.externalTransactionId === "txn-depot");
  check("concurrent sync does not duplicate added transactions", extraRows.length === 1);
  check(
    "removed transactions are ignored, not turned into payments",
    depotAfter?.reviewStatus === "IGNORED",
  );

  const webhookBody = JSON.stringify({
    webhook_type: "TRANSACTIONS",
    webhook_code: "SYNC_UPDATES_AVAILABLE",
    item_id: itemA.itemId,
  });
  queueFakePlaidSync(accessTokenA, {
    added: [
      {
        transactionId: "txn-webhook",
        accountId: "fake-checking",
        date: "2026-03-21",
        name: "WEBHOOK DEPOSIT",
        amount: -10,
        pending: false,
      },
    ],
  });
  const firstHook = await handlePlaidWebhookPayload(prisma, { rawBody: webhookBody });
  const replayHook = await handlePlaidWebhookPayload(prisma, { rawBody: webhookBody });
  check("first webhook processes", firstHook.processed === true && firstHook.duplicate === false);
  check("replayed webhook is idempotent", replayHook.duplicate === true && replayHook.processed === false);
  const afterWebhook = await loadOwnedBankReconciliation(prisma, ownerA, connectedA.importId);
  check(
    "webhook sync added one review row once",
    afterWebhook.rows.filter((row) => row.externalTransactionId === "txn-webhook").length === 1,
  );

  const foreignBody = JSON.stringify({
    webhook_type: "TRANSACTIONS",
    webhook_code: "SYNC_UPDATES_AVAILABLE",
    item_id: itemB.itemId,
  });
  queueFakePlaidSync(accessTokenB, {
    added: [
      {
        transactionId: "txn-b-extra",
        accountId: "fake-checking",
        date: "2026-03-22",
        name: "TENANT B ONLY",
        amount: -15,
        pending: false,
      },
    ],
  });
  await handlePlaidWebhookPayload(prisma, { rawBody: foreignBody });
  const workspaceAAfterB = await loadOwnedBankReconciliation(prisma, ownerA, connectedA.importId);
  check(
    "tenant B webhook never writes tenant A rows",
    workspaceAAfterB.rows.every((row) => row.externalTransactionId !== "txn-b-extra"),
  );

  const disconnected = await disconnectOwnedBankPlaidItem(prisma, ownerA);
  check("disconnect marks the feed DISCONNECTED", disconnected.status === "DISCONNECTED");
  const itemDisconnected = await prisma.bankPlaidItem.findFirst({
    where: { businessId: tenantA.business.id },
  });
  check("disconnect wipes the access-token ciphertext", itemDisconnected.accessTokenCipher === "");
  const historical = await loadOwnedBankReconciliation(prisma, ownerA, connectedA.importId);
  check("historical review rows survive disconnect", historical.rows.length >= 3);
  let syncAfterDisconnect = false;
  try {
    await syncOwnedBankPlaidItem(prisma, ownerA);
  } catch (error) {
    syncAfterDisconnect = error instanceof BankConnectError;
  }
  check("sync after disconnect is rejected", syncAfterDisconnect);

  const paymentsAfter = await prisma.payment.count();
  const invoicesAfter = await prisma.invoice.findMany({ select: { id: true, status: true, total: true } });
  const financeAfter = await prisma.businessFinanceConnection.findMany({
    where: { businessId: { in: [tenantA.business.id, tenantB.business.id] } },
  });
  check("no Payment rows were created by connect/sync", paymentsAfter === paymentsBefore);
  check(
    "invoice status and total are unchanged",
    invoicesAfter.length === invoicesBefore.length &&
      invoicesAfter[0].status === invoicesBefore[0].status &&
      invoicesAfter[0].total.toString() === invoicesBefore[0].total.toString(),
  );
  check(
    "BusinessFinanceConnection was not marked CONNECTED",
    financeAfter.every((row) => row.status !== "CONNECTED"),
  );
  check(
    "finance provider still will not invent a cash balance",
    getFinanceConnectionProvider().fetchExternalBalance().then
      ? (await getFinanceConnectionProvider().fetchExternalBalance()).error ===
          BANKING_NOT_CONNECTED_MESSAGE
      : false,
  );
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\n${failures} bank-connect check(s) failed.`);
  process.exit(1);
}

console.log("\nAll bank-connect checks passed.");
