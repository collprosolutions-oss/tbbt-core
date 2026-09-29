/**
 * OWNER purchase-order receipt recording.
 *
 * Proves authorization, tenant isolation, partial delivery, and
 * concurrent retry on a dedicated test database. Recording a receipt
 * must not create a payment, expense, invoice, or supplier order.
 *
 * Run with:
 *   npm run test:purchase-order-receipts
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const {
  addPurchaseListItem,
  createPurchaseOrder,
  createSupplier,
  ensurePurchaseList,
  MATERIALS_SUPPLIERS_SCHEMA_SOURCE,
  purchaseOrderReceiptQuantities,
  purchaseOrderStatusFromReceipts,
  recordPurchaseOrderReceipt,
  updatePurchaseOrderStatus,
} = await import("@/lib/materials");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_purchase_order_receipt_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for purchase-order receipt test database.");
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

try {
  console.log("\nSTATIC — Receipt path stays separate from pickup, payments, and DDL");
  const receiptSrc = readRepo("src/lib/materials/receipt.ts");
  const schema = readRepo("prisma/schema.prisma");
  const migration = readRepo(
    "prisma/migrations/20260929140000_purchase_order_received_quantities/migration.sql",
  );
  const pickupSrc = readRepo("src/lib/materials/pickup.ts");
  const actionsSrc = readRepo("src/app/actions/materials.ts");
  check(
    "Receipt writes quantityReceived on PO items, not quantityPickedUp",
    receiptSrc.includes("quantityReceived") &&
      receiptSrc.includes("RECORD_PO_RECEIPT") &&
      !receiptSrc.includes("quantityPickedUp") &&
      schema.includes("quantityReceived") &&
      !schema.includes("quantityPickedUp") &&
      pickupSrc.includes("pickupRequired"),
  );
  check(
    "Receipt migration is additive and does not share pickup columns",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes('ADD COLUMN IF NOT EXISTS "quantityReceived"') &&
      !migration.includes("quantityPickedUp") &&
      !migration.includes("pickupException") &&
      !migration.includes("CREATE TABLE"),
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
      !actionsSrc.includes('readString(formData, "businessId")'),
  );
  const remaining = purchaseOrderReceiptQuantities({
    quantityOrdered: "10",
    quantityReceived: "4",
  });
  check(
    "Ordered-versus-received helper reports remaining quantity",
    remaining.quantityOrdered === 10 &&
      remaining.quantityReceived === 4 &&
      remaining.quantityRemaining === 6 &&
      remaining.fullyReceived === false &&
      purchaseOrderStatusFromReceipts([remaining]) === "PARTIALLY_RECEIVED" &&
      purchaseOrderStatusFromReceipts([
        purchaseOrderReceiptQuantities({ quantityOrdered: 2, quantityReceived: 2 }),
      ]) === "RECEIVED",
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
    (error) => error instanceof Error,
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
  const firstLumber = firstReceipt.items.find((row) => row.id === lumberLine.id);
  const firstScrews = firstReceipt.items.find((row) => row.id === screwLine.id);
  const firstDiff = purchaseOrderReceiptQuantities({
    quantityOrdered: firstLumber.quantity.toString(),
    quantityReceived: firstLumber.quantityReceived.toString(),
  });
  check(
    "Partial delivery records 4 of 10 and leaves the other line unordered-received",
    firstReceipt.status === "PARTIALLY_RECEIVED" &&
      firstDiff.quantityOrdered === 10 &&
      firstDiff.quantityReceived === 4 &&
      firstDiff.quantityRemaining === 6 &&
      Number(firstScrews.quantityReceived.toString()) === 0 &&
      firstReceipt.receivedAt == null,
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
  check(
    "Duplicate concurrent submit records the increment once",
    retryOne.id === retryTwo.id &&
      retryOne.status === "PARTIALLY_RECEIVED" &&
      Number(retryLumber.quantityReceived.toString()) === 7,
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
    secondDelivery.id === draftPo.id &&
      thirdDelivery.id === draftPo.id &&
      Number(concurrentLumber.quantityReceived.toString()) === 9 &&
      Number(concurrentScrews.quantityReceived.toString()) === 4 &&
      afterConcurrent.status === "PARTIALLY_RECEIVED",
  );
  await expectError(
    "Received quantity cannot exceed remaining ordered quantity",
    () =>
      recordPurchaseOrderReceipt(prisma, ownerA, {
        purchaseOrderId: draftPo.id,
        attemptKey: "receipt-over",
        items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "2" }],
      }),
    (error) => /remaining ordered quantity/i.test(String(error.message)),
  );

  const completed = await recordPurchaseOrderReceipt(prisma, ownerA, {
    purchaseOrderId: draftPo.id,
    attemptKey: "receipt-final",
    items: [{ purchaseOrderItemId: lumberLine.id, quantityReceived: "1" }],
  });
  const completedLumber = completed.items.find((row) => row.id === lumberLine.id);
  const completedList = await prisma.materialPurchaseListItem.findUnique({
    where: { id: lumber.id },
  });
  check(
    "Final remaining quantity marks the PO and list item received",
    completed.status === "RECEIVED" &&
      completed.receivedAt != null &&
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
    process.exit(1);
  }
  console.log("\nAll purchase-order receipt checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
