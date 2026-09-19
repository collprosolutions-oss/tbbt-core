/**
 * Company/business notification when a homeowner submits a public request.
 *
 * Proves the tenant's configured Business.publicEmail is the recipient,
 * never the customer's email, and that a missing/unusable customer email
 * is not treated as the company-notification bug.
 *
 * Does not call Resend.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-request-company-notify.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { createPublicServiceRequest } = await import("@/lib/public-intake");
const {
  buildNewRequestCompanyEmail,
  requestedWorkForCompanyEmail,
} = await import("@/lib/request-mail");
const {
  notifyBusinessNewPublicRequest,
  resolveBusinessNotificationEmail,
} = await import("@/lib/request-notify");
const { newRequestCompanyEmailIdempotencyKey } = await import("@/lib/mail");

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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function capturingSend() {
  const sent = [];
  return {
    sent,
    async send(input) {
      sent.push(input);
      return { id: "msg_test" };
    },
  };
}

function testConfig() {
  return {
    apiKey: "re_test_placeholder",
    fromAddress: "notify@tbbt.test",
    appUrl: "https://www.collproreno.com",
  };
}

function fakeNotifyDb({ businesses, requests }) {
  return {
    business: {
      async findUnique({ where }) {
        return businesses.find((row) => row.id === where.id) ?? null;
      },
    },
    serviceRequest: {
      async findFirst({ where }) {
        return (
          requests.find(
            (row) => row.id === where.id && row.businessId === where.businessId,
          ) ?? null
        );
      },
    },
  };
}

const intakeSrc = readRepo("src/app/actions/intake.ts");
const notifySrc = readRepo("src/lib/request-notify.ts");
const mailSrc = readRepo("src/lib/mail.ts");
const publicIntakeSrc = readRepo("src/lib/public-intake.ts");

console.log("\nSTATIC — Company notify is wired after persist, tenant-scoped");
check(
  "Public submit persists the request before company notify",
  intakeSrc.indexOf("createPublicServiceRequest(prisma") <
    intakeSrc.indexOf("notifyBusinessNewPublicRequest(prisma") &&
    intakeSrc.includes("if (!created.ok)") &&
    intakeSrc.indexOf("if (!created.ok)") <
      intakeSrc.indexOf("notifyBusinessNewPublicRequest(prisma"),
);
check(
  "Company notify looks up the tenant by the public slug, not a form businessId",
  intakeSrc.includes("where: { slug: safeSlug }") &&
    intakeSrc.includes("businessId: notifyBusiness.id") &&
    publicIntakeSrc.includes("Ignored if present. Browser-supplied businessId is never authorization."),
);
check(
  "Notify failure cannot fail public submit",
  intakeSrc.includes("Request already persisted. Company email must not fail submit."),
);
check(
  "Recipient is Business.publicEmail only",
  notifySrc.includes("resolveBusinessNotificationEmail(business?.publicEmail)") &&
    notifySrc.includes("to: recipient") &&
    notifySrc.includes("kind: \"request\""),
);
check(
  "Customer email is never the send target",
  !notifySrc.includes("to: request.customer") &&
    !notifySrc.includes("customer.email") &&
    !/to:\s*request\.customer\?\.email/.test(notifySrc),
);
check(
  "Send still goes through Resend config helpers",
  notifySrc.includes("getMailConfig") &&
    mailSrc.includes("process.env.RESEND_API_KEY") &&
    mailSrc.includes("process.env.EMAIL_FROM") &&
    mailSrc.includes("newRequestCompanyEmailIdempotencyKey"),
);
check(
  "Idempotency is per request so retries do not double-mail",
  newRequestCompanyEmailIdempotencyKey("req-1") ===
    newRequestCompanyEmailIdempotencyKey("req-1") &&
    newRequestCompanyEmailIdempotencyKey("req-1") !==
      newRequestCompanyEmailIdempotencyKey("req-2"),
);

console.log("\nUNIT — Configured business notification email source");
check(
  "Usable publicEmail is the company recipient",
  resolveBusinessNotificationEmail("  Owner@Handy.test ") === "Owner@Handy.test",
);
check(
  "Missing publicEmail is not a recipient",
  resolveBusinessNotificationEmail(null) === null &&
    resolveBusinessNotificationEmail("") === null,
);
check(
  "Unusable publicEmail is not a recipient",
  resolveBusinessNotificationEmail("not-an-email") === null,
);

const companyEmail = buildNewRequestCompanyEmail({
  businessName: "Handy Handyman Services",
  customerName: "Fake Test Customer",
  customerPhone: "555-0100",
  customerEmail: "not-an-email",
  address: "12 Oak St\nReno, NV\n89501",
  requestedWork: "Ceiling Fan Replacement",
  notes: "Please come Tuesday",
  requestsUrl: "https://www.collproreno.com/requests",
});
check(
  "Company subject names the tenant",
  companyEmail.subject === "New service request for Handy Handyman Services",
);
check(
  "Company body still works when the customer email is unusable",
  companyEmail.text.includes("Fake Test Customer") &&
    companyEmail.text.includes("Ceiling Fan Replacement") &&
    !companyEmail.text.includes("Customer email") &&
    !companyEmail.text.includes("not-an-email"),
);
check(
  "Company email links to owner requests, not a customer portal",
  companyEmail.text.includes("https://www.collproreno.com/requests") &&
    !companyEmail.text.includes("/e/") &&
    !companyEmail.text.includes("/p/"),
);
check(
  "Requested work helper uses stored labels",
  requestedWorkForCompanyEmail({
    items: [
      {
        quantity: 1,
        customDescription: null,
        serviceCatalogItem: { name: "Ceiling Fan Replacement" },
      },
    ],
    summary: "ignored when items exist",
  }) === "1 × Ceiling Fan Replacement",
);

console.log("\nUNIT — Tenant isolation of the company recipient");
const tenantA = {
  id: "biz_a",
  name: "Handy Handyman Services",
  publicEmail: "owner-a@handy-a.test",
};
const tenantB = {
  id: "biz_b",
  name: "Other Handyman",
  publicEmail: "owner-b@handy-b.test",
};
const requestA = {
  id: "req_a",
  businessId: "biz_a",
  summary: "Ceiling Fan Replacement",
  description: "Please come Tuesday",
  customer: {
    name: "Fake Test Customer",
    email: "not-an-email",
    phone: "555-0100",
  },
  property: {
    addressLine1: "12 Oak St",
    addressLine2: null,
    city: "Reno",
    region: "NV",
    postalCode: "89501",
  },
  items: [
    {
      customDescription: null,
      quantity: 1,
      serviceCatalogItem: { name: "Ceiling Fan Replacement" },
    },
  ],
  serviceCatalogItem: { name: "Ceiling Fan Replacement" },
};
const isolated = capturingSend();
const isolatedResult = await notifyBusinessNewPublicRequest(
  fakeNotifyDb({ businesses: [tenantA, tenantB], requests: [requestA] }),
  { businessId: tenantA.id, requestId: requestA.id },
  { getConfig: testConfig, send: isolated.send },
);
check(
  "New public request notifies that tenant's publicEmail",
  isolatedResult.sent === true &&
    isolatedResult.to === "owner-a@handy-a.test" &&
    isolated.sent.length === 1 &&
    isolated.sent[0].to === "owner-a@handy-a.test",
);
check(
  "Company recipient is not the fake customer address",
  isolated.sent[0].to !== "not-an-email" &&
    isolated.sent[0].kind === "request",
);
check(
  "Sibling tenant inbox is not copied",
  isolated.sent[0].to !== tenantB.publicEmail &&
    isolated.sent.every((row) => row.to !== tenantB.publicEmail),
);

const cross = capturingSend();
const crossResult = await notifyBusinessNewPublicRequest(
  fakeNotifyDb({ businesses: [tenantA, tenantB], requests: [requestA] }),
  { businessId: tenantB.id, requestId: requestA.id },
  { getConfig: testConfig, send: cross.send },
);
check(
  "Foreign tenant id cannot notify using another tenant's request",
  crossResult.sent === false &&
    crossResult.skipped === "request_not_found" &&
    cross.sent.length === 0,
);

const missingCustomerEmail = capturingSend();
const missingCustomerResult = await notifyBusinessNewPublicRequest(
  fakeNotifyDb({
    businesses: [tenantA],
    requests: [
      {
        ...requestA,
        customer: { name: "Fake Test Customer", email: null, phone: "555-0100" },
      },
    ],
  }),
  { businessId: tenantA.id, requestId: requestA.id },
  { getConfig: testConfig, send: missingCustomerEmail.send },
);
check(
  "Missing customer email still notifies the company",
  missingCustomerResult.sent === true &&
    missingCustomerResult.to === tenantA.publicEmail &&
    missingCustomerEmail.sent[0].to === tenantA.publicEmail,
);

const noCompany = capturingSend();
const noCompanyResult = await notifyBusinessNewPublicRequest(
  fakeNotifyDb({
    businesses: [{ ...tenantA, publicEmail: null }],
    requests: [requestA],
  }),
  { businessId: tenantA.id, requestId: requestA.id },
  { getConfig: testConfig, send: noCompany.send },
);
check(
  "No configured business email skips send instead of using the customer",
  noCompanyResult.sent === false &&
    noCompanyResult.skipped === "no_business_email" &&
    noCompany.sent.length === 0,
);

const unconfigured = capturingSend();
const unconfiguredResult = await notifyBusinessNewPublicRequest(
  fakeNotifyDb({ businesses: [tenantA], requests: [requestA] }),
  { businessId: tenantA.id, requestId: requestA.id },
  {
    getConfig: () => ({ error: "Email delivery is not configured" }),
    send: unconfigured.send,
  },
);
check(
  "Unconfigured Resend skips company notify without throwing",
  unconfiguredResult.sent === false &&
    unconfiguredResult.skipped === "not_configured" &&
    unconfigured.sent.length === 0,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run persist proof.");
  process.exit(1);
}

const testDbName = `tbbt_request_company_notify_${randomUUID().slice(0, 8)}`;
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
  console.error("Failed to push schema for request-company-notify test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — New tenant persist + company recipient isolation");
  const handy = await prisma.business.create({
    data: {
      name: "Handy Handyman Services",
      slug: "handy-handyman-services",
      tradeCode: "HANDYMAN",
      publicEmail: "owner@handy-handyman.test",
    },
  });
  const other = await prisma.business.create({
    data: {
      name: "Other Handyman Co",
      slug: "other-handyman-co",
      tradeCode: "HANDYMAN",
      publicEmail: "owner@other-handyman.test",
    },
  });
  const fan = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handy.id,
      name: "Ceiling Fan Replacement",
      category: "Fans & Fixtures",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(180),
      active: true,
    },
  });
  const shelf = await prisma.serviceCatalogItem.create({
    data: {
      businessId: other.id,
      name: "Shelf Install",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(90),
      active: true,
    },
  });

  const created = await createPublicServiceRequest(prisma, {
    slug: "handy-handyman-services",
    businessId: other.id,
    name: "Fake Test Customer",
    email: "not-an-email",
    phone: "555-0100",
    address: "",
    streetAddress: "12 Oak St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Please come Tuesday",
    catalogItemIds: [fan.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Homeowner public request persists", created.ok === true);

  const stored = created.ok
    ? await prisma.serviceRequest.findFirst({
        where: { id: created.requestId },
        select: {
          id: true,
          businessId: true,
          customer: { select: { email: true, name: true } },
        },
      })
    : null;
  check(
    "Request persists to the slug tenant, not a forged businessId",
    stored?.businessId === handy.id && stored?.businessId !== other.id,
  );
  check(
    "Fake customer email is stored as submitted and is not usable",
    stored?.customer?.email === "not-an-email",
  );

  const dbSend = capturingSend();
  const dbNotify = created.ok
    ? await notifyBusinessNewPublicRequest(
        prisma,
        { businessId: handy.id, requestId: created.requestId },
        { getConfig: testConfig, send: dbSend.send },
      )
    : { sent: false };
  check(
    "Notification is addressed to that tenant's configured business email",
    dbNotify.sent === true &&
      dbNotify.to === "owner@handy-handyman.test" &&
      dbSend.sent.length === 1 &&
      dbSend.sent[0].to === "owner@handy-handyman.test" &&
      dbSend.sent[0].to !== stored?.customer?.email &&
      dbSend.sent[0].to !== other.publicEmail &&
      dbSend.sent[0].subject.includes("Handy Handyman Services"),
  );

  const otherSend = capturingSend();
  const otherNotify = created.ok
    ? await notifyBusinessNewPublicRequest(
        prisma,
        { businessId: other.id, requestId: created.requestId },
        { getConfig: testConfig, send: otherSend.send },
      )
    : { sent: true };
  check(
    "Other tenant cannot be notified for this request",
    otherNotify.sent === false && otherSend.sent.length === 0,
  );

  const otherCreated = await createPublicServiceRequest(prisma, {
    slug: "other-handyman-co",
    name: "Other Homeowner",
    email: "",
    phone: "555-0199",
    address: "10 Main St",
    notes: "",
    catalogItemIds: [shelf.id],
    includeOther: false,
    otherDescription: "",
  });
  const otherStored = otherCreated.ok
    ? await prisma.serviceRequest.findFirst({
        where: { id: otherCreated.requestId },
        select: { businessId: true, customer: { select: { email: true } } },
      })
    : null;
  const otherTenantSend = capturingSend();
  const otherTenantNotify = otherCreated.ok
    ? await notifyBusinessNewPublicRequest(
        prisma,
        { businessId: other.id, requestId: otherCreated.requestId },
        { getConfig: testConfig, send: otherTenantSend.send },
      )
    : { sent: false };
  check(
    "A second tenant's request notifies only that tenant's publicEmail",
    otherCreated.ok === true &&
      otherStored?.businessId === other.id &&
      otherStored?.customer?.email == null &&
      otherTenantNotify.to === "owner@other-handyman.test" &&
      otherTenantSend.sent[0]?.to === "owner@other-handyman.test" &&
      otherTenantSend.sent[0]?.to !== handy.publicEmail,
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

console.log(
  failed === 0
    ? `\nAll request-company-notify checks passed (${passed}).`
    : `\n${failed} request-company-notify check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
