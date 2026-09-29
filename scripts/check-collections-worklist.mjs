/**
 * OWNER collections worklist proofs.
 *
 * Recorded Invoice + Payment balances, recorded contact state,
 * authorization, tenant isolation, and no-send / no-mark-paid behavior
 * against a dedicated database. Page load does not send reminders.
 *
 * Run with:
 *   npm run test:collections-worklist
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for collections worklist checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { APP_NAV } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  ensureDefaultAutomationRules,
  processPendingAutomationRuns,
  scanScheduledBusinessEvents,
} = await import("@/lib/automation");
const {
  BANK_NOT_CONNECTED_COLLECTIONS_MESSAGE,
  COLLECTIONS_BALANCE_MESSAGE,
  COLLECTIONS_NEXT_STEP_RECORDED_MESSAGE,
  COLLECTIONS_NO_CONTACT_LABEL,
  COLLECTIONS_OWNER_NEXT_STEP_MESSAGE,
  COLLECTIONS_OWNER_RESOLVE_MESSAGE,
  COLLECTIONS_QUEUE_LIMIT,
  COLLECTIONS_READ_ONLY_MESSAGE,
  COLLECTIONS_RESOLVED_MESSAGE,
  COLLECTIONS_ROUTE,
  COLLECTIONS_UNKNOWN_INVOICE_MESSAGE,
  CollectionWorkItemError,
  collectionsWorklistReadAllowed,
  collectionsWorklistWriteAllowed,
  loadCollectionsWorklist,
  recordCollectionNextStep,
  resolveCollectionWorkItem,
} = await import("@/lib/collections");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const loadSrc = readSrc("src/lib/collections/load.ts");
const writeSrc = readSrc("src/lib/collections/record.ts");
const actionSrc = readSrc("src/app/actions/collections.ts");
const uiSrc = readSrc("src/components/invoices/collections-worklist.tsx");
const pageSrc = readSrc("src/app/(app)/invoices/collections/page.tsx");
const navSrc = readSrc("src/lib/nav.ts");
const invoicePageSrc = readSrc("src/app/(app)/invoices/page.tsx");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_collections_worklist_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

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
  console.error("Failed to push schema for collections worklist test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { Prisma, PrismaClient } = require("@prisma/client");
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

function daysAgo(days, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000);
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "Collections Co" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

async function seedSentInvoice(input) {
  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      status: "COMPLETED",
      projectToken: randomUUID(),
      createdAt: input.createdAt ?? new Date(),
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
      createdAt: input.createdAt ?? new Date(),
      paidAt: input.paidAt ?? null,
    },
  });
  return { job, invoice };
}

try {
  console.log("\nSTATIC — OWNER worklist, recorded balances, no send");
  check("Dedicated route stays /invoices/collections", COLLECTIONS_ROUTE === "/invoices/collections");
  check(
    "OWNER-only read and write gates",
    collectionsWorklistReadAllowed("OWNER") === true &&
      collectionsWorklistWriteAllowed("OWNER") === true &&
      collectionsWorklistReadAllowed("ADMIN") === false &&
      collectionsWorklistWriteAllowed("ADMIN") === false &&
      collectionsWorklistReadAllowed("MEMBER") === false &&
      collectionsWorklistWriteAllowed("MEMBER") === false,
  );
  check(
    "Honesty copy refuses send, bank inference, and mark-paid",
    /does not send reminders, mark invoices paid, or write payments/.test(COLLECTIONS_READ_ONLY_MESSAGE) &&
      /No bank deposit is inferred/.test(COLLECTIONS_BALANCE_MESSAGE) &&
      /does not send SMS or email/.test(COLLECTIONS_OWNER_NEXT_STEP_MESSAGE) &&
      /does not change payment status/.test(COLLECTIONS_OWNER_NEXT_STEP_MESSAGE) &&
      /without marking the invoice paid/.test(COLLECTIONS_OWNER_RESOLVE_MESSAGE) &&
      /Banking is Not Connected/.test(BANK_NOT_CONNECTED_COLLECTIONS_MESSAGE) &&
      /has not been sent/.test(COLLECTIONS_NEXT_STEP_RECORDED_MESSAGE) &&
      /was not marked paid/.test(COLLECTIONS_RESOLVED_MESSAGE),
  );
  check(
    "Load path is mutation-free on page load",
    !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(loadSrc) &&
      /mutationsOnLoad: false/.test(loadSrc) &&
      !/attemptPaymentReminderSms|sendDraftInvoiceIfNeeded|markInvoicePaid|recordOwnerInvoiceBalancePayment|reconcileStripeCheckoutPayment|recordSucceededPayment|emitAndProcessBusinessEvent|attemptCustomerSms/.test(
        loadSrc,
      ),
  );
  check(
    "Write path does not send, mark paid, or write payments",
    !/attemptPaymentReminderSms|sendDraftInvoiceIfNeeded|markInvoicePaid|recordOwnerInvoiceBalancePayment|reconcileStripeCheckoutPayment|recordSucceededPayment|emitAndProcessBusinessEvent|attemptCustomerSms/.test(
      writeSrc,
    ) &&
      !/attemptPaymentReminderSms|markInvoicePaid|recordOwnerInvoiceBalancePayment|reconcileStripeCheckoutPayment/.test(
        actionSrc,
      ) &&
      writeSrc.includes("invoiceCollectionWorkItem") &&
      !writeSrc.includes("invoice.update") &&
      !writeSrc.includes("payment.create"),
  );
  check(
    "UI has no send or mark-paid controls",
    uiSrc.includes("recordCollectionNextStepAction") &&
      uiSrc.includes("resolveCollectionWorkItemAction") &&
      !/Send reminder|Mark paid|Pay invoice|Mark sent/i.test(uiSrc),
  );
  check(
    "Global navigation is unchanged",
    APP_NAV.every((item) => item.href !== COLLECTIONS_ROUTE) && !navSrc.includes("/invoices/collections"),
  );
  check(
    "Invoices page links OWNER to the worklist without sending",
    invoicePageSrc.includes('href="/invoices/collections"') &&
      invoicePageSrc.includes('access.workspace.role === "OWNER"') &&
      invoicePageSrc.includes("Does not send reminders"),
  );
  check(
    "Page load uses requireManagementPageAccess before listing",
    pageSrc.includes("requireManagementPageAccess()") && pageSrc.includes("assertCanReadCollectionsWorklist"),
  );
  check("No-contact label stays recorded-only", COLLECTIONS_NO_CONTACT_LABEL === "No recorded contact");

  const now = new Date("2026-09-29T16:00:00.000Z");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Collections",
      slug: `alpha-col-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Collections",
      slug: `beta-col-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-col-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-col-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-col-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-col-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const unpaid = await seedSentInvoice({
    businessId: businessA.id,
    customerId: customer.id,
    total: "100.00",
    createdAt: daysAgo(12, now),
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: unpaid.job.id,
      invoiceId: unpaid.invoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal("40.00"),
      method: "CHECK",
      receivedAt: daysAgo(2, now),
    },
  });

  const jobLinked = await seedSentInvoice({
    businessId: businessA.id,
    customerId: customer.id,
    total: "80.00",
    createdAt: daysAgo(20, now),
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: jobLinked.job.id,
      invoiceId: null,
      purpose: "MATERIAL_DEPOSIT",
      amount: new Prisma.Decimal("25.00"),
      method: "CASH",
      receivedAt: daysAgo(18, now),
    },
  });

  const fullyCovered = await seedSentInvoice({
    businessId: businessA.id,
    customerId: customer.id,
    total: "50.00",
    createdAt: daysAgo(8, now),
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      invoiceId: fullyCovered.invoice.id,
      purpose: "INVOICE_BALANCE",
      amount: new Prisma.Decimal("50.00"),
      method: "ZELLE_BANK_TRANSFER",
      receivedAt: daysAgo(1, now),
    },
  });

  const paidInvoice = await seedSentInvoice({
    businessId: businessA.id,
    customerId: customer.id,
    total: "70.00",
    status: "PAID",
    paidAt: daysAgo(3, now),
    createdAt: daysAgo(30, now),
  });
  const draftInvoice = await seedSentInvoice({
    businessId: businessA.id,
    customerId: customer.id,
    total: "90.00",
    status: "DRAFT",
    createdAt: daysAgo(4, now),
  });

  const betaUnpaid = await seedSentInvoice({
    businessId: businessB.id,
    customerId: betaCustomer.id,
    total: "999.00",
    createdAt: daysAgo(5, now),
  });

  await prisma.customerCommunication.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      direction: "OUTBOUND",
      channel: "EMAIL",
      purpose: "INVOICE_READY",
      relatedType: "INVOICE",
      relatedId: unpaid.invoice.id,
      idempotencyKey: `invoice-ready:${unpaid.invoice.id}`,
      bodySnapshot: "Invoice ready",
      status: "SENT",
      provider: "resend",
      attemptedAt: daysAgo(11, now),
    },
  });

  console.log("\nRUNTIME — balances, contact, authorization, isolation, no-send");
  const beforeComms = await prisma.customerCommunication.count({ where: { businessId: businessA.id } });
  const beforePayments = await prisma.payment.count({ where: { businessId: businessA.id } });
  const beforeInvoices = await prisma.invoice.findMany({
    where: { businessId: businessA.id },
    select: { id: true, status: true, paidAt: true },
  });

  const workspace = await loadCollectionsWorklist(prisma, ownerA, { now });
  check("Worklist load records mutationsOnLoad false", workspace.mutationsOnLoad === false);
  check("Worklist is read-only", workspace.readOnly === true);
  check(
    "Worklist includes only unpaid SENT invoices",
    workspace.items.every((row) => row.status === "SENT" && Number(row.amountDue) > 0) &&
      workspace.items.some((row) => row.invoiceId === unpaid.invoice.id) &&
      workspace.items.some((row) => row.invoiceId === jobLinked.invoice.id) &&
      !workspace.items.some((row) => row.invoiceId === fullyCovered.invoice.id) &&
      !workspace.items.some((row) => row.invoiceId === paidInvoice.invoice.id) &&
      !workspace.items.some((row) => row.invoiceId === draftInvoice.invoice.id) &&
      !workspace.items.some((row) => row.invoiceId === betaUnpaid.invoice.id),
  );

  const unpaidRow = workspace.items.find((row) => row.invoiceId === unpaid.invoice.id);
  check(
    "Unpaid balance subtracts recorded invoice payments",
    unpaidRow != null && Number(unpaidRow.amountDue) === 60,
  );
  check(
    "Unpaid labels show invoice total, recorded paid, and remaining",
    unpaidRow?.invoiceTotalLabel.includes("100") === true &&
      unpaidRow?.amountPaidLabel.includes("40") === true &&
      unpaidRow?.amountDueLabel.includes("60") === true,
  );
  check("Due date is not invented", unpaidRow?.dueDate === null);

  const jobLinkedRow = workspace.items.find((row) => row.invoiceId === jobLinked.invoice.id);
  check(
    "Job-linked recorded deposit reduces the original invoice balance",
    jobLinkedRow != null && Number(jobLinkedRow.amountDue) === 55,
  );

  check(
    "Recorded invoice-related contact is shown",
    unpaidRow?.contact?.purpose === "INVOICE_READY" &&
      unpaidRow.contact.channel === "EMAIL" &&
      unpaidRow.contact.status === "SENT" &&
      unpaidRow.contact.relatedToThisInvoice === true,
  );
  check(
    "Job-linked invoice without its own communication stays no recorded contact or customer-level later contact only",
    jobLinkedRow?.contact == null || jobLinkedRow.contact.relatedToThisInvoice === false,
  );

  await expectError(
    "ADMIN cannot load the OWNER collections worklist",
    () => loadCollectionsWorklist(prisma, adminA, { now }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot load the OWNER collections worklist",
    () => loadCollectionsWorklist(prisma, memberA, { now }),
    (error) => error instanceof ForbiddenError,
  );

  const betaWorkspace = await loadCollectionsWorklist(prisma, ownerB, { now });
  check(
    "Tenant B cannot see tenant A unpaid invoices",
    betaWorkspace.items.every((row) => row.invoiceId === betaUnpaid.invoice.id) &&
      !betaWorkspace.items.some((row) => row.invoiceId === unpaid.invoice.id),
  );

  await expectError(
    "ADMIN cannot record a collections next step",
    () =>
      recordCollectionNextStep(prisma, adminA, {
        invoiceId: unpaid.invoice.id,
        nextStep: "CALL",
        note: "Call Friday",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record a collections resolution",
    () => resolveCollectionWorkItem(prisma, memberA, { invoiceId: unpaid.invoice.id, note: "Done" }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Owner B cannot record a next step on tenant A invoice",
    () =>
      recordCollectionNextStep(prisma, ownerB, {
        invoiceId: unpaid.invoice.id,
        nextStep: "CALL",
        note: "cross tenant",
      }),
    (error) => error instanceof CollectionWorkItemError && error.message === COLLECTIONS_UNKNOWN_INVOICE_MESSAGE,
  );
  await expectError(
    "Paid invoice cannot receive a collections next step",
    () =>
      recordCollectionNextStep(prisma, ownerA, {
        invoiceId: paidInvoice.invoice.id,
        nextStep: "WAIT",
      }),
    (error) => error instanceof CollectionWorkItemError,
  );

  const recorded = await recordCollectionNextStep(prisma, ownerA, {
    invoiceId: unpaid.invoice.id,
    nextStep: "CALL",
    note: "Call Friday",
  });
  check("OWNER can record a next step", recorded.outcome === "CREATED" && recorded.workItem.status === "OPEN");
  check("Recorded next step stays CALL", recorded.workItem.nextStep === "CALL");

  const afterNextStepInvoice = await prisma.invoice.findFirst({
    where: { id: unpaid.invoice.id },
    select: { status: true, paidAt: true },
  });
  const afterNextStepPayments = await prisma.payment.count({ where: { businessId: businessA.id } });
  const afterNextStepComms = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  check(
    "Next step does not change payment status",
    afterNextStepInvoice?.status === "SENT" && afterNextStepInvoice.paidAt == null,
  );
  check("Next step does not write a payment", afterNextStepPayments === beforePayments);
  check("Next step does not send or create a communication", afterNextStepComms === beforeComms);

  const resolved = await resolveCollectionWorkItem(prisma, ownerA, {
    invoiceId: unpaid.invoice.id,
    note: "Promised to mail a check",
  });
  check("OWNER can record a resolution", resolved.workItem.status === "RESOLVED");
  const afterResolveInvoice = await prisma.invoice.findFirst({
    where: { id: unpaid.invoice.id },
    select: { status: true, paidAt: true, paymentMethod: true },
  });
  const afterResolvePayments = await prisma.payment.count({ where: { businessId: businessA.id } });
  const afterResolveComms = await prisma.customerCommunication.count({
    where: { businessId: businessA.id },
  });
  check(
    "Resolution does not mark the invoice paid",
    afterResolveInvoice?.status === "SENT" &&
      afterResolveInvoice.paidAt == null &&
      afterResolveInvoice.paymentMethod == null,
  );
  check("Resolution does not write a payment", afterResolvePayments === beforePayments);
  check("Resolution does not send a reminder", afterResolveComms === beforeComms);

  const afterWriteWorkspace = await loadCollectionsWorklist(prisma, ownerA, { now });
  const afterWriteRow = afterWriteWorkspace.items.find((row) => row.invoiceId === unpaid.invoice.id);
  check(
    "Worklist still shows the unpaid balance after resolution",
    afterWriteRow != null && Number(afterWriteRow.amountDue) === 60 && afterWriteRow.workItem?.status === "RESOLVED",
  );

  const afterLoadComms = await prisma.customerCommunication.count({ where: { businessId: businessA.id } });
  const afterLoadInvoices = await prisma.invoice.findMany({
    where: { businessId: businessA.id },
    select: { id: true, status: true, paidAt: true },
  });
  check("Page-load style reads do not create communications", afterLoadComms === beforeComms);
  check(
    "Page-load style reads do not change invoice payment status",
    afterLoadInvoices.every((row) => {
      const before = beforeInvoices.find((item) => item.id === row.id);
      return before && before.status === row.status && String(before.paidAt) === String(row.paidAt);
    }),
  );

  await ensureDefaultAutomationRules(prisma, businessA.id);
  const pendingBefore = await prisma.automationRun.count({
    where: { businessId: businessA.id, status: { in: ["PENDING", "RUNNING"] } },
  });
  await scanScheduledBusinessEvents(prisma, businessA.id);
  await processPendingAutomationRuns(prisma, businessA.id);
  const pendingAfter = await prisma.automationRun.count({
    where: { businessId: businessA.id, status: { in: ["PENDING", "RUNNING"] } },
  });
  const sentAfterScan = await prisma.customerCommunication.count({
    where: { businessId: businessA.id, purpose: "PAYMENT_REMINDER" },
  });
  check("Collections writes do not queue payment-reminder automation", pendingAfter === pendingBefore);
  check("No payment reminder was sent from collections work", sentAfterScan === 0);

  const overflowCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Bound Sample" },
  });
  for (let i = 0; i < COLLECTIONS_QUEUE_LIMIT + 1; i += 1) {
    await seedSentInvoice({
      businessId: businessA.id,
      customerId: overflowCustomer.id,
      total: "10.00",
      createdAt: daysAgo(40 + i, now),
    });
  }
  const bounded = await loadCollectionsWorklist(prisma, ownerA, { now });
  check(
    "Worklist stays bounded",
    bounded.items.length === COLLECTIONS_QUEUE_LIMIT &&
      bounded.queueLimit === COLLECTIONS_QUEUE_LIMIT &&
      bounded.overflow === true &&
      bounded.unpaidCount > COLLECTIONS_QUEUE_LIMIT,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\n${failures} collections worklist check(s) failed.`);
  process.exit(1);
}
console.log("\nAll collections worklist checks passed.");
