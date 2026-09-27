/**
 * OWNER-authorized completed job/property export proofs.
 *
 * Covers the versioned v1 contract, default redaction, express OWNER
 * authorization, tenant checks, and JSON round-trip parsing on a
 * dedicated test database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-job-property-export.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  JOB_PROPERTY_EXPORT_CONTRACT,
  JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS,
  JOB_PROPERTY_EXPORT_VERSION,
  buildCompletedJobPropertyExport,
  canExportCompletedJobProperty,
  jobPropertyExportFilename,
  listExportableCompletedJobProperties,
  parseJobPropertyExport,
  serializeJobPropertyExport,
} = await import("@/lib/job-property-export");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_job_property_export_test";
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
  console.error("Failed to push schema for job/property export test database.");
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

const contractSrc = readRepo("src/lib/job-property-export/contract.ts");
const buildSrc = readRepo("src/lib/job-property-export/build.ts");
const parseSrc = readRepo("src/lib/job-property-export/parse.ts");
const accessSrc = readRepo("src/lib/job-property-export/access.ts");
const pickerPageSrc = readRepo("src/app/(app)/jobs/handoff-export/page.tsx");
const exportPageSrc = readRepo("src/app/(app)/jobs/[jobId]/handoff-export/page.tsx");
const downloadSrc = readRepo("src/app/(app)/jobs/[jobId]/handoff-export/download/route.ts");
const navSrc = readRepo("src/lib/nav.ts");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const authSrc = readRepo("src/lib/authorization.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const packageSrc = readRepo("package.json");

console.log("\nSTATIC — isolated OWNER surface, contract honesty, no shared wiring");
check(
  "OWNER may export; ADMIN and MEMBER cannot",
  canExportCompletedJobProperty("OWNER") &&
    !canExportCompletedJobProperty("ADMIN") &&
    !canExportCompletedJobProperty("MEMBER"),
);
check(
  "Contract is versioned tbbt.completed-job-property.v1",
  JOB_PROPERTY_EXPORT_CONTRACT === "tbbt.completed-job-property.v1" &&
    JOB_PROPERTY_EXPORT_VERSION === 1 &&
    contractSrc.includes("tbbt.completed-job-property.v1"),
);
check(
  "Intended consumers are HQ Watchfolio and REIOS without claiming they are live",
  JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS.includes("hq-watchfolio") &&
    JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS.includes("reios") &&
    contractSrc.includes("not live synchronization") &&
    contractSrc.includes("not a shared database") &&
    !contractSrc.includes("live sync is enabled"),
);
check(
  "Builder scopes job, property, customer, and photos by access.businessId",
  buildSrc.includes("where: { id: input.jobId, businessId }") &&
    buildSrc.includes("where: { id: job.propertyId, businessId }") &&
    buildSrc.includes("where: { id: job.customerId, businessId }") &&
    buildSrc.includes("where: { jobId: job.id, businessId }") &&
    buildSrc.includes("access.assertOwned(job)") &&
    buildSrc.includes("access.assertOwned(property)"),
);
check(
  "Default load redacts customer contact and photo items",
  buildSrc.includes("includePrivateCustomer ? (customer?.name ?? null) : null") &&
    buildSrc.includes("items: includePhotos") &&
    !buildSrc.includes("propertyAccessInstructions"),
);
check(
  "Dedicated pages and download route stay OWNER-gated",
  pickerPageSrc.includes("canExportCompletedJobProperty") &&
    exportPageSrc.includes("canExportCompletedJobProperty") &&
    downloadSrc.includes("buildCompletedJobPropertyExport") &&
    downloadSrc.includes("includePrivateCustomer") &&
    downloadSrc.includes("includePhotos"),
);
check(
  "Global navigation and Settings export were not used",
  !navSrc.includes("handoff-export") &&
    !navSrc.includes("Watchfolio") &&
    !navSrc.includes("REIOS") &&
    !settingsSrc.includes("handoff-export") &&
    !settingsSrc.includes("Watchfolio"),
);
check(
  "No new capability, schema table, or shared-database claim",
  !authSrc.includes("EXPORT_JOB_PROPERTY") &&
    !schemaSrc.includes("JobPropertyExport") &&
    !schemaSrc.includes("Watchfolio") &&
    !buildSrc.includes("CREATE TABLE") &&
    !buildSrc.includes("liveSynchronization: true") &&
    packageSrc.includes("test:job-property-export"),
);
check(
  "Parser rejects live sync, shared database, and non-OWNER authorization",
  parseSrc.includes("limits.liveSynchronization must be false") &&
    parseSrc.includes("limits.sharedDatabase must be false") &&
    parseSrc.includes('asExactString(value.role, "OWNER"') &&
    parseSrc.includes("redacted customer contact fields must be null"),
);
check(
  "Access helper is OWNER-only and does not invent ADMIN export",
  accessSrc.includes('return role === "OWNER"') && accessSrc.includes('requireBusinessRole(access, "OWNER")'),
);

try {
  console.log("\nDB — tenant checks, redaction, express authorization, round-trip");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Export", slug: `alpha-jpe-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Export", slug: `beta-jpe-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerA = await prisma.user.create({
    data: { name: "Olivia", email: `owner-jpe-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminA = await prisma.user.create({
    data: { name: "Ada", email: `admin-jpe-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberA = await prisma.user.create({
    data: { name: "Mia", email: `member-jpe-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "Bea", email: `beta-jpe-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const propertyA = await prisma.property.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      label: "Alpha House",
      addressLine1: "12 Oak St",
      city: "Reno",
      region: "NV",
      postalCode: "89501",
    },
  });
  const propertyB = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      label: "Beta House",
      addressLine1: "99 Hidden Rd",
      city: "Sparks",
      region: "NV",
      postalCode: "89431",
    },
  });
  const completedA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "COMPLETED",
      serviceIntent: "ONE_TIME",
      projectToken: randomUUID(),
      propertyAccessInstructions: "Key under mat. Code 4321.",
      propertyAccessContactInfo: "Neighbor 555-0111",
    },
  });
  const inProgressA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      status: "IN_PROGRESS",
      projectToken: randomUUID(),
    },
  });
  const completedNoProperty = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const completedB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const plantedMismatch = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyB.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const photoA = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: completedA.id,
      stage: "AFTER",
      caption: "Finished lockset",
      url: "https://example.invalid/alpha-after.jpg",
      marketingPermissionStatus: "PRIVATE",
    },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: businessB.id,
      jobId: completedB.id,
      stage: "AFTER",
      caption: "Beta only photo",
      url: "https://example.invalid/beta-secret.jpg",
    },
  });

  const ownerAccessA = makeAccess(businessA.id, "OWNER", ownerMemA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", adminMemA.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memberMemA.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", ownerMemB.id);

  const listed = await listExportableCompletedJobProperties(prisma, ownerAccessA);
  check(
    "Picker lists only same-business completed jobs that have a same-business property",
    listed.some((row) => row.jobId === completedA.id && row.propertyId === propertyA.id) &&
      !listed.some((row) => row.jobId === completedB.id) &&
      !listed.some((row) => row.jobId === inProgressA.id) &&
      !listed.some((row) => row.jobId === completedNoProperty.id) &&
      !listed.some((row) => row.jobId === plantedMismatch.id),
  );

  await expectRejects(
    "ADMIN cannot list exportable jobs",
    () => listExportableCompletedJobProperties(prisma, adminAccessA),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot list exportable jobs",
    () => listExportableCompletedJobProperties(prisma, memberAccessA),
    (error) => error instanceof ForbiddenError,
  );

  const redacted = await buildCompletedJobPropertyExport(prisma, ownerAccessA, {
    jobId: completedA.id,
    includePrivateCustomer: false,
    includePhotos: false,
  });
  check(
    "Default OWNER export redacts customer name/email/phone",
    redacted.customer.included === false &&
      redacted.customer.id === customerA.id &&
      redacted.customer.name === null &&
      redacted.customer.email === null &&
      redacted.customer.phone === null &&
      !JSON.stringify(redacted).includes("Pat Alpha") &&
      !JSON.stringify(redacted).includes("pat-alpha@example.com") &&
      !JSON.stringify(redacted).includes("555-0100"),
  );
  check(
    "Default OWNER export redacts photos but records the count",
    redacted.photos.included === false &&
      redacted.photos.count === 1 &&
      redacted.photos.items.length === 0 &&
      !JSON.stringify(redacted).includes(photoA.url) &&
      !JSON.stringify(redacted).includes("Finished lockset"),
  );
  check(
    "Access instructions and foreign-tenant facts are never selected",
    !JSON.stringify(redacted).includes("Key under mat") &&
      !JSON.stringify(redacted).includes("4321") &&
      !JSON.stringify(redacted).includes("Beta Secret") &&
      !JSON.stringify(redacted).includes("99 Hidden Rd") &&
      !JSON.stringify(redacted).includes("beta-secret.jpg"),
  );
  check(
    "Provenance and property facts stay recorded on the redacted packet",
    redacted.contract === JOB_PROPERTY_EXPORT_CONTRACT &&
      redacted.job.status === "COMPLETED" &&
      redacted.job.id === completedA.id &&
      redacted.property.id === propertyA.id &&
      redacted.property.addressLine1 === "12 Oak St" &&
      redacted.provenance.businessId === businessA.id &&
      redacted.authorization.role === "OWNER" &&
      redacted.authorization.authorizedByMembershipId === ownerMemA.id &&
      redacted.limits.liveSynchronization === false &&
      redacted.limits.sharedDatabase === false &&
      redacted.limits.writesOtherRepositories === false &&
      redacted.limits.consumerIntegration === "none",
  );

  const authorized = await buildCompletedJobPropertyExport(prisma, ownerAccessA, {
    jobId: completedA.id,
    includePrivateCustomer: true,
    includePhotos: true,
  });
  check(
    "Express OWNER authorization includes private customer data and photo metadata",
    authorized.customer.included === true &&
      authorized.customer.name === "Pat Alpha" &&
      authorized.customer.email === "pat-alpha@example.com" &&
      authorized.customer.phone === "555-0100" &&
      authorized.photos.included === true &&
      authorized.photos.count === 1 &&
      authorized.photos.items[0]?.id === photoA.id &&
      authorized.photos.items[0]?.url === photoA.url &&
      authorized.photos.items[0]?.caption === "Finished lockset",
  );
  check(
    "Authorized photo packet still omits binaries and access secrets",
    !JSON.stringify(authorized).includes("Key under mat") &&
      !JSON.stringify(authorized).includes("storedAssetId") &&
      authorized.omitted.includes("Photo binaries and storage credentials"),
  );

  const serialized = serializeJobPropertyExport(redacted);
  const parsedRoundTrip = parseJobPropertyExport(JSON.parse(serialized));
  const reserialized = serializeJobPropertyExport(parsedRoundTrip);
  check(
    "Round-trip parse of the redacted packet preserves the contract",
    serialized === reserialized &&
      parsedRoundTrip.job.id === redacted.job.id &&
      parsedRoundTrip.property.id === redacted.property.id &&
      parsedRoundTrip.customer.included === false &&
      parsedRoundTrip.photos.items.length === 0,
  );
  const authorizedRoundTrip = parseJobPropertyExport(JSON.parse(serializeJobPropertyExport(authorized)));
  check(
    "Round-trip parse of the authorized packet preserves included fields",
    authorizedRoundTrip.customer.name === "Pat Alpha" &&
      authorizedRoundTrip.photos.items[0]?.url === photoA.url &&
      authorizedRoundTrip.authorization.includePrivateCustomer === true &&
      authorizedRoundTrip.authorization.includePhotos === true,
  );
  check(
    "Filename stays on the versioned contract",
    jobPropertyExportFilename(redacted).startsWith("tbbt-completed-job-property-v1-") &&
      jobPropertyExportFilename(redacted).endsWith(".json"),
  );

  await expectRejects(
    "ADMIN cannot export even with express-authorization flags",
    () =>
      buildCompletedJobPropertyExport(prisma, adminAccessA, {
        jobId: completedA.id,
        includePrivateCustomer: true,
        includePhotos: true,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot export",
    () =>
      buildCompletedJobPropertyExport(prisma, memberAccessA, {
        jobId: completedA.id,
        includePrivateCustomer: false,
        includePhotos: false,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "Foreign OWNER cannot export another tenant's completed job",
    () =>
      buildCompletedJobPropertyExport(prisma, ownerAccessB, {
        jobId: completedA.id,
        includePrivateCustomer: true,
        includePhotos: true,
      }),
    (error) => error?.code === "NOT_FOUND",
  );
  await expectRejects(
    "Incomplete same-business job cannot be exported",
    () =>
      buildCompletedJobPropertyExport(prisma, ownerAccessA, {
        jobId: inProgressA.id,
        includePrivateCustomer: false,
        includePhotos: false,
      }),
    (error) => error?.code === "NOT_COMPLETED",
  );
  await expectRejects(
    "Completed job without a property cannot be exported",
    () =>
      buildCompletedJobPropertyExport(prisma, ownerAccessA, {
        jobId: completedNoProperty.id,
        includePrivateCustomer: false,
        includePhotos: false,
      }),
    (error) => error?.code === "NO_PROPERTY",
  );
  await expectRejects(
    "Completed job pointing at another tenant's property cannot be exported",
    () =>
      buildCompletedJobPropertyExport(prisma, ownerAccessA, {
        jobId: plantedMismatch.id,
        includePrivateCustomer: true,
        includePhotos: true,
      }),
    (error) => error?.code === "NO_PROPERTY",
  );

  const liveSyncAttempt = JSON.parse(serialized);
  liveSyncAttempt.limits.liveSynchronization = true;
  await expectRejects(
    "Parser rejects a packet that claims live synchronization",
    () => parseJobPropertyExport(liveSyncAttempt),
    (error) => error?.code === "INVALID" && String(error.message).includes("liveSynchronization"),
  );
  const adminRoleAttempt = JSON.parse(serialized);
  adminRoleAttempt.authorization.role = "ADMIN";
  await expectRejects(
    "Parser rejects a non-OWNER authorization role",
    () => parseJobPropertyExport(adminRoleAttempt),
    (error) => error?.code === "INVALID" && String(error.message).includes("OWNER"),
  );
  const leakedCustomer = JSON.parse(serialized);
  leakedCustomer.customer.name = "Pat Alpha";
  await expectRejects(
    "Parser rejects a redacted packet that still contains customer contact",
    () => parseJobPropertyExport(leakedCustomer),
    (error) => error?.code === "INVALID",
  );
  const wrongVersion = JSON.parse(serialized);
  wrongVersion.version = 2;
  await expectRejects(
    "Parser rejects an unknown contract version",
    () => parseJobPropertyExport(wrongVersion),
    (error) => error?.code === "INVALID",
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected job/property export test error");
  console.error(error);
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nJob/property export check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll job/property export checks passed.");
