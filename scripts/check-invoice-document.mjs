/**
 * Focused verification for professional invoice carry-forward + PDF
 * (src/lib/invoice-carry-forward.ts, src/lib/invoice-document.ts,
 * src/lib/invoice-pdf.ts, src/app/actions/invoice.ts).
 *
 * Imports the real persist / document / PDF helpers. Server actions that
 * depend on next/headers are not invoked.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-invoice-document.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  buildInvoiceLineSnapshots,
  LABOR_MINIMUM_INVOICE_DESCRIPTION,
  backfillEmptyInvoiceWorkLines,
  persistDraftInvoiceFromCompletedJob,
  selectApprovedChangeOrdersForInvoiceBackfill,
} = await import("@/lib/invoice-carry-forward");
const {
  INVOICE_DOCUMENT_LOGO_HEIGHT_PX,
  invoiceNumberFromId,
  invoicePdfFilename,
  isCustomerVisibleInvoiceStatus,
  loadInvoiceDocumentForBusiness,
  loadInvoiceDocumentForProjectToken,
  sanitizeFilenamePart,
} = await import("@/lib/invoice-document");
const { renderInvoicePdf } = await import("@/lib/invoice-pdf");
const { getBusinessDocumentLogoSrc, getBusinessLogoSrc } = await import(
  "@/lib/business-branding"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_invoice_document_test";
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
  console.error("Failed to push schema for invoice-document test database.");
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

async function createApprovedCompletedJob(input) {
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: input.businessId,
      name: input.lineDescription,
      pricingMode: "FIXED",
      price: new Prisma.Decimal(input.unitPrice),
      category: "Plumbing",
    },
  });

  const estimate = await prisma.estimate.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "APPROVED",
      total: new Prisma.Decimal(input.versionTotal),
      laborMinimumAdjustment: new Prisma.Decimal(input.laborMinimum),
      publicToken: randomUUID(),
    },
  });

  await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      serviceCatalogItemId: catalog.id,
      description: input.lineDescription,
      quantity: new Prisma.Decimal(input.quantity),
      unitPrice: new Prisma.Decimal(input.unitPrice),
      total: new Prisma.Decimal(input.lineTotal),
      type: "LABOR",
    },
  });

  const version = await prisma.estimateVersion.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(input.versionTotal),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(input.laborMinimum),
      customerName: input.customerName,
      approvedAt: new Date(),
      lineItems: {
        create: [
          {
            businessId: input.businessId,
            description: input.lineDescription,
            quantity: new Prisma.Decimal(input.quantity),
            unitPrice: new Prisma.Decimal(input.unitPrice),
            total: new Prisma.Decimal(input.lineTotal),
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

  const job = await prisma.job.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  return { catalog, estimate, version, job };
}

try {
  console.log("\nPURE — invoice number / filename / carry-forward helpers");
  check(
    "invoice number uses last 8 of id",
    invoiceNumberFromId("clxyzinvoiceABCDEFGH") === "INV-ABCDEFGH",
  );
  check(
    "filename sanitizes slashes and spaces",
    invoicePdfFilename("INV-ABC/DEF", "Jane Doe / LLC") ===
      "Invoice-INV-ABC-DEF-Jane-Doe-LLC.pdf",
  );
  check("empty filename part falls back", sanitizeFilenamePart("///") === "invoice");
  check("DRAFT is not customer-visible", isCustomerVisibleInvoiceStatus("DRAFT") === false);
  check("SENT is customer-visible", isCustomerVisibleInvoiceStatus("SENT") === true);
  check("PAID is customer-visible", isCustomerVisibleInvoiceStatus("PAID") === true);
  check(
    "dashboard/website logo stays the dark-background CollPro asset",
    getBusinessLogoSrc("collpro-reno") === "/brand/collpro-logo.png",
  );
  check(
    "invoice/document logo is the transparent CollPro variant",
    getBusinessDocumentLogoSrc("collpro-reno") === "/brand/collpro-logo-document.png",
  );
  check(
    "transparent document logo file exists",
    existsSync(new URL("../public/brand/collpro-logo-document.png", import.meta.url)),
  );

  const built = buildInvoiceLineSnapshots({
    approvedLineItems: [
      {
        description: "Faucet",
        quantity: 2,
        unitPrice: 100,
        total: 200,
        type: "LABOR",
      },
    ],
    laborMinimumAdjustment: 25,
    approvedChangeOrderLineItems: [
      {
        description: "Grout",
        quantity: 1,
        unitPrice: 75,
        total: 75,
        type: "LABOR",
      },
    ],
  });
  check("carry-forward includes approved line + labor min + CO", built.length === 3);
  check(
    "labor min uses the stored snapshot description",
    built[1].description === LABOR_MINIMUM_INVOICE_DESCRIPTION &&
      built[1].total.toString() === "25",
  );
  check("change-order line is copied last", built[2].description === "Grout");

  const closetLine = {
    description: "Closet Shelf / Rod Repair",
    quantity: 2,
    unitPrice: 100,
    total: 200,
    type: "LABOR",
  };
  const curtainLine = {
    description: "Curtain Rod Installation",
    quantity: 1,
    unitPrice: 75,
    total: 75,
    type: "LABOR",
  };
  const keypadCo = {
    id: "co-keypad",
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    lineItems: [
      {
        description: "Keypad / Electronic Deadbolt Replacement",
        quantity: 1,
        unitPrice: 100,
        total: 100,
        type: "LABOR",
      },
    ],
  };
  const laterCo = {
    id: "co-later",
    createdAt: new Date("2026-09-04T12:00:00.000Z"),
    lineItems: [
      {
        description: "Should not appear",
        quantity: 1,
        unitPrice: 50,
        total: 50,
        type: "LABOR",
      },
    ],
  };
  const invoiceCreatedAt = new Date("2026-09-02T12:00:00.000Z");
  const matchedCos = selectApprovedChangeOrdersForInvoiceBackfill({
    approvedLineItems: [closetLine, curtainLine],
    laborMinimumAdjustment: 0,
    approvedChangeOrders: [laterCo, keypadCo],
    invoiceCreatedAt,
    invoiceTotal: 375,
  });
  check(
    "backfill selector keeps the approved CO that existed at invoice create",
    matchedCos?.length === 1 && matchedCos[0].id === "co-keypad",
  );
  check(
    "backfill selector omits a later approved CO that would break the invoice total",
    matchedCos?.every((changeOrder) => changeOrder.id !== "co-later") === true,
  );
  const estimateOnly = selectApprovedChangeOrdersForInvoiceBackfill({
    approvedLineItems: [closetLine, curtainLine],
    laborMinimumAdjustment: 0,
    approvedChangeOrders: [keypadCo, laterCo],
    invoiceCreatedAt,
    invoiceTotal: 275,
  });
  check(
    "backfill selector uses estimate-only when that is the stored invoice total",
    estimateOnly?.length === 0,
  );
  check(
    "backfill selector returns null when no approved subset matches the invoice total",
    selectApprovedChangeOrdersForInvoiceBackfill({
      approvedLineItems: [closetLine, curtainLine],
      laborMinimumAdjustment: 0,
      approvedChangeOrders: [keypadCo],
      invoiceCreatedAt,
      invoiceTotal: 999,
    }) === null,
  );

  const otherBusiness = await prisma.business.create({
    data: {
      name: "Other Subscriber Co",
      slug: "other-subscriber-co",
      tradeCode: "HANDYMAN",
    },
  });
  const collproBusiness = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });

  const otherCustomer = await prisma.customer.create({
    data: {
      businessId: otherBusiness.id,
      name: "Jordan Rivera",
      email: "jordan@example.com",
      phone: "555-0100",
    },
  });
  const otherProperty = await prisma.property.create({
    data: {
      businessId: otherBusiness.id,
      customerId: otherCustomer.id,
      addressLine1: "10 Other Ave",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const collproCustomer = await prisma.customer.create({
    data: {
      businessId: collproBusiness.id,
      name: "CollPro Customer",
      email: "collpro-customer@example.com",
    },
  });
  const collproProperty = await prisma.property.create({
    data: {
      businessId: collproBusiness.id,
      customerId: collproCustomer.id,
      addressLine1: "99 CollPro Way",
    },
  });

  const otherWork = await createApprovedCompletedJob({
    businessId: otherBusiness.id,
    customerId: otherCustomer.id,
    propertyId: otherProperty.id,
    customerName: otherCustomer.name,
    lineDescription: "Bathroom faucet repair",
    quantity: 2,
    unitPrice: 100,
    lineTotal: 200,
    laborMinimum: 25,
    versionTotal: 225,
  });

  const declinedCo = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: otherWork.job.id,
      title: "Never approved",
      status: "DECLINED",
      total: new Prisma.Decimal(9999),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: declinedCo.id,
      description: "Should never bill",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(9999),
      total: new Prisma.Decimal(9999),
      type: "LABOR",
    },
  });

  const approvedCo = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: otherWork.job.id,
      title: "Additional grout work",
      status: "APPROVED",
      total: new Prisma.Decimal(75),
      approvedAt: new Date(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: approvedCo.id,
      description: "Grout repair",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(75),
      total: new Prisma.Decimal(75),
      type: "LABOR",
    },
  });

  console.log("\nTEST 1 — Completed job creates one DRAFT invoice with carried lines");
  const created = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: otherBusiness.id,
    jobId: otherWork.job.id,
  });
  check("create succeeds", created.ok === true && created.reused === false);
  check("invoice total is approved work + approved CO ($300)", created.ok && created.total.toString() === "300");

  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: created.invoiceId },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("invoice starts DRAFT", invoice.status === "DRAFT");
  check("exactly three snapshot lines were copied", invoice.lineItems.length === 3);
  check(
    "approved estimate qty/price copied",
    invoice.lineItems[0].description === "Bathroom faucet repair" &&
      invoice.lineItems[0].quantity.toString() === "2" &&
      invoice.lineItems[0].unitPrice.toString() === "100" &&
      invoice.lineItems[0].total.toString() === "200",
  );
  check(
    "labor minimum carried forward",
    invoice.lineItems[1].description === LABOR_MINIMUM_INVOICE_DESCRIPTION &&
      invoice.lineItems[1].total.toString() === "25",
  );
  check(
    "approved change-order line carried forward",
    invoice.lineItems[2].description === "Grout repair" &&
      invoice.lineItems[2].total.toString() === "75",
  );
  check(
    "declined change-order line was not copied",
    invoice.lineItems.every((line) => line.description !== "Should never bill"),
  );
  check(
    "copied lines are new rows (estimate/CO originals remain)",
    invoice.lineItems.every((line) => !line.estimateId && !line.changeOrderId && line.invoiceId === invoice.id),
  );

  console.log("\nTEST 2 — Repeated create does not duplicate the invoice");
  const again = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: otherBusiness.id,
    jobId: otherWork.job.id,
  });
  check("second call reuses the same invoice", again.ok === true && again.reused === true && again.invoiceId === invoice.id);
  const invoiceCount = await prisma.invoice.count({ where: { jobId: otherWork.job.id } });
  check("still exactly one invoice for the job", invoiceCount === 1);
  const lineCount = await prisma.lineItem.count({ where: { invoiceId: invoice.id } });
  check("line items were not copied a second time", lineCount === 3);

  console.log("\nTEST 3 — Sent invoice commercial content stays frozen if catalog changes");
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: "SENT" },
  });
  await prisma.serviceCatalogItem.update({
    where: { id: otherWork.catalog.id },
    data: { price: new Prisma.Decimal(9999), name: "NEW CATALOG NAME" },
  });
  await prisma.estimate.update({
    where: { id: otherWork.estimate.id },
    data: { total: new Prisma.Decimal(9999) },
  });
  const frozen = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoice.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("invoice total unchanged after catalog/estimate edit", frozen.total.toString() === "300");
  check(
    "invoice line still has the approved snapshot, not the new catalog price",
    frozen.lineItems[0].unitPrice.toString() === "100" &&
      frozen.lineItems[0].description === "Bathroom faucet repair",
  );

  console.log("\nTEST 4 — Preview document + PDF use stored invoice data");
  const document = await loadInvoiceDocumentForBusiness(
    invoice.id,
    otherBusiness.id,
    prisma,
  );
  check("owner document loads", Boolean(document));
  check("document uses this tenant's business name", document?.business.name === "Other Subscriber Co");
  check("other tenant does not receive CollPro logo", document?.business.logoSrc == null);
  check("other tenant does not receive CollPro phone", document?.business.phone == null);
  check("customer name carried onto the document", document?.customer.name === "Jordan Rivera");
  check("customer contact carried onto the document", document?.customer.email === "jordan@example.com");
  check("service address carried onto the document", document?.serviceAddress?.includes("10 Other Ave") === true);
  check("document total is $300.00", document?.totalLabel === "$300.00");
  check("SENT amount due is still the total", document?.amountDueLabel === "$300.00");
  check("job reference is present", Boolean(document?.jobReference));

  const pdf = await renderInvoicePdf(document);
  const pdfText = pdfExtractText(pdf);
  check("PDF starts with %PDF", pdf.subarray(0, 4).toString() === "%PDF");
  check("PDF contains this tenant's business name", pdfText.includes("Other Subscriber Co"));
  check("PDF contains the customer name", pdfText.includes("Jordan Rivera"));
  check("PDF contains the approved faucet line", pdfText.includes("Bathroom faucet repair"));
  check("PDF contains the change-order line", pdfText.includes("Grout repair"));
  check("PDF contains the invoice total", pdfText.includes("$300.00"));
  check("PDF does not contain CollPro phone", !pdfText.includes("239-357-8199"));
  check("PDF does not contain CollPro display branding", !pdfText.includes("CollPro Reno"));
  check(
    "PDF filename is sanitized Invoice-<number>-<customer>.pdf",
    document.pdfFilename ===
      `Invoice-${document.invoiceNumber}-Jordan-Rivera.pdf`,
  );

  console.log("\nTEST 5 — Mark Paid behavior and receipt reuse");
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: "PAID",
      paidAt: new Date("2026-09-02T15:00:00.000Z"),
      paymentMethod: "CASH",
      paymentReference: "SECRET-OWNER-ONLY-REF",
    },
  });
  const paidDoc = await loadInvoiceDocumentForBusiness(
    invoice.id,
    otherBusiness.id,
    prisma,
  );
  check("paid document status is Paid", paidDoc?.statusLabel === "Paid");
  check("paid amount due is $0.00", paidDoc?.amountDueLabel === "$0.00");
  check("paid amount shows as payment", paidDoc?.amountPaidLabel === "$300.00");
  check("paid date appears when paidAt exists", Boolean(paidDoc?.paidAtLabel));
  const paidPdf = await renderInvoicePdf(paidDoc);
  const paidPdfText = pdfExtractText(paidPdf);
  check("paid PDF does not leak owner payment reference", !paidPdfText.includes("SECRET-OWNER-ONLY-REF"));
  check("paid PDF does not leak payment method enum", !paidPdfText.includes("CASH"));

  console.log("\nTEST 6 — Customer portal scope");
  const draftJob = await createApprovedCompletedJob({
    businessId: otherBusiness.id,
    customerId: otherCustomer.id,
    propertyId: otherProperty.id,
    customerName: otherCustomer.name,
    lineDescription: "Draft only work",
    quantity: 1,
    unitPrice: 50,
    lineTotal: 50,
    laborMinimum: 0,
    versionTotal: 50,
  });
  const draftInvoice = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: otherBusiness.id,
    jobId: draftJob.job.id,
  });
  const draftPortal = await loadInvoiceDocumentForProjectToken(
    draftJob.job.projectToken,
    prisma,
  );
  check("portal hides DRAFT invoices", draftPortal === null);

  const otherToken = otherWork.job.projectToken;
  const portalDoc = await loadInvoiceDocumentForProjectToken(otherToken, prisma);
  check("portal shows SENT/PAID invoice for the matching token", portalDoc?.invoiceId === invoice.id);
  check("portal document has no owner payment reference", !JSON.stringify(portalDoc).includes("SECRET-OWNER-ONLY-REF"));

  const foreignTokenDoc = await loadInvoiceDocumentForProjectToken(randomUUID(), prisma);
  check("unknown portal token returns no invoice", foreignTokenDoc === null);

  const wrongBusiness = await loadInvoiceDocumentForBusiness(
    invoice.id,
    collproBusiness.id,
    prisma,
  );
  check("other businessId cannot load this invoice", wrongBusiness === null);

  console.log("\nTEST 7 — CollPro tenant uses its own branding; other tenant does not");
  const collproWork = await createApprovedCompletedJob({
    businessId: collproBusiness.id,
    customerId: collproCustomer.id,
    propertyId: collproProperty.id,
    customerName: collproCustomer.name,
    lineDescription: "CollPro faucet",
    quantity: 1,
    unitPrice: 40,
    lineTotal: 40,
    laborMinimum: 0,
    versionTotal: 40,
  });
  const collproCreated = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: collproBusiness.id,
    jobId: collproWork.job.id,
  });
  const collproDoc = await loadInvoiceDocumentForBusiness(
    collproCreated.invoiceId,
    collproBusiness.id,
    prisma,
  );
  check("CollPro document uses CollPro business name from the DB", collproDoc?.business.name === "CollPro Reno Handyman Services");
  check(
    "CollPro invoice document uses the transparent document logo, not the dark UI logo",
    collproDoc?.business.logoSrc === "/brand/collpro-logo-document.png",
  );
  check("CollPro document uses the configured CollPro phone", collproDoc?.business.phone === "239-357-8199");
  const otherDocAgain = await loadInvoiceDocumentForBusiness(
    invoice.id,
    otherBusiness.id,
    prisma,
  );
  check(
    "other tenant document still has no CollPro logo/phone after CollPro invoice exists",
    otherDocAgain?.business.logoSrc == null && otherDocAgain?.business.phone == null,
  );

  console.log("\nTEST 8 — Empty paid invoice backfills approved work only");
  const founderWork = await createApprovedCompletedJob({
    businessId: otherBusiness.id,
    customerId: otherCustomer.id,
    propertyId: otherProperty.id,
    customerName: otherCustomer.name,
    lineDescription: "Closet Shelf / Rod Repair",
    quantity: 2,
    unitPrice: 100,
    lineTotal: 200,
    laborMinimum: 0,
    versionTotal: 275,
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      estimateId: founderWork.estimate.id,
      description: "Curtain Rod Installation",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(75),
      total: new Prisma.Decimal(75),
      type: "LABOR",
    },
  });
  await prisma.estimateVersionLineItem.create({
    data: {
      businessId: otherBusiness.id,
      estimateVersionId: founderWork.version.id,
      description: "Curtain Rod Installation",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(75),
      total: new Prisma.Decimal(75),
      type: "LABOR",
    },
  });
  await prisma.estimate.update({
    where: { id: founderWork.estimate.id },
    data: { total: new Prisma.Decimal(275) },
  });
  await prisma.estimateVersion.update({
    where: { id: founderWork.version.id },
    data: { total: new Prisma.Decimal(275) },
  });

  const draftCo = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: founderWork.job.id,
      title: "Draft never sent",
      status: "DRAFT",
      total: new Prisma.Decimal(40),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: draftCo.id,
      description: "Draft only line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(40),
      total: new Prisma.Decimal(40),
      type: "LABOR",
    },
  });
  const sentCo = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: founderWork.job.id,
      title: "Sent never approved",
      status: "SENT",
      total: new Prisma.Decimal(55),
      sentAt: new Date(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: sentCo.id,
      description: "Sent only line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(55),
      total: new Prisma.Decimal(55),
      type: "LABOR",
    },
  });
  const declinedCo2 = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: founderWork.job.id,
      title: "Declined extra",
      status: "DECLINED",
      total: new Prisma.Decimal(60),
      declinedAt: new Date(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: declinedCo2.id,
      description: "Declined only line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(60),
      total: new Prisma.Decimal(60),
      type: "LABOR",
    },
  });
  const cancelledCo = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: founderWork.job.id,
      title: "Cancelled extra",
      status: "CANCELLED",
      total: new Prisma.Decimal(70),
      cancelledAt: new Date(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: cancelledCo.id,
      description: "Cancelled only line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(70),
      total: new Prisma.Decimal(70),
      type: "LABOR",
    },
  });
  const keypadApproved = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: founderWork.job.id,
      title: "Keypad change order",
      status: "APPROVED",
      total: new Prisma.Decimal(100),
      approvedAt: new Date("2026-09-01T15:00:00.000Z"),
      createdAt: new Date("2026-09-01T15:00:00.000Z"),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: keypadApproved.id,
      description: "Keypad / Electronic Deadbolt Replacement",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(100),
      total: new Prisma.Decimal(100),
      type: "LABOR",
    },
  });
  const laterApproved = await prisma.changeOrder.create({
    data: {
      businessId: otherBusiness.id,
      jobId: founderWork.job.id,
      title: "Later approved extra",
      status: "APPROVED",
      total: new Prisma.Decimal(50),
      approvedAt: new Date("2026-09-04T18:00:00.000Z"),
      createdAt: new Date("2026-09-04T18:00:00.000Z"),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      changeOrderId: laterApproved.id,
      description: "Later extra work",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(50),
      total: new Prisma.Decimal(50),
      type: "LABOR",
    },
  });

  const emptyPaid = await prisma.invoice.create({
    data: {
      businessId: otherBusiness.id,
      customerId: otherCustomer.id,
      jobId: founderWork.job.id,
      status: "PAID",
      total: new Prisma.Decimal(375),
      paidAt: new Date("2026-09-03T16:00:00.000Z"),
      paymentMethod: "STRIPE",
      paymentReference: "pi_legacy_empty_375",
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
    },
  });
  const beforeBackfill = await prisma.invoice.findUniqueOrThrow({
    where: { id: emptyPaid.id },
  });
  const foreignBackfill = await backfillEmptyInvoiceWorkLines(prisma, {
    businessId: collproBusiness.id,
    invoiceId: emptyPaid.id,
  });
  check("other tenant cannot backfill this invoice", foreignBackfill.backfilled === false);
  check(
    "cross-tenant backfill created no lines",
    (await prisma.lineItem.count({ where: { invoiceId: emptyPaid.id } })) === 0,
  );

  const founderDoc = await loadInvoiceDocumentForBusiness(
    emptyPaid.id,
    otherBusiness.id,
    prisma,
  );
  const afterBackfill = await prisma.invoice.findUniqueOrThrow({
    where: { id: emptyPaid.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("document loader backfilled the empty paid invoice", afterBackfill.lineItems.length === 3);
  check(
    "backfill copied original approved closet qty 2",
    afterBackfill.lineItems[0].description === "Closet Shelf / Rod Repair" &&
      afterBackfill.lineItems[0].quantity.toString() === "2",
  );
  check(
    "backfill copied original approved curtain qty 1",
    afterBackfill.lineItems[1].description === "Curtain Rod Installation" &&
      afterBackfill.lineItems[1].quantity.toString() === "1",
  );
  check(
    "backfill copied the approved keypad change order",
    afterBackfill.lineItems[2].description ===
      "Keypad / Electronic Deadbolt Replacement" &&
      afterBackfill.lineItems[2].quantity.toString() === "1",
  );
  check(
    "unapproved change-order lines were not backfilled",
    afterBackfill.lineItems.every(
      (line) =>
        !["Draft only line", "Sent only line", "Declined only line", "Cancelled only line", "Later extra work"].includes(
          line.description,
        ),
    ),
  );
  check("historical invoice total stays $375", afterBackfill.total.toString() === "375");
  check(
    "paidAt is unchanged",
    afterBackfill.paidAt?.toISOString() === beforeBackfill.paidAt?.toISOString(),
  );
  check("payment method is unchanged", afterBackfill.paymentMethod === "STRIPE");
  check(
    "payment reference is unchanged",
    afterBackfill.paymentReference === "pi_legacy_empty_375",
  );
  check("invoice status stays PAID", afterBackfill.status === "PAID");
  check("document total remains $375.00", founderDoc?.totalLabel === "$375.00");
  check("document payments remain $375.00", founderDoc?.amountPaidLabel === "$375.00");
  check("document amount due remains $0.00", founderDoc?.amountDueLabel === "$0.00");
  check(
    "document lists the three approved work descriptions",
    founderDoc?.lineItems.map((line) => line.description).join("|") ===
      "Closet Shelf / Rod Repair|Curtain Rod Installation|Keypad / Electronic Deadbolt Replacement",
  );

  const secondBackfill = await backfillEmptyInvoiceWorkLines(prisma, {
    businessId: otherBusiness.id,
    invoiceId: emptyPaid.id,
  });
  check("second backfill is a no-op", secondBackfill.backfilled === false);
  check(
    "second backfill does not duplicate lines",
    (await prisma.lineItem.count({ where: { invoiceId: emptyPaid.id } })) === 3,
  );

  const reuseEmpty = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: otherBusiness.id,
    jobId: founderWork.job.id,
  });
  check("persist reuse does not create a second invoice", reuseEmpty.ok === true && reuseEmpty.reused === true);
  check(
    "persist reuse does not duplicate invoice lines",
    (await prisma.lineItem.count({ where: { invoiceId: emptyPaid.id } })) === 3,
  );
  check(
    "persist reuse does not change the paid total",
    (await prisma.invoice.findUniqueOrThrow({ where: { id: emptyPaid.id } })).total.toString() ===
      "375",
  );

  const founderPdf = await renderInvoicePdf(founderDoc);
  const founderPdfText = pdfExtractText(founderPdf);
  check("PDF heading includes WORK PERFORMED", founderPdfText.includes("WORK PERFORMED"));
  check("PDF contains closet work", founderPdfText.includes("Closet Shelf / Rod Repair"));
  check("PDF contains curtain work", founderPdfText.includes("Curtain Rod Installation"));
  check("PDF contains keypad work", founderPdfText.includes("Keypad / Electronic Deadbolt Replacement"));
  check("PDF still shows the $375.00 total", founderPdfText.includes("$375.00"));
  check("PDF does not invent later extra work", !founderPdfText.includes("Later extra work"));
  check("original approved estimate total is still $275", (await prisma.estimateVersion.findUniqueOrThrow({
    where: { id: founderWork.version.id },
  })).total.toString() === "275");

  console.log("\nTEST 9 — Document logo stays separate from the dark website logo");
  const brandingSrc = readFileSync(new URL("../src/lib/business-branding.ts", import.meta.url), "utf8");
  const invoiceDocSrc = readFileSync(new URL("../src/lib/invoice-document.ts", import.meta.url), "utf8");
  const invoicePdfSrc = readFileSync(new URL("../src/lib/invoice-pdf.ts", import.meta.url), "utf8");
  const invoiceHtmlSrc = readFileSync(
    new URL("../src/components/invoices/invoice-document.tsx", import.meta.url),
    "utf8",
  );
  const appShellSrc = readFileSync(new URL("../src/app/(app)/layout.tsx", import.meta.url), "utf8");
  const publicSiteSrc = readFileSync(new URL("../src/lib/public-site.ts", import.meta.url), "utf8");
  const documentLogoPath = new URL("../public/brand/collpro-logo-document.png", import.meta.url);
  check(
    "document helper is distinct from the dark website/dashboard logo",
    getBusinessLogoSrc("collpro-reno") === "/brand/collpro-logo.png" &&
      getBusinessDocumentLogoSrc("collpro-reno") === "/brand/collpro-logo-document.png",
  );
  check(
    "invoice HTML uses the document logo helper",
    invoiceDocSrc.includes("getBusinessDocumentLogoSrc") &&
      !invoiceDocSrc.includes("getBusinessLogoSrc(") &&
      invoiceHtmlSrc.includes("invoice.business.logoSrc"),
  );
  check("PDF renderer uses the document view logo path", invoicePdfSrc.includes("docView.business.logoSrc"));
  check(
    "invoice HTML and PDF use the same readable document-logo height",
    INVOICE_DOCUMENT_LOGO_HEIGHT_PX === 108 &&
      invoiceHtmlSrc.includes("INVOICE_DOCUMENT_LOGO_HEIGHT_PX") &&
      invoicePdfSrc.includes("INVOICE_DOCUMENT_LOGO_HEIGHT_PX"),
  );
  check(
    "website and dashboard still use the dark logo helper",
    appShellSrc.includes("getBusinessLogoSrc") &&
      publicSiteSrc.includes("getBusinessLogoSrc") &&
      brandingSrc.includes('"/brand/collpro-logo.png"'),
  );
  check("transparent document logo asset exists", existsSync(documentLogoPath));
  const documentLogoBytes = readFileSync(documentLogoPath);
  check(
    "document logo is the approved light PNG, not a later generated substitute",
    documentLogoBytes.length > 1_400_000 &&
      documentLogoBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  const collproPdf = await renderInvoicePdf(collproDoc);
  check("CollPro PDF renders with the document logo present", collproPdf.subarray(0, 4).toString() === "%PDF");

  console.log(
    failures === 0
      ? "\nAll invoice-document checks passed."
      : `\n${failures} invoice-document check(s) failed.`,
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
