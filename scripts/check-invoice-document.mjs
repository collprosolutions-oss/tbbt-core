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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  buildInvoiceLineSnapshots,
  LABOR_MINIMUM_INVOICE_DESCRIPTION,
  backfillEmptyInvoiceWorkLines,
  invoiceCustomerPricingTotal,
  persistDraftInvoiceFromCompletedJob,
  selectApprovedChangeOrdersForInvoiceBackfill,
} = await import("@/lib/invoice-carry-forward");
const {
  INVOICE_DOCUMENT_LOGO_HEIGHT_PX,
  INVOICE_LABOR_SECTION_TITLE,
  INVOICE_TOTAL_CUSTOMER_LABEL,
  invoiceDocumentPlainText,
  invoiceNumberFromId,
  invoicePdfFilename,
  isCustomerVisibleInvoiceStatus,
  loadInvoiceDocumentForBusiness,
  loadInvoiceDocumentForProjectToken,
  sanitizeFilenamePart,
} = await import("@/lib/invoice-document");
const { joinLineDescription } = await import("@/lib/estimate-line-scope");
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

/** Founder-approved document logo from 5c6c8ae — not the earlier PR #30 binary. */
const APPROVED_DOCUMENT_LOGO_SHA256 =
  "fb319b2559e49d1226a3af5af5c801a794b4553b68feb286f9b85ff219d4f7b9";

function inspectPng(bytes) {
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(pngSig)) {
    return {
      isPng: false,
      width: 0,
      height: 0,
      bitDepth: 0,
      colorType: -1,
      hasAlphaChannel: false,
      transparentPixels: 0,
      decoded: false,
    };
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let hasTrns = false;
  const idat = [];
  for (let i = 8; i + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString("ascii");
    const dataStart = i + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      break;
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR" && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "tRNS") {
      hasTrns = true;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    i = dataEnd + 4;
  }

  const hasAlphaChannel = colorType === 4 || colorType === 6 || hasTrns;
  let transparentPixels = 0;
  let decoded = false;
  if (colorType === 6 && bitDepth === 8 && width > 0 && height > 0 && idat.length > 0) {
    const inflated = inflateSync(Buffer.concat(idat));
    const bpp = 4;
    const stride = width * bpp;
    const prev = Buffer.alloc(stride);
    const row = Buffer.alloc(stride);
    let offset = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = inflated[offset];
      offset += 1;
      inflated.copy(row, 0, offset, offset + stride);
      offset += stride;
      for (let x = 0; x < stride; x += 1) {
        const left = x >= bpp ? row[x - bpp] : 0;
        const up = prev[x];
        const upLeft = x >= bpp ? prev[x - bpp] : 0;
        if (filter === 1) {
          row[x] = (row[x] + left) & 255;
        } else if (filter === 2) {
          row[x] = (row[x] + up) & 255;
        } else if (filter === 3) {
          row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
        } else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          row[x] = (row[x] + pr) & 255;
        }
      }
      for (let x = 3; x < stride; x += 4) {
        if (row[x] === 0) {
          transparentPixels += 1;
        }
      }
      row.copy(prev);
    }
    decoded = offset === inflated.length;
  }

  return {
    isPng: true,
    width,
    height,
    bitDepth,
    colorType,
    hasAlphaChannel,
    transparentPixels,
    decoded,
  };
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

const FOUNDER_MATERIAL_ROWS = [
  { description: "60-lb concrete bags", quantity: 22, unitPrice: "8", total: "176" },
  { description: "Welded wire mesh sheets", quantity: 1, unitPrice: "45", total: "45" },
  { description: "8-ft form boards", quantity: 3, unitPrice: "12", total: "36" },
  { description: "Form stakes / pins", quantity: 12, unitPrice: "1.5", total: "18" },
  { description: "Anchor bolts / hardware", quantity: 10, unitPrice: "0.5", total: "5" },
  { description: "Material pickup / procurement", quantity: 1, unitPrice: "5.18", total: "5.18" },
  { description: "Poly Plastic", quantity: 1, unitPrice: "2", total: "2" },
  { description: "Vegetable Oil", quantity: 1, unitPrice: "2", total: "2" },
];

