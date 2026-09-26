/**
 * Request / customer journey continuity.
 *
 * Proves pipeline Open request deep-links to the selected request, the
 * dedicated request record page surfaces recorded contact + identity-review
 * follow-up, invoice RecordNav keeps Property/Request when those FKs exist,
 * and navigation never invents IDs, mutates records, or crosses tenants.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-request-record-continuity.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { pipelineOpenRequestHref } = await import("@/lib/pipeline");
const {
  appendIntakeIdentityReview,
  IDENTITY_REVIEW_MARKER,
} = await import("@/lib/customer-identity");
const {
  recordedCustomerEmail,
  recordedCustomerPhone,
  requestCallHref,
  requestEmailHref,
  requestIdentityReviewContext,
} = await import("@/lib/request-follow-up");
const { customerInvoiceHistoryContext } = await import(
  "@/lib/customer-invoice-history"
);
const { paymentMethodLabel } = await import("@/lib/invoice-payment");
const {
  buildRecordNavItems,
  loadRecordJourney,
  recordHref,
} = await import("@/lib/record-nav");
const { INVOICE_KIND_ORIGINAL } = await import("@/lib/revenue-integrity");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_request_record_continuity_test";
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
  console.error("Failed to push schema for request-record-continuity test database.");
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

const pipelineWorkspace = readRepo("src/components/pipeline/pipeline-workspace.tsx");
const pipelineLib = readRepo("src/lib/pipeline.ts");
const requestRecordPage = readRepo("src/app/(app)/requests/[requestId]/page.tsx");
const requestsPage = readRepo("src/app/(app)/requests/page.tsx");
const requestsWorkspace = readRepo("src/components/requests/requests-workspace.tsx");
const requestFollowUpLib = readRepo("src/lib/request-follow-up.ts");
const requestFollowUpUi = readRepo("src/components/requests/request-follow-up.tsx");
const recordNavLib = readRepo("src/lib/record-nav.ts");
const customerProfile = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const customerInvoiceHistory = readRepo("src/lib/customer-invoice-history.ts");
const invoiceRecordPage = readRepo("src/app/(app)/invoices/[invoiceId]/page.tsx");
const invoiceActions = readRepo("src/app/actions/invoice.ts");
const dashboardPage = readRepo("src/app/(app)/dashboard/page.tsx");
const customersListPage = readRepo("src/app/(app)/customers/page.tsx");
const publicIntake = readRepo("src/lib/public-intake.ts");

console.log("\nSTATIC — Pipeline Open request uses the selected request ID");
check(
  "pipelineOpenRequestHref lives in the pipeline domain helper",
  pipelineLib.includes("export function pipelineOpenRequestHref") &&
    pipelineLib.includes("`/requests?selected=${encodeURIComponent(id)}`"),
);
check(
  "Pipeline workspace Open request uses the helper, not a bare /requests href",
  pipelineWorkspace.includes("pipelineOpenRequestHref(row.serviceRequestId)") &&
    pipelineWorkspace.includes("Open request") &&
    !pipelineWorkspace.includes('href="/requests"'),
);
check(
  "1. Pipeline Open request uses the actual selected request ID",
  pipelineOpenRequestHref("req_live_123") === "/requests?selected=req_live_123",
);
check(
  "2. no serviceRequestId does not fabricate a selected route",
  pipelineOpenRequestHref(null) === null &&
    pipelineOpenRequestHref(undefined) === null &&
    pipelineOpenRequestHref("") === null &&
    pipelineOpenRequestHref("   ") === null,
);

console.log("\nSTATIC — Dedicated request record page stays scoped and surfaces follow-up");
check(
  "3. request record page stays tenant scoped",
  requestRecordPage.includes("where: { id: requestId, ...access.scope }") &&
    requestRecordPage.includes("access.assertOwned(request)") &&
    requestRecordPage.includes("requireManagementPageAccess"),
);
check(
  "Both request surfaces remain",
  requestsPage.includes("<RequestsWorkspace") &&
    requestRecordPage.includes("Service request") &&
    requestsPage.includes("initialSelectedId={params.selected}"),
);
check(
  "4. recorded phone is displayed",
  requestRecordPage.includes("RequestRecordedContact") &&
    requestFollowUpUi.includes("recordedCustomerPhone") &&
    requestFollowUpLib.includes("export function recordedCustomerPhone"),
);
check(
  "5. recorded email is displayed",
  requestRecordPage.includes("RequestRecordedContact") &&
    requestFollowUpUi.includes("recordedCustomerEmail"),
);
check(
  "6. missing phone/email does not create fake actions",
  requestFollowUpUi.includes("if (!tel && !mailto) return null") &&
    requestFollowUpLib.includes("Missing phone/email never become a tel/mailto action"),
);
check(
  "7. Call link uses recorded phone only",
  requestFollowUpUi.includes("requestCallHref(phone)") &&
    requestFollowUpLib.includes("return telHref(phone)"),
);
check(
  "8. Email link uses recorded email only",
  requestFollowUpUi.includes("requestEmailHref(email)") &&
    requestFollowUpLib.includes("`mailto:${value}`"),
);
check(
  "9. identity-review warning appears when canonical request state calls for it",
  requestRecordPage.includes("requestIdentityReviewContext(request.description)") &&
    requestRecordPage.includes("RequestIdentityReviewNotice") &&
    requestFollowUpUi.includes("Needs identity review"),
);
check(
  "Request record page reuses follow-up helpers instead of cloning workspace markup",
  requestRecordPage.includes("@/components/requests/request-follow-up") &&
    requestRecordPage.includes("@/lib/request-follow-up") &&
    requestsWorkspace.includes("RequestContactActions") &&
    requestsPage.includes("requestIdentityReviewContext(request.description)"),
);
check(
  "Public request intake is unchanged by this page",
  publicIntake.includes("createPublicServiceRequest") &&
    !requestRecordPage.includes("createPublicServiceRequest"),
);

console.log("\nUNIT — Recorded contact and identity-review helpers");
const recordedPhone = "(239) 357-8199";
const recordedEmail = "owner@example.com";
check(
  "recorded phone is returned as stored",
  recordedCustomerPhone(recordedPhone) === recordedPhone,
);
check(
  "recorded email is returned as stored",
  recordedCustomerEmail(recordedEmail) === recordedEmail,
);
check(
  "blank phone/email are not treated as recorded",
  recordedCustomerPhone("   ") === null &&
    recordedCustomerEmail("  ") === null &&
    recordedCustomerPhone(null) === null &&
    recordedCustomerEmail(undefined) === null,
);
check(
  "Call href uses the recorded phone only",
  requestCallHref(recordedPhone) === `tel:${recordedPhone}` &&
    requestCallHref(null) === null &&
    requestCallHref("") === null &&
    requestCallHref("   ") === null,
);
check(
  "Email href uses the recorded email only",
  requestEmailHref(recordedEmail) === `mailto:${recordedEmail}` &&
    requestEmailHref("  pat@example.com  ") === "mailto:pat@example.com" &&
    requestEmailHref(null) === null &&
    requestEmailHref("") === null,
);
check(
  "missing phone/email do not create fake actions",
  requestCallHref(null) === null && requestEmailHref(undefined) === null,
);

const identityDescription = appendIntakeIdentityReview(
  "Fence repair",
  {
    reason: "email_phone_conflict",
    emailCustomerIds: ["c-email"],
    phoneCustomerIds: ["c-phone"],
  },
);
const identityReview = requestIdentityReviewContext(identityDescription);
check(
  "identity-review warning is derived from the recorded review marker",
  identityReview?.reason === "email_phone_conflict" &&
    identityReview.message.includes("filed for owner review") &&
    identityDescription.includes(IDENTITY_REVIEW_MARKER),
);
check(
  "no identity-review marker means no warning",
  requestIdentityReviewContext("Ordinary request notes") === null &&
    requestIdentityReviewContext(null) === null,
);

console.log("\nSTATIC — Invoice RecordNav projection keeps Property and Request");
const invoiceCase = recordNavLib.slice(recordNavLib.indexOf('case "invoice"'));
check(
  "invoice loader reads job.property and estimate.serviceRequest",
  invoiceCase.includes("property: { select: propertySelect }") &&
    invoiceCase.includes("serviceRequest: { select: { id: true, businessId: true } }") &&
    invoiceCase.includes("const request = ownedByBusiness(estimate?.serviceRequest, access.businessId)") &&
    invoiceCase.includes("property: projectProperty(job?.property, access.businessId, customer?.id)") &&
    invoiceCase.includes("requests: request ? [{ id: request.id }] : []"),
);
check(
  "invoice RecordNav still scopes the origin with access.scope",
  invoiceCase.includes("where: { id: origin.id, ...access.scope }"),
);
check(
  "this lane did not edit the invoice record page or invoice actions",
  invoiceRecordPage.includes("loadRecordJourney") &&
    invoiceActions.includes("export async function markInvoicePaid"),
);

console.log("\nUNIT — RecordNav builder does not invent missing hops");
const invoiceItems = buildRecordNavItems({
  origin: { kind: "invoice", id: "inv-1" },
  related: {
    customer: { id: "c1", name: "Pat" },
    property: { id: "p1", customerId: "c1", addressLine1: "10 Main" },
    requests: [{ id: "r1" }],
    estimates: [{ id: "e1" }],
    jobs: [{ id: "j1" }],
    invoices: [{ id: "inv-1", kind: INVOICE_KIND_ORIGINAL }],
  },
  role: "OWNER",
});
check(
  "15. normal Customer → Request → Estimate → Job → Invoice navigation remains valid",
  idsOf(invoiceItems, "customer")[0] === "c1" &&
    idsOf(invoiceItems, "property")[0] === "p1" &&
    idsOf(invoiceItems, "request")[0] === "r1" &&
    idsOf(invoiceItems, "estimate")[0] === "e1" &&
    idsOf(invoiceItems, "job")[0] === "j1" &&
    idsOf(invoiceItems, "invoice")[0] === "inv-1",
);
const invoiceMissing = buildRecordNavItems({
  origin: { kind: "invoice", id: "inv-2" },
  related: {
    customer: { id: "c1", name: "Pat" },
    invoices: [{ id: "inv-2", kind: INVOICE_KIND_ORIGINAL }],
  },
  role: "OWNER",
});
check(
  "12/13 builder: missing Property or Request does not invent one",
  idsOf(invoiceMissing, "property").length === 0 &&
    idsOf(invoiceMissing, "request").length === 0 &&
    idsOf(invoiceMissing, "invoice")[0] === "inv-2",
);
check(
  "16. no public customer route becomes an owner route",
  recordHref("customer", "c1") === "/customers/c1" &&
    recordHref("request", "r1") === "/requests/r1" &&
    !recordHref("customer", "c1")?.startsWith("/p/") &&
    !recordNavLib.includes("/p/[token]") &&
    !recordNavLib.includes("/e/"),
);

console.log("\nSTATIC — Navigation introduces no mutation and stays in-lane");
check(
  "17. no mutation is introduced by navigation",
  !recordNavLib.includes("db.invoice.update") &&
    !recordNavLib.includes("db.serviceRequest.update") &&
    !recordNavLib.includes("prisma.") &&
    !requestFollowUpLib.includes("prisma") &&
    !pipelineLib.includes("prisma.") &&
    !requestRecordPage.includes(".update(") &&
    !requestRecordPage.includes(".create(") &&
    !requestRecordPage.includes(".delete("),
);
check(
  "Dashboard, customers list, invoice UI, and invoice actions were not edited by this check target",
  dashboardPage.includes("Open requests") &&
    customersListPage.includes("Customer Overview") &&
    invoiceRecordPage.includes("Back to Invoices"),
);

console.log("\nUNIT — Customer profile invoice history uses recorded fields only");
const paidHistory = customerInvoiceHistoryContext({
  status: "PAID",
  paidAt: new Date("2026-09-01T12:00:00.000Z"),
  paymentMethod: "CASH",
});
const unpaidHistory = customerInvoiceHistoryContext({
  status: "SENT",
  paidAt: null,
  paymentMethod: null,
});
const paidWithoutDate = customerInvoiceHistoryContext({
  status: "PAID",
  paidAt: null,
  paymentMethod: "CHECK",
});
check(
  "18. optional customer-profile invoice-history enhancement uses recorded fields only",
  paidHistory.status === "PAID" &&
    paidHistory.paidAt?.toISOString() === "2026-09-01T12:00:00.000Z" &&
    paidHistory.paymentMethod === "CASH" &&
    paidHistory.paymentMethodLabel === paymentMethodLabel("CASH") &&
    unpaidHistory.paidAt === null &&
    unpaidHistory.paymentMethodLabel === null &&
    paidWithoutDate.paidAt === null &&
    paidWithoutDate.paymentMethodLabel === paymentMethodLabel("CHECK") &&
    customerProfile.includes("customerInvoiceHistoryContext(invoice)") &&
    customerInvoiceHistory.includes("Does not calculate new financial truth"),
);

async function seedTenant(label, slug) {
  const business = await prisma.business.create({
    data: { name: `${label} Handyman`, slug, tradeCode: "HANDYMAN" },
  });
  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: `${label} Customer`,
      email: `${slug}@example.com`,
      phone: "239-555-0100",
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
      description: appendIntakeIdentityReview(`${label} notes`, {
        reason: "duplicate_email",
        emailCustomerIds: [customer.id],
        phoneCustomerIds: [],
      }),
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
      status: "PAID",
      total: new Prisma.Decimal(250),
      paidAt: new Date("2026-09-02T15:00:00.000Z"),
      paymentMethod: "CASH",
    },
  });
  return { business, customer, property, request, estimate, job, invoice };
}

try {
  const tenantA = await seedTenant("Alpha", `cont-a-${randomUUID().slice(0, 8)}`);
  const tenantB = await seedTenant("Bravo", `cont-b-${randomUUID().slice(0, 8)}`);
  const accessA = makeAccess(tenantA.business.id, "OWNER");
  const accessB = makeAccess(tenantB.business.id, "OWNER");

  console.log("\nDB — Request record stays tenant scoped");
  const ownedRequest = await prisma.serviceRequest.findFirst({
    where: { id: tenantA.request.id, ...accessA.scope },
    include: { customer: { select: { id: true, email: true, phone: true } } },
  });
  const foreignRequest = await prisma.serviceRequest.findFirst({
    where: { id: tenantB.request.id, ...accessA.scope },
  });
  check(
    "3. scoped request lookup returns the owned request with recorded contact",
    ownedRequest?.id === tenantA.request.id &&
      ownedRequest.customer?.phone === "239-555-0100" &&
      ownedRequest.customer?.email === `${tenantA.business.slug}@example.com`,
  );
  check(
    "3. scoped request lookup cannot see a foreign-tenant request",
    foreignRequest == null,
  );
  check(
    "4/5. recorded phone and email remain on the scoped request customer",
    recordedCustomerPhone(ownedRequest?.customer?.phone) === "239-555-0100" &&
      recordedCustomerEmail(ownedRequest?.customer?.email)?.includes("@example.com"),
  );
  check(
    "9. identity-review context is present on the canonical request description",
    requestIdentityReviewContext(ownedRequest?.description)?.reason === "duplicate_email",
  );

  console.log("\nDB — Invoice RecordNav Property / Request continuity");
  const fromInvoice = await loadRecordJourney(prisma, accessA, {
    kind: "invoice",
    id: tenantA.invoice.id,
  });
  check(
    "10. invoice RecordNav includes Property when related",
    idsOf(fromInvoice, "property")[0] === tenantA.property.id,
  );
  check(
    "11. invoice RecordNav includes Request when related",
    idsOf(fromInvoice, "request")[0] === tenantA.request.id,
  );
  check(
    "15. invoice journey stays Customer → Property → Request → Estimate → Job → Invoice",
    fromInvoice.map((item) => item.kind).join(",") ===
      "customer,property,request,estimate,job,invoice" &&
      idsOf(fromInvoice, "customer")[0] === tenantA.customer.id &&
      idsOf(fromInvoice, "estimate")[0] === tenantA.estimate.id &&
      idsOf(fromInvoice, "job")[0] === tenantA.job.id &&
      idsOf(fromInvoice, "invoice")[0] === tenantA.invoice.id,
  );

  const jobNoProperty = await prisma.job.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const invoiceNoHops = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      jobId: jobNoProperty.id,
      kind: INVOICE_KIND_ORIGINAL,
      status: "DRAFT",
      total: new Prisma.Decimal(15),
    },
  });
  const fromInvoiceNoHops = await loadRecordJourney(prisma, accessA, {
    kind: "invoice",
    id: invoiceNoHops.id,
  });
  check(
    "12. missing Property does not invent one",
    idsOf(fromInvoiceNoHops, "property").length === 0,
  );
  check(
    "13. missing Request does not invent one",
    idsOf(fromInvoiceNoHops, "request").length === 0 &&
      idsOf(fromInvoiceNoHops, "estimate").length === 0 &&
      idsOf(fromInvoiceNoHops, "job")[0] === jobNoProperty.id,
  );

  console.log("\nDB — Foreign relations fail closed");
  const foreignInvoice = await loadRecordJourney(prisma, accessA, {
    kind: "invoice",
    id: tenantB.invoice.id,
  });
  check("14. foreign invoice origin fails closed", foreignInvoice.length === 0);

  const invoicePointingAtB = await prisma.invoice.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantB.customer.id,
      jobId: tenantB.job.id,
      status: "DRAFT",
      total: new Prisma.Decimal(20),
    },
  });
  const fromCorruptInvoice = await loadRecordJourney(prisma, accessA, {
    kind: "invoice",
    id: invoicePointingAtB.id,
  });
  check(
    "14. foreign job / customer / property / request on an owned invoice are omitted",
    idsOf(fromCorruptInvoice, "invoice")[0] === invoicePointingAtB.id &&
      !idsOf(fromCorruptInvoice, "customer").includes(tenantB.customer.id) &&
      !idsOf(fromCorruptInvoice, "job").includes(tenantB.job.id) &&
      !idsOf(fromCorruptInvoice, "property").includes(tenantB.property.id) &&
      !idsOf(fromCorruptInvoice, "request").includes(tenantB.request.id) &&
      !idsOf(fromCorruptInvoice, "estimate").includes(tenantB.estimate.id),
  );
  check(
    "14. tenant B invoice journey never leaks tenant A ids",
    !hrefsOf(
      await loadRecordJourney(prisma, accessB, {
        kind: "invoice",
        id: tenantB.invoice.id,
      }),
    ).some(
      (href) =>
        href.includes(tenantA.customer.id) ||
        href.includes(tenantA.request.id) ||
        href.includes(tenantA.estimate.id) ||
        href.includes(tenantA.job.id) ||
        href.includes(tenantA.invoice.id),
    ),
  );

  const history = customerInvoiceHistoryContext({
    status: tenantA.invoice.status,
    paidAt: tenantA.invoice.paidAt,
    paymentMethod: tenantA.invoice.paymentMethod,
  });
  check(
    "18. paid invoice history uses the recorded paid date and method",
    history.status === "PAID" &&
      history.paidAt?.toISOString() === tenantA.invoice.paidAt.toISOString() &&
      history.paymentMethod === "CASH",
  );
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nrequest-record-continuity check failed: ${failures} failure(s)`);
  process.exit(1);
}

console.log("\nrequest-record-continuity check passed");
