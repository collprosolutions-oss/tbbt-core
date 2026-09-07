/**
 * Printable customer estimate document + PDF.
 *
 * Version-first customer fields, customer-facing pricing only, and no
 * calculator / intake / owner internals in the HTML or PDF payload.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-document.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX,
  LABOR_MINIMUM_CUSTOMER_LABEL,
  estimateDocumentPlainText,
  estimateNumberFromId,
  estimatePdfFilename,
  estimateStatusLabel,
  loadEstimateDocumentByToken,
  loadEstimateDocumentForBusiness,
} = await import("@/lib/estimate-document");
const { renderEstimatePdf } = await import("@/lib/estimate-pdf");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { joinLineDescription } = await import("@/lib/estimate-line-scope");
const { defaultWorkAreaPersonalPropertyPolicy } = await import(
  "@/lib/estimate-policies"
);
const { getBusinessDocumentLogoSrc } = await import("@/lib/business-branding");
const { INVOICE_DOCUMENT_LOGO_HEIGHT_PX } = await import("@/lib/invoice-document");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function pdfExtractText(buffer) {
  const raw = buffer.toString("latin1");
  const hex = [...raw.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((match) => {
      try {
        return Buffer.from(match[1], "hex").toString("utf8");
      } catch {
        return "";
      }
    })
    .join("");
  const literals = [...raw.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]).join("");
  return `${hex}\n${literals}`;
}

const INTERNAL_LEAKS = [
  "panelRate",
  "contentsHandlingLightRate",
  "TBBT Calculator Snapshot",
  "TBBT Calculator Definition",
  "TBBT Customer Policy",
  "TBBT Work Area Intake",
  "/api/storage/private/",
  "Customer-reported / unverified",
  "Request photos",
  "recommendedAmount",
  "appliedAmount",
  "overriddenAmount",
  "calculatorId",
  "decorative-wall-paneling",
  "TBBT Material Takeoff",
  "TBBT Material Takeoff Source",
  "calculatedQuantity",
  "quantityOverride",
  "bagYieldCuFt",
  "wastePercent",
  "unitCost",
  "customerUnitPrice",
  "lengthFtPart",
  "lengthInPart",
  "wallWidthInPart",
  "Owner-only margin",
  "INTERNAL_OWNER_NOTE",
];
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

console.log("\nSTATIC — Printable estimate routes and helpers");

check(
  "Estimate number is derived like invoices",
  estimateNumberFromId("clxyzestimateABCDEFGH") === "EST-ABCDEFGH",
);
check(
  "PDF filename is sanitized",
  estimatePdfFilename("EST-ABC/DEF", "Jane Doe / LLC") ===
    "Estimate-EST-ABC-DEF-Jane-Doe-LLC.pdf",
);
check("Statuses have customer-facing labels", estimateStatusLabel("SENT") === "Sent");
check(
  "Print logo height matches the invoice document",
  ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX === INVOICE_DOCUMENT_LOGO_HEIGHT_PX,
);

const printPage = readRepo("src/app/(invoice-document)/e/[token]/print/page.tsx");
const ownerPrint = readRepo(
  "src/app/(invoice-document)/estimates/[estimateId]/print/page.tsx",
);
const publicPdf = readRepo("src/app/(invoice-document)/e/[token]/pdf/route.ts");
const ownerPdf = readRepo(
  "src/app/(invoice-document)/estimates/[estimateId]/pdf/route.ts",
);
const documentView = readRepo("src/components/estimates/estimate-document.tsx");
const documentLib = readRepo("src/lib/estimate-document.ts");
const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const customerPage = readRepo("src/app/e/[token]/page.tsx");

check(
  "Public print page has no approve button",
  printPage.includes("EstimateDocument") && !printPage.includes("ApproveEstimateButton"),
);
check(
  "Owner print is scoped to the signed-in business",
  ownerPrint.includes("requireManagementPageAccess") &&
    ownerPrint.includes("loadEstimateDocumentForBusiness"),
);
check(
  "Owner PDF requires management access",
  ownerPdf.includes("requireManagementPageAccess") &&
    ownerPdf.includes("renderEstimatePdf"),
);
check(
  "Public PDF is token-scoped only",
  publicPdf.includes("loadEstimateDocumentByToken") &&
    !publicPdf.includes("requireManagementPageAccess"),
);
check(
  "Print sheet includes branding, customer, address, services, totals, and terms",
  ["ESTIMATE", "PREPARED FOR", "SERVICE ADDRESS", "SERVICES", "TERMS", "Total"].every(
    (label) => documentView.includes(label),
  ),
);
check(
  "Document loader uses the document logo, not the dark website logo",
  documentLib.includes("getBusinessDocumentLogoSrc") &&
    !documentLib.includes("getBusinessLogoSrc("),
);
check(
  "Document loader is version-first and strips internals via splitLineDescription",
  documentLib.includes("versions") &&
    documentLib.includes("splitLineDescription") &&
    documentLib.includes("uniqueCustomerPolicies"),
);
check(
  "Owner estimate page links to print and PDF",
  ownerPage.includes("/print") && ownerPage.includes("/pdf"),
);
check(
  "Customer interactive page keeps approval and website logo",
  customerPage.includes("ApproveEstimateButton") &&
    customerPage.includes("getBusinessLogoSrc") &&
    customerPage.includes("Print / PDF"),
);
check(
  "Print routes do not mention calculator internals",
  !printPage.includes("panelRate") &&
    !documentView.includes("panelRate") &&
    !documentView.includes("CalculatorBreakdown"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_estimate_document_test";
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
  console.error("Failed to push schema for estimate-document test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

const encodedDescription = joinLineDescription(
  "Decorative Wall Paneling & Finish Carpentry",
  "Install metal siding on a 24×12 feature wall, 9 panels.",
  {
    calculatorId: "decorative-wall-paneling",
    inputs: { wallWidthFt: 24, wallHeightFt: 12, panelCount: 9 },
    rates: { panelRate: 90, contentsHandlingLightRate: 45 },
    recommendedAmount: 1800,
    appliedAmount: 1800,
    overriddenAmount: null,
  },
  [defaultWorkAreaPersonalPropertyPolicy()],
  {
    materialTakeoff: {
      version: 1,
      takeoffType: "sheet-covering",
      inputs: {
        wallWidthFt: 24,
        wallHeightFt: 12,
        wallWidthFtPart: 24,
        wallWidthInPart: 0,
        bagYieldCuFt: 0.45,
      },
      wastePercent: 10,
      measurementSource: {
        kind: "intake",
        label: "Customer-reported / unverified",
        unverified: true,
      },
      explanation: "Internal takeoff notes must not print.",
      skippedMeasurements: [],
      removedItemIds: [],
      items: [
        {
          id: "sheets",
          kind: "sheets",
          label: "4x8 sheets",
          unit: "sheet",
          optional: false,
          selected: true,
          calculatedQuantity: 10,
          quantityOverride: 11,
          unitCost: 28,
          customerUnitPrice: 42,
          explanation: "Owner-only derivation",
          convertedLineItemId: null,
        },
      ],
    },
  },
);

function assertNoInternalLeaks(label, text) {
  for (const leak of INTERNAL_LEAKS) {
    check(`${label} does not expose ${leak}`, !text.includes(leak));
  }
}

try {
  const business = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });
  const otherBusiness = await prisma.business.create({
    data: {
      name: "Other Subscriber Co",
      slug: "other-subscriber-est-doc",
      tradeCode: "HANDYMAN",
    },
  });
  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: "Jordan Rivera",
      email: "jordan@example.com",
      phone: "239-555-0100",
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: "10 Cypress Ave",
      city: "Naples",
      region: "FL",
      postalCode: "34102",
    },
  });

  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      status: "DRAFT",
      total: new Prisma.Decimal(1850),
      laborMinimumAdjustment: new Prisma.Decimal(50),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      description: `${encodedDescription}\nINTERNAL_OWNER_NOTE Owner-only margin`,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1800),
      total: new Prisma.Decimal(1800),
      type: "LABOR",
    },
  });

  console.log("\nTEST 1 — Draft document uses live customer-facing fields");
  const draftDoc = await loadEstimateDocumentForBusiness(
    estimate.id,
    business.id,
    prisma,
  );
  check("draft document loads", Boolean(draftDoc));
  check("draft number is EST- plus last 8 of id", draftDoc?.estimateNumber === estimateNumberFromId(estimate.id));
  check("draft status is Draft", draftDoc?.statusLabel === "Draft");
  check("draft uses document logo", draftDoc?.business.logoSrc === getBusinessDocumentLogoSrc("collpro-reno"));
  check("draft includes business phone", draftDoc?.business.phone === "239-357-8199");
  check("draft customer name", draftDoc?.customer.name === "Jordan Rivera");
  check("draft service address", draftDoc?.serviceAddress?.includes("10 Cypress Ave") === true);
  check("draft line title is customer-facing", draftDoc?.lineItems[0]?.description === "Decorative Wall Paneling & Finish Carpentry");
  check(
    "draft included work is customer-facing",
    draftDoc?.lineItems[0]?.includedWork?.includes("24×12 feature wall") === true,
  );
  check("draft subtotal is the line total", draftDoc?.subtotalLabel === "$1,800.00");
  check("draft shows labor minimum", draftDoc?.laborMinimumLabel === LABOR_MINIMUM_CUSTOMER_LABEL);
  check("draft labor minimum amount", draftDoc?.laborMinimumAmountLabel === "$50.00");
  check("draft total includes labor minimum", draftDoc?.totalLabel === "$1,850.00");
  check(
    "draft terms include Work Area & Personal Property",
    draftDoc?.policies.some((policy) => policy.title === "Work Area & Personal Property") === true,
  );
  assertNoInternalLeaks("draft document", estimateDocumentPlainText(draftDoc));

  console.log("\nTEST 2 — Sent version is frozen and used for print/PDF");
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "SENT" },
  });
  await createEstimateVersionSnapshot(prisma, {
    estimateId: estimate.id,
    businessId: business.id,
  });

  await prisma.customer.update({
    where: { id: customer.id },
    data: { name: "CHANGED LIVE CUSTOMER", email: "changed@example.com" },
  });
  await prisma.property.update({
    where: { id: property.id },
    data: { addressLine1: "999 Changed St" },
  });
  await prisma.lineItem.updateMany({
    where: { estimateId: estimate.id },
    data: {
      description: "CHANGED LIVE LINE with panelRate 999",
      unitPrice: new Prisma.Decimal(9),
      total: new Prisma.Decimal(9),
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { total: new Prisma.Decimal(9) },
  });

  const sentDoc = await loadEstimateDocumentByToken(estimate.publicToken, prisma);
  check("token loader finds the sent estimate", Boolean(sentDoc));
  check("sent document still shows snapshot customer", sentDoc?.customer.name === "Jordan Rivera");
  check("sent document still shows snapshot address", sentDoc?.serviceAddress?.includes("10 Cypress Ave") === true);
  check("sent document still shows snapshot title", sentDoc?.lineItems[0]?.description === "Decorative Wall Paneling & Finish Carpentry");
  check("sent document still shows snapshot total", sentDoc?.totalLabel === "$1,850.00");
  check("sent status is Sent", sentDoc?.statusLabel === "Sent");
  check(
    "other business cannot load this estimate",
    (await loadEstimateDocumentForBusiness(estimate.id, otherBusiness.id, prisma)) === null,
  );

  const pdf = await renderEstimatePdf(sentDoc);
  const pdfText = pdfExtractText(pdf);
  check("PDF starts with %PDF", pdf.subarray(0, 4).toString() === "%PDF");
  check("PDF contains ESTIMATE", pdfText.includes("ESTIMATE"));
  check("PDF contains estimate number", pdfText.includes(sentDoc.estimateNumber));
  check("PDF contains business name", pdfText.includes("CollPro Reno Handyman Services"));
  check("PDF contains customer name", pdfText.includes("Jordan Rivera"));
  check("PDF contains service address", pdfText.includes("10 Cypress Ave"));
  check("PDF contains service title", pdfText.includes("Decorative Wall Paneling"));
  check("PDF contains included work", pdfText.includes("feature wall"));
  check("PDF contains customer total", pdfText.includes("$1,850.00"));
  check("PDF contains terms title", pdfText.includes("Work Area & Personal Property"));
  check("PDF does not use the live rewritten customer", !pdfText.includes("CHANGED LIVE CUSTOMER"));
  check("PDF filename is Estimate-<number>-<customer>.pdf", sentDoc.pdfFilename === `Estimate-${sentDoc.estimateNumber}-Jordan-Rivera.pdf`);
  assertNoInternalLeaks("PDF text", pdfText);
  assertNoInternalLeaks("sent document", estimateDocumentPlainText(sentDoc));

  console.log("\nTEST 3 — Zero labor minimum is omitted");
  const simple = await prisma.estimate.create({
    data: {
      businessId: otherBusiness.id,
      status: "DRAFT",
      total: new Prisma.Decimal(100),
      laborMinimumAdjustment: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: otherBusiness.id,
      estimateId: simple.id,
      description: "Simple repair",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(100),
      total: new Prisma.Decimal(100),
      type: "LABOR",
    },
  });
  const simpleDoc = await loadEstimateDocumentForBusiness(
    simple.id,
    otherBusiness.id,
    prisma,
  );
  check("simple document has no labor-minimum row", simpleDoc?.laborMinimumLabel === null);
  check("simple document total is the line total", simpleDoc?.totalLabel === "$100.00");
  check("other tenant does not receive CollPro logo", simpleDoc?.business.logoSrc == null);
  check("other tenant does not receive CollPro phone", simpleDoc?.business.phone == null);
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failed === 0
    ? `\nAll estimate-document checks passed (${passed}).`
    : `\n${failed} estimate-document check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