const FOUNDER_TAKEOFF = {
  version: 1,
  takeoffType: "concrete-slab",
  inputs: { lengthFt: 10, widthFt: 10 },
  wastePercent: 10,
  markupPercent: 40,
  laborRate: 36,
  laborAdjustment: 0,
  measurementSource: { kind: "manual", label: "owner takeoff", unverified: false },
  explanation: "internal $36/bag production quantity formula",
  skippedMeasurements: [],
  removedItemIds: [],
  items: [
    {
      id: "bags",
      kind: "material",
      label: "60-lb bags",
      unit: "bag",
      optional: false,
      selected: true,
      calculatedQuantity: 22,
      quantityOverride: null,
      unitCost: 6.5,
      customerUnitPrice: 8,
      explanation: "waste included",
      convertedLineItemId: null,
    },
  ],
};

function founderLaborDescription() {
  return joinLineDescription(
    "Concrete slab / approved work",
    "Form, pour, and finish a concrete slab as specified.",
    null,
    null,
    {
      customerMaterialsTotal: { amount: 300, manual: true },
      materialTakeoff: FOUNDER_TAKEOFF,
    },
  );
}

function founderSnapshotLines() {
  return [
    {
      description: founderLaborDescription(),
      quantity: 1,
      unitPrice: 800,
      total: 800,
      type: "LABOR",
    },
    ...FOUNDER_MATERIAL_ROWS.map((row) => ({
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      total: row.total,
      type: "MATERIAL",
    })),
  ];
}

