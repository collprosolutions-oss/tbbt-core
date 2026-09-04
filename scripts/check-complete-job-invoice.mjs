/**
 * Complete Job → create/reuse invoice → send (DRAFT → SENT).
 *
 * Imports the real completeJobAndSendInvoice / persist helpers.
 * Server actions that depend on next/headers are not invoked.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-complete-job-invoice.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  completeJobAndSendInvoice,
  invoiceSendShouldNotify,
  sendDraftInvoiceIfNeeded,
} = await import("@/lib/complete-job-invoice");
const {
  isCustomerVisibleInvoiceStatus,
  loadInvoiceDocumentForProjectToken,
} = await import("@/lib/invoice-document");
const { renderInvoicePdf } = await import("@/lib/invoice-pdf");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_complete_job_invoice_test";
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
  console.error("Failed to push schema for complete-job-invoice test database.");
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
  console.log("\nPURE — send notification gate");
  check("DRAFT invoices notify on send", invoiceSendShouldNotify("DRAFT") === true);
  check("SENT invoices do not notify again", invoiceSendShouldNotify("SENT") === false);
  check("PAID invoices do not notify again", invoiceSendShouldNotify("PAID") === false);

  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });
  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Jordan Rivera",
      email: "jordan@example.com",
    },
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

  const work = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 275,
    laborMinimum: 0,
    estimateLines: [
      {
        description: "Closet Shelf / Rod Repair",
        quantity: 2,
        unitPrice: 100,
        total: 200,
      },
      {
        description: "Curtain Rod Installation",
        quantity: 1,
        unitPrice: 75,
        total: 75,
      },
    ],
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Closet Shelf / Rod Repair",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(100),
      active: true,
    },
  });

  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Draft leftover",
    status: "DRAFT",
    total: 0,
    description: "Old $0 draft",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Sent not approved",
    status: "SENT",
    total: 55,
    description: "Sent only line",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Declined extra",
    status: "DECLINED",
    total: 60,
    description: "Declined only line",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Cancelled extra",
    status: "CANCELLED",
    total: 70,
    description: "Cancelled only line",
  });
  await addChangeOrder({
    businessId: businessA.id,
    jobId: work.job.id,
    title: "Keypad change order",
    status: "APPROVED",
    total: 100,
    description: "Keypad / Electronic Deadbolt Replacement",
  });
  await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: work.job.id,
      description: "Unconverted additional work",
      status: "OPEN",
      source: "CUSTOMER",
    },
  });

  console.log("\nTEST A — Completing an approved job creates and sends one invoice");
  const completed = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
  });
  check("complete succeeds", completed.ok === true);
  check("job is marked completed", (await prisma.job.findUniqueOrThrow({ where: { id: work.job.id } })).status === "COMPLETED");
  check("invoice was created", completed.ok && completed.invoiceCreated === true);
  check("invoice is SENT", completed.ok && completed.invoiceStatus === "SENT" && completed.newlySent === true);
  check("portal-visible status", isCustomerVisibleInvoiceStatus(completed.ok ? completed.invoiceStatus : "") === true);

  const invoiceCount = await prisma.invoice.count({ where: { jobId: work.job.id } });
  check("exactly one invoice", invoiceCount === 1);
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: completed.invoiceId },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("invoice total is $375", invoice.total.toString() === "375");
  check("three approved work lines", invoice.lineItems.length === 3);
  check(
    "original approved closet qty 2",
    invoice.lineItems[0].description === "Closet Shelf / Rod Repair" &&
      invoice.lineItems[0].quantity.toString() === "2",
  );
  check(
    "original approved curtain qty 1",
    invoice.lineItems[1].description === "Curtain Rod Installation",
  );
  check(
    "approved change-order keypad is included",
    invoice.lineItems[2].description === "Keypad / Electronic Deadbolt Replacement",
  );
  check(
    "unapproved change orders and raw additional work are excluded",
    invoice.lineItems.every(
      (line) =>
        !["Old $0 draft", "Sent only line", "Declined only line", "Cancelled only line", "Unconverted additional work"].includes(
          line.description,
        ),
    ),
  );

  const portalDoc = await loadInvoiceDocumentForProjectToken(
    work.job.projectToken,
    prisma,
  );
  check("customer portal can load the sent invoice", portalDoc?.invoiceId === invoice.id);
  check("portal document lists the three work descriptions", portalDoc?.lineItems.length === 3);
  const pdf = await renderInvoicePdf(portalDoc);
  const pdfText = pdfExtractText(pdf);
  check("PDF contains closet work", pdfText.includes("Closet Shelf / Rod Repair"));
  check("PDF contains keypad work", pdfText.includes("Keypad / Electronic Deadbolt Replacement"));
  check("PDF contains WORK PERFORMED", pdfText.includes("WORK PERFORMED"));
  check("PDF total is $375.00", pdfText.includes("$375.00"));

  console.log("\nTEST B — Retrying Complete Job is idempotent");
  const retry = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
  });
  check("retry succeeds", retry.ok === true);
  check("retry reuses the same invoice", retry.ok && retry.invoiceId === invoice.id && retry.invoiceReused === true);
  check("retry does not send again", retry.ok && retry.newlySent === false);
  check("retry does not notify again", retry.ok && retry.customerNotified === false);
  check(
    "still exactly one invoice",
    (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 1,
  );
  check(
    "line items were not duplicated",
    (await prisma.lineItem.count({ where: { invoiceId: invoice.id } })) === 3,
  );
  const afterRetry = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("retry did not change invoice total", afterRetry.total.toString() === "375");
  check("retry left status SENT", afterRetry.status === "SENT");
  check("retry created no payment write", afterRetry.paidAt == null && afterRetry.paymentMethod == null);

  console.log("\nTEST C — Approved scope stays frozen after catalog edits");
  const estimateBefore = await prisma.estimateVersion.findUniqueOrThrow({
    where: { id: work.version.id },
  });
  await prisma.serviceCatalogItem.update({
    where: { id: catalog.id },
    data: { price: new Prisma.Decimal(9999), name: "NEW CATALOG NAME" },
  });
  await prisma.estimate.update({
    where: { id: work.estimate.id },
    data: { total: new Prisma.Decimal(9999) },
  });
  const frozen = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("invoice total still $375 after catalog edit", frozen.total.toString() === "375");
  check(
    "invoice line still uses the approved snapshot description/price",
    frozen.lineItems[0].description === "Closet Shelf / Rod Repair" &&
      frozen.lineItems[0].unitPrice.toString() === "100",
  );
  check(
    "original approved estimate version is unchanged",
    (await prisma.estimateVersion.findUniqueOrThrow({ where: { id: work.version.id } })).total.toString() ===
      estimateBefore.total.toString(),
  );

  console.log("\nTEST E — Existing paid invoice is not financially altered");
  const paidAt = new Date("2026-09-03T16:00:00.000Z");
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: "PAID",
      paidAt,
      paymentMethod: "STRIPE",
      paymentReference: "pi_existing_375",
    },
  });
  const paidRetry = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: work.job.id,
    businessName: businessA.name,
  });
  const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("paid retry succeeds without a new invoice", paidRetry.ok === true && paidRetry.invoiceId === invoice.id);
  check("paid retry does not send again", paidRetry.ok && paidRetry.newlySent === false);
  check("paid status is unchanged", paid.status === "PAID");
  check("paid total is unchanged", paid.total.toString() === "375");
  check("paidAt is unchanged", paid.paidAt?.toISOString() === paidAt.toISOString());
  check("payment method is unchanged", paid.paymentMethod === "STRIPE");
  check("payment reference is unchanged", paid.paymentReference === "pi_existing_375");

  console.log("\nTEST F — Tenant isolation");
  const foreign = await completeJobAndSendInvoice(prisma, {
    businessId: businessB.id,
    jobId: work.job.id,
    businessName: businessB.name,
  });
  check("other business cannot complete/send this job", foreign.ok === false);
  check(
    "foreign complete did not add a second invoice",
    (await prisma.invoice.count({ where: { jobId: work.job.id } })) === 1,
  );
  const foreignSend = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessB.id,
    invoiceId: invoice.id,
    businessName: businessB.name,
  });
  check("other business cannot send this invoice", foreignSend.ok === false);
  const stillPaid = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  check("isolated send attempt left payment state alone", stillPaid.status === "PAID" && stillPaid.total.toString() === "375");

  console.log("\nTEST — Unstarted job is not completed or invoiced");
  const unstarted = await createInProgressApprovedJob({
    businessId: businessA.id,
    customerId: customerA.id,
    propertyId: propertyA.id,
    customerName: customerA.name,
    estimateTotal: 50,
    estimateLines: [
      { description: "Unstarted work", quantity: 1, unitPrice: 50, total: 50 },
    ],
    status: "SCHEDULED",
  });
  const blocked = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: unstarted.job.id,
    businessName: businessA.name,
  });
  check("unstarted job is rejected", blocked.ok === false);
  check(
    "unstarted job stays SCHEDULED",
    (await prisma.job.findUniqueOrThrow({ where: { id: unstarted.job.id } })).status === "SCHEDULED",
  );
  check(
    "no invoice was created for the unstarted job",
    (await prisma.invoice.count({ where: { jobId: unstarted.job.id } })) === 0,
  );

  console.log(
    failures === 0
      ? "\nAll complete-job-invoice checks passed."
      : `\n${failures} complete-job-invoice check(s) failed.`,
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
