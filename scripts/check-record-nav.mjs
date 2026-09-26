/**
 * Record journey navigation.
 *
 * Proves Customer → Request → Estimate → Job → Invoice links come from
 * actual foreign keys, never from a similar name, similar amount, or a
 * shared customer. Also proves tenant isolation, MEMBER financial-link
 * denial, and ORIGINAL / SUPPLEMENTAL invoice labels.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-record-nav.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  buildRecordNavItems,
  loadRecordJourney,
  recordHref,
  recordNavKindAllowed,
} = await import("@/lib/record-nav");
const {
  INVOICE_KIND_ORIGINAL,
  INVOICE_KIND_SUPPLEMENTAL,
  invoiceKindLabel,
  recordNavInvoiceLabel,
} = await import("@/lib/revenue-integrity");
const { canAccessManagementConsole } = await import("@/lib/authorization");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_record_nav_test";
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
  console.error("Failed to push schema for record-nav test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function idsOf(items, kind) {
  return items.filter((item) => item.kind === kind).map((item) => item.id);
}

function hrefsOf(items) {
  return items.map((item) => item.href).filter(Boolean);
}

function makeAccess(businessId, role = "OWNER") {
  return {
    businessId,
    scope: { businessId },
    workspace: { role },
  };
}

async function seedTenant(label, slug) {
  const business = await prisma.business.create({
    data: { name: `${label} Handyman`, slug, tradeCode: "HANDYMAN" },
  });
  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: `${label} Customer`,
      email: `${slug}@example.com`,
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: `${label} Street 1`,
      city: `${label} City`,
      region: "TX",
      postalCode: "75001",
    },
  });
  const request = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      status: "CONVERTED",
      summary: `${label} repair`,
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      serviceRequestId: request.id,
      status: "APPROVED",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      estimateId: estimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      jobId: job.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "SENT",
      total: new Prisma.Decimal(250),
    },
  });
  return { business, customer, property, request, estimate, job, invoice };
}

const customerPage = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const requestPage = readRepo("src/app/(app)/requests/page.tsx");
const requestRecordPage = readRepo("src/app/(app)/requests/[requestId]/page.tsx");
const estimatePage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const jobPage = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const invoicePage = readRepo("src/app/(app)/invoices/[invoiceId]/page.tsx");
const fieldJobPage = readRepo("src/app/field/jobs/[jobId]/page.tsx");
const recordNavLib = readRepo("src/lib/record-nav.ts");
const recordNavUi = readRepo("src/components/record-nav.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const schemaSrc = readRepo("prisma/schema.prisma");

console.log("\nSTATIC — RecordNav is record journey, not a new global nav");
check(
  "RecordNav still lives in the shared component",
  recordNavUi.includes('aria-label="Related records"') &&
    recordNavUi.includes("flex-col") &&
    recordNavUi.includes("flex-wrap"),
);
check(
  "APP_NAV has no RecordNav / journey destination",
  !navSrc.includes("RecordNav") && !navSrc.includes("record-nav"),
);
check(
  "Customer / estimate / job / invoice / request pages load the journey helper",
  customerPage.includes("loadRecordJourney") &&
    estimatePage.includes("loadRecordJourney") &&
    jobPage.includes("loadRecordJourney") &&
    invoicePage.includes("loadRecordJourney") &&
    requestRecordPage.includes("loadRecordJourney"),
);
check(
  "Request list still exists and still uses RequestsWorkspace",
  requestPage.includes("<RequestsWorkspace") &&
    requestPage.includes("buildRecordNavItems"),
);
check("Dedicated request record route exists", requestRecordPage.includes("Service request"));
check(
  "Field job page does not import RecordNav or financial invoice hrefs",
  !fieldJobPage.includes("RecordNav") &&
    !fieldJobPage.includes("/invoices/") &&
    !fieldJobPage.includes("/estimates/"),
);
check(
  "Resolver refuses name/amount/customer-only guessing",
  recordNavLib.includes("Never infers a link from a similar name") &&
    recordNavLib.includes("access.scope") &&
    recordNavLib.includes("serviceRequest") &&
    recordNavLib.includes("ownedByBusiness"),
);
check(
  "Nested to-many hops add explicit businessId where clauses",
  recordNavLib.includes("const tenantWhere = { businessId: access.businessId }") &&
    recordNavLib.includes("serviceRequests: {\n            where: tenantWhere,") &&
    recordNavLib.includes("estimates: {\n            where: tenantWhere,") &&
    recordNavLib.includes("jobs: {\n            where: tenantWhere,") &&
    recordNavLib.includes("invoices: {\n            where: tenantWhere,"),
);
check(
  "To-one hops are used only when related.businessId matches the workspace",
  recordNavLib.includes("ownedByBusiness") &&
    recordNavLib.includes("row.businessId === businessId") &&
    recordNavLib.includes("A foreign-key match alone is never the tenant boundary"),
);
check(
  "No schema.prisma relationship redesign in this helper",
  schemaSrc.includes("serviceRequestId") &&
    schemaSrc.includes("estimateId") &&
    schemaSrc.includes('kind             String    @default("ORIGINAL")'),
);

console.log("\nUNIT — Auth, invoice kinds, no invented origin");
check(
  "#114 invoiceKindLabel is unchanged",
  invoiceKindLabel(INVOICE_KIND_ORIGINAL) === "Invoice" &&
    invoiceKindLabel(INVOICE_KIND_SUPPLEMENTAL) === "Balance invoice",
);
check(
  "RecordNav labels ORIGINAL vs balance/supplemental clearly",
  recordNavInvoiceLabel(INVOICE_KIND_ORIGINAL) === "Original invoice" &&
    recordNavInvoiceLabel(INVOICE_KIND_SUPPLEMENTAL) === "Balance invoice",
);
check("MEMBER cannot open the management console", canAccessManagementConsole("MEMBER") === false);
check("MEMBER cannot receive an estimate or invoice nav kind", !recordNavKindAllowed("MEMBER", "estimate") && !recordNavKindAllowed("MEMBER", "invoice"));
check("OWNER may link estimates and invoices", recordNavKindAllowed("OWNER", "estimate") && recordNavKindAllowed("OWNER", "invoice"));
check(
  "recordHref uses existing record routes",
  recordHref("request", "r1") === "/requests/r1" &&
    recordHref("estimate", "e1") === "/estimates/e1" &&
    recordHref("job", "j1") === "/jobs/j1" &&
    recordHref("invoice", "i1") === "/invoices/i1" &&
    recordHref("customer", "c1") === "/customers/c1",
);

const memberItems = buildRecordNavItems({
  origin: { kind: "job", id: "job-1" },
  related: {
    customer: { id: "c1", name: "Pat" },
    estimates: [{ id: "e1" }],
    jobs: [{ id: "job-1" }],
    invoices: [{ id: "i1", kind: INVOICE_KIND_ORIGINAL }],
  },
  role: "MEMBER",
});
check("MEMBER receives no record-journey links", memberItems.length === 0);

const ownerItems = buildRecordNavItems({
  origin: { kind: "job", id: "job-1" },
  related: {
    customer: { id: "c1", name: "Pat" },
    estimates: [{ id: "e1" }],
    jobs: [{ id: "job-1" }],
    invoices: [
      { id: "i-sup", kind: INVOICE_KIND_SUPPLEMENTAL, createdAt: new Date("2026-02-01") },
      { id: "i-orig", kind: INVOICE_KIND_ORIGINAL, createdAt: new Date("2026-01-01") },
    ],
  },
  role: "OWNER",
});
check(
  "OWNER job nav includes customer, approved estimate, original invoice, then balance invoice",
  idsOf(ownerItems, "customer")[0] === "c1" &&
    idsOf(ownerItems, "estimate")[0] === "e1" &&
    idsOf(ownerItems, "invoice").join(",") === "i-orig,i-sup" &&
    ownerItems.find((item) => item.id === "i-orig")?.label === "Original invoice" &&
    ownerItems.find((item) => item.id === "i-sup")?.label === "Balance invoice",
);
check(
  "Current job is not a link",
  ownerItems.find((item) => item.id === "job-1")?.current === true &&
    ownerItems.find((item) => item.id === "job-1")?.href === null,
);
check(
  "Builder does not invent a request without a request id",
  idsOf(ownerItems, "request").length === 0,
);

try {
  const tenantA = await seedTenant("Alpha", `nav-a-${randomUUID().slice(0, 8)}`);
  const tenantB = await seedTenant("Bravo", `nav-b-${randomUUID().slice(0, 8)}`);
  const accessA = makeAccess(tenantA.business.id, "OWNER");
  const accessB = makeAccess(tenantB.business.id, "OWNER");
  const memberA = makeAccess(tenantA.business.id, "MEMBER");

  const siblingRequest = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      status: "OPEN",
      summary: "Alpha sibling",
    },
  });
  const siblingEstimate = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      serviceRequestId: siblingRequest.id,
      status: "DRAFT",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const standaloneEstimate = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      propertyId: tenantA.property.id,
      status: "DRAFT",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const supplemental = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      jobId: tenantA.job.id,
      kind: INVOICE_KIND_SUPPLEMENTAL,
      status: "DRAFT",
      total: new Prisma.Decimal(75),
    },
  });

  console.log("\nDB — Deterministic request → estimate → job → invoice chain");
  const fromRequest = await loadRecordJourney(prisma, accessA, {
    kind: "request",
    id: tenantA.request.id,
  });
  check(
    "request→estimate linkage uses Estimate.serviceRequestId",
    idsOf(fromRequest, "estimate").includes(tenantA.estimate.id),
  );
  check(
    "request nav does not claim the sibling estimate as origin/only estimate without listing it separately",
    idsOf(fromRequest, "estimate").includes(siblingEstimate.id) === false,
  );
  check(
    "request nav includes customer and property when those FKs exist",
    idsOf(fromRequest, "customer")[0] === tenantA.customer.id &&
      idsOf(fromRequest, "property")[0] === tenantA.property.id,
  );

  const fromSiblingRequest = await loadRecordJourney(prisma, accessA, {
    kind: "request",
    id: siblingRequest.id,
  });
  check(
    "sibling request only lists its own linked estimate",
    idsOf(fromSiblingRequest, "estimate").join(",") === siblingEstimate.id,
  );

  const fromEstimate = await loadRecordJourney(prisma, accessA, {
    kind: "estimate",
    id: tenantA.estimate.id,
  });
  check(
    "estimate→job linkage uses Job.estimateId",
    idsOf(fromEstimate, "job").includes(tenantA.job.id),
  );
  check(
    "estimate nav includes originating request only when serviceRequestId is set",
    idsOf(fromEstimate, "request").join(",") === tenantA.request.id,
  );
  check(
    "estimate nav reaches invoices only through the linked job",
    idsOf(fromEstimate, "invoice").includes(tenantA.invoice.id) &&
      idsOf(fromEstimate, "invoice").includes(supplemental.id),
  );

  const fromStandalone = await loadRecordJourney(prisma, accessA, {
    kind: "estimate",
    id: standaloneEstimate.id,
  });
  check(
    "standalone estimate does not invent a request or job",
    idsOf(fromStandalone, "request").length === 0 &&
      idsOf(fromStandalone, "job").length === 0 &&
      idsOf(fromStandalone, "invoice").length === 0,
  );

  const fromJob = await loadRecordJourney(prisma, accessA, {
    kind: "job",
    id: tenantA.job.id,
  });
  check(
    "job→original invoice uses Invoice.jobId + ORIGINAL kind",
    fromJob.find((item) => item.id === tenantA.invoice.id)?.label === "Original invoice",
  );
  check(
    "job→supplemental invoices uses Invoice.jobId + SUPPLEMENTAL kind",
    fromJob.find((item) => item.id === supplemental.id)?.label === "Balance invoice",
  );
  check(
    "job related request is only the estimate.serviceRequestId",
    idsOf(fromJob, "request").join(",") === tenantA.request.id &&
      !idsOf(fromJob, "request").includes(siblingRequest.id),
  );
  check(
    "job nav does not guess the same-customer sibling estimate",
    !idsOf(fromJob, "estimate").includes(siblingEstimate.id) &&
      !idsOf(fromJob, "estimate").includes(standaloneEstimate.id) &&
      idsOf(fromJob, "estimate").join(",") === tenantA.estimate.id,
  );

  const fromInvoice = await loadRecordJourney(prisma, accessA, {
    kind: "invoice",
    id: tenantA.invoice.id,
  });
  check(
    "invoice→job uses Invoice.jobId",
    idsOf(fromInvoice, "job").join(",") === tenantA.job.id,
  );
  check(
    "invoice→estimate uses Job.estimateId, not a same-amount guess",
    idsOf(fromInvoice, "estimate").join(",") === tenantA.estimate.id &&
      !idsOf(fromInvoice, "estimate").includes(siblingEstimate.id) &&
      !idsOf(fromInvoice, "estimate").includes(standaloneEstimate.id),
  );
  check(
    "invoice nav includes customer when Invoice.customerId exists",
    idsOf(fromInvoice, "customer")[0] === tenantA.customer.id,
  );

  const fromCustomer = await loadRecordJourney(prisma, accessA, {
    kind: "customer",
    id: tenantA.customer.id,
  });
  check(
    "customer record still surfaces every FK-linked request/estimate/job/invoice",
    idsOf(fromCustomer, "request").includes(tenantA.request.id) &&
      idsOf(fromCustomer, "request").includes(siblingRequest.id) &&
      idsOf(fromCustomer, "estimate").includes(tenantA.estimate.id) &&
      idsOf(fromCustomer, "estimate").includes(siblingEstimate.id) &&
      idsOf(fromCustomer, "estimate").includes(standaloneEstimate.id) &&
      idsOf(fromCustomer, "job").includes(tenantA.job.id) &&
      idsOf(fromCustomer, "invoice").includes(tenantA.invoice.id) &&
      idsOf(fromCustomer, "invoice").includes(supplemental.id),
  );

  console.log("\nDB — Isolation and MEMBER financial links");
  const fromAJob = await loadRecordJourney(prisma, accessA, {
    kind: "job",
    id: tenantA.job.id,
  });
  const leakedB = hrefsOf(fromAJob).some(
    (href) =>
      href.includes(tenantB.customer.id) ||
      href.includes(tenantB.request.id) ||
      href.includes(tenantB.estimate.id) ||
      href.includes(tenantB.job.id) ||
      href.includes(tenantB.invoice.id),
  );
  check("tenant B never appears on tenant A job nav", leakedB === false);

  const crossTenant = await loadRecordJourney(prisma, accessA, {
    kind: "job",
    id: tenantB.job.id,
  });
  check("tenant A access cannot load tenant B's job journey", crossTenant.length === 0);

  const fromB = await loadRecordJourney(prisma, accessB, {
    kind: "invoice",
    id: tenantB.invoice.id,
  });
  check(
    "tenant B invoice journey stays on tenant B ids",
    idsOf(fromB, "customer")[0] === tenantB.customer.id &&
      idsOf(fromB, "job")[0] === tenantB.job.id &&
      !idsOf(fromB, "job").includes(tenantA.job.id),
  );

  const memberJourney = await loadRecordJourney(prisma, memberA, {
    kind: "job",
    id: tenantA.job.id,
  });
  check(
    "MEMBER does not receive forbidden financial links",
    memberJourney.length === 0 &&
      !hrefsOf(memberJourney).some((href) => href.startsWith("/invoices/") || href.startsWith("/estimates/")),
  );

  console.log("\nDB — Corrupted cross-tenant FKs are omitted");
  const foreignRequestOnA = await prisma.serviceRequest.create({
    data: {
      businessId: tenantB.business.id,
      customerId: tenantA.customer.id,
      status: "OPEN",
      summary: "Corrupt B request on A customer",
    },
  });
  const foreignEstimateOnA = await prisma.estimate.create({
    data: {
      businessId: tenantB.business.id,
      customerId: tenantA.customer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const foreignJobOnA = await prisma.job.create({
    data: {
      businessId: tenantB.business.id,
      customerId: tenantA.customer.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const foreignInvoiceOnA = await prisma.invoice.create({
    data: {
      businessId: tenantB.business.id,
      customerId: tenantA.customer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(40),
    },
  });

  const customerAfterCorrupt = await loadRecordJourney(prisma, accessA, {
    kind: "customer",
    id: tenantA.customer.id,
  });
  check(
    "Customer A omits a Business-B ServiceRequest that points at Customer A",
    !idsOf(customerAfterCorrupt, "request").includes(foreignRequestOnA.id),
  );
  check(
    "Customer A omits Business-B Estimate / Job / Invoice rows that point at Customer A",
    !idsOf(customerAfterCorrupt, "estimate").includes(foreignEstimateOnA.id) &&
      !idsOf(customerAfterCorrupt, "job").includes(foreignJobOnA.id) &&
      !idsOf(customerAfterCorrupt, "invoice").includes(foreignInvoiceOnA.id),
  );

  const requestPointingAtB = await prisma.serviceRequest.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantB.customer.id,
      propertyId: tenantB.property.id,
      status: "OPEN",
      summary: "A request with B customer/property",
    },
  });
  const fromCorruptRequest = await loadRecordJourney(prisma, accessA, {
    kind: "request",
    id: requestPointingAtB.id,
  });
  check(
    "Request A omits a foreign customerId / propertyId",
    !idsOf(fromCorruptRequest, "customer").includes(tenantB.customer.id) &&
      !idsOf(fromCorruptRequest, "property").includes(tenantB.property.id) &&
      fromCorruptRequest.some((item) => item.kind === "request" && item.id === requestPointingAtB.id),
  );

  const estimatePointingAtB = await prisma.estimate.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantB.customer.id,
      propertyId: tenantB.property.id,
      serviceRequestId: tenantB.request.id,
      status: "DRAFT",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  const fromCorruptEstimate = await loadRecordJourney(prisma, accessA, {
    kind: "estimate",
    id: estimatePointingAtB.id,
  });
  check(
    "Estimate A omits foreign serviceRequest / customer / property",
    !idsOf(fromCorruptEstimate, "request").includes(tenantB.request.id) &&
      !idsOf(fromCorruptEstimate, "customer").includes(tenantB.customer.id) &&
      !idsOf(fromCorruptEstimate, "property").includes(tenantB.property.id) &&
      fromCorruptEstimate.some((item) => item.kind === "estimate" && item.id === estimatePointingAtB.id),
  );

  const jobPointingAtB = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantB.customer.id,
      propertyId: tenantB.property.id,
      estimateId: tenantB.estimate.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const fromCorruptJob = await loadRecordJourney(prisma, accessA, {
    kind: "job",
    id: jobPointingAtB.id,
  });
  check(
    "Job A omits foreign estimate / customer / property",
    !idsOf(fromCorruptJob, "estimate").includes(tenantB.estimate.id) &&
      !idsOf(fromCorruptJob, "customer").includes(tenantB.customer.id) &&
      !idsOf(fromCorruptJob, "property").includes(tenantB.property.id) &&
      fromCorruptJob.some((item) => item.kind === "job" && item.id === jobPointingAtB.id),
  );

  const invoicePointingAtB = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantB.customer.id,
      jobId: tenantB.job.id,
      status: "DRAFT",
      total: new Prisma.Decimal(15),
    },
  });
  const fromCorruptInvoice = await loadRecordJourney(prisma, accessA, {
    kind: "invoice",
    id: invoicePointingAtB.id,
  });
  check(
    "Invoice A omits foreign job / customer",
    !idsOf(fromCorruptInvoice, "job").includes(tenantB.job.id) &&
      !idsOf(fromCorruptInvoice, "customer").includes(tenantB.customer.id) &&
      !idsOf(fromCorruptInvoice, "estimate").includes(tenantB.estimate.id) &&
      fromCorruptInvoice.some((item) => item.kind === "invoice" && item.id === invoicePointingAtB.id),
  );

  const sameTenantAfterCorrupt = await loadRecordJourney(prisma, accessA, {
    kind: "job",
    id: tenantA.job.id,
  });
  check(
    "Normal same-tenant chain still shows Customer → Request → Estimate → Job → Invoice",
    idsOf(sameTenantAfterCorrupt, "customer")[0] === tenantA.customer.id &&
      idsOf(sameTenantAfterCorrupt, "request")[0] === tenantA.request.id &&
      idsOf(sameTenantAfterCorrupt, "estimate")[0] === tenantA.estimate.id &&
      idsOf(sameTenantAfterCorrupt, "job")[0] === tenantA.job.id &&
      idsOf(sameTenantAfterCorrupt, "invoice").includes(tenantA.invoice.id),
  );
  check(
    "Existing tenant-B-origin top-level lookup remains empty for tenant A",
    (await loadRecordJourney(prisma, accessA, { kind: "job", id: tenantB.job.id })).length === 0,
  );

  const leakedAfterCorrupt = [
    ...customerAfterCorrupt,
    ...fromCorruptRequest,
    ...fromCorruptEstimate,
    ...fromCorruptJob,
    ...fromCorruptInvoice,
    ...sameTenantAfterCorrupt,
  ];
  check(
    "No corrupted hop exposes a tenant-B href or id",
    !leakedAfterCorrupt.some(
      (item) =>
        item.id === tenantB.customer.id ||
        item.id === tenantB.property.id ||
        item.id === tenantB.request.id ||
        item.id === tenantB.estimate.id ||
        item.id === tenantB.job.id ||
        item.id === tenantB.invoice.id ||
        item.id === foreignRequestOnA.id ||
        item.id === foreignEstimateOnA.id ||
        item.id === foreignJobOnA.id ||
        item.id === foreignInvoiceOnA.id,
    ),
  );

  console.log("\nSTATIC — Existing record routes still exist");
  check("Customer route still exists", customerPage.includes("Customer profile"));
  check("Estimate route still exists", estimatePage.includes("Back to Estimates"));
  check("Job route still exists", jobPage.includes("Back to Jobs"));
  check("Invoice route still exists", invoicePage.includes("Back to Invoices"));
  check("Requests list route still exists", requestPage.includes("Requests / New Leads") || requestPage.includes("PAGE_TITLE"));
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nrecord-nav check failed: ${failures} failure(s)`);
  process.exit(1);
}

console.log("\nrecord-nav check passed");
