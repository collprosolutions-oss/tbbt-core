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

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  persistDraftInvoiceFromCompletedJob,
} = await import("@/lib/invoice-carry-forward");
const { completeJobAndSendInvoice } = await import("@/lib/complete-job-invoice");
const {
  isCustomerVisibleInvoiceStatus,
  loadInvoiceDocumentForBusiness,
  loadInvoiceDocumentForProjectToken,
} = await import("@/lib/invoice-document");
const { renderInvoicePdf } = await import("@/lib/invoice-pdf");
const {
  INVOICE_KIND_ORIGINAL,
  INVOICE_KIND_SUPPLEMENTAL,
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
  invoicePaymentBreakdown,
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
      approvedAt: input.status === "APPROVED" ? new Date() : null,
      sentAt: input.status === "SENT" || input.status === "APPROVED" ? new Date() : null,
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
        },
      ],
    }).unbilled === false,
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
  const originalPayments = paymentsBelongingToInvoice({ id: original.id, jobId: work.job.id }, allPayments);
  const balancePayments = paymentsBelongingToInvoice({ id: balance.id, jobId: work.job.id }, allPayments);
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
