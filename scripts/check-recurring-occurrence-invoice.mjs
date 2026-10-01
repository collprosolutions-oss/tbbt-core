/**
 * OWNER draft invoice for one completed recurring occurrence.
 *
 * Dedicated unique local disposable database. Remote DATABASE_URL
 * hosts are refused before Prisma generate, schema push, or forced
 * database drop.
 *
 * Proves tenant isolation, occurrence binding (never the source or
 * another visit), concurrent first-create reuse, historical approved
 * prices, job-only payment attach, no send/charge, and that Complete
 * Job / Create invoice cannot bill an occurrence by accident.
 *
 * Run with:
 *   npm run test:recurring-occurrence-invoice
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the recurring-occurrence invoice check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "Recurring-occurrence invoice disposable database");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for recurring-occurrence invoice checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { isRecurringOccurrenceJob, parseOwnerRecurringConfirmation } = await import(
  "@/lib/cleaning-recurring-booking"
);
const {
  persistDraftInvoiceFromCompletedJob,
  persistDraftInvoicePaymentEstimateId,
  persistDraftInvoiceTestHooks,
  RECURRING_OCCURRENCE_USE_DRAFT_INVOICE_ACTION_MESSAGE,
} = await import("@/lib/invoice-carry-forward");
const { completeJobAndSendInvoice } = await import("@/lib/complete-job-invoice");
const {
  OWNER_CREATES_RECURRING_OCCURRENCE_INVOICE_MESSAGE,
  RECURRING_OCCURRENCE_INVOICE_CONFIRM_REQUIRED_MESSAGE,
  RECURRING_OCCURRENCE_INVOICE_NOT_COMPLETED_MESSAGE,
  RECURRING_OCCURRENCE_INVOICE_SOURCE_MESSAGE,
  createOwnedDraftInvoiceFromCompletedRecurringOccurrence,
  loadRecurringOccurrenceInvoiceReview,
  persistDraftInvoiceFromCompletedRecurringOccurrence,
} = await import("@/lib/recurring-occurrence-invoice");
const { PAYMENT_PURPOSE_MATERIAL_DEPOSIT, recordSucceededPayment } = await import(
  "@/lib/project-payments"
);
const { INVOICE_KIND_ORIGINAL } = await import("@/lib/revenue-integrity");
const { buildOwnerTodayHandoffItems } = await import("@/lib/owner-today");
const { Prisma } = await import("@prisma/client");

let session;
let prisma;

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId, timezone) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Occurrence Invoice Co", timezone },
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

const persistSrc = read("src/lib/invoice-carry-forward.ts");
const occurrenceSrc = read("src/lib/recurring-occurrence-invoice.ts");
const actionSrc = read("src/app/actions/invoice.ts");
const completeSrc = read("src/lib/complete-job-invoice.ts");
const formSrc = read("src/components/jobs/cleaning-recurring-occurrence-invoice-form.tsx");
const pageSrc = read("src/app/(app)/jobs/[jobId]/page.tsx");
const todaySrc = read("src/lib/owner-today.ts");
const workspaceSrc = read("src/components/jobs/jobs-workspace.tsx");

console.log("\nSTATIC — explicit OWNER draft, no send / charge / background bill");
check(
  "Occurrence identity requires source + unique key and excludes next booking / corrective",
  isRecurringOccurrenceJob({
    recurrenceSourceJobId: "src",
    recurrenceOccurrenceKey: "recurring:src:2026-10-05",
  }) === true &&
    isRecurringOccurrenceJob({ recurrenceSourceJobId: "src" }) === false &&
    isRecurringOccurrenceJob({
      recurrenceSourceJobId: "src",
      recurrenceOccurrenceKey: "recurring:src:2026-10-05",
      nextBookingSourceJobId: "nb",
    }) === false &&
    parseOwnerRecurringConfirmation("1") === true &&
    parseOwnerRecurringConfirmation("") === false,
);
check(
  "Canonical persist refuses occurrences unless job-only payments are requested",
  persistSrc.includes('recurringOccurrence?: "refuse" | "allow-job-payments-only"') &&
    persistSrc.includes("isRecurringOccurrenceJob(job)") &&
    persistSrc.includes("RECURRING_OCCURRENCE_USE_DRAFT_INVOICE_ACTION_MESSAGE") &&
    persistDraftInvoicePaymentEstimateId({
      estimateId: "est-1",
      recurringOccurrence: "allow-job-payments-only",
    }) === null &&
    persistDraftInvoicePaymentEstimateId({ estimateId: "est-1" }) === "est-1",
);
check(
  "Occurrence persist reuses snapshots and binds to the occurrence job only",
  occurrenceSrc.includes("persistDraftInvoiceFromCompletedJob") &&
    occurrenceSrc.includes('recurringOccurrence: "allow-job-payments-only"') &&
    occurrenceSrc.includes("source.id === job.id") &&
    occurrenceSrc.includes("Invoice.jobId to the occurrence only") &&
    !occurrenceSrc.includes("sendDraftInvoiceIfNeeded") &&
    !occurrenceSrc.includes("markInvoicePaid") &&
    !occurrenceSrc.includes("recordOwnerInvoiceBalancePayment"),
);
const occurrenceActionSrc = actionSrc.slice(
  actionSrc.indexOf("export async function createDraftInvoiceFromCompletedRecurringOccurrence"),
  actionSrc.indexOf("export async function markInvoiceSent"),
);
const occurrenceCompleteSrc = completeSrc.slice(
  completeSrc.indexOf("if (completedJob && isRecurringOccurrenceJob"),
  completeSrc.indexOf("const persist = await persistDraftInvoiceFromCompletedJob"),
);
check(
  "OWNER action is reviewable, confirmed, and does not send or charge",
  actionSrc.includes("createDraftInvoiceFromCompletedRecurringOccurrence") &&
    actionSrc.includes("createOwnedDraftInvoiceFromCompletedRecurringOccurrence") &&
    occurrenceActionSrc.includes("confirmCreate") &&
    !occurrenceActionSrc.includes("sendDraftInvoiceIfNeeded") &&
    !occurrenceActionSrc.includes("redirect(") &&
    formSrc.includes("Create a draft invoice for this completed recurring booking only") &&
    formSrc.includes("It will not send, charge, or bill the original job") &&
    formSrc.includes('name="confirmCreate"'),
);
check(
  "Complete Job and Today send path skip recurring occurrences",
  completeSrc.includes("isRecurringOccurrenceJob(completedJob)") &&
    occurrenceCompleteSrc.includes("invoiceSkipped: true") &&
    occurrenceCompleteSrc.includes("return {") &&
    !occurrenceCompleteSrc.includes("persistDraftInvoiceFromCompletedJob") &&
    !occurrenceCompleteSrc.includes("sendDraftInvoiceIfNeeded") &&
    todaySrc.includes("if (isRecurringOccurrenceJob(job)) continue") &&
    pageSrc.includes("CleaningRecurringOccurrenceInvoiceForm") &&
    pageSrc.includes("!isRecurringOccurrence && invoices.length === 0") &&
    workspaceSrc.includes("job.isRecurringOccurrence") &&
    workspaceSrc.includes("Review draft invoice"),
);
check(
  "No background invoice writer on the occurrence path",
  !occurrenceSrc.includes("setInterval") &&
    !occurrenceSrc.includes("scanScheduledBusinessEvents") &&
    !occurrenceSrc.includes("completeJobAndSendInvoice") &&
    OWNER_CREATES_RECURRING_OCCURRENCE_INVOICE_MESSAGE.includes("business owner") &&
    RECURRING_OCCURRENCE_USE_DRAFT_INVOICE_ACTION_MESSAGE.includes("occurrence invoice action"),
);

session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_recurring_occurrence_invoice",
  setProcessEnv: true,
});
prisma = session.prisma;
await prisma.$executeRawUnsafe(`
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_jobId_original_unique"
  ON "Invoice"("jobId")
  WHERE "jobId" IS NOT NULL AND "kind" = 'ORIGINAL'
`);

try {
  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-roi-${suffix}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ava", email: `admin-roi-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-roi-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-roi-${suffix}@example.com`, passwordHash: "x" },
  });

  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Occurrence Invoice",
      slug: `alpha-roi-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/Los_Angeles",
    },
  });
  const cleanB = await prisma.business.create({
    data: {
      name: "Beta Occurrence Invoice",
      slug: `beta-roi-${suffix}`,
      tradeCode: "CLEANING",
      timezone: "America/New_York",
    },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: cleanA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: cleanA.id, role: "ADMIN" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: cleanA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: cleanB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(cleanA.id, "OWNER", memOwnerA.id, ownerUser.id, "America/Los_Angeles");
  const adminA = makeAccess(cleanA.id, "ADMIN", memAdminA.id, adminUser.id, "America/Los_Angeles");
  const memberA = makeAccess(cleanA.id, "MEMBER", memMemberA.id, memberUser.id, "America/Los_Angeles");
  const ownerB = makeAccess(cleanB.id, "OWNER", memOwnerB.id, ownerBUser.id, "America/New_York");

  async function createSeries(businessId, options = {}) {
    const {
      customerName = "Recurring Customer",
      lineDescription = "Standard clean",
      lineTotal = "180",
      occurrenceStatus = "COMPLETED",
      secondOccurrence = true,
    } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: customerName,
        email: `roi-${randomUUID().slice(0, 6)}@example.com`,
      },
    });
    const property = await prisma.property.create({
      data: {
        businessId,
        customerId: customer.id,
        addressLine1: "100 Pine St",
        city: "Los Angeles",
        region: "CA",
        postalCode: "90012",
      },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        businessId,
        customerId: customer.id,
        propertyId: property.id,
        description: "Recurring clean",
        tradeCode: "CLEANING",
        serviceIntent: "RECURRING",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId,
        customerId: customer.id,
        propertyId: property.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: lineTotal,
      },
    });
    const version = await prisma.estimateVersion.create({
      data: {
        businessId,
        estimateId: estimate.id,
        versionNumber: 1,
        total: lineTotal,
        laborMinimumWaived: false,
        laborMinimumAdjustment: 0,
        customerName,
        approvedAt: new Date("2026-09-19T16:00:00.000Z"),
        lineItems: {
          create: [
            {
              businessId,
              description: lineDescription,
              quantity: 1,
              unitPrice: lineTotal,
              total: lineTotal,
              type: "LABOR",
            },
          ],
        },
      },
    });
    await prisma.estimate.update({
      where: { id: estimate.id },
      data: { approvedVersionId: version.id },
    });
    const source = await prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        propertyId: property.id,
        estimateId: estimate.id,
        approvedEstimateVersionId: version.id,
        projectToken: randomUUID(),
        status: "COMPLETED",
        serviceIntent: "RECURRING",
        recurrenceCadence: "WEEKLY",
        recurrenceStatus: "ACTIVE",
      },
    });
    const first = await prisma.job.create({
      data: {
        businessId,
        customerId: customer.id,
        propertyId: property.id,
        estimateId: estimate.id,
        approvedEstimateVersionId: version.id,
        projectToken: randomUUID(),
        status: occurrenceStatus,
        scheduledAt: new Date("2026-10-05T16:00:00.000Z"),
        serviceIntent: "RECURRING",
        recurrenceCadence: "WEEKLY",
        recurrenceStatus: "ACTIVE",
        recurrenceSourceJobId: source.id,
        recurrenceOccurrenceKey: `recurring:${source.id}:2026-10-05`,
      },
    });
    const second = secondOccurrence
      ? await prisma.job.create({
          data: {
            businessId,
            customerId: customer.id,
            propertyId: property.id,
            estimateId: estimate.id,
            approvedEstimateVersionId: version.id,
            projectToken: randomUUID(),
            status: "COMPLETED",
            scheduledAt: new Date("2026-10-12T16:00:00.000Z"),
            serviceIntent: "RECURRING",
            recurrenceCadence: "WEEKLY",
            recurrenceStatus: "ACTIVE",
            recurrenceSourceJobId: source.id,
            recurrenceOccurrenceKey: `recurring:${source.id}:2026-10-12`,
          },
        })
      : null;
    return { customer, property, estimate, version, source, first, second };
  }

  console.log("\nLIVE — authorization, isolation, binding, history, concurrency");
  const seriesA = await createSeries(cleanA.id, { customerName: "Alpha Recurring" });
  const seriesB = await createSeries(cleanB.id, { customerName: "Beta Recurring" });

  await expectThrow(
    "ADMIN cannot create a recurring-occurrence draft",
    () =>
      createOwnedDraftInvoiceFromCompletedRecurringOccurrence(prisma, adminA, {
        jobId: seriesA.first.id,
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      error.message === OWNER_CREATES_RECURRING_OCCURRENCE_INVOICE_MESSAGE,
  );
  await expectThrow(
    "MEMBER cannot create a recurring-occurrence draft",
    () =>
      createOwnedDraftInvoiceFromCompletedRecurringOccurrence(prisma, memberA, {
        jobId: seriesA.first.id,
        confirmCreate: "1",
      }),
    (error) =>
      error instanceof ForbiddenError &&
      error.message === OWNER_CREATES_RECURRING_OCCURRENCE_INVOICE_MESSAGE,
  );
  await expectThrow(
    "OWNER must confirm the draft is for this occurrence only",
    () =>
      createOwnedDraftInvoiceFromCompletedRecurringOccurrence(prisma, ownerA, {
        jobId: seriesA.first.id,
        confirmCreate: "",
      }),
    (error) => error.message === RECURRING_OCCURRENCE_INVOICE_CONFIRM_REQUIRED_MESSAGE,
  );
  await expectThrow(
    "OWNER A cannot invoice business B's occurrence",
    () =>
      createOwnedDraftInvoiceFromCompletedRecurringOccurrence(prisma, ownerA, {
        jobId: seriesB.first.id,
        confirmCreate: "1",
      }),
    (error) => error instanceof Error,
  );
  const persistAsB = await persistDraftInvoiceFromCompletedRecurringOccurrence(prisma, {
    businessId: cleanB.id,
    jobId: seriesA.first.id,
  });
  check(
    "persist(B, occurrence A) does not find or invoice occurrence A",
    persistAsB.ok === false &&
      persistAsB.error === "That job could not be found." &&
      (await prisma.invoice.count({ where: { jobId: seriesA.first.id } })) === 0,
  );

  const sourceAttempt = await persistDraftInvoiceFromCompletedRecurringOccurrence(prisma, {
    businessId: cleanA.id,
    jobId: seriesA.source.id,
  });
  check(
    "Source job is refused by the occurrence persist",
    sourceAttempt.ok === false &&
      sourceAttempt.error === RECURRING_OCCURRENCE_INVOICE_SOURCE_MESSAGE &&
      (await prisma.invoice.count({ where: { jobId: seriesA.source.id } })) === 0,
  );
  const defaultPersistOccurrence = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: cleanA.id,
    jobId: seriesA.first.id,
  });
  check(
    "Canonical persist refuses an occurrence so Complete Job / Create invoice cannot bill it",
    defaultPersistOccurrence.ok === false &&
      defaultPersistOccurrence.error === RECURRING_OCCURRENCE_USE_DRAFT_INVOICE_ACTION_MESSAGE &&
      (await prisma.invoice.count({ where: { jobId: seriesA.first.id } })) === 0,
  );

  const scheduled = await createSeries(cleanA.id, {
    customerName: "Not Done",
    occurrenceStatus: "SCHEDULED",
    secondOccurrence: false,
  });
  const notCompleted = await persistDraftInvoiceFromCompletedRecurringOccurrence(prisma, {
    businessId: cleanA.id,
    jobId: scheduled.first.id,
  });
  check(
    "Unfinished occurrence cannot become a draft",
    notCompleted.ok === false &&
      notCompleted.error === RECURRING_OCCURRENCE_INVOICE_NOT_COMPLETED_MESSAGE &&
      (await prisma.invoice.count({ where: { jobId: scheduled.first.id } })) === 0,
  );

  await recordSucceededPayment(prisma, {
    businessId: cleanA.id,
    customerId: seriesA.customer.id,
    estimateId: seriesA.estimate.id,
    jobId: seriesA.source.id,
    purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    amount: new Prisma.Decimal(40),
    method: "CASH",
    note: "source deposit",
  });

  const created = await createOwnedDraftInvoiceFromCompletedRecurringOccurrence(prisma, ownerA, {
    jobId: seriesA.first.id,
    confirmCreate: "1",
  });
  check("OWNER creates a draft for occurrence one", created.ok && created.reused === false);
  const firstInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: created.invoiceId },
    include: { lineItems: true, payments: true },
  });
  check(
    "Draft binds to occurrence one, stays DRAFT, and uses the frozen $180 scope",
    firstInvoice.jobId === seriesA.first.id &&
      firstInvoice.businessId === cleanA.id &&
      firstInvoice.customerId === seriesA.customer.id &&
      firstInvoice.status === "DRAFT" &&
      firstInvoice.kind === INVOICE_KIND_ORIGINAL &&
      firstInvoice.total.toString() === "180" &&
      firstInvoice.lineItems.length === 1 &&
      firstInvoice.lineItems[0].description === "Standard clean" &&
      firstInvoice.lineItems[0].total.toString() === "180" &&
      firstInvoice.payments.length === 0,
  );
  const sourcePayments = await prisma.payment.findMany({
    where: { businessId: cleanA.id, estimateId: seriesA.estimate.id },
  });
  check(
    "Shared estimate deposit stays on the source job and is not attached to the occurrence draft",
    sourcePayments.length === 1 &&
      sourcePayments[0].jobId === seriesA.source.id &&
      sourcePayments[0].invoiceId === null &&
      (await prisma.invoice.count({ where: { jobId: seriesA.source.id } })) === 0 &&
      (await prisma.invoice.count({ where: { jobId: seriesA.second.id } })) === 0,
  );

  const retry = await createOwnedDraftInvoiceFromCompletedRecurringOccurrence(prisma, ownerA, {
    jobId: seriesA.first.id,
    confirmCreate: true,
  });
  check(
    "Retry returns the same draft and does not send or duplicate",
    retry.ok &&
      retry.reused === true &&
      retry.invoiceId === created.invoiceId &&
      (await prisma.invoice.count({ where: { jobId: seriesA.first.id } })) === 1 &&
      (await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoiceId } })).status ===
        "DRAFT",
  );

  const secondCreated = await persistDraftInvoiceFromCompletedRecurringOccurrence(prisma, {
    businessId: cleanA.id,
    jobId: seriesA.second.id,
  });
  check("Occurrence two gets its own draft", secondCreated.ok && secondCreated.reused === false);
  const secondInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: secondCreated.invoiceId },
  });
  check(
    "Occurrence two never receives occurrence one's invoice",
    secondInvoice.id !== firstInvoice.id &&
      secondInvoice.jobId === seriesA.second.id &&
      secondInvoice.status === "DRAFT" &&
      (await prisma.invoice.count({ where: { jobId: seriesA.first.id } })) === 1,
  );

  const laterVersion = await prisma.estimateVersion.create({
    data: {
      businessId: cleanA.id,
      estimateId: seriesA.estimate.id,
      versionNumber: 2,
      total: "999",
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      customerName: "Alpha Recurring",
      approvedAt: new Date("2026-10-20T16:00:00.000Z"),
      lineItems: {
        create: [
          {
            businessId: cleanA.id,
            description: "Premium clean",
            quantity: 1,
            unitPrice: "999",
            total: "999",
            type: "LABOR",
          },
        ],
      },
    },
  });
  await prisma.estimate.update({
    where: { id: seriesA.estimate.id },
    data: { approvedVersionId: laterVersion.id, total: "999" },
  });
  await prisma.job.update({
    where: { id: seriesA.source.id },
    data: { approvedEstimateVersionId: laterVersion.id },
  });
  const afterPriceChange = await persistDraftInvoiceFromCompletedRecurringOccurrence(prisma, {
    businessId: cleanA.id,
    jobId: seriesA.first.id,
  });
  const frozen = await prisma.invoice.findUniqueOrThrow({
    where: { id: created.invoiceId },
    include: { lineItems: true },
  });
  check(
    "Later catalog / source version edits do not rewrite the occurrence draft",
    afterPriceChange.ok &&
      afterPriceChange.invoiceId === created.invoiceId &&
      frozen.total.toString() === "180" &&
      frozen.lineItems[0].description === "Standard clean" &&
      frozen.lineItems[0].total.toString() === "180",
  );

  const historical = await createSeries(cleanA.id, {
    customerName: "History Customer",
    lineDescription: "Legacy clean",
    lineTotal: "125",
  });
  const v2 = await prisma.estimateVersion.create({
    data: {
      businessId: cleanA.id,
      estimateId: historical.estimate.id,
      versionNumber: 2,
      total: "400",
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      customerName: "History Customer",
      approvedAt: new Date("2026-10-21T16:00:00.000Z"),
      lineItems: {
        create: [
          {
            businessId: cleanA.id,
            description: "New clean",
            quantity: 1,
            unitPrice: "400",
            total: "400",
            type: "LABOR",
          },
        ],
      },
    },
  });
  await prisma.estimate.update({
    where: { id: historical.estimate.id },
    data: { approvedVersionId: v2.id, total: "400" },
  });
  await prisma.job.update({
    where: { id: historical.source.id },
    data: { approvedEstimateVersionId: v2.id },
  });
  const historicalDraft = await persistDraftInvoiceFromCompletedRecurringOccurrence(prisma, {
    businessId: cleanA.id,
    jobId: historical.first.id,
  });
  const historicalInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: historicalDraft.invoiceId },
    include: { lineItems: true },
  });
  check(
    "New occurrence draft still uses the occurrence's frozen approved version",
    historicalDraft.ok &&
      historicalInvoice.total.toString() === "125" &&
      historicalInvoice.lineItems[0].description === "Legacy clean" &&
      historicalInvoice.jobId === historical.first.id,
  );

  const raceSeries = await createSeries(cleanA.id, {
    customerName: "Race Customer",
    lineTotal: "210",
    secondOccurrence: false,
  });
  let arrived = 0;
  const release = [];
  persistDraftInvoiceTestHooks.beforeCreateOriginal = () =>
    new Promise((resolve) => {
      arrived += 1;
      release.push(resolve);
      if (arrived >= 2) {
        for (const done of release) done();
      }
    });
  const raceClientA = session.createClient();
  const raceClientB = session.createClient();
  let raceResults;
  try {
    raceResults = await Promise.all([
      persistDraftInvoiceFromCompletedRecurringOccurrence(raceClientA, {
        businessId: cleanA.id,
        jobId: raceSeries.first.id,
      }),
      persistDraftInvoiceFromCompletedRecurringOccurrence(raceClientB, {
        businessId: cleanA.id,
        jobId: raceSeries.first.id,
      }),
    ]);
  } finally {
    persistDraftInvoiceTestHooks.beforeCreateOriginal = undefined;
  }
  const raceOk = raceResults.filter((result) => result.ok);
  const raceIds = [...new Set(raceOk.map((result) => result.invoiceId))];
  const raceInvoices = await prisma.invoice.findMany({
    where: { jobId: raceSeries.first.id },
  });
  check(
    "Concurrent creates return one ORIGINAL draft for that occurrence",
    raceOk.length === 2 &&
      raceIds.length === 1 &&
      raceInvoices.length === 1 &&
      raceInvoices[0].id === raceIds[0] &&
      raceInvoices[0].status === "DRAFT" &&
      raceInvoices[0].kind === INVOICE_KIND_ORIGINAL &&
      raceInvoices[0].jobId === raceSeries.first.id,
  );

  const inProgress = await createSeries(cleanA.id, {
    customerName: "Complete Later",
    occurrenceStatus: "IN_PROGRESS",
    secondOccurrence: false,
  });
  const completedOccurrence = await completeJobAndSendInvoice(prisma, {
    businessId: cleanA.id,
    jobId: inProgress.first.id,
    businessName: cleanA.name,
    actorMembershipId: memOwnerA.id,
  });
  check(
    "Completing an occurrence does not create, send, or charge an invoice",
    completedOccurrence.ok === true &&
      completedOccurrence.invoiceSkipped === true &&
      completedOccurrence.invoiceId == null &&
      completedOccurrence.newlySent === false &&
      (await prisma.job.findUniqueOrThrow({ where: { id: inProgress.first.id } })).status ===
        "COMPLETED" &&
      (await prisma.invoice.count({ where: { jobId: inProgress.first.id } })) === 0 &&
      (await prisma.invoice.count({ where: { jobId: inProgress.source.id } })) === 0,
  );

  const review = await loadRecurringOccurrenceInvoiceReview(prisma, ownerA, seriesA.first.id);
  const foreignReview = await loadRecurringOccurrenceInvoiceReview(prisma, ownerB, seriesA.first.id);
  const sourceReview = await loadRecurringOccurrenceInvoiceReview(prisma, ownerA, seriesA.source.id);
  check(
    "Review model is occurrence-scoped and hidden from the other tenant",
    review?.jobId === seriesA.first.id &&
      review.sourceJobId === seriesA.source.id &&
      review.existingInvoiceId === created.invoiceId &&
      review.totalLabel.includes("180") &&
      foreignReview === null &&
      sourceReview === null,
  );

  const handoff = buildOwnerTodayHandoffItems(
    [
      {
        id: seriesA.first.id,
        businessId: cleanA.id,
        status: "COMPLETED",
        recurrenceSourceJobId: seriesA.source.id,
        recurrenceOccurrenceKey: seriesA.first.recurrenceOccurrenceKey,
        estimate: { total: 180 },
        invoices: [],
        changeOrders: [],
        customer: { name: "Alpha Recurring" },
      },
      {
        id: "regular-unbilled",
        businessId: cleanA.id,
        status: "COMPLETED",
        estimate: { total: 90 },
        invoices: [],
        changeOrders: [],
        customer: { name: "One time" },
      },
    ],
    cleanA.id,
  );
  check(
    "Today send-path handoff skips recurring occurrences",
    handoff.length === 1 && handoff[0].jobId === "regular-unbilled",
  );
} catch (error) {
  failed += 1;
  console.error("FAIL - live recurring-occurrence invoice proofs crashed");
  console.error(error);
} finally {
  await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll recurring-occurrence invoice checks passed (${passed}).`
    : `\n${failed} recurring-occurrence invoice check(s) failed; ${passed} passed.`,
);
if (failed > 0) process.exit(1);
