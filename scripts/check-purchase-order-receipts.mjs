/**
 * OWNER purchase-order receipt recording.
 *
 * Proves authorization, tenant isolation, partial delivery, sequential
 * receipts, mismatched replay, and a real same-line race on a dedicated
 * local test database. Recording a receipt must not create a payment,
 * expense, invoice, or supplier order.
 *
 * Run with:
 *   npm run test:purchase-order-receipts
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsed = new URL(baseUrl);
if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
  console.error("Refusing to run purchase-order receipt checks against a non-local DATABASE_URL host.");
  process.exit(1);
}

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const {
  addPurchaseListItem,
  createPurchaseOrder,
  createSupplier,
  ensurePurchaseList,
  lockPurchaseListItemsForUpdate,
  lockTenantOwnedPurchaseOrder,
  lockTenantOwnedPurchaseOrderItems,
  MATERIALS_SUPPLIERS_SCHEMA_SOURCE,
  parseReceiptDeliveryQuantity,
  purchaseOrderReceiptQuantities,
  purchaseOrderStatusFromReceipts,
  recordPurchaseOrderReceipt,
  updatePurchaseListItem,
  updatePurchaseOrderStatus,
} = await import("@/lib/materials");

const testDbName = "tbbt_purchase_order_receipt_test";
const testParsed = new URL(baseUrl);
testParsed.pathname = `/${testDbName}`;
const testUrl = testParsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const terminateExisting = spawnSync(
  "psql",
  [
    adminUrl.toString(),
    "-c",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
  ],
  { encoding: "utf8" },
);
if (terminateExisting.status !== 0) {
  console.warn(terminateExisting.stderr || terminateExisting.stdout);
}
const dropExisting = spawnSync(
  "psql",
  [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}"`],
  { encoding: "utf8" },
);
if (dropExisting.status !== 0) {
  console.warn(dropExisting.stderr || dropExisting.stdout);
}
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.error(createDb.stderr || createDb.stdout);
  process.exit(createDb.status ?? 1);
}

const migrate = spawnSync(
  "npx",
  ["prisma", "migrate", "deploy"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (migrate.status !== 0) {
  console.error("Failed to migrate the purchase-order receipt test database.");
  try {
    dropTestDatabase();
  } catch (error) {
    console.error(error);
  }
  process.exit(migrate.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const prismaRace = new PrismaClient({ datasourceUrl: testUrl });
const prismaHold = new PrismaClient({ datasourceUrl: testUrl });

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
    console.error(`FAIL - ${label} (no error thrown)`);
    failures += 1;
  } catch (error) {
    if (predicate(error)) {
      console.log(`  ok  - ${label}`);
    } else {
      console.error(`FAIL - ${label}`, error);
      failures += 1;
    }
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, business: { id: businessId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

async function waitUntil(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

async function waitForGrantedPurchaseOrderLock(client) {
  return waitUntil(
    async () => {
      const rows = await client.$queryRaw`
        SELECT l.pid
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE c.relname = 'MaterialPurchaseOrder'
          AND l.granted
          AND a.datname = current_database()
          AND a.pid <> pg_backend_pid()
      `;
      return rows[0]?.pid ?? null;
    },
    10000,
    "Timed out waiting for contender A to hold the purchase-order lock",
  );
}

async function waitForBlockedByPid(client, blockerPid) {
  return waitUntil(
    async () => {
      const rows = await client.$queryRaw`
        SELECT pid
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()
          AND ${blockerPid} = ANY (pg_blocking_pids(pid))
      `;
      return rows[0]?.pid ?? null;
    },
    10000,
    `Timed out waiting for contender B to block on pid ${blockerPid}`,
  );
}

async function waitForLockWaiters(client, minCount, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = await client.$queryRaw`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `;
    if (rows.length >= minCount) return rows.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${minCount} lock waiter(s) in pg_stat_activity`);
}

async function withHeldLocks(lock, work, minWaiters) {
  let markHeld;
  const held = new Promise((resolve) => {
    markHeld = resolve;
  });
  let release = () => {};
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const hold = prismaHold.$transaction(
    async (tx) => {
      await lock(tx);
      markHeld();
      await released;
    },
    { maxWait: 15000, timeout: 20000 },
  );
  try {
    await Promise.race([
      held,
      hold.then(() => {
        throw new Error("hold ended before lock");
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for hold lock")), 15000);
      }),
    ]);
    const pending = work();
    try {
      await waitForLockWaiters(prismaHold, minWaiters);
    } finally {
      release();
    }
    await hold;
    return pending;
  } catch (error) {
    release();
    await hold.catch(() => {});
    throw error;
  }
}

function dropTestDatabase() {
  const terminate = spawnSync(
    "psql",
    [
      adminUrl.toString(),
      "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    ],
    { encoding: "utf8" },
  );
  if (terminate.status !== 0) {
    throw new Error(terminate.stderr || terminate.stdout || "Failed to terminate test-db connections.");
  }
  const drop = spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}"`],
    { encoding: "utf8" },
  );
  if (drop.status !== 0) {
    throw new Error(drop.stderr || drop.stdout || "Failed to drop the purchase-order receipt test database.");
  }
}

try {
  console.log("\nSTATIC — Receipt path stays separate from pickup, payments, and DDL");
  const receiptSrc = readRepo("src/lib/materials/receipt.ts");
  const cardSrc = readRepo("src/components/materials/purchase-list-card.tsx");
  const actionsSrc = readRepo("src/app/actions/materials.ts");
  const typesSrc = readRepo("src/lib/materials/types.ts");
  const purchaseSrc = readRepo("src/lib/materials/purchase.ts");
  const pickupSrc = readRepo("src/lib/materials/pickup.ts");
  const migration = readRepo(
    "prisma/migrations/20260929140000_purchase_order_received_quantities/migration.sql",
  );
  check(
    "Receipt writes quantityReceived on PO items, not quantityPickedUp",
    receiptSrc.includes("quantityReceived") &&
      receiptSrc.includes("RECORD_PO_RECEIPT") &&
      !receiptSrc.includes("quantityPickedUp") &&
      pickupSrc.includes("pickupRequired"),
  );
  check(
    "Receipt migration is additive and does not share pickup columns",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes('ADD COLUMN IF NOT EXISTS "quantityReceived"') &&
      migration.includes('CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderReceipt"') &&
      migration.includes('CREATE TABLE IF NOT EXISTS "MaterialPurchaseOrderReceiptItem"') &&
      !migration.includes("quantityPickedUp") &&
      !migration.includes("pickupException"),
  );
  check(
    "Receipt request path creates no payment, expense, invoice, or supplier order",
    !receiptSrc.includes("createExpense") &&
      !receiptSrc.includes("createInvoice") &&
      !receiptSrc.includes("createPayment") &&
      !receiptSrc.includes("recordPurchaseOperation") &&
      !receiptSrc.includes("createCartHandoff") &&
      !receiptSrc.includes("linkPurchaseItemToExpense") &&
      !receiptSrc.includes("$executeRawUnsafe") &&
      !receiptSrc.includes("CREATE TABLE") &&
      MATERIALS_SUPPLIERS_SCHEMA_SOURCE === "prisma-migrate" &&
      !actionsSrc.includes('readString(formData, "businessId")') &&
      actionsSrc.includes("alreadyRecorded") &&
      cardSrc.includes("[receiptState]") &&
      purchaseSrc.includes("lockTenantOwnedPurchaseOrderItems") &&
      purchaseSrc.includes("lockPurchaseListItemsForUpdate") &&
      purchaseSrc.includes('NOT: { status: "RECEIVED" }') &&
      receiptSrc.includes('currentStatus !== "RECEIVED"') &&
      typesSrc.includes('ORDERED_EXTERNALLY: ["ORDERED_EXTERNALLY", "CANCELLED"]') &&
      cardSrc.includes("Already recorded."),
  );
  const remaining = purchaseOrderReceiptQuantities({
    quantityOrdered: "10",
    quantityReceived: "4",
  });
  const tenth = purchaseOrderReceiptQuantities({
    quantityOrdered: "1.1",
    quantityReceived: "1",
  });
  const mixed = purchaseOrderReceiptQuantities({
    quantityOrdered: "10.3",
    quantityReceived: "4.1",
  });
  check(
    "Ordered-versus-received helper reports remaining quantity",
    remaining.quantityOrdered.toString() === "10" &&
      remaining.quantityReceived.toString() === "4" &&
      remaining.quantityRemaining.toString() === "6" &&
      remaining.fullyReceived === false &&
      purchaseOrderStatusFromReceipts([remaining]) === "PARTIALLY_RECEIVED" &&
      purchaseOrderStatusFromReceipts([
        purchaseOrderReceiptQuantities({ quantityOrdered: 2, quantityReceived: 2 }),
      ]) === "RECEIVED" &&
      tenth.quantityRemaining.toString() === "0.1" &&
      mixed.quantityRemaining.toString() === "6.2" &&
      parseReceiptDeliveryQuantity("").status === "skip" &&
      parseReceiptDeliveryQuantity("0").status === "skip" &&
      parseReceiptDeliveryQuantity("2.5").status === "ok" &&
      parseReceiptDeliveryQuantity("0.00001").status === "invalid" &&
      parseReceiptDeliveryQuantity("0x5").status === "invalid" &&
      parseReceiptDeliveryQuantity("-1").status === "invalid",
  );

  const ownerUser = await prisma.user.create({
    data: { name: "PO Owner", email: `po-owner-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "PO Admin", email: `po-admin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "PO Member", email: `po-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "PO Beta", email: `po-beta-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Receipts", slug: `alpha-po-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Receipts", slug: `beta-po-${randomUUID().slice(0, 8)}` },
  });
  const ownerMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: ownerUser.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: adminUser.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { businessId: businessA.id, userId: memberUser.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { businessId: businessB.id, userId: betaUser.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const depot = await createSupplier(prisma, ownerA, { name: "Depot Yard" });
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Pat", email: `pat-${randomUUID()}@example.com` },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const list = await ensurePurchaseList(prisma, ownerA, { estimateId: estimate.id });
  const lumber = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: list.id,
    name: "2x4 lumber",
    quantityNeeded: "10",
    unit: "ea",
    plannedUnitCost: "3.50",
    supplierId: depot.id,
  });
  const screws = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: list.id,
    name: "Deck screws",
    quantityNeeded: "4",
    unit: "box",
    plannedUnitCost: "8.00",
    supplierId: depot.id,
  });
  const shared = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: list.id,
    name: "Shared hinge",
    quantityNeeded: "6",
    unit: "ea",
    plannedUnitCost: "1.25",
    supplierId: depot.id,
  });
  const draftPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: list.id,
    supplierId: depot.id,
    itemIds: [lumber.id, screws.id],
  });
  const lumberLine = draftPo.items.find((row) => row.purchaseListItemId === lumber.id);
  const screwLine = draftPo.items.find((row) => row.purchaseListItemId === screws.id);

  console.log("\nTEST — Authorization and tenant isolation");
  await expectError(
    "Draft PO cannot accept a receipt until ordered externally",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerA, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-draft-blocked",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "2" }],
      }),
    (error) => /ordered externally/i.test(String(error.message)),
  );
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: draftPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  await expectError(
    "ADMIN cannot record a purchase-order receipt",
    () =>
      recordPurchaseOrderReceipt(prisma, adminA, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-admin-blocked",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "1" }],
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "MEMBER cannot record a purchase-order receipt",
    () =>
      recordPurchaseOrderReceipt(prisma, memberA, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-member-blocked",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "1" }],
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectError(
    "Business B cannot receive against Business A purchase order",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerB, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-cross-tenant",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "1" }],
      }),
    (error) => /not found in this business/i.test(String(error.message)),
  );
  await expectError(
    "Manual RECEIVED is rejected so empty receipts cannot block receiving",
    () =>
      updatePurchaseOrderStatus(prisma, adminA, {
        purchaseOrderId: draftPo.id,
        status: "RECEIVED",
      }),
    (error) => /cannot move from ORDERED_EXTERNALLY to RECEIVED/i.test(String(error.message)),
  );
  const afterDenied = await prisma.materialPurchaseOrderItem.findUnique({
    where: { id: lumberLine.id },
  });
  check(
    "Denied callers did not increment received quantity",
    Number(afterDenied.quantityReceived.toString()) === 0,
  );

  console.log("\nTEST — Partial receipt and ordered-versus-received");
  const expensesBefore = await prisma.expense.count({ where: { businessId: businessA.id } });
  const invoicesBefore = await prisma.invoice.count({ where: { businessId: businessA.id } });
  const paymentsBefore = await prisma.payment.count({ where: { businessId: businessA.id } });
  const firstReceipt = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: draftPo.id,
    attemptKey: "receipt-partial-1",
    items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "4" }],
  });
  const firstLumber = firstReceipt.order.items.find((row) => row.id === lumberLine.id);
  const firstScrews = firstReceipt.order.items.find((row) => row.id === screwLine.id);
  const firstDiff = purchaseOrderReceiptQuantities({
    quantityOrdered: firstLumber.quantity.toString(),
    quantityReceived: firstLumber.quantityReceived.toString(),
  });
  const firstAudit = await prisma.materialPurchaseOrderReceipt.findMany({
    where: { businessId: businessA.id, purchaseOrderId: draftPo.id },
    include: { items: true },
  });
  check(
    "Partial delivery records 4 of 10 and leaves the other line unordered-received",
    firstReceipt.replayed === false &&
      firstReceipt.order.status === "PARTIALLY_RECEIVED" &&
      firstDiff.quantityOrdered.toString() === "10" &&
      firstDiff.quantityReceived.toString() === "4" &&
      firstDiff.quantityRemaining.toString() === "6" &&
      Number(firstScrews.quantityReceived.toString()) === 0 &&
      firstReceipt.order.receivedAt == null &&
      firstAudit.length === 1 &&
      firstAudit[0].recordedByMembershipId === ownerMem.id &&
      Number(firstAudit[0].items[0].quantity.toString()) === 4,
  );
  const lumberListAfterPartial = await prisma.materialPurchaseListItem.findUnique({
    where: { id: lumber.id },
  });
  check(
    "Partial receipt does not mark the list item purchased or attach an expense",
    lumberListAfterPartial.status === "ORDERED" &&
      lumberListAfterPartial.quantityPurchased == null &&
      lumberListAfterPartial.actualCost == null &&
      lumberListAfterPartial.expenseId == null,
  );

  console.log("\nTEST — Concurrent retry of the same receipt attempt");
  const retryKey = "receipt-retry-same";
  const [retryOne, retryTwo] = await Promise.all([
    recordPurchaseOrderReceipt(prisma, ownerA, {
      purchaseOrderId: draftPo.id,
      attemptKey: retryKey,
      items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "3" }],
    }),
    recordPurchaseOrderReceipt(prisma, ownerA, {
      purchaseOrderId: draftPo.id,
      attemptKey: retryKey,
      items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "3" }],
    }),
  ]);
  const retryLumber = await prisma.materialPurchaseOrderItem.findUnique({
    where: { id: lumberLine.id },
  });
  const retryAudits = await prisma.materialPurchaseOrderReceipt.count({
    where: { businessId: businessA.id, attemptKey: retryKey },
  });
  check(
    "Duplicate concurrent submit records the increment once",
    retryOne.order.id === retryTwo.order.id &&
      retryOne.replayed !== retryTwo.replayed &&
      retryOne.order.status === "PARTIALLY_RECEIVED" &&
      Number(retryLumber.quantityReceived.toString()) === 7 &&
      retryAudits === 1,
  );

  console.log("\nTEST — Concurrent distinct deliveries serialize on the PO");
  const [secondDelivery, thirdDelivery] = await Promise.all([
    recordPurchaseOrderReceipt(prisma, ownerA, {
      purchaseOrderId: draftPo.id,
      attemptKey: "receipt-concurrent-a",
      items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "2" }],
    }),
    recordPurchaseOrderReceipt(prisma, ownerA, {
      purchaseOrderId: draftPo.id,
      attemptKey: "receipt-concurrent-b",
      items: [{ purchaseOrderItemId: screwLine.id, quantityReceived: "4" }],
    }),
  ]);
  const afterConcurrent = await prisma.materialPurchaseOrder.findFirst({
    where: { id: draftPo.id, businessId: businessA.id },
    include: { items: true },
  });
  const concurrentLumber = afterConcurrent.items.find((row) => row.id === lumberLine.id);
  const concurrentScrews = afterConcurrent.items.find((row) => row.id === screwLine.id);
  check(
    "Two different deliveries add without double-counting",
    secondDelivery.order.id === draftPo.id &&
      thirdDelivery.order.id === draftPo.id &&
      Number(concurrentLumber.quantityReceived.toString()) === 9 &&
      Number(concurrentScrews.quantityReceived.toString()) === 4 &&
      afterConcurrent.status === "PARTIALLY_RECEIVED",
  );
  await expectError(
    "Received quantity cannot exceed remaining ordered quantity",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerA, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-over-qty",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "2" }],
      }),
    (error) => /remaining ordered quantity/i.test(String(error.message)),
  );

  const completed = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: draftPo.id,
    attemptKey: "receipt-final-1",
    items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "1" }],
  });
  const completedLumber = completed.order.items.find((row) => row.id === lumberLine.id);
  const completedList = await prisma.materialPurchaseListItem.findUnique({
    where: { id: lumber.id },
  });
  check(
    "Final remaining quantity marks the PO and list item received",
    completed.order.status === "RECEIVED" &&
      completed.order.receivedAt != null &&
      Number(completedLumber.quantityReceived.toString()) === 10 &&
      completedList.status === "RECEIVED" &&
      completedList.expenseId == null &&
      completedList.quantityPurchased == null,
  );
  await expectError(
    "Fully received PO rejects another receipt",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerA, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-already-done",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "1" }],
      }),
    (error) => /already fully received/i.test(String(error.message)),
  );

  console.log("\nTEST — Sequential receipts, mismatched replay, and invalid input");
  const seqEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const seqList = await ensurePurchaseList(prisma, ownerA, { estimateId: seqEstimate.id });
  const seqItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: seqList.id,
    name: "Sequential pipe",
    quantityNeeded: "10",
    unit: "ea",
    supplierId: depot.id,
  });
  const otherPoItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: seqList.id,
    name: "Other PO only",
    quantityNeeded: "5",
    unit: "ea",
    supplierId: depot.id,
  });
  const seqPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: seqList.id,
    supplierId: depot.id,
    itemIds: [seqItem.id],
  });
  const foreignPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: seqList.id,
    supplierId: depot.id,
    itemIds: [otherPoItem.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: seqPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: foreignPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  const seqLine = seqPo.items[0];
  const foreignLine = foreignPo.items[0];
  const firstSeq = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: seqPo.id,
    attemptKey: "receipt-seq-1",
    items: [{ purchaseOrderItemId: seqLine.id, quantityReceived: "2" }],
  });
  const secondSeq = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: seqPo.id,
    attemptKey: "receipt-seq-2",
    items: [{ purchaseOrderItemId: seqLine.id, quantityReceived: "2" }],
  });
  const thirdSeq = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: seqPo.id,
    attemptKey: "receipt-seq-3",
    items: [{ purchaseOrderItemId: seqLine.id, quantityReceived: "2" }],
  });
  const afterSequential = await prisma.materialPurchaseOrderItem.findUnique({
    where: { id: seqLine.id },
  });
  const seqReceipts = await prisma.materialPurchaseOrderReceipt.count({
    where: { businessId: businessA.id, purchaseOrderId: seqPo.id },
  });
  check(
    "Three sequential receipts each increment with a new attempt key",
    firstSeq.replayed === false &&
      secondSeq.replayed === false &&
      thirdSeq.replayed === false &&
      Number(afterSequential.quantityReceived.toString()) === 6 &&
      seqReceipts === 3,
  );
  await expectError(
    "Mismatched replay of an earlier attempt key is rejected",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerA, {
        purchaseOrderId: seqPo.id,
        attemptKey: "receipt-seq-1",
        items: [{ purchaseOrderItemId: seqLine.id, quantityReceived: "3" }],
      }),
    (error) => /already used for a different receipt/i.test(String(error.message)),
  );
  const matchedReplay = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: seqPo.id,
    attemptKey: "receipt-seq-1",
    items: [{ purchaseOrderItemId: seqLine.id, quantityReceived: "2" }],
  });
  const afterReplay = await prisma.materialPurchaseOrderItem.findUnique({
    where: { id: seqLine.id },
  });
  check(
    "Matching replay does not increment again",
    matchedReplay.replayed === true &&
      Number(afterReplay.quantityReceived.toString()) === 6,
  );
  await expectError(
    "Line id from another PO in the same business is rejected",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerA, {
        purchaseOrderId: seqPo.id,
        attemptKey: "receipt-foreign-line",
        items: [{ purchaseOrderItemId: foreignLine.id, quantityReceived: "1" }],
      }),
    (error) => /belong to this purchase order and business/i.test(String(error.message)),
  );
  for (const [label, value] of [
    ["negative", "-1"],
    ["NaN", "NaN"],
    ["too many decimals", "0.00001"],
    ["hex", "0x5"],
  ]) {
    await expectError(
      `Invalid ${label} quantity is rejected`,
      () =>
        recordPurchaseOrderReceipt(prisma, ownerA, {
          purchaseOrderId: seqPo.id,
          attemptKey: `receipt-bad-${label.replace(/\s+/g, "")}`,
          items: [{ purchaseOrderItemId: seqLine.id, quantityReceived: value }],
        }),
      (error) => /plain decimal|greater than zero|at least one received/i.test(String(error.message)),
    );
  }

  console.log("\nTEST — Manual RECEIVED is not downgraded by a later partial receipt");
  const receivedEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const receivedList = await ensurePurchaseList(prisma, ownerA, { estimateId: receivedEstimate.id });
  const alreadyReceived = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: receivedList.id,
    name: "Already received hinge",
    quantityNeeded: "4",
    unit: "ea",
    supplierId: depot.id,
  });
  await updatePurchaseListItem(prisma, ownerA, {
    itemId: alreadyReceived.id,
    status: "RECEIVED",
  });
  const laterPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: receivedList.id,
    supplierId: depot.id,
    itemIds: [alreadyReceived.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: laterPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: laterPo.id,
    attemptKey: "receipt-keep-received",
    items: [{ purchaseOrderItemId: laterPo.items[0].id, quantityReceived: "1" }],
  });
  const stillReceived = await prisma.materialPurchaseListItem.findUnique({
    where: { id: alreadyReceived.id },
  });
  check(
    "Partial receipt on a new PO does not downgrade a RECEIVED list item",
    stillReceived.status === "RECEIVED" && laterPo.items.length === 1,
  );

  console.log("\nTEST — Same-line race that exceeds remaining uses separate clients");
  const raceEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const raceList = await ensurePurchaseList(prisma, ownerA, { estimateId: raceEstimate.id });
  const raceItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: raceList.id,
    name: "Race lumber",
    quantityNeeded: "3",
    unit: "ea",
    supplierId: depot.id,
  });
  const racePo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: raceList.id,
    supplierId: depot.id,
    itemIds: [raceItem.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: racePo.id,
    status: "ORDERED_EXTERNALLY",
  });
  const raceLine = racePo.items[0];
  const raceA = recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: racePo.id,
    attemptKey: "receipt-race-a",
    items: [{ purchaseOrderItemId: raceLine.id, quantityReceived: "2" }],
  });
  const raceAPid = await waitForGrantedPurchaseOrderLock(prismaHold);
  const raceB = recordPurchaseOrderReceipt(prismaRace, ownerA, {
    purchaseOrderId: racePo.id,
    attemptKey: "receipt-race-b",
    items: [{ purchaseOrderItemId: raceLine.id, quantityReceived: "2" }],
  });
  const raceBPid = await waitForBlockedByPid(prismaHold, raceAPid);
  const raceResults = await Promise.allSettled([raceA, raceB]);
  const raceOk = raceResults.filter((row) => row.status === "fulfilled");
  const raceFailed = raceResults.filter((row) => row.status === "rejected");
  const raceLineAfter = await prisma.materialPurchaseOrderItem.findUnique({
    where: { id: raceLine.id },
  });
  check(
    "Exactly one same-line over-remaining race succeeds",
    raceOk.length === 1 &&
      raceFailed.length === 1 &&
      /remaining ordered quantity/i.test(String(raceFailed[0].reason?.message ?? "")) &&
      Number(raceLineAfter.quantityReceived.toString()) === 2 &&
      Number(raceAPid) > 0 &&
      Number(raceBPid) > 0 &&
      Number(raceBPid) !== Number(raceAPid),
  );

  console.log("\nTEST — Shared list item and cancel preserve RECEIVED lines");
  const sharedPoOne = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: list.id,
    supplierId: depot.id,
    itemIds: [shared.id],
  });
  const sharedPoTwo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: list.id,
    supplierId: depot.id,
    itemIds: [shared.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: sharedPoOne.id,
    status: "ORDERED_EXTERNALLY",
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: sharedPoTwo.id,
    status: "ORDERED_EXTERNALLY",
  });
  await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: sharedPoOne.id,
    attemptKey: "receipt-shared-one",
    items: [{ purchaseOrderItemId: sharedPoOne.items[0].id, quantityReceived: "6" }],
  });
  const sharedAfterOne = await prisma.materialPurchaseListItem.findUnique({
    where: { id: shared.id },
  });
  check(
    "List item stays ORDERED while another non-cancelled PO line is outstanding",
    sharedAfterOne.status === "ORDERED",
  );
  await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: sharedPoTwo.id,
    attemptKey: "receipt-shared-two",
    items: [{ purchaseOrderItemId: sharedPoTwo.items[0].id, quantityReceived: "6" }],
  });
  const sharedAfterTwo = await prisma.materialPurchaseListItem.findUnique({
    where: { id: shared.id },
  });
  check("List item becomes RECEIVED only after every open PO line is filled", sharedAfterTwo.status === "RECEIVED");

  const siblingEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const siblingList = await ensurePurchaseList(prisma, ownerA, { estimateId: siblingEstimate.id });
  const siblingItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: siblingList.id,
    name: "Sibling stay-open",
    quantityNeeded: "6",
    unit: "ea",
    supplierId: depot.id,
  });
  const siblingKeep = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: siblingList.id,
    supplierId: depot.id,
    itemIds: [siblingItem.id],
  });
  const siblingDrop = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: siblingList.id,
    supplierId: depot.id,
    itemIds: [siblingItem.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: siblingKeep.id,
    status: "ORDERED_EXTERNALLY",
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: siblingDrop.id,
    status: "ORDERED_EXTERNALLY",
  });
  await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: siblingDrop.id,
    attemptKey: "receipt-sibling-partial",
    items: [{ purchaseOrderItemId: siblingDrop.items[0].id, quantityReceived: "2" }],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: siblingDrop.id,
    status: "CANCELLED",
  });
  const siblingAfterCancel = await prisma.materialPurchaseListItem.findUnique({
    where: { id: siblingItem.id },
  });
  check(
    "Cancel leaves a list item in place when another non-cancelled PO line remains",
    siblingAfterCancel.status === "ORDERED",
  );
  await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: siblingKeep.id,
    attemptKey: "receipt-sibling-keep",
    items: [{ purchaseOrderItemId: siblingKeep.items[0].id, quantityReceived: "6" }],
  });
  const siblingAfterKeep = await prisma.materialPurchaseListItem.findUnique({
    where: { id: siblingItem.id },
  });
  check(
    "Receipt can mark a previously cancelled sibling's list item RECEIVED",
    siblingAfterKeep.status === "RECEIVED",
  );

  console.log("\nTEST — Concurrent cancel versus receipt uses a real lock barrier");
  const barrierEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const barrierList = await ensurePurchaseList(prisma, ownerA, { estimateId: barrierEstimate.id });
  const barrierOne = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: barrierList.id,
    name: "Barrier hinge A",
    quantityNeeded: "2",
    unit: "ea",
    supplierId: depot.id,
  });
  const barrierTwo = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: barrierList.id,
    name: "Barrier hinge B",
    quantityNeeded: "2",
    unit: "ea",
    supplierId: depot.id,
  });
  const cancelSharedPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: barrierList.id,
    supplierId: depot.id,
    itemIds: [barrierOne.id, barrierTwo.id],
  });
  const receiveSharedPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: barrierList.id,
    supplierId: depot.id,
    itemIds: [barrierOne.id, barrierTwo.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: cancelSharedPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: receiveSharedPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  const barrierStarted = Date.now();
  const [cancelOutcome, receiptOutcome] = await withHeldLocks(
    async (tx) => {
      await lockPurchaseListItemsForUpdate(tx, businessA.id, [barrierOne.id, barrierTwo.id]);
    },
    () =>
      Promise.allSettled([
        updatePurchaseOrderStatus(prisma, ownerA, {
          purchaseOrderId: cancelSharedPo.id,
          status: "CANCELLED",
        }),
        recordPurchaseOrderReceipt(prismaRace, ownerA, {
          purchaseOrderId: receiveSharedPo.id,
          attemptKey: "receipt-cancel-race",
          items: receiveSharedPo.items.map((row) => ({
            purchaseOrderItemId: row.id,
            quantityReceived: row.quantity.toString(),
          })),
        }),
      ]),
    2,
  );
  const barrierMs = Date.now() - barrierStarted;
  const afterCancelPo = await prisma.materialPurchaseOrder.findUnique({
    where: { id: cancelSharedPo.id },
  });
  const afterReceivePo = await prisma.materialPurchaseOrder.findUnique({
    where: { id: receiveSharedPo.id },
  });
  const afterBarrierOne = await prisma.materialPurchaseListItem.findUnique({
    where: { id: barrierOne.id },
  });
  const afterBarrierTwo = await prisma.materialPurchaseListItem.findUnique({
    where: { id: barrierTwo.id },
  });
  check(
    "Concurrent cancel versus receipt neither deadlocks nor overwrites RECEIVED",
    cancelOutcome.status === "fulfilled" &&
      receiptOutcome.status === "fulfilled" &&
      receiptOutcome.value.replayed === false &&
      afterCancelPo.status === "CANCELLED" &&
      afterReceivePo.status === "RECEIVED" &&
      afterBarrierOne.status === "RECEIVED" &&
      afterBarrierTwo.status === "RECEIVED" &&
      barrierMs < 15000,
  );
  if (cancelOutcome.status === "rejected") {
    console.error("  cancel error:", cancelOutcome.reason);
  }
  if (receiptOutcome.status === "rejected") {
    console.error("  receipt error:", receiptOutcome.reason);
  }

  const cancelEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const cancelList = await ensurePurchaseList(prisma, ownerA, { estimateId: cancelEstimate.id });
  const keepItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: cancelList.id,
    name: "Keep received",
    quantityNeeded: "2",
    unit: "ea",
    supplierId: depot.id,
  });
  const dropItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: cancelList.id,
    name: "Cancel leftover",
    quantityNeeded: "2",
    unit: "ea",
    supplierId: depot.id,
  });
  const cancelPo = await createPurchaseOrder(prisma, ownerA, {
    purchaseListId: cancelList.id,
    supplierId: depot.id,
    itemIds: [keepItem.id, dropItem.id],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: cancelPo.id,
    status: "ORDERED_EXTERNALLY",
  });
  const keepLine = cancelPo.items.find((row) => row.purchaseListItemId === keepItem.id);
  await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: cancelPo.id,
    attemptKey: "receipt-cancel-keep",
    items: [{ purchaseOrderItemId: keepLine.id, quantityReceived: "2" }],
  });
  await updatePurchaseOrderStatus(prisma, ownerA, {
    purchaseOrderId: cancelPo.id,
    status: "CANCELLED",
  });
  const keepAfterCancel = await prisma.materialPurchaseListItem.findUnique({
    where: { id: keepItem.id },
  });
  const dropAfterCancel = await prisma.materialPurchaseListItem.findUnique({
    where: { id: dropItem.id },
  });
  check(
    "Cancelling a partly received PO does not mark already-RECEIVED list items cancelled",
    keepAfterCancel.status === "RECEIVED" && dropAfterCancel.status === "CANCELLED",
  );

  const expensesAfter = await prisma.expense.count({ where: { businessId: businessA.id } });
  const invoicesAfter = await prisma.invoice.count({ where: { businessId: businessA.id } });
  const paymentsAfter = await prisma.payment.count({ where: { businessId: businessA.id } });
  const historyCount = await prisma.materialPriceHistory.count({
    where: { businessId: businessA.id },
  });
  check(
    "Receipts created no payment, expense, invoice, or price-history row",
    expensesAfter === expensesBefore &&
      invoicesAfter === invoicesBefore &&
      paymentsAfter === paymentsBefore &&
      historyCount === 0,
  );

  const leaked = await prisma.materialPurchaseOrder.findMany({
    where: { businessId: businessB.id },
  });
  check("Business B still has no purchase orders from Business A receipts", leaked.length === 0);

  if (failures > 0) {
    console.error(`\n${failures} purchase-order receipt check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll purchase-order receipt checks passed.");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await prismaRace.$disconnect();
  await prismaHold.$disconnect();
  try {
    dropTestDatabase();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