async function createFounderMaterialsCompletedJob(input) {
  const laborDescription = founderLaborDescription();
  const estimate = await prisma.estimate.create({
    data: {
      businessId: input.businessId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      status: "APPROVED",
      total: new Prisma.Decimal("1100"),
      laborMinimumAdjustment: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });

  await prisma.lineItem.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      description: laborDescription,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(800),
      total: new Prisma.Decimal(800),
      type: "LABOR",
    },
  });
  for (const row of FOUNDER_MATERIAL_ROWS) {
    await prisma.lineItem.create({
      data: {
        businessId: input.businessId,
        estimateId: estimate.id,
        description: row.description,
        quantity: new Prisma.Decimal(row.quantity),
        unitPrice: new Prisma.Decimal(row.unitPrice),
        total: new Prisma.Decimal(row.total),
        type: "MATERIAL",
      },
    });
  }

  const version = await prisma.estimateVersion.create({
    data: {
      businessId: input.businessId,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal("1100"),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      customerName: input.customerName,
      approvedAt: new Date(),
      lineItems: {
        create: [
          {
            businessId: input.businessId,
            description: laborDescription,
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal(800),
            total: new Prisma.Decimal(800),
            type: "LABOR",
          },
          ...FOUNDER_MATERIAL_ROWS.map((row) => ({
            businessId: input.businessId,
            description: row.description,
            quantity: new Prisma.Decimal(row.quantity),
            unitPrice: new Prisma.Decimal(row.unitPrice),
            total: new Prisma.Decimal(row.total),
            type: "MATERIAL",
          })),
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

  return { estimate, version, job };
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

  const founderSnapshots = founderSnapshotLines();
  check(
    "raw material selling lines still sum to $289.18",
    founderSnapshots
      .filter((line) => line.type === "MATERIAL")
      .reduce((sum, line) => sum.add(new Prisma.Decimal(line.total)), new Prisma.Decimal(0))
      .toString() === "289.18",
  );
  check(
    "customer pricing total uses the $300 materials override, not $289.18",
    invoiceCustomerPricingTotal(founderSnapshots).toString() === "1100",
  );
  check(
    "backfill selector matches Invoice.total $1,100 when raw lines sum to $1,089.18",
    selectApprovedChangeOrdersForInvoiceBackfill({
      approvedLineItems: founderSnapshots,
      laborMinimumAdjustment: 0,
      approvedChangeOrders: [],
      invoiceCreatedAt,
      invoiceTotal: 1100,
    })?.length === 0,
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

  console.log("\nTEST 7b — Owner-saved contact is live on invoices");
  await prisma.business.update({
    where: { id: collproBusiness.id },
    data: {
      publicPhone: "941-555-0199",
      publicEmail: "office@collproreno.com",
      publicWebsite: "https://www.collproreno.com",
    },
  });
  const collproContactDoc = await loadInvoiceDocumentForBusiness(
    collproCreated.invoiceId,
    collproBusiness.id,
    prisma,
  );
  check(
    "CollPro invoice uses the saved phone/email/website, not only the fallback",
    collproContactDoc?.business.phone === "941-555-0199" &&
      collproContactDoc?.business.email === "office@collproreno.com" &&
      collproContactDoc?.business.website === "https://www.collproreno.com" &&
      collproContactDoc?.totalLabel === collproDoc?.totalLabel,
  );
  const collproContactPdf = await renderInvoicePdf(collproContactDoc);
  const collproContactPdfText = pdfExtractText(collproContactPdf);
  check("CollPro invoice PDF includes the saved phone", collproContactPdfText.includes("941-555-0199"));
  check("CollPro invoice PDF includes the saved website", collproContactPdfText.includes("https://www.collproreno.com"));

  await prisma.business.update({
    where: { id: otherBusiness.id },
    data: { publicPhone: "305-555-0140" },
  });
  const otherContactInvoice = await loadInvoiceDocumentForBusiness(
    invoice.id,
    otherBusiness.id,
    prisma,
  );
  check(
    "other tenant invoice shows its own phone and still omits CollPro branding",
    otherContactInvoice?.business.phone === "305-555-0140" &&
      otherContactInvoice?.business.phone !== "239-357-8199" &&
      otherContactInvoice?.business.name === "Other Subscriber Co",
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
  check(
    "invoice HTML does not copy estimate PROJECT CONDITIONS or TERMS & CONDITIONS sections",
    !invoiceHtmlSrc.includes("PROJECT CONDITIONS") &&
      !invoiceHtmlSrc.includes("TERMS & CONDITIONS") &&
      !invoiceHtmlSrc.includes("EstimateDocumentTerms") &&
      !invoiceDocSrc.includes("projectConditions") &&
      !invoiceDocSrc.includes("TERMS_AND_CONDITIONS"),
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
  const websiteLogoBytes = readFileSync(new URL("../public/brand/collpro-logo.png", import.meta.url));
  const documentPng = inspectPng(documentLogoBytes);
  const websitePng = inspectPng(websiteLogoBytes);
  const documentLogoSha256 = createHash("sha256").update(documentLogoBytes).digest("hex");
  check(
    "document logo PNG has a real alpha channel, not just a document filename",
    documentPng.isPng && documentPng.hasAlphaChannel && documentPng.colorType === 6,
  );
  check(
    "document logo PNG decodes with transparent pixels (no baked-in plate)",
    documentPng.decoded && documentPng.transparentPixels > 0,
  );
  check(
    "document logo binary is not the dark website/dashboard logo",
    documentLogoBytes.length !== websiteLogoBytes.length &&
      !documentLogoBytes.equals(websiteLogoBytes) &&
      websitePng.isPng &&
      websitePng.colorType === 2,
  );
  check(
    "document logo is the founder-approved 5c6c8ae binary",
    documentLogoSha256 === APPROVED_DOCUMENT_LOGO_SHA256 &&
      documentPng.width === 1243 &&
      documentPng.height === 1170,
  );
  const collproPdf = await renderInvoicePdf(collproDoc);
  check("CollPro PDF renders with the document logo present", collproPdf.subarray(0, 4).toString() === "%PDF");
  check(
    "invoice HTML presents Labor / Materials / Invoice Total without a raw Subtotal",
    invoiceHtmlSrc.includes("CustomerEstimateLineSections") &&
      invoiceHtmlSrc.includes("INVOICE_LABOR_SECTION_TITLE") &&
      invoiceHtmlSrc.includes("INVOICE_TOTAL_CUSTOMER_LABEL") &&
      invoiceHtmlSrc.includes("Amount Due") &&
      !invoiceHtmlSrc.includes("Subtotal"),
  );
  check(
    "invoice PDF uses the labor/materials section titles and Invoice Total",
    invoicePdfSrc.includes("INVOICE_LABOR_SECTION_TITLE") &&
      invoicePdfSrc.includes("INVOICE_MATERIALS_SECTION_TITLE") &&
      invoicePdfSrc.includes("INVOICE_TOTAL_CUSTOMER_LABEL") &&
      invoicePdfSrc.includes("Amount Due") &&
      !invoicePdfSrc.includes('row("Subtotal"'),
  );
  check(
    "labor section title still contains WORK PERFORMED for existing PDF tests",
    INVOICE_LABOR_SECTION_TITLE.includes("WORK PERFORMED") &&
      INVOICE_TOTAL_CUSTOMER_LABEL === "Invoice Total",
  );

  console.log("\nTEST 10 — Approved customer materials total survives estimate → job → invoice");
  const founderMaterialsWork = await createFounderMaterialsCompletedJob({
    businessId: otherBusiness.id,
    customerId: otherCustomer.id,
    propertyId: otherProperty.id,
    customerName: otherCustomer.name,
  });
  const founderCreated = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: otherBusiness.id,
    jobId: founderMaterialsWork.job.id,
  });
  check("founder invoice create succeeds", founderCreated.ok === true && founderCreated.reused === false);
  check(
    "invoice total is the approved $1,100, not raw $1,089.18",
    founderCreated.ok && founderCreated.total.toString() === "1100",
  );
  const founderInvoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: founderCreated.invoiceId },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check(
    "copied snapshot still has $800 labor + $289.18 raw material rows",
    founderInvoice.lineItems
      .filter((line) => line.type === "LABOR")
      .reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0))
      .toString() === "800" &&
      founderInvoice.lineItems
        .filter((line) => line.type === "MATERIAL")
        .reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0))
        .toString() === "289.18" &&
      founderInvoice.lineItems.length === 9,
  );

  const founderMaterialsDoc = await loadInvoiceDocumentForBusiness(
    founderInvoice.id,
    otherBusiness.id,
    prisma,
  );
  const founderPlain = founderMaterialsDoc
    ? invoiceDocumentPlainText(founderMaterialsDoc)
    : "";
  check("founder document loads", Boolean(founderMaterialsDoc));
  check("labor total is $800.00", founderMaterialsDoc?.laborTotalLabel === "$800.00");
  check(
    "materials total is the approved $300.00, not $289.18",
    founderMaterialsDoc?.materialTotalLabel === "$300.00",
  );
  check("invoice total is $1,100.00", founderMaterialsDoc?.totalLabel === "$1,100.00");
  check("payments start at $0.00", founderMaterialsDoc?.amountPaidLabel === "$0.00");
  check("amount due is $1,100.00", founderMaterialsDoc?.amountDueLabel === "$1,100.00");
  check(
    "customer document does not show the raw $1,089.18 subtotal",
    !founderPlain.includes("$1,089.18") &&
      !JSON.stringify(founderMaterialsDoc).includes("1,089.18") &&
      !JSON.stringify(founderMaterialsDoc).includes("1089.18"),
  );
  check(
    "customer document does not show the raw $289.18 material sum",
    !founderPlain.includes("$289.18") &&
      !JSON.stringify(founderMaterialsDoc).includes("289.18"),
  );
  check(
    "labor section keeps the customer title and Scope / Included Work",
    founderMaterialsDoc?.laborLines.length === 1 &&
      founderMaterialsDoc?.laborLines[0]?.description === "Concrete slab / approved work" &&
      founderMaterialsDoc?.laborLines[0]?.includedWork?.includes(
        "Form, pour, and finish a concrete slab as specified.",
      ) === true &&
      founderMaterialsDoc?.laborLines[0]?.amountLabel === "$800.00",
  );
  check(
    "materials keep Description + Qty only, with no unit or extended prices",
    founderMaterialsDoc?.materialLines.length === 8 &&
      founderMaterialsDoc?.materialLines.every(
        (line) =>
          line.showLinePricing === false &&
          line.unitPriceLabel === "" &&
          line.amountLabel === "" &&
          Boolean(line.quantityLabel) &&
          Boolean(line.description),
      ) === true &&
      founderMaterialsDoc?.materialLines.map((line) => line.description).join("|") ===
        FOUNDER_MATERIAL_ROWS.map((row) => row.description).join("|") &&
      founderMaterialsDoc?.materialLines.map((line) => line.quantityLabel).join("|") ===
        FOUNDER_MATERIAL_ROWS.map((row) => String(row.quantity)).join("|"),
  );
  check(
    "owner-only takeoff / cost / markup / $36 bag internals stay off the customer invoice",
    !founderPlain.includes("TBBT") &&
      !founderPlain.includes("customerUnitPrice") &&
      !founderPlain.includes("unitCost") &&
      !founderPlain.includes("wastePercent") &&
      !founderPlain.includes("markupPercent") &&
      !founderPlain.includes("$36") &&
      !founderPlain.includes("production quantity") &&
      !JSON.stringify(founderMaterialsDoc).includes("TBBT Material") &&
      !JSON.stringify(founderMaterialsDoc).includes("$36/bag"),
  );

  const founderMaterialsPdf = await renderInvoicePdf(founderMaterialsDoc);
  const founderMaterialsPdfText = pdfExtractText(founderMaterialsPdf);
  check("PDF heading includes WORK PERFORMED", founderMaterialsPdfText.includes("WORK PERFORMED"));
  check("PDF includes MATERIALS", founderMaterialsPdfText.includes("MATERIALS"));
  check("PDF includes Invoice Total", founderMaterialsPdfText.includes("Invoice Total"));
  check("PDF labor amount is $800.00", founderMaterialsPdfText.includes("$800.00"));
  check("PDF materials total is $300.00", founderMaterialsPdfText.includes("$300.00"));
  check("PDF invoice total is $1,100.00", founderMaterialsPdfText.includes("$1,100.00"));
  check("PDF does not show $1,089.18", !founderMaterialsPdfText.includes("$1,089.18"));
  check("PDF does not show $289.18", !founderMaterialsPdfText.includes("$289.18"));
  check(
    "PDF does not show individual material unit or extended prices",
    !founderMaterialsPdfText.includes("$176.00") &&
      !founderMaterialsPdfText.includes("$45.00") &&
      !founderMaterialsPdfText.includes("$8.00") &&
      !founderMaterialsPdfText.includes("$5.18"),
  );
  check("PDF still lists material descriptions", founderMaterialsPdfText.includes("60-lb concrete bags"));
  check("PDF still lists material quantities", founderMaterialsPdfText.includes("22"));
  check("PDF keeps Scope / Included Work", founderMaterialsPdfText.includes("Scope / Included Work"));
  check(
    "PDF does not copy estimate Project Conditions or Terms & Conditions",
    !founderMaterialsPdfText.includes("PROJECT CONDITIONS") &&
      !founderMaterialsPdfText.includes("TERMS & CONDITIONS"),
  );
  check(
    "HTML/PDF/plain text agree on approved customer pricing",
    founderPlain.includes("$800.00") &&
      founderPlain.includes("$300.00") &&
      founderPlain.includes("$1,100.00") &&
      founderMaterialsPdfText.includes("$800.00") &&
      founderMaterialsPdfText.includes("$300.00") &&
      founderMaterialsPdfText.includes("$1,100.00"),
  );

  await prisma.invoice.update({
    where: { id: founderInvoice.id },
    data: { status: "PAID", paidAt: new Date("2026-09-07T18:00:00.000Z") },
  });
  const paidFounderDoc = await loadInvoiceDocumentForBusiness(
    founderInvoice.id,
    otherBusiness.id,
    prisma,
  );
  check("paid invoice keeps the $1,100.00 total", paidFounderDoc?.totalLabel === "$1,100.00");
  check("payments reduce Amount Due to $0.00", paidFounderDoc?.amountDueLabel === "$0.00");
  check("paid payments equal the invoice total", paidFounderDoc?.amountPaidLabel === "$1,100.00");

  await prisma.lineItem.updateMany({
    where: { estimateId: founderMaterialsWork.estimate.id, type: "MATERIAL" },
    data: { unitPrice: new Prisma.Decimal(99), total: new Prisma.Decimal(999) },
  });
  await prisma.estimate.update({
    where: { id: founderMaterialsWork.estimate.id },
    data: { total: new Prisma.Decimal(9999) },
  });
  await prisma.estimateVersion.update({
    where: { id: founderMaterialsWork.version.id },
    data: { total: new Prisma.Decimal(9999) },
  });
  const frozenFounder = await loadInvoiceDocumentForBusiness(
    founderInvoice.id,
    otherBusiness.id,
    prisma,
  );
  check(
    "later estimate/catalog/material edits do not change historical invoice pricing",
    frozenFounder?.laborTotalLabel === "$800.00" &&
      frozenFounder?.materialTotalLabel === "$300.00" &&
      frozenFounder?.totalLabel === "$1,100.00",
  );
  const frozenInvoiceRow = await prisma.invoice.findUniqueOrThrow({
    where: { id: founderInvoice.id },
    include: { lineItems: true },
  });
  check(
    "invoice snapshot rows stay at the approved $289.18 raw material sum",
    frozenInvoiceRow.total.toString() === "1100" &&
      frozenInvoiceRow.lineItems
        .filter((line) => line.type === "MATERIAL")
        .reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0))
        .toString() === "289.18",
  );

  const foreignFounderDoc = await loadInvoiceDocumentForBusiness(
    founderInvoice.id,
    collproBusiness.id,
    prisma,
  );
  check("other tenant cannot load the founder materials invoice", foreignFounderDoc === null);

  const emptyMaterialsJob = await createFounderMaterialsCompletedJob({
    businessId: otherBusiness.id,
    customerId: otherCustomer.id,
    propertyId: otherProperty.id,
    customerName: otherCustomer.name,
  });
  const emptyMaterialsInvoice = await prisma.invoice.create({
    data: {
      businessId: otherBusiness.id,
      customerId: otherCustomer.id,
      jobId: emptyMaterialsJob.job.id,
      status: "SENT",
      total: new Prisma.Decimal("1100"),
    },
  });
  const emptyMaterialsDoc = await loadInvoiceDocumentForBusiness(
    emptyMaterialsInvoice.id,
    otherBusiness.id,
    prisma,
  );
  const emptyMaterialsLines = await prisma.lineItem.count({
    where: { invoiceId: emptyMaterialsInvoice.id },
  });
  check(
    "empty invoice backfill reconstructs lines when Invoice.total is the $1,100 customer price",
    emptyMaterialsLines === 9 &&
      emptyMaterialsDoc?.laborTotalLabel === "$800.00" &&
      emptyMaterialsDoc?.materialTotalLabel === "$300.00" &&
      emptyMaterialsDoc?.totalLabel === "$1,100.00",
  );

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
