/**
 * OWNER-only tenant-scoped customer-records export proofs.
 *
 * Covers authorization, isolation, completeness, pagination/limits,
 * secret omission, and private-file references on a dedicated local
 * test database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customer-records-export.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  CUSTOMER_RECORDS_EXPORT_CONTRACT,
  CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
  CUSTOMER_RECORDS_EXPORT_OMISSIONS,
  CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
  CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  CUSTOMER_RECORDS_EXPORT_VERSION,
  PRIVATE_FILE_OMISSION,
  boundExportRead,
  buildCustomerRecordsExport,
  canExportCustomerRecords,
  customerRecordsExportFileTruncationMessage,
  customerRecordsExportFilename,
  customerRecordsExportPageTruncationMessage,
  listExportableCustomerRecords,
  parseCustomerRecordsExport,
  serializeCustomerRecordsExport,
} = await import("@/lib/customer-records-export");
const { CustomerRecordsExportError } = await import("@/lib/customer-records-export/access");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_customer_records_export_test";
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
  console.error("Failed to push schema for customer-records export test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "Export Tenant" },
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

async function expectRejects(label, fn, isExpected) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

const contractSrc = readRepo("src/lib/customer-records-export/contract.ts");
const buildSrc = readRepo("src/lib/customer-records-export/build.ts");
const parseSrc = readRepo("src/lib/customer-records-export/parse.ts");
const accessSrc = readRepo("src/lib/customer-records-export/access.ts");
const pageSrc = readRepo("src/app/(app)/customers/records-export/page.tsx");
const downloadSrc = readRepo("src/app/(app)/customers/records-export/download/route.ts");
const panelSrc = readRepo("src/components/customers/customer-records-export-panel.tsx");
const customersPageSrc = readRepo("src/app/(app)/customers/page.tsx");
const customerProfileSrc = readRepo("src/app/(app)/customers/[customerId]/page.tsx");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const businessExportSrc = readRepo("src/lib/business-export.ts");
const accountingExportSrc = readRepo("src/lib/accounting-export.ts");
const csvButtonSrc = readRepo("src/components/customers/export-customers-button.tsx");
const authSrc = readRepo("src/lib/authorization.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const navSrc = readRepo("src/lib/nav.ts");
const packageSrc = readRepo("package.json");

const SECRET_MARKERS = [
  "publicToken",
  "projectToken",
  "stripeCheckoutSessionId",
  "stripePaymentIntentId",
  "propertyAccessInstructions",
  "passwordHash",
  "totpSecret",
  "storageKey",
];

console.log("\nSTATIC — inspect existing exports, then OWNER-only customer records");
check(
  "Existing business ZIP, accounting ZIP, and customers CSV remain",
  businessExportSrc.includes("buildBusinessExportZip") &&
    accountingExportSrc.includes("buildAccountingExportZip") &&
    csvButtonSrc.includes("ExportCustomersButton") &&
    customersPageSrc.includes("ExportCustomersButton"),
);
check(
  "OWNER may export customer records; ADMIN and MEMBER cannot",
  canExportCustomerRecords("OWNER") &&
    !canExportCustomerRecords("ADMIN") &&
    !canExportCustomerRecords("MEMBER"),
);
check(
  "Contract is versioned tbbt.customer-records.v1",
  CUSTOMER_RECORDS_EXPORT_CONTRACT === "tbbt.customer-records.v1" &&
    CUSTOMER_RECORDS_EXPORT_VERSION === 1 &&
    contractSrc.includes("tbbt.customer-records.v1"),
);
check(
  "Builder scopes every load by access.businessId and asserts ownership",
  buildSrc.includes("where: { id: cursor, businessId }") &&
    buildSrc.includes("where: { id: customerId, businessId }") &&
    buildSrc.includes("where: { businessId, customerId: customer.id }") &&
    buildSrc.includes("access.assertOwned(customer)") &&
    buildSrc.includes("access.assertOwned(row)") &&
    buildSrc.includes("access.assertOwned(photo)"),
);
check(
  "Secrets, portal tokens, Stripe ids, access codes, and storage keys are never selected",
  SECRET_MARKERS.every((marker) => !buildSrc.includes(marker)) &&
    !buildSrc.includes("url: true") &&
    buildSrc.includes("PRIVATE_FILE_OMISSION"),
);
check(
  "Dedicated page and download route stay OWNER-gated",
  pageSrc.includes("canExportCustomerRecords") &&
    pageSrc.includes("buildCustomerRecordsExport") &&
    downloadSrc.includes("buildCustomerRecordsExport") &&
    downloadSrc.includes("Cache-Control") &&
    downloadSrc.includes("no-store"),
);
check(
  "Settings and customer surfaces expose the OWNER export without a new global nav item",
  settingsSrc.includes("/customers/records-export") &&
    settingsSrc.includes("CUSTOMER_RECORDS_EXPORT_MESSAGE") &&
    settingsSrc.includes('role === "OWNER"') &&
    customersPageSrc.includes("/customers/records-export") &&
    customerProfileSrc.includes("/customers/records-export?customerId=") &&
    !navSrc.includes("records-export"),
);
check(
  "No new capability, schema table, or shared-database claim",
  !authSrc.includes("EXPORT_CUSTOMER_RECORDS") &&
    !schemaSrc.includes("CustomerRecordsExport") &&
    !buildSrc.includes("liveSynchronization: true") &&
    packageSrc.includes("test:customer-records-export"),
);
check(
  "Parser rejects live sync, shared database, non-OWNER authorization, and file bytes",
  parseSrc.includes("limits.liveSynchronization must be false") &&
    parseSrc.includes("limits.sharedDatabase must be false") &&
    parseSrc.includes('asExactString(value.role, "OWNER"') &&
    parseSrc.includes('assertAbsent(value, `${label}`, FORBIDDEN_FILE_KEYS)') &&
    parseSrc.includes("publicToken") &&
    parseSrc.includes("stripeCheckoutSessionId"),
);
check(
  "Access helper is OWNER-only and does not invent ADMIN export",
  accessSrc.includes('return role === "OWNER"') && accessSrc.includes('requireBusinessRole(access, "OWNER")'),
);
check(
  "Customer pages and related/file reads are bounded and detect one extra row",
  CUSTOMER_RECORDS_EXPORT_PAGE_SIZE === 25 &&
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT === 50 &&
    CUSTOMER_RECORDS_EXPORT_FILE_LIMIT === 40 &&
    buildSrc.includes("take: CUSTOMER_RECORDS_EXPORT_PAGE_SIZE + 1") &&
    buildSrc.includes("take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1") &&
    buildSrc.includes("take: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT + 1") &&
    buildSrc.includes("boundExportRead"),
);
check(
  "UI shows pagination and file-reference honesty",
  panelSrc.includes("customerRecordsExportPageTruncationMessage") &&
    panelSrc.includes("customerRecordsExportFileTruncationMessage") &&
    panelSrc.includes("document.provenance.page.truncated"),
);
check(
  "boundExportRead keeps the cap and marks overflow",
  boundExportRead(["a", "b", "c"], 2).truncated === true &&
    boundExportRead(["a", "b", "c"], 2).items.join(",") === "a,b" &&
    boundExportRead(["a", "b"], 2).truncated === false,
);

try {
  console.log("\nDB — authorization, isolation, completeness, limits");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Records", slug: `alpha-cre-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Records", slug: `beta-cre-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerA = await prisma.user.create({
    data: { name: "Olivia", email: `owner-cre-${randomUUID()}@example.com`, passwordHash: "hashed-owner-secret" },
  });
  const adminA = await prisma.user.create({
    data: { name: "Ada", email: `admin-cre-${randomUUID()}@example.com`, passwordHash: "hashed-admin-secret" },
  });
  const memberA = await prisma.user.create({
    data: { name: "Mia", email: `member-cre-${randomUUID()}@example.com`, passwordHash: "hashed-member-secret" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "Bea", email: `beta-cre-${randomUUID()}@example.com`, passwordHash: "hashed-beta-secret" },
  });
  const ownerMemA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMemA = await prisma.membership.create({
    data: { userId: adminA.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMemA = await prisma.membership.create({
    data: { userId: memberA.id, businessId: businessA.id, role: "MEMBER" },
  });
  const ownerMemB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });

  const customerA = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Pat Alpha",
      email: "pat-alpha@example.com",
      phone: "555-0100",
      firstLeadSource: "WEBSITE",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const overflowCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Overflow Alpha",
      email: "overflow-alpha@example.com",
      createdAt: new Date("2020-01-02T00:00:00.000Z"),
    },
  });
  const customerB = await prisma.customer.create({
    data: {
      businessId: businessB.id,
      name: "Beta Secret",
      email: "beta-secret@example.com",
      phone: "555-0199",
    },
  });

  const requestA1 = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "OPEN",
      summary: "Fix door",
      description: "Front door sticks",
      leadSource: "WEBSITE",
    },
  });
  const requestA2 = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "CONVERTED",
      summary: "Paint trim",
    },
  });
  const requestB = await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "OPEN",
      summary: "Beta only request",
    },
  });
  const requestCross = await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: customerA.id,
      status: "OPEN",
      summary: "Cross-tenant planted request",
    },
  });
  const requestMismatchedOwner = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerB.id,
      status: "OPEN",
      summary: "Wrong-customer planted request",
    },
  });

  const estimateToken = `est-secret-${randomUUID()}`;
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      serviceRequestId: requestA1.id,
      status: "SENT",
      total: "125.50",
      publicToken: estimateToken,
    },
  });
  const estimateB = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "DRAFT",
      total: "999.00",
      publicToken: `beta-est-${randomUUID()}`,
    },
  });

  const projectToken = `portal-secret-${randomUUID()}`;
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      estimateId: estimateA.id,
      status: "COMPLETED",
      serviceIntent: "ONE_TIME",
      projectToken,
      propertyAccessInstructions: "Key under mat. Code 4321.",
      propertyAccessContactInfo: "Neighbor 555-0111",
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "COMPLETED",
      projectToken: `beta-portal-${randomUUID()}`,
    },
  });

  const invoiceA = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      jobId: jobA.id,
      kind: "ORIGINAL",
      status: "SENT",
      total: "125.50",
      paymentMethod: "CHECK",
      paymentReference: "1001",
    },
  });
  const invoiceB = await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      status: "SENT",
      total: "888.00",
    },
  });

  const stripeSession = `cs_test_${randomUUID()}`;
  const paymentA = await prisma.payment.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      invoiceId: invoiceA.id,
      jobId: jobA.id,
      purpose: "INVOICE_BALANCE",
      amount: "40.00",
      method: "CHECK",
      note: "Partial",
      stripeCheckoutSessionId: stripeSession,
      stripePaymentIntentId: `pi_${randomUUID()}`,
    },
  });
  const paymentB = await prisma.payment.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      invoiceId: invoiceB.id,
      purpose: "INVOICE_BALANCE",
      amount: "888.00",
      method: "CASH",
    },
  });

  const photoUrl = `https://secret-storage.example/private-${randomUUID()}.jpg`;
  const photoA = await prisma.serviceRequestPhoto.create({
    data: {
      businessId: businessA.id,
      serviceRequestId: requestA1.id,
      url: photoUrl,
    },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      stage: "AFTER",
      caption: "Finished lockset",
      url: `https://secret-storage.example/job-${randomUUID()}.jpg`,
      marketingPermissionStatus: "PRIVATE",
    },
  });
  await prisma.serviceRequestPhoto.create({
    data: {
      businessId: businessB.id,
      serviceRequestId: requestB.id,
      url: "https://secret-storage.example/beta-only.jpg",
    },
  });

  const overflowRequests = await Promise.all(
    Array.from({ length: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1 }, (_, index) =>
      prisma.serviceRequest.create({
        data: {
          businessId: businessA.id,
          customerId: overflowCustomer.id,
          status: "OPEN",
          summary: `Overflow request ${index + 1}`,
          createdAt: new Date(Date.UTC(2024, 0, 1 + index)),
        },
      }),
    ),
  );

  const extraCustomers = [];
  for (let index = 0; index < CUSTOMER_RECORDS_EXPORT_PAGE_SIZE; index += 1) {
    extraCustomers.push(
      await prisma.customer.create({
        data: {
          businessId: businessA.id,
          name: `Extra ${String(index + 1).padStart(2, "0")}`,
          createdAt: new Date(Date.UTC(2025, 0, 1 + index)),
        },
      }),
    );
  }

  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id);

  await expectRejects(
    "ADMIN cannot export customer records",
    () => buildCustomerRecordsExport(prisma, adminAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot export customer records",
    () => buildCustomerRecordsExport(prisma, memberAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "ADMIN cannot list exportable customer records",
    () => listExportableCustomerRecords(prisma, adminAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "OWNER cannot export another business's customer by id",
    () => buildCustomerRecordsExport(prisma, ownerAccessA, { customerId: customerB.id }),
    (error) => error instanceof CustomerRecordsExportError && error.code === "NOT_FOUND",
  );
  await expectRejects(
    "OWNER cannot page from another business's customer cursor",
    () => buildCustomerRecordsExport(prisma, ownerAccessA, { cursor: customerB.id }),
    (error) => error instanceof CustomerRecordsExportError && error.code === "INVALID",
  );

  const pageOne = await buildCustomerRecordsExport(prisma, ownerAccessA);
  const pageOneJson = serializeCustomerRecordsExport(pageOne);
  const pageOneIds = pageOne.customers.map((packet) => packet.customer.id);
  const packetA = pageOne.customers.find((packet) => packet.customer.id === customerA.id);
  const overflowPacket = pageOne.customers.find((packet) => packet.customer.id === overflowCustomer.id);

  check(
    "First page is bounded and marked truncated when more customers exist",
    pageOne.provenance.page.truncated === true &&
      pageOne.provenance.page.limit === CUSTOMER_RECORDS_EXPORT_PAGE_SIZE &&
      pageOne.provenance.page.count === CUSTOMER_RECORDS_EXPORT_PAGE_SIZE &&
      pageOne.customers.length === CUSTOMER_RECORDS_EXPORT_PAGE_SIZE &&
      Boolean(pageOne.provenance.page.nextCursor) &&
      customerRecordsExportPageTruncationMessage(CUSTOMER_RECORDS_EXPORT_PAGE_SIZE).includes(
        String(CUSTOMER_RECORDS_EXPORT_PAGE_SIZE),
      ),
  );
  check(
    "First page includes the oldest same-business customers and never another tenant",
    pageOneIds.includes(customerA.id) &&
      pageOneIds.includes(overflowCustomer.id) &&
      !pageOneIds.includes(customerB.id) &&
      pageOne.customers.every((packet) => packet.customer.id !== customerB.id),
  );
  check(
    "OWNER export includes the complete related set for a customer under the cap",
    Boolean(packetA) &&
      packetA.requests.count === 2 &&
      packetA.requests.truncated === false &&
      packetA.requests.items.some((row) => row.id === requestA1.id && row.summary === "Fix door") &&
      packetA.requests.items.some((row) => row.id === requestA2.id) &&
      packetA.estimates.count === 1 &&
      packetA.estimates.items[0].id === estimateA.id &&
      packetA.estimates.items[0].total === "125.50" &&
      packetA.jobs.count === 1 &&
      packetA.jobs.items[0].id === jobA.id &&
      packetA.invoices.count === 1 &&
      packetA.invoices.items[0].id === invoiceA.id &&
      packetA.payments.count === 1 &&
      packetA.payments.items[0].id === paymentA.id &&
      packetA.payments.items[0].amount === "40.00",
  );
  check(
    "Related overflow is truncated at the related-record cap",
    Boolean(overflowPacket) &&
      overflowPacket.requests.truncated === true &&
      overflowPacket.requests.count === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.requests.items.length === CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT &&
      overflowPacket.requests.items[0].id === overflowRequests[0].id &&
      !overflowPacket.requests.items.some(
        (row) => row.id === overflowRequests[CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT].id,
      ),
  );
  check(
    "Export never includes another business's records or planted cross-tenant rows",
    !pageOneJson.includes(customerB.name) &&
      !pageOneJson.includes(customerB.email) &&
      !pageOneJson.includes(requestB.id) &&
      !pageOneJson.includes(requestCross.id) &&
      !pageOneJson.includes(requestMismatchedOwner.id) &&
      !pageOneJson.includes(estimateB.id) &&
      !pageOneJson.includes(jobB.id) &&
      !pageOneJson.includes(invoiceB.id) &&
      !pageOneJson.includes(paymentB.id) &&
      !pageOneJson.includes("Beta only request") &&
      !pageOneJson.includes("Cross-tenant planted request") &&
      !pageOneJson.includes("Wrong-customer planted request"),
  );
  check(
    "Secrets, portal tokens, Stripe ids, access codes, and private file URLs are omitted",
    !pageOneJson.includes(estimateToken) &&
      !pageOneJson.includes(projectToken) &&
      !pageOneJson.includes(stripeSession) &&
      !pageOneJson.includes("Key under mat") &&
      !pageOneJson.includes("4321") &&
      !pageOneJson.includes(photoUrl) &&
      !pageOneJson.includes("hashed-owner-secret") &&
      !pageOneJson.includes("publicToken") &&
      !pageOneJson.includes("projectToken") &&
      !pageOneJson.includes("stripeCheckoutSessionId") &&
      !pageOneJson.includes("storageKey"),
  );
  check(
    "Private files are same-business references with a labeled omission",
    packetA.files.count >= 2 &&
      packetA.files.items.some(
        (file) =>
          file.id === photoA.id &&
          file.kind === "REQUEST_PHOTO" &&
          file.relatedRequestId === requestA1.id &&
          file.status === "REFERENCE" &&
          file.omission === PRIVATE_FILE_OMISSION,
      ) &&
      packetA.files.items.every((file) => !("url" in file) && !("storageKey" in file)) &&
      CUSTOMER_RECORDS_EXPORT_OMISSIONS.some((item) => item.includes("Private file bytes")),
  );

  const pageTwo = await buildCustomerRecordsExport(prisma, ownerAccessA, {
    cursor: pageOne.provenance.page.nextCursor,
  });
  const pageTwoIds = pageTwo.customers.map((packet) => packet.customer.id);
  const allPageIds = [...pageOneIds, ...pageTwoIds];
  const expectedExtra = extraCustomers.map((row) => row.id);
  check(
    "Second page continues after the cursor with no overlap and no other tenant",
    pageTwo.provenance.page.cursor === pageOne.provenance.page.nextCursor &&
      pageTwo.provenance.page.truncated === false &&
      pageTwoIds.length > 0 &&
      pageTwoIds.every((id) => !pageOneIds.includes(id)) &&
      !pageTwoIds.includes(customerB.id) &&
      expectedExtra.every((id) => allPageIds.includes(id)) &&
      allPageIds.includes(customerA.id) &&
      allPageIds.includes(overflowCustomer.id) &&
      !allPageIds.includes(customerB.id),
  );

  const single = await buildCustomerRecordsExport(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check(
    "Single-customer export is complete for that tenant customer only",
    single.provenance.page.customerId === customerA.id &&
      single.customers.length === 1 &&
      single.customers[0].customer.id === customerA.id &&
      single.customers[0].requests.items.map((row) => row.id).sort().join(",") ===
        [requestA1.id, requestA2.id].sort().join(",") &&
      single.customers[0].payments.items[0].id === paymentA.id &&
      !serializeCustomerRecordsExport(single).includes(customerB.name),
  );

  const otherOwner = await buildCustomerRecordsExport(prisma, ownerAccessB);
  const otherJson = serializeCustomerRecordsExport(otherOwner);
  check(
    "The other OWNER only receives their own tenant's customers and related records",
    otherOwner.customers.length === 1 &&
      otherOwner.customers[0].customer.id === customerB.id &&
      otherOwner.customers[0].requests.items.some((row) => row.id === requestB.id) &&
      !otherJson.includes(customerA.name) &&
      !otherJson.includes(requestA1.id) &&
      !otherJson.includes(estimateA.id) &&
      !otherJson.includes(jobA.id) &&
      !otherJson.includes(invoiceA.id) &&
      !otherJson.includes(paymentA.id),
  );

  const roundTrip = parseCustomerRecordsExport(JSON.parse(serializeCustomerRecordsExport(single)));
  check(
    "Portable JSON round-trips through the versioned parser",
    roundTrip.contract === CUSTOMER_RECORDS_EXPORT_CONTRACT &&
      roundTrip.customers[0].customer.id === customerA.id &&
      roundTrip.customers[0].invoices.items[0].total === "125.50" &&
      roundTrip.authorization.role === "OWNER" &&
      customerRecordsExportFilename(roundTrip).includes(businessA.slug),
  );

  const listed = await listExportableCustomerRecords(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check(
    "List helper reuses the same OWNER builder and tenant counts",
    listed.customers.length === 1 &&
      listed.customers[0].customerId === customerA.id &&
      listed.customers[0].requestCount === 2 &&
      listed.customers[0].paymentCount === 1 &&
      listed.truncated === false,
  );

  await prisma.serviceRequestPhoto.createMany({
    data: Array.from({ length: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT }, (_, index) => ({
      businessId: businessA.id,
      serviceRequestId: requestA2.id,
      url: `https://secret-storage.example/overflow-${index}.jpg`,
      createdAt: new Date(Date.UTC(2024, 6, 1 + index)),
    })),
  });
  const fileLimited = await buildCustomerRecordsExport(prisma, ownerAccessA, {
    customerId: customerA.id,
  });
  check(
    "File references stop at the cap and never include overflow URLs",
    fileLimited.customers[0].files.truncated === true &&
      fileLimited.customers[0].files.count === CUSTOMER_RECORDS_EXPORT_FILE_LIMIT &&
      fileLimited.customers[0].files.items.length === CUSTOMER_RECORDS_EXPORT_FILE_LIMIT &&
      !serializeCustomerRecordsExport(fileLimited).includes("/overflow-") &&
      customerRecordsExportFileTruncationMessage(CUSTOMER_RECORDS_EXPORT_FILE_LIMIT).includes(
        String(CUSTOMER_RECORDS_EXPORT_FILE_LIMIT),
      ),
  );

  const parsedLimited = parseCustomerRecordsExport(JSON.parse(serializeCustomerRecordsExport(fileLimited)));
  check(
    "Truncated file-reference packet round-trips with the cap marked",
    parsedLimited.customers[0].files.truncated === true &&
      parsedLimited.customers[0].files.count === CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
  );

  try {
    parseCustomerRecordsExport({
      ...single,
      authorization: { ...single.authorization, role: "ADMIN" },
    });
    check("Parser rejects non-OWNER authorization", false);
  } catch (error) {
    check(
      "Parser rejects non-OWNER authorization",
      error instanceof CustomerRecordsExportError && /authorization.role/.test(error.message),
    );
  }
  try {
    parseCustomerRecordsExport({
      ...single,
      limits: { ...single.limits, liveSynchronization: true },
    });
    check("Parser rejects live synchronization", false);
  } catch (error) {
    check(
      "Parser rejects live synchronization",
      error instanceof CustomerRecordsExportError && /liveSynchronization/.test(error.message),
    );
  }
  try {
    const forged = structuredClone(single);
    forged.customers[0].files.items[0].url = photoUrl;
    parseCustomerRecordsExport(forged);
    check("Parser rejects private file URLs on references", false);
  } catch (error) {
    check(
      "Parser rejects private file URLs on references",
      error instanceof CustomerRecordsExportError && /must not include url/.test(error.message),
    );
  }
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected customer-records export test error");
  console.error(error);
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nCustomer-records export check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll customer-records export checks passed.");
