/**
 * Revenue integrity: supplemental / balance invoices and completed-but-unbilled
 * owner attention.
 *
 * Imports the real persist / complete-job / document / reports helpers.
 * Server actions that depend on next/headers are not invoked.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-revenue-integrity.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  isOriginalInvoiceUniqueViolation,
  persistDraftInvoiceFromCompletedJob,
  persistDraftInvoiceTestHooks,
} = await import("@/lib/invoice-carry-forward");
const { completeJobAndSendInvoice, sendDraftInvoiceIfNeeded } = await import(
  "@/lib/complete-job-invoice"
);
const {
  isCustomerVisibleInvoiceStatus,
  loadInvoiceDocumentForBusiness,
  loadInvoiceDocumentForProjectToken,
} = await import("@/lib/invoice-document");
const { renderInvoicePdf } = await import("@/lib/invoice-pdf");
const {
  INVOICE_KIND_ORIGINAL,
  INVOICE_KIND_SUPPLEMENTAL,
  billedChangeOrderIds,
  completedJobBillingAttention,
  listCompletedUnbilledJobs,
  selectPortalInvoice,
} = await import("@/lib/revenue-integrity");
const { buildReport, resolveReportRange } = await import("@/lib/reports");
const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("@/lib/authorization");
const {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  attachEstimatePaymentsToInvoice,
  invoicePaymentBreakdown,
  listPaymentsForInvoice,
  listPaymentsGroupedByInvoiceId,
  listProjectPayments,
  paymentsBelongingToInvoice,
  recordSucceededPayment,
} = await import("@/lib/project-payments");
const { evaluateCompleteJob } = await import("@/lib/job-lifecycle");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_revenue_integrity_test";
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
  console.error("Failed to push schema for revenue-integrity test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function pdfExtractText(buffer) {
  const raw = buffer.toString("latin1");
  return [...raw.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((match) => {
      try {
        return Buffer.from(match[1], "hex").toString("utf8");
      } catch {
        return "";
      }
    })
    .join("");
}

function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function migrationStatements(sql) {
  const statements = [];
  let current = [];
  let dollarCount = 0;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--") && current.length === 0) continue;
    current.push(line);
    dollarCount += (line.match(/\$\$/g) ?? []).length;
    if (dollarCount % 2 === 0 && trimmed.endsWith(";")) {
      const text = current.join("\n").trim().replace(/;$/, "");
      current = [];
      if (text && !text.includes("DO $$")) {
        statements.push(text);
      }
    }
  }
  return statements;
}

function makeAccess(businessId, role) {
  return {
    businessId,
    workspace: { role },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function createInProgressApprovedJob(input) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "APPROVED",
      total: new Prisma.Decimal(input.estimateTotal),
      laborMinimumAdjustment: new Prisma.Decimal(input.laborMinimum ?? 0),
      publicToken: randomUUID(),
    },
  });

  for (const line of input.estimateLines) {
    await prisma.lineItem.create({
      data: {
        businessId: input.businessId,
        estimateId: estimate.id,
        description: line.description,
        quantity: new Prisma.Decimal(line.quantity),
        unitPrice: new Prisma.Decimal(line.unitPrice),
        total: new Prisma.Decimal(line.total),
        type: "LABOR",
      },
    });
  }

  const version = await prisma.estimateVersion.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(input.estimateTotal),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(input.laborMinimum ?? 0),
      customerName: input.customerName,
      approvedAt: new Date(),
      lineItems: {
        create: input.estimateLines.map((line) => ({
          businessId: input.businessId,
          description: line.description,
          quantity: new Prisma.Decimal(line.quantity),
          unitPrice: new Prisma.Decimal(line.unitPrice),
          total: new Prisma.Decimal(line.total),
          type: "LABOR",
        })),
      },
    },
  });

  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });

  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      status: input.status ?? "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });

  return { estimate, version, job };
}

async function addChangeOrder(input) {
  const changeOrder = await prisma.changeOrder.create({
    data: {
      businessId: input.businessId,
      jobId: input.jobId,
      title: input.title,
      status: input.status,
      total: new Prisma.Decimal(input.total),
      createdAt: input.createdAt ?? undefined,
      approvedAt:
        input.approvedAt !== undefined
          ? input.approvedAt
          : input.status === "APPROVED"
            ? new Date()
            : null,
      sentAt: input.status === "SENT" || input.status === "APPROVED" ? input.approvedAt ?? new Date() : null,
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      changeOrderId: changeOrder.id,
      description: input.description,
      quantity: new Prisma.Decimal(input.quantity ?? 1),
      unitPrice: new Prisma.Decimal(input.total),
      total: new Prisma.Decimal(input.total),
      type: "LABOR",
    },
  });
  return changeOrder;
}

try {
  console.log("\nPURE — attention + portal selection");
  const now = new Date("2026-09-25T12:00:00.000Z");
  const later = new Date("2026-09-25T13:00:00.000Z");
  check(
    "completed job with no covering invoice is unbilled",
    completedJobBillingAttention({
      jobStatus: "COMPLETED",
      originalApprovedTotal: 200,
      invoices: [],
      changeOrders: [],
    }).unbilled === true,
  );
  check(
    "fully billed completed job is not surfaced",
    completedJobBillingAttention({
      jobStatus: "COMPLETED",
      originalApprovedTotal: 200,
      invoices: [
        {
          id: "inv-1",
          status: "SENT",
          kind: INVOICE_KIND_ORIGINAL,
          createdAt: now,
          total: 200,
        },
      ],
      changeOrders: [],
    }).unbilled === false,
  );
  const partial = completedJobBillingAttention({
    jobStatus: "COMPLETED",
    originalApprovedTotal: 200,
    invoices: [
      {
        id: "inv-1",
        status: "PAID",
        kind: INVOICE_KIND_ORIGINAL,
        createdAt: now,
        total: 200,
      },
    ],
    changeOrders: [
      {
        id: "co-1",
        status: "APPROVED",
        total: 75,
        invoiceId: null,
        createdAt: later,
        approvedAt: later,
      },
    ],
  });
  check("partially billed completed job is surfaced", partial.unbilled === true);
  check(
    "partially billed reason is unbilled change orders",
    partial.unbilled && partial.reason === "unbilled-change-orders",
  );
  check(
    "supplementally billed job is not surfaced",
    completedJobBillingAttention({
      jobStatus: "COMPLETED",
      originalApprovedTotal: 200,
      invoices: [
        {
          id: "inv-1",
          status: "PAID",
          kind: INVOICE_KIND_ORIGINAL,
          createdAt: now,
          total: 200,
        },
        {
          id: "inv-2",
          status: "SENT",
          kind: INVOICE_KIND_SUPPLEMENTAL,
          createdAt: later,
          total: 75,
        },
      ],
      changeOrders: [
        {
          id: "co-1",
          status: "APPROVED",
          total: 75,
          invoiceId: "inv-2",
          createdAt: later,
          approvedAt: later,
        },
      ],
    }).unbilled === false,
  );
  const createdJan1 = new Date("2026-01-01T12:00:00.000Z");
  const invoicedJan5 = new Date("2026-01-05T12:00:00.000Z");
  const approvedJan10 = new Date("2026-01-10T12:00:00.000Z");
  const approvedJan3 = new Date("2026-01-03T12:00:00.000Z");
  const lateApprovalAttention = completedJobBillingAttention({
    jobStatus: "COMPLETED",
    originalApprovedTotal: 200,
    invoices: [
      {
        id: "inv-orig",
        status: "SENT",
        kind: INVOICE_KIND_ORIGINAL,
        createdAt: invoicedJan5,
        total: 200,
      },
    ],
    changeOrders: [
      {
        id: "co-late-approval",
        status: "APPROVED",
        total: 80,
        invoiceId: null,
        createdAt: createdJan1,
        approvedAt: approvedJan10,
      },
    ],
  });
  check(
    "CO created before original but approved after is unbilled attention",
    lateApprovalAttention.unbilled === true && lateApprovalAttention.reason === "unbilled-change-orders",
  );
  check(
    "CO created before original but approved after is not inferred billed",
    billedChangeOrderIds({
      invoices: [
        {
          id: "inv-orig",
          status: "SENT",
          kind: INVOICE_KIND_ORIGINAL,
          createdAt: invoicedJan5,
          total: 200,
        },
      ],
      changeOrders: [
        {
          id: "co-late-approval",
          status: "APPROVED",
          total: 80,
          invoiceId: null,
          createdAt: createdJan1,
          approvedAt: approvedJan10,
        },
      ],
    }).has("co-late-approval") === false,
  );
  check(
    "CO with no approvedAt is not inferred billed even when createdAt is earlier",
    billedChangeOrderIds({
      invoices: [
        {
          id: "inv-orig",
          status: "SENT",
          kind: INVOICE_KIND_ORIGINAL,
          createdAt: invoicedJan5,
          total: 200,
        },
      ],
      changeOrders: [
        {
          id: "co-unproven",
          status: "APPROVED",
          total: 80,
          invoiceId: null,
          createdAt: createdJan1,
        },
      ],
    }).has("co-unproven") === false,
  );
  check(
    "CO approved before original invoice may be inferred billed",
    billedChangeOrderIds({
      invoices: [
        {
          id: "inv-orig",
          status: "SENT",
          kind: INVOICE_KIND_ORIGINAL,
          createdAt: invoicedJan5,
          total: 200,
        },
      ],
      changeOrders: [
        {
          id: "co-early-approval",
          status: "APPROVED",
          total: 80,
          invoiceId: null,
          createdAt: createdJan1,
          approvedAt: approvedJan3,
        },
      ],
    }).has("co-early-approval") === true,
  );
  check(
    "portal prefers the oldest SENT invoice",
    selectPortalInvoice([
      { id: "paid", status: "PAID", createdAt: now },
      { id: "sent", status: "SENT", createdAt: later },
    ])?.id === "sent",
  );
  check("MEMBER still has no MANAGE_INVOICES", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_INVOICES));
  check("MEMBER still has no VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
  try {
    requireBusinessCapability(makeAccess("biz", "MEMBER"), CAPABILITIES.MANAGE_INVOICES);
    check("MEMBER capability gate rejects invoice management", false);
  } catch (error) {
    check("MEMBER capability gate rejects invoice management", error instanceof ForbiddenError);
  }

  const businessA = await prisma.business.create({
    data: { name: "Alpha Revenue", slug: `alpha-rev-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Revenue", slug: `beta-rev-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Jordan Rivera", email: "jordan@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      addressLine1: "10 Other Ave",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });
  const propertyB = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      addressLine1: "99 Beta Way",
    },
  });

  console.log("\nTEST — Existing complete-job invoice flow still creates one ORIGINAL invoice");
  const work = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 275,
    estimateLines: [
      { description: "Closet Shelf / Rod Repair", quantity: 2, unitPrice: 100, total: 200 },
      { description: "Curtain Rod Installation", quantity: 1, unitPrice: 75, total: 75 },
    ],
  });
  const earlyCo = await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Keypad change order",
    status: "APPROVED",
    total: 100,
    description: "Keypad / Electronic Deadbolt Replacement",
  });
  const completed = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
  });
  check("complete succeeds", completed.ok === true);
  check("invoice is SENT", completed.ok && completed.invoiceStatus === "SENT");
  const original = await prisma.invoice.findUniqueOrThrow({
    where: { id: completed.invoiceId },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("created invoice is ORIGINAL", original.kind === INVOICE_KIND_ORIGINAL);
  check("original total is $375", original.total.toString() === "375");
  check("exactly one invoice after complete", (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 1);
  const earlyCoAfter = await prisma.changeOrder.findUniqueOrThrow({ where: { id: earlyCo.id } });
  check("approved CO at complete time is attached to the original invoice", earlyCoAfter.invoiceId === original.id);

  const retry = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
  });
  check("retry reuses the original invoice", retry.ok && retry.invoiceId === original.id && retry.invoiceReused === true);
  check(
    "retry still has exactly one invoice",
    (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 1,
  );

  console.log("\nTEST — Late approved CO produces a supplemental invoice without rewriting the original");
  const originalSnapshot = {
    total: original.total.toString(),
    status: original.status,
    lineCount: original.lineItems.length,
    firstDescription: original.lineItems[0].description,
  };
  const lateCo = await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Later extra work",
    status: "APPROVED",
    total: 80,
    description: "Later extra work",
  });
  const originalAfterLateCo = await prisma.invoice.findUniqueOrThrow({
    where: { id: original.id },
    include: { lineItems: true },
  });
  check("approving a late CO does not change the original total", originalAfterLateCo.total.toString() === originalSnapshot.total);
  check("approving a late CO does not change the original status", originalAfterLateCo.status === originalSnapshot.status);
  check("approving a late CO does not add lines to the original", originalAfterLateCo.lineItems.length === originalSnapshot.lineCount);

  const supplemental = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
  });
  check("late CO persist creates a new invoice", supplemental.ok && supplemental.reused === false);
  check("new invoice is SUPPLEMENTAL", supplemental.ok && supplemental.kind === INVOICE_KIND_SUPPLEMENTAL);
  check("supplemental total is only the late CO amount", supplemental.ok && supplemental.total.toString() === "80");
  check("two invoices now exist for the job", (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 2);

  const originalAfterSupplemental = await prisma.invoice.findUniqueOrThrow({
    where: { id: original.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("original total remains $375", originalAfterSupplemental.total.toString() === "375");
  check("original status remains SENT", originalAfterSupplemental.status === "SENT");
  check("original first line is unchanged", originalAfterSupplemental.lineItems[0].description === originalSnapshot.firstDescription);
  check(
    "original still has no later extra work line",
    originalAfterSupplemental.lineItems.every((line) => line.description !== "Later extra work"),
  );

  const balance = await prisma.invoice.findUniqueOrThrow({
    where: { id: supplemental.invoiceId },
    include: { lineItems: true },
  });
  check("supplemental belongs to the same business", balance.businessId === businessA.id);
  check("supplemental belongs to the same customer/job", balance.customerId === customerA.id && balance.jobId === work.job.id);
  check("supplemental includes only the late CO line", balance.lineItems.length === 1 && balance.lineItems[0].description === "Later extra work");
  const lateCoAfter = await prisma.changeOrder.findUniqueOrThrow({ where: { id: lateCo.id } });
  check("late CO is attached to the supplemental invoice", lateCoAfter.invoiceId === balance.id);

  console.log("\nTEST — Same CO cannot be billed twice (idempotent)");
  const again = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
  });
  check("second persist reuses rather than creating another supplemental", again.ok && again.reused === true);
  check("second persist does not create a third invoice", (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 2);
  check("late CO still points at the same supplemental", (await prisma.changeOrder.findUniqueOrThrow({ where: { id: lateCo.id } })).invoiceId === balance.id);
  check("supplemental total was not doubled", (await prisma.invoice.findUniqueOrThrow({ where: { id: balance.id } })).total.toString() === "80");

  await prisma.invoice.update({
    where: { id: balance.id },
    data: { status: "SENT" },
  });

  console.log("\nTEST — Foreign-business job/CO/invoice IDs are rejected");
  const foreignPersist = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessB.id,
    jobId: work.job.id,
  });
  check("foreign business cannot persist an invoice for this job", foreignPersist.ok === false);
  const foreignComplete = await completeJobAndSendInvoice(prisma, {
    businessId: businessB.id,
    jobId: work.job.id,
    businessName: businessB.name,
  });
  check("foreign business cannot complete/send this job", foreignComplete.ok === false);
  check(
    "foreign attempts did not add another invoice",
    (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 2,
  );
  const foreignDoc = await loadInvoiceDocumentForBusiness(original.id, businessB.id, prisma);
  check("foreign business cannot load the invoice document", foreignDoc === null);
  const stillOriginal = await prisma.invoice.findUniqueOrThrow({ where: { id: original.id } });
  check("isolated load left the original invoice alone", stillOriginal.total.toString() === "375" && stillOriginal.status === "SENT");

  console.log("\nTEST — Payments attach to the correct invoice/job");
  await recordSucceededPayment(prisma, {
    businessId: businessA.id,
    customerId: customerA.id,
    estimateId: work.estimate.id,
    jobId: work.job.id,
    invoiceId: original.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: new Prisma.Decimal(375),
    method: "CASH",
    note: "original-pay",
  });
  await recordSucceededPayment(prisma, {
    businessId: businessA.id,
    customerId: customerA.id,
    jobId: work.job.id,
    invoiceId: balance.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: new Prisma.Decimal(80),
    method: "CHECK",
    note: "balance-pay",
  });
  const allPayments = await listProjectPayments(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    invoiceId: original.id,
  });
  const originalPayments = paymentsBelongingToInvoice(
    { id: original.id, jobId: work.job.id, kind: original.kind },
    allPayments,
  );
  const balancePayments = paymentsBelongingToInvoice(
    { id: balance.id, jobId: work.job.id, kind: balance.kind },
    allPayments,
  );
  check("original invoice receives only its $375 payment", originalPayments.length === 1 && originalPayments[0].amount.toString() === "375");
  check("supplemental invoice receives only its $80 payment", balancePayments.length === 1 && balancePayments[0].amount.toString() === "80");
  check(
    "original amount due is zero after its payment",
    invoicePaymentBreakdown({ status: original.status, total: original.total, payments: originalPayments }).amountDue.toString() === "0",
  );
  check(
    "supplemental amount due is zero after its payment",
    invoicePaymentBreakdown({ status: "SENT", total: balance.total, payments: balancePayments }).amountDue.toString() === "0",
  );
  const foreignPaymentRejected = await recordSucceededPayment(prisma, {
    businessId: businessB.id,
    customerId: customerB.id,
    jobId: work.job.id,
    invoiceId: original.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: new Prisma.Decimal(1),
    method: "CASH",
  }).then(
    () => false,
    () => true,
  );
  check("foreign-business payment against this invoice/job is rejected", foreignPaymentRejected);

  console.log("\nTEST — Invoice document still passes for original and portal prefers SENT balance after original is paid");
  const doc = await loadInvoiceDocumentForBusiness(original.id, businessA.id, prisma);
  check("original document loads", doc?.invoiceId === original.id);
  check("original document total is $375.00", doc?.totalLabel === "$375.00");
  check("original document is customer-visible", isCustomerVisibleInvoiceStatus(doc?.status ?? "") === true);
  const pdf = await renderInvoicePdf(doc);
  const pdfText = pdfExtractText(pdf);
  check("original PDF still contains closet work", pdfText.includes("Closet Shelf / Rod Repair"));
  check("original PDF does not invent later extra work", !pdfText.includes("Later extra work"));

  await prisma.invoice.update({
    where: { id: original.id },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "CASH" },
  });
  const portalDoc = await loadInvoiceDocumentForProjectToken(work.job.projectToken, prisma);
  check("portal shows the SENT supplemental after the original is paid", portalDoc?.invoiceId === balance.id);
  check("portal supplemental document lists later extra work", portalDoc?.lineItems.some((line) => line.description === "Later extra work") === true);

  console.log("\nTEST — Completed-but-unbilled owner attention");
  const fieldJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 150,
    estimateLines: [{ description: "Field only work", quantity: 1, unitPrice: 150, total: 150 }],
  });
  const fieldLifecycle = evaluateCompleteJob(fieldJob.job.status);
  check("field complete is allowed from IN_PROGRESS", fieldLifecycle.ok === true && fieldLifecycle.nextStatus === "COMPLETED");
  await prisma.job.update({
    where: { id: fieldJob.job.id },
    data: { status: "COMPLETED" },
  });
  check(
    "field complete did not create an invoice",
    (await prisma.invoice.count({ where: { jobId: fieldJob.job.id } })) === 0,
  );

  const billedJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 50,
    estimateLines: [{ description: "Fully billed work", quantity: 1, unitPrice: 50, total: 50 }],
    status: "COMPLETED",
  });
  const billedInvoice = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: billedJob.job.id,
  });
  await prisma.invoice.update({
    where: { id: billedInvoice.invoiceId },
    data: { status: "SENT" },
  });

  const range = resolveReportRange("all");
  const report = buildReport(
    {
      businessId: businessA.id,
      invoices: (await prisma.invoice.findMany({ where: { businessId: businessA.id } })).map((invoice) => ({
        ...invoice,
        total: Number(invoice.total.toString()),
      })),
      customers: [{ id: customerA.id, name: customerA.name, createdAt: customerA.createdAt }],
      jobs: (await prisma.job.findMany({ where: { businessId: businessA.id } })).map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        customerId: job.customerId,
        estimateId: job.estimateId,
      })),
      estimates: (await prisma.estimate.findMany({ where: { businessId: businessA.id } })).map((estimate) => ({
        id: estimate.id,
        status: estimate.status,
        total: Number(estimate.total.toString()),
        createdAt: estimate.createdAt,
        customerId: estimate.customerId,
        serviceRequestId: estimate.serviceRequestId,
      })),
      changeOrders: (await prisma.changeOrder.findMany({ where: { businessId: businessA.id } })).map((changeOrder) => ({
        id: changeOrder.id,
        jobId: changeOrder.jobId,
        status: changeOrder.status,
        total: Number(changeOrder.total.toString()),
        invoiceId: changeOrder.invoiceId,
        approvedAt: changeOrder.approvedAt,
        createdAt: changeOrder.createdAt,
      })),
      serviceRequests: [],
      catalogItems: [],
      estimateLineItems: [],
      approvedTimeEntries: [],
      payrollRuns: [],
      memberships: [],
      expenses: [],
    },
    range,
  );
  const unbilledKeys = report.attention.filter((item) => item.key.startsWith("job-unbilled:")).map((item) => item.key);
  check(
    "completed job with no billed work is surfaced",
    unbilledKeys.includes(`job-unbilled:${fieldJob.job.id}`),
  );
  check(
    "fully billed completed job is not surfaced",
    !unbilledKeys.includes(`job-unbilled:${billedJob.job.id}`),
  );
  check(
    "supplementally billed original job is not surfaced after the balance invoice exists",
    !unbilledKeys.includes(`job-unbilled:${work.job.id}`),
  );

  const listed = listCompletedUnbilledJobs({
    jobs: [
      { id: fieldJob.job.id, status: "COMPLETED", estimateId: fieldJob.estimate.id },
      { id: billedJob.job.id, status: "COMPLETED", estimateId: billedJob.estimate.id },
      { id: work.job.id, status: "COMPLETED", estimateId: work.estimate.id },
    ],
    invoices: (await prisma.invoice.findMany({ where: { businessId: businessA.id } })).map((invoice) => ({
      id: invoice.id,
      status: invoice.status,
      kind: invoice.kind,
      createdAt: invoice.createdAt,
      total: invoice.total,
      jobId: invoice.jobId,
    })),
    changeOrders: (await prisma.changeOrder.findMany({ where: { businessId: businessA.id } })).map((changeOrder) => ({
      id: changeOrder.id,
      jobId: changeOrder.jobId,
      status: changeOrder.status,
      total: changeOrder.total,
      invoiceId: changeOrder.invoiceId,
      approvedAt: changeOrder.approvedAt,
      createdAt: changeOrder.createdAt,
    })),
    estimates: [
      { id: fieldJob.estimate.id, total: 150 },
      { id: billedJob.estimate.id, total: 50 },
      { id: work.estimate.id, total: 275 },
    ],
  });
  check("lister includes the field-completed unbilled job", listed.some((row) => row.job.id === fieldJob.job.id));
  check("lister omits the fully billed job", listed.every((row) => row.job.id !== billedJob.job.id));
  check("lister omits the supplementally billed job", listed.every((row) => row.job.id !== work.job.id));

  const tenantB = listCompletedUnbilledJobs({
    jobs: [{ id: fieldJob.job.id, status: "COMPLETED", estimateId: fieldJob.estimate.id }],
    invoices: [],
    changeOrders: [],
    estimates: [{ id: fieldJob.estimate.id, total: 150 }],
  });
  check("attention helper itself is tenant-agnostic data in / data out", tenantB.length === 1);

  const businessBJob = await createInProgressApprovedJob({
    businessId: businessB.id,
    customerId: customerB.id,
    propertyId: propertyB.id,
    customerName: customerB.name,
    estimateTotal: 40,
    estimateLines: [{ description: "Beta work", quantity: 1, unitPrice: 40, total: 40 }],
    status: "COMPLETED",
  });
  const reportB = buildReport(
    {
      businessId: businessB.id,
      invoices: [],
      customers: [{ id: customerB.id, name: customerB.name, createdAt: new Date() }],
      jobs: [{ id: businessBJob.job.id, status: "COMPLETED", createdAt: new Date(), customerId: customerB.id, estimateId: businessBJob.estimate.id }],
      estimates: [{ id: businessBJob.estimate.id, status: "APPROVED", total: 40, createdAt: new Date(), customerId: customerB.id, serviceRequestId: null }],
      changeOrders: [],
      serviceRequests: [],
      catalogItems: [],
      estimateLineItems: [],
      approvedTimeEntries: [],
      payrollRuns: [],
      memberships: [],
      expenses: [],
    },
    range,
  );
  check(
    "tenant B report does not include tenant A's unbilled job",
    reportB.attention.every((item) => item.key !== `job-unbilled:${fieldJob.job.id}`),
  );
  check(
    "tenant B report includes its own unbilled completed job",
    reportB.attention.some((item) => item.key === `job-unbilled:${businessBJob.job.id}`),
  );

  console.log("\nTEST — Late-approved CO created before the original invoice stays billable");
  const timingJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 200,
    estimateLines: [{ description: "Timing original work", quantity: 1, unitPrice: 200, total: 200 }],
    status: "COMPLETED",
  });
  const originalJan5 = new Date("2026-01-05T12:00:00.000Z");
  const timingOriginal = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: timingJob.job.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "SENT",
      total: new Prisma.Decimal(200),
      createdAt: originalJan5,
    },
  });
  const lateApprovalCo = await addChangeOrder({
    businessId: businessA.id,
    jobId: timingJob.job.id,
    title: "Created early, approved late",
    status: "APPROVED",
    total: 90,
    description: "Created early, approved late",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    approvedAt: new Date("2026-01-10T12:00:00.000Z"),
  });
  const earlyApprovalCo = await addChangeOrder({
    businessId: businessA.id,
    jobId: timingJob.job.id,
    title: "Approved before original",
    status: "APPROVED",
    total: 40,
    description: "Approved before original",
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    approvedAt: new Date("2026-01-03T12:00:00.000Z"),
  });

  const migrationSql = readFileSync(
    new URL("../prisma/migrations/20260926100000_revenue_integrity_supplemental_invoices/migration.sql", import.meta.url),
    "utf8",
  );
  const statements = migrationStatements(migrationSql);
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }

  const lateAfterMigrate = await prisma.changeOrder.findUniqueOrThrow({ where: { id: lateApprovalCo.id } });
  const earlyAfterMigrate = await prisma.changeOrder.findUniqueOrThrow({ where: { id: earlyApprovalCo.id } });
  check("migration leaves late-approved CO unbilled", lateAfterMigrate.invoiceId === null);
  check("migration attaches CO approved before the original invoice", earlyAfterMigrate.invoiceId === timingOriginal.id);
  check(
    "runtime still treats late-approved CO as unbilled attention",
    completedJobBillingAttention({
      jobStatus: "COMPLETED",
      originalApprovedTotal: 200,
      invoices: [timingOriginal],
      changeOrders: [lateAfterMigrate, earlyAfterMigrate],
    }).unbilled === true,
  );

  const latePersist = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: timingJob.job.id,
  });
  check("late-approved CO produces a supplemental invoice", latePersist.ok && latePersist.reused === false);
  check("late-approved supplemental total is only that CO", latePersist.ok && latePersist.total.toString() === "90");
  const lateAfterBill = await prisma.changeOrder.findUniqueOrThrow({ where: { id: lateApprovalCo.id } });
  check("late-approved CO is billed exactly once on the supplemental", lateAfterBill.invoiceId === latePersist.invoiceId);
  const earlyStillOriginal = await prisma.changeOrder.findUniqueOrThrow({ where: { id: earlyApprovalCo.id } });
  check("early-approved CO stays on the original and is not duplicated", earlyStillOriginal.invoiceId === timingOriginal.id);
  const lateAgain = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: timingJob.job.id,
  });
  check("same late-approved CO cannot be billed twice", lateAgain.ok && lateAgain.reused === true);
  check(
    "timing job still has one ORIGINAL and one SUPPLEMENTAL",
    (await prisma.invoice.count({ where: { jobId: timingJob.job.id, kind: INVOICE_KIND_ORIGINAL } })) === 1 &&
      (await prisma.invoice.count({ where: { jobId: timingJob.job.id, kind: INVOICE_KIND_SUPPLEMENTAL } })) === 1,
  );
  const unchangedOriginal = await prisma.invoice.findUniqueOrThrow({ where: { id: timingOriginal.id } });
  check("original invoice total stayed $200 after late CO billing", unchangedOriginal.total.toString() === "200");

  console.log("\nTEST — Multi-invoice payment attribution");
  const payJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 300,
    estimateLines: [{ description: "Payment job work", quantity: 1, unitPrice: 300, total: 300 }],
    status: "COMPLETED",
  });
  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: payJob.job.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "SENT",
      total: new Prisma.Decimal(300),
      createdAt: new Date("2026-03-01T12:00:00.000Z"),
    },
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: payJob.job.id,
    title: "Balance after original",
    status: "APPROVED",
    total: 60,
    description: "Balance after original",
    createdAt: new Date("2026-03-02T12:00:00.000Z"),
    approvedAt: new Date("2026-03-02T12:00:00.000Z"),
  });
  const invoiceBPersist = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: payJob.job.id,
  });
  check("payment job created a supplemental invoice", invoiceBPersist.ok && invoiceBPersist.kind === INVOICE_KIND_SUPPLEMENTAL);
  const invoiceB = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceBPersist.invoiceId } });
  await prisma.invoice.update({ where: { id: invoiceB.id }, data: { status: "SENT" } });

  const legacyPayment = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      estimateId: payJob.estimate.id,
      jobId: payJob.job.id,
      invoiceId: null,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal(50),
      method: "CASH",
      note: "legacy-unallocated",
    },
  });
  const payRows = await listProjectPayments(prisma, {
    businessId: businessA.id,
    jobId: payJob.job.id,
    invoiceId: invoiceA.id,
  });
  const beforeA = paymentsBelongingToInvoice({ id: invoiceA.id, jobId: payJob.job.id, kind: invoiceA.kind }, payRows);
  const beforeB = paymentsBelongingToInvoice({ id: invoiceB.id, jobId: payJob.job.id, kind: invoiceB.kind }, payRows);
  check("legacy job-only payment is counted on ORIGINAL A only", beforeA.some((row) => row.id === legacyPayment.id));
  check("legacy job-only payment is never counted on SUPPLEMENTAL B", beforeB.every((row) => row.id !== legacyPayment.id));
  check(
    "B remains fully due while the legacy payment is unallocated",
    invoicePaymentBreakdown({ status: "SENT", total: invoiceB.total, payments: beforeB }).amountDue.toString() === "60",
  );

  const attached = await attachEstimatePaymentsToInvoice(prisma, {
    businessId: businessA.id,
    estimateId: payJob.estimate.id,
    jobId: payJob.job.id,
    invoiceId: invoiceA.id,
  });
  check("legacy carry-forward assigns the payment to ORIGINAL A", attached === 1);
  const afterAttach = await prisma.payment.findUniqueOrThrow({ where: { id: legacyPayment.id } });
  check("legacy payment invoiceId is ORIGINAL A", afterAttach.invoiceId === invoiceA.id);
  const refused = await attachEstimatePaymentsToInvoice(prisma, {
    businessId: businessA.id,
    estimateId: payJob.estimate.id,
    jobId: payJob.job.id,
    invoiceId: invoiceB.id,
  });
  check("carry-forward refuses to attach legacy payments to a supplemental invoice", refused === 0);

  const payA = await recordSucceededPayment(prisma, {
    businessId: businessA.id,
    customerId: customerA.id,
    jobId: payJob.job.id,
    invoiceId: invoiceA.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: new Prisma.Decimal(250),
    method: "CHECK",
    note: "direct-A",
  });
  const payB = await recordSucceededPayment(prisma, {
    businessId: businessA.id,
    customerId: customerA.id,
    jobId: payJob.job.id,
    invoiceId: invoiceB.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: new Prisma.Decimal(15),
    method: "ZELLE_BANK_TRANSFER",
    note: "direct-B",
  });
  const grouped = await listPaymentsGroupedByInvoiceId(prisma, businessA.id, [
    { id: invoiceA.id, jobId: payJob.job.id, kind: invoiceA.kind },
    { id: invoiceB.id, jobId: payJob.job.id, kind: invoiceB.kind },
  ]);
  const groupedA = grouped.get(invoiceA.id) ?? [];
  const groupedB = grouped.get(invoiceB.id) ?? [];
  check(
    "direct invoiceId=A payment stays isolated on A",
    groupedA.some((row) => row.id === payA.id) && groupedB.every((row) => row.id !== payA.id),
  );
  check(
    "direct invoiceId=B payment stays isolated on B",
    groupedB.some((row) => row.id === payB.id) && groupedA.every((row) => row.id !== payB.id),
  );
  check("A document payments include the $50 legacy + $250 direct", groupedA.reduce((sum, row) => sum + Number(row.amount), 0) === 300);
  check("B document payments include only B's $15", groupedB.reduce((sum, row) => sum + Number(row.amount), 0) === 15);

  const remainingB = await listPaymentsForInvoice(prisma, {
    businessId: businessA.id,
    invoice: { id: invoiceB.id, jobId: payJob.job.id, kind: invoiceB.kind },
  });
  const dueB = invoicePaymentBreakdown({
    status: "SENT",
    total: invoiceB.total,
    payments: remainingB,
  });
  check("marking B paid would record only B's remaining $45", dueB.amountDue.toString() === "45");
  await recordSucceededPayment(prisma, {
    businessId: businessA.id,
    customerId: customerA.id,
    jobId: payJob.job.id,
    invoiceId: invoiceB.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: dueB.amountDue,
    method: "CASH",
    note: "mark-B-remaining",
  });
  const docA = await loadInvoiceDocumentForBusiness(invoiceA.id, businessA.id, prisma);
  const docB = await loadInvoiceDocumentForBusiness(invoiceB.id, businessA.id, prisma);
  check("invoice A document total stays $300.00", docA?.totalLabel === "$300.00");
  check("invoice B document total stays $60.00", docB?.totalLabel === "$60.00");
  check("invoice A document amount due is $0.00", docA?.amountDueLabel === "$0.00");
  check("invoice B document amount due is $0.00 after its own remaining payment", docB?.amountDueLabel === "$0.00");
  check("invoice A document does not list the supplemental work", docA?.lineItems.every((line) => line.description !== "Balance after original") === true);

  console.log("\nTEST — Legacy duplicate-invoice migration normalization");
  const dupJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 120,
    estimateLines: [{ description: "Legacy duplicate job", quantity: 1, unitPrice: 120, total: 120 }],
    status: "COMPLETED",
  });
  const singleJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 70,
    estimateLines: [{ description: "One invoice job", quantity: 1, unitPrice: 70, total: 70 }],
    status: "COMPLETED",
  });
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "Invoice_jobId_original_unique"`);
  const legacyA = await prisma.invoice.create({
    data: {
      id: "legacy_inv_a_older",
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: dupJob.job.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "PAID",
      total: new Prisma.Decimal(120),
      paidAt: new Date("2026-02-01T12:00:00.000Z"),
      paymentMethod: "CASH",
      paymentReference: "legacy-a",
      createdAt: new Date("2026-02-01T10:00:00.000Z"),
    },
  });
  const legacyB = await prisma.invoice.create({
    data: {
      id: "legacy_inv_b_newer",
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: dupJob.job.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "SENT",
      total: new Prisma.Decimal(35),
      createdAt: new Date("2026-02-02T10:00:00.000Z"),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      invoiceId: legacyA.id,
      description: "Legacy original line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(120),
      total: new Prisma.Decimal(120),
      type: "LABOR",
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      invoiceId: legacyB.id,
      description: "Legacy later line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(35),
      total: new Prisma.Decimal(35),
      type: "LABOR",
    },
  });
  const legacyDupPayment = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: dupJob.job.id,
      invoiceId: legacyA.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal(120),
      method: "CASH",
      note: "belongs-to-A",
    },
  });
  const singleInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: singleJob.job.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "SENT",
      total: new Prisma.Decimal(70),
    },
  });

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }

  const afterA = await prisma.invoice.findUniqueOrThrow({
    where: { id: legacyA.id },
    include: { lineItems: true },
  });
  const afterB = await prisma.invoice.findUniqueOrThrow({
    where: { id: legacyB.id },
    include: { lineItems: true },
  });
  const afterSingle = await prisma.invoice.findUniqueOrThrow({ where: { id: singleInvoice.id } });
  check("oldest legacy invoice is ORIGINAL after migration", afterA.kind === INVOICE_KIND_ORIGINAL);
  check("newer legacy invoice is SUPPLEMENTAL after migration", afterB.kind === INVOICE_KIND_SUPPLEMENTAL);
  check("legacy ORIGINAL total/status/paidAt unchanged", afterA.total.toString() === "120" && afterA.status === "PAID" && afterA.paidAt instanceof Date);
  check("legacy SUPPLEMENTAL total/status unchanged", afterB.total.toString() === "35" && afterB.status === "SENT");
  check("legacy ORIGINAL line items unchanged", afterA.lineItems.length === 1 && afterA.lineItems[0].description === "Legacy original line");
  check("legacy SUPPLEMENTAL line items unchanged", afterB.lineItems.length === 1 && afterB.lineItems[0].description === "Legacy later line");
  check(
    "legacy payment relationship unchanged",
    (await prisma.payment.findUniqueOrThrow({ where: { id: legacyDupPayment.id } })).invoiceId === legacyA.id,
  );
  check("one-invoice job stays ORIGINAL", afterSingle.kind === INVOICE_KIND_ORIGINAL);
  let uniqueSucceeded = false;
  try {
    await prisma.invoice.create({
      data: {
        businessId: businessA.id,
        customerId: customerA.id,
        jobId: dupJob.job.id,
        kind: INVOICE_KIND_ORIGINAL,
        total: new Prisma.Decimal(1),
      },
    });
  } catch {
    uniqueSucceeded = true;
  }
  check("partial unique index rejects a second ORIGINAL for the same job", uniqueSucceeded);

  console.log("\nTEST — Concurrent first ORIGINAL persist reuses the winner");
  const originalIndexName = "Invoice_jobId_original_unique";
  const paymentUniqueError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.19.3",
    meta: { modelName: "Payment", target: ["stripeCheckoutSessionId"] },
  });
  const invoiceIdUniqueError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.19.3",
    meta: { modelName: "Invoice", target: ["id"] },
  });
  const originalUniqueError = new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${originalIndexName}\``,
    {
      code: "P2002",
      clientVersion: "6.19.3",
      meta: { modelName: "Invoice", target: originalIndexName },
    },
  );
  check(
    "Payment unique violations are not treated as an ORIGINAL race",
    isOriginalInvoiceUniqueViolation(paymentUniqueError) === false,
  );
  check(
    "unrelated Invoice unique violations are not treated as an ORIGINAL race",
    isOriginalInvoiceUniqueViolation(invoiceIdUniqueError) === false,
  );
  check(
    "the ORIGINAL unique index is recognized as the first-invoice race",
    isOriginalInvoiceUniqueViolation(originalUniqueError) === true,
  );
  check("non-Prisma errors are not swallowed as an ORIGINAL race", isOriginalInvoiceUniqueViolation(new Error("boom")) === false);

  const originalRaceJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 210,
    estimateLines: [
      { description: "Door hardware", quantity: 1, unitPrice: 120, total: 120 },
      { description: "Weatherstrip", quantity: 1, unitPrice: 90, total: 90 },
    ],
    status: "COMPLETED",
  });
  const originalRaceCo = await addChangeOrder({
    businessId: businessA.id,
    jobId: originalRaceJob.job.id,
    title: "Threshold",
    status: "APPROVED",
    total: 45,
    description: "Threshold",
  });
  const originalRaceDeposit = await recordSucceededPayment(prisma, {
    businessId: businessA.id,
    customerId: customerA.id,
    estimateId: originalRaceJob.estimate.id,
    jobId: originalRaceJob.job.id,
    purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
    amount: new Prisma.Decimal(50),
    method: "STRIPE",
    note: "estimate-deposit",
  });

  let originalArrived = 0;
  /** @type {Array<() => void>} */
  const originalRelease = [];
  persistDraftInvoiceTestHooks.beforeCreateOriginal = () =>
    new Promise((resolve) => {
      originalArrived += 1;
      originalRelease.push(resolve);
      if (originalArrived >= 2) {
        for (const done of originalRelease) done();
      }
    });
  const originalRaceClientA = new PrismaClient({ datasourceUrl: testUrl });
  const originalRaceClientB = new PrismaClient({ datasourceUrl: testUrl });
  /** @type {Array<Awaited<ReturnType<typeof persistDraftInvoiceFromCompletedJob>>>} */
  let originalRaceResults;
  try {
    originalRaceResults = await Promise.all([
      persistDraftInvoiceFromCompletedJob(originalRaceClientA, {
        businessId: businessA.id,
        jobId: originalRaceJob.job.id,
      }),
      persistDraftInvoiceFromCompletedJob(originalRaceClientB, {
        businessId: businessA.id,
        jobId: originalRaceJob.job.id,
      }),
    ]);
  } finally {
    persistDraftInvoiceTestHooks.beforeCreateOriginal = undefined;
    await originalRaceClientA.$disconnect();
    await originalRaceClientB.$disconnect();
  }

  const originalSuccessful = originalRaceResults.filter((result) => result.ok);
  const originalIds = [...new Set(originalSuccessful.map((result) => result.invoiceId))];
  const originalCreated = originalSuccessful.filter((result) => result.reused === false);
  const originalReused = originalSuccessful.filter((result) => result.reused === true);
  const originalRaceInvoices = await prisma.invoice.findMany({
    where: { jobId: originalRaceJob.job.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const originalRaceOriginals = originalRaceInvoices.filter((invoice) => invoice.kind === INVOICE_KIND_ORIGINAL);
  const originalRaceSupplementals = originalRaceInvoices.filter(
    (invoice) => invoice.kind === INVOICE_KIND_SUPPLEMENTAL,
  );
  const originalWinner = originalRaceOriginals[0];
  const originalRaceLines = originalWinner
    ? await prisma.lineItem.findMany({
        where: { invoiceId: originalWinner.id, businessId: businessA.id },
      })
    : [];
  const originalRacePayments = await prisma.payment.findMany({
    where: { jobId: originalRaceJob.job.id, businessId: businessA.id },
  });
  const originalRaceCoAfter = await prisma.changeOrder.findUniqueOrThrow({
    where: { id: originalRaceCo.id },
  });
  check("both first-invoice callers overlapped at create", originalArrived === 2);
  check("both concurrent first-invoice callers succeeded", originalSuccessful.length === 2);
  check("both first-invoice callers returned the same invoice id", originalIds.length === 1);
  check("exactly one caller created the ORIGINAL", originalCreated.length === 1);
  check("the losing caller reused the winning ORIGINAL", originalReused.length === 1);
  check("exactly one invoice row exists after the first-invoice race", originalRaceInvoices.length === 1);
  check("exactly one ORIGINAL invoice remains", originalRaceOriginals.length === 1);
  check("no supplemental invoice was created by the first-invoice race", originalRaceSupplementals.length === 0);
  check("no orphan draft remains", originalRaceInvoices.every((invoice) => invoice.id === originalIds[0]));
  check(
    "winning ORIGINAL total is the approved estimate plus the approved CO",
    originalWinner?.total.toString() === "255",
  );
  check(
    "exact expected line count on the ORIGINAL",
    originalRaceLines.length === 3 &&
      originalRaceLines.some((line) => line.description === "Door hardware") &&
      originalRaceLines.some((line) => line.description === "Weatherstrip") &&
      originalRaceLines.some((line) => line.description === "Threshold"),
  );
  check("no duplicate line items were written", originalRaceLines.length === 3);
  check(
    "exactly one estimate-deposit Payment remains and is attached once",
    originalRacePayments.length === 1 &&
      originalRacePayments[0].id === originalRaceDeposit.id &&
      originalRacePayments[0].purpose === PAYMENT_PURPOSE_MATERIAL_DEPOSIT &&
      originalRacePayments[0].invoiceId === originalWinner?.id &&
      originalRacePayments[0].amount.toString() === "50",
  );
  check(
    "approved CO at first-invoice time stayed on the ORIGINAL",
    originalRaceCoAfter.invoiceId === originalWinner?.id,
  );
  const originalRaceRetry = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: originalRaceJob.job.id,
  });
  check(
    "subsequent third retry reuses the same ORIGINAL",
    originalRaceRetry.ok &&
      originalRaceRetry.reused === true &&
      originalRaceRetry.invoiceId === originalIds[0],
  );
  check(
    "third retry still has one ORIGINAL and no supplemental",
    (await prisma.invoice.count({ where: { jobId: originalRaceJob.job.id } })) === 1 &&
      (await prisma.invoice.count({
        where: { jobId: originalRaceJob.job.id, kind: INVOICE_KIND_SUPPLEMENTAL },
      })) === 0,
  );
  const originalSent = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessA.id,
    invoiceId: originalIds[0],
    businessName: businessA.name,
  });
  const originalSentAgain = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessA.id,
    invoiceId: originalIds[0],
    businessName: businessA.name,
  });
  check("first send after the race moves the shared ORIGINAL to SENT", originalSent.ok && originalSent.newlySent === true);
  check("retry send does not send the shared ORIGINAL again", originalSentAgain.ok && originalSentAgain.newlySent === false);
  const foreignOriginalPersist = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessB.id,
    jobId: originalRaceJob.job.id,
  });
  const missingOriginalPersist = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: randomUUID(),
  });
  check(
    "foreign tenant cannot persist an ORIGINAL for this job",
    foreignOriginalPersist.ok === false &&
      foreignOriginalPersist.error === "That job could not be found.",
  );
  check(
    "unknown job IDs remain blocked",
    missingOriginalPersist.ok === false &&
      missingOriginalPersist.error === "That job could not be found.",
  );
  check(
    "foreign/unknown IDs did not add an invoice",
    (await prisma.invoice.count({ where: { jobId: originalRaceJob.job.id } })) === 1,
  );

  console.log("\nTEST — Concurrent supplemental persist returns the winning invoice, not ORIGINAL");
  const raceJob = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 220,
    estimateLines: [{ description: "Race original work", quantity: 1, unitPrice: 220, total: 220 }],
    status: "COMPLETED",
  });
  const raceOriginal = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: raceJob.job.id,
  });
  check("race job created an ORIGINAL invoice", raceOriginal.ok && raceOriginal.kind === INVOICE_KIND_ORIGINAL);
  await prisma.invoice.update({
    where: { id: raceOriginal.invoiceId },
    data: { status: "SENT", createdAt: new Date("2026-04-01T12:00:00.000Z") },
  });
  const raceCo = await addChangeOrder({
    businessId: businessA.id,
    jobId: raceJob.job.id,
    title: "Race balance work",
    status: "APPROVED",
    total: 55,
    description: "Race balance work",
    createdAt: new Date("2026-04-02T12:00:00.000Z"),
    approvedAt: new Date("2026-04-02T12:00:00.000Z"),
  });

  let arrived = 0;
  /** @type {Array<() => void>} */
  const release = [];
  persistDraftInvoiceTestHooks.afterCreateSupplemental = () =>
    new Promise((resolve) => {
      arrived += 1;
      release.push(resolve);
      if (arrived >= 2) {
        for (const done of release) done();
      }
    });
  const raceClientA = new PrismaClient({ datasourceUrl: testUrl });
  const raceClientB = new PrismaClient({ datasourceUrl: testUrl });
  let raceResults;
  try {
    raceResults = await Promise.all([
      persistDraftInvoiceFromCompletedJob(raceClientA, {
        businessId: businessA.id,
        jobId: raceJob.job.id,
      }),
      persistDraftInvoiceFromCompletedJob(raceClientB, {
        businessId: businessA.id,
        jobId: raceJob.job.id,
      }),
    ]);
  } finally {
    persistDraftInvoiceTestHooks.afterCreateSupplemental = undefined;
    await raceClientA.$disconnect();
    await raceClientB.$disconnect();
  }

  const successful = raceResults.filter((result) => result.ok);
  const invoiceIds = [...new Set(successful.map((result) => result.invoiceId))];
  const raceInvoices = await prisma.invoice.findMany({
    where: { jobId: raceJob.job.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const raceSupplementals = raceInvoices.filter((invoice) => invoice.kind === INVOICE_KIND_SUPPLEMENTAL);
  const raceCoAfter = await prisma.changeOrder.findUniqueOrThrow({ where: { id: raceCo.id } });
  const winnerId = raceCoAfter.invoiceId;
  check("both concurrent callers succeeded", successful.length === 2);
  check("both callers resolved to the same invoice id", invoiceIds.length === 1);
  check("the shared invoice is the winning supplemental, not ORIGINAL", invoiceIds[0] === winnerId && winnerId !== raceOriginal.invoiceId);
  check(
    "neither losing call returned the ORIGINAL invoice",
    successful.every((result) => result.invoiceId !== raceOriginal.invoiceId),
  );
  check("exactly one supplemental invoice remains", raceSupplementals.length === 1);
  check("exactly one invoice owns the CO", raceCoAfter.invoiceId === raceSupplementals[0]?.id);
  check(
    "no orphan or zero-value supplemental remains",
    raceSupplementals.every((invoice) => invoice.total.toString() === "55") &&
      (await prisma.invoice.count({
        where: { jobId: raceJob.job.id, kind: INVOICE_KIND_SUPPLEMENTAL, total: new Prisma.Decimal(0) },
      })) === 0,
  );
  const originalAfterRace = await prisma.invoice.findUniqueOrThrow({ where: { id: raceOriginal.invoiceId } });
  check("original invoice is unchanged", originalAfterRace.total.toString() === "220" && originalAfterRace.kind === INVOICE_KIND_ORIGINAL);
  check("supplemental total is the late CO amount", raceSupplementals[0]?.total.toString() === "55");
  const raceRetry = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: raceJob.job.id,
  });
  check("subsequent retry reuses the winning supplemental", raceRetry.ok && raceRetry.reused === true && raceRetry.invoiceId === winnerId);

  console.log(
    failures === 0
      ? "\nAll revenue-integrity checks passed."
      : `\n${failures} revenue-integrity check(s) failed.`,
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

process.exit(failures === 0 ? 0 : 1);
