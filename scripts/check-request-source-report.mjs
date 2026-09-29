/**
 * OWNER/ADMIN recorded request-source progression report.
 *
 * Proves counts, tenant isolation, query bounds, and MEMBER deny on a
 * dedicated test database. Does not invent attribution, ad spend,
 * conversion credit, or tracking cookies.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-request-source-report.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  PUBLIC_DEFAULT_LEAD_SOURCE,
  OWNER_DEFAULT_LEAD_SOURCE,
} = await import("@/lib/lead-attribution");
const {
  UNKNOWN_REQUEST_SOURCE,
  REQUEST_SOURCE_REPORT_CHILD_TAKE,
  REQUEST_SOURCE_REPORT_MESSAGE,
  REQUEST_SOURCE_REPORT_REQUEST_TAKE,
  REQUEST_SOURCE_REPORT_TRUNCATED_MESSAGE,
  buildRequestSourceProgression,
  recordedRequestSource,
  requestSourceReportCsvRows,
  requestSourceReportLabel,
} = await import("@/lib/request-source-report");
const {
  loadRequestSourceReport,
  requireRequestSourceReportAccess,
} = await import("@/lib/request-source-report-data");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const domainSrc = readSrc("src/lib/request-source-report.ts");
const dataSrc = readSrc("src/lib/request-source-report-data.ts");
const pageSrc = readSrc("src/app/(app)/reports/page.tsx");
const workspaceSrc = readSrc("src/components/reports/reports-workspace.tsx");
const growthSrc = readSrc("src/components/growth/growth-workspace.tsx");
const publicIntakeSrc = readSrc("src/lib/public-intake.ts");
const importOpsSrc = readSrc("src/lib/external-lead-import-ops.ts");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_request_source_report_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for request-source report test database.");
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

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
  };
}

function row(report, source) {
  return report.rows.find((item) => item.source === source) ?? null;
}

try {
  console.log("\nSTATIC — recorded sources, honesty, and OWNER/ADMIN gate");
  check("Public intake default source is WEBSITE", PUBLIC_DEFAULT_LEAD_SOURCE === "WEBSITE");
  check("Imported / owner-entered default source is MANUAL", OWNER_DEFAULT_LEAD_SOURCE === "MANUAL");
  check(
    "Public intake writes the recorded lead source onto the request",
    publicIntakeSrc.includes("leadSource,") &&
      publicIntakeSrc.includes("originalLeadSource: leadSource") &&
      publicIntakeSrc.includes("parseLeadSource(input.leadSource, PUBLIC_DEFAULT_LEAD_SOURCE)"),
  );
  check(
    "Imported leads write the reviewed source onto the created request",
    importOpsSrc.includes("leadSource: row.leadSource, originalLeadSource: row.leadSource") &&
      importOpsSrc.includes("createOwnerLoggedLead"),
  );
  check("Unknown key is lowercase unknown", UNKNOWN_REQUEST_SOURCE === "unknown");
  check("Blank source is labeled unknown", requestSourceReportLabel(null) === "unknown");
  check("Unrecognized source is labeled unknown", requestSourceReportLabel("COOKIE") === "unknown");
  check("Recorded WEBSITE stays WEBSITE", recordedRequestSource({ leadSource: "WEBSITE", originalLeadSource: null }) === "WEBSITE");
  check(
    "Original source wins over a later working source",
    recordedRequestSource({ leadSource: "GOOGLE", originalLeadSource: "WEBSITE" }) === "WEBSITE",
  );
  check(
    "Honesty copy refuses invented attribution, spend, conversion, and cookies",
    REQUEST_SOURCE_REPORT_MESSAGE.includes("Unknown sources stay unknown") &&
      REQUEST_SOURCE_REPORT_MESSAGE.includes("does not invent attribution, ad spend, conversion credit, or tracking cookies"),
  );
  check(
    "Domain does not invent conversion credit, ad spend, or cookies",
    domainSrc.includes("does not invent attribution, ad spend, conversion credit") &&
      !domainSrc.includes("document.cookie") &&
      !domainSrc.includes("recordedCost") &&
      !domainSrc.includes("averageTicket") &&
      !dataSrc.includes("document.cookie") &&
      !dataSrc.includes("recordedCost"),
  );
  check(
    "Loader denies MEMBER and requires OWNER/ADMIN",
    dataSrc.includes('requireBusinessRole(access as BusinessAccess, ["OWNER", "ADMIN"])') &&
      dataSrc.includes("MEMBER is") &&
      pageSrc.includes("requireManagementPageAccess") &&
      pageSrc.includes("CAPABILITIES.VIEW_REPORTS") &&
      pageSrc.includes("loadRequestSourceReport"),
  );
  check("Reports nav stays hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/reports"));
  check("Reports nav stays visible to OWNER and ADMIN", visibleAppNav("OWNER").some((item) => item.href === "/reports") && visibleAppNav("ADMIN").some((item) => item.href === "/reports"));
  check(
    "Queries are same-business and bounded",
    dataSrc.includes("where: { ...scope, ...requestCreatedAtWhere(range) }") &&
      dataSrc.includes("take: REQUEST_SOURCE_REPORT_REQUEST_TAKE + 1") &&
      dataSrc.includes("where: { ...scope, serviceRequestId: { in: requestIds } }") &&
      dataSrc.includes("where: { ...scope, estimateId: { in: estimateIds } }") &&
      dataSrc.includes("take: REQUEST_SOURCE_REPORT_CHILD_TAKE + 1") &&
      REQUEST_SOURCE_REPORT_REQUEST_TAKE === 200 &&
      REQUEST_SOURCE_REPORT_CHILD_TAKE === 400,
  );
  check(
    "UI labels unknown and does not invent spend or conversion",
    workspaceSrc.includes("REQUEST_SOURCE_REPORT_MESSAGE") &&
      workspaceSrc.includes("Request → estimate → job") &&
      !workspaceSrc.includes("ad spend") &&
      growthSrc.includes("/reports?area=request-sources") &&
      growthSrc.includes("does not invent conversion credit, ad spend, or tracking cookies"),
  );

  const invented = buildRequestSourceProgression({
    requests: [{ id: "r1", leadSource: null, originalLeadSource: null }],
    estimates: [{ id: "e1", serviceRequestId: null }],
    jobs: [{ id: "j1", estimateId: null }],
  });
  check(
    "Unlinked estimate/job do not invent progression",
    invented.rows.length === 1 &&
      invented.rows[0].source === "unknown" &&
      invented.rows[0].label === "unknown" &&
      invented.rows[0].requests === 1 &&
      invented.rows[0].estimates === 0 &&
      invented.rows[0].jobs === 0,
  );
  const csv = requestSourceReportCsvRows(invented);
  check(
    "CSV is request/estimate/job counts only",
    csv.headers.join(",") === "Source,Requests,With estimate,With job" &&
      csv.rows[0].join(",") === "unknown,1,0,0",
  );

  console.log("\nDB — counts, tenant isolation, query bounds, MEMBER deny");
  const businessA = await prisma.business.create({
    data: { name: "Alpha Sources", slug: `alpha-sources-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Sources", slug: `beta-sources-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-sources-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-sources-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-sources-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-owner-sources-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  try {
    requireRequestSourceReportAccess(memberA);
    check("MEMBER requireRequestSourceReportAccess is forbidden", false);
  } catch (error) {
    check("MEMBER requireRequestSourceReportAccess is forbidden", error instanceof ForbiddenError);
  }

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });

  const websiteWon = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Public website won",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
    },
  });
  const websiteEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      serviceRequestId: websiteWon.id,
      status: "APPROVED",
      total: 400,
      leadSource: "WEBSITE",
      publicToken: randomUUID(),
    },
  });
  await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      estimateId: websiteEstimate.id,
      status: "COMPLETED",
      leadSource: "WEBSITE",
      projectToken: randomUUID(),
    },
  });

  const websiteEstimated = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Public website estimated",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
    },
  });
  await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      serviceRequestId: websiteEstimated.id,
      status: "SENT",
      total: 200,
      leadSource: "WEBSITE",
      publicToken: randomUUID(),
    },
  });

  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Public website request only",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
    },
  });

  const importedGoogle = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Imported Google lead",
      leadSource: "GOOGLE",
      originalLeadSource: "GOOGLE",
    },
  });
  await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      serviceRequestId: importedGoogle.id,
      status: "DRAFT",
      total: 150,
      leadSource: "GOOGLE",
      publicToken: randomUUID(),
    },
  });

  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Imported manual lead",
      leadSource: "MANUAL",
      originalLeadSource: "MANUAL",
    },
  });

  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Historical request with no source",
    },
  });

  await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      summary: "Corrected working source keeps original",
      leadSource: "GOOGLE",
      originalLeadSource: "WEBSITE",
    },
  });

  await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "SENT",
      total: 999,
      leadSource: "WEBSITE",
      publicToken: randomUUID(),
    },
  });
  await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      status: "COMPLETED",
      leadSource: "WEBSITE",
      projectToken: randomUUID(),
    },
  });

  const betaRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      summary: "Beta website secret",
      leadSource: "WEBSITE",
      originalLeadSource: "WEBSITE",
    },
  });
  const betaEstimate = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      serviceRequestId: betaRequest.id,
      status: "APPROVED",
      total: 9999,
      leadSource: "WEBSITE",
      publicToken: randomUUID(),
    },
  });
  await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      estimateId: betaEstimate.id,
      status: "COMPLETED",
      leadSource: "WEBSITE",
      projectToken: randomUUID(),
    },
  });

  const reportA = await loadRequestSourceReport(prisma, ownerA);
  const reportAdmin = await loadRequestSourceReport(prisma, adminA);
  const reportB = await loadRequestSourceReport(prisma, ownerB);

  check("OWNER and ADMIN load the same A counts", JSON.stringify(reportA.rows) === JSON.stringify(reportAdmin.rows));
  check(
    "WEBSITE counts follow actual progression (4 requests, 2 estimated, 1 job)",
    row(reportA, "WEBSITE")?.requests === 4 &&
      row(reportA, "WEBSITE")?.estimates === 2 &&
      row(reportA, "WEBSITE")?.jobs === 1,
  );
  check(
    "Imported GOOGLE counts as 1 request with 1 estimate and 0 jobs",
    row(reportA, "GOOGLE")?.requests === 1 &&
      row(reportA, "GOOGLE")?.estimates === 1 &&
      row(reportA, "GOOGLE")?.jobs === 0,
  );
  check(
    "Imported MANUAL counts as 1 request with no progression",
    row(reportA, "MANUAL")?.requests === 1 &&
      row(reportA, "MANUAL")?.estimates === 0 &&
      row(reportA, "MANUAL")?.jobs === 0,
  );
  check(
    "Missing source is labeled unknown and is not invented as WEBSITE",
    row(reportA, "unknown")?.label === "unknown" &&
      row(reportA, "unknown")?.requests === 1 &&
      row(reportA, "unknown")?.estimates === 0,
  );
  check(
    "Unlinked WEBSITE estimate/job do not inflate A counts",
    reportA.sampledRequestCount === 7 &&
      reportA.rows.reduce((sum, item) => sum + item.requests, 0) === 7,
  );
  check(
    "Business B is isolated to its own WEBSITE 1/1/1",
    reportB.sampledRequestCount === 1 &&
      row(reportB, "WEBSITE")?.requests === 1 &&
      row(reportB, "WEBSITE")?.estimates === 1 &&
      row(reportB, "WEBSITE")?.jobs === 1 &&
      !reportB.rows.some((item) => item.source === "GOOGLE" || item.source === "unknown"),
  );
  check(
    "Business A never includes Beta's secret 9999 progression",
    row(reportA, "WEBSITE")?.jobs === 1 && row(reportA, "WEBSITE")?.requests === 4,
  );

  try {
    await loadRequestSourceReport(prisma, memberA);
    check("MEMBER loadRequestSourceReport is denied", false);
  } catch (error) {
    check("MEMBER loadRequestSourceReport is denied", error instanceof ForbiddenError);
  }

  console.log("\nDB — request and child query bounds");
  const boundBusiness = await prisma.business.create({
    data: { name: "Bound Sources", slug: `bound-sources-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const boundOwnerUser = await prisma.user.create({
    data: { name: "Bound Owner", email: `bound-owner-sources-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const boundMem = await prisma.membership.create({
    data: { userId: boundOwnerUser.id, businessId: boundBusiness.id, role: "OWNER" },
  });
  const boundAccess = makeAccess(boundBusiness.id, "OWNER", boundMem.id);
  const boundCustomer = await prisma.customer.create({
    data: { businessId: boundBusiness.id, name: "Bound Homeowner" },
  });
  await prisma.serviceRequest.createMany({
    data: Array.from({ length: REQUEST_SOURCE_REPORT_REQUEST_TAKE }, (_, index) => ({
      businessId: boundBusiness.id,
      customerId: boundCustomer.id,
      summary: `Bound Facebook ${index}`,
      leadSource: "FACEBOOK",
      originalLeadSource: "FACEBOOK",
      createdAt: new Date(2026, 8, 2, 0, 0, index),
    })),
  });
  await prisma.serviceRequest.create({
    data: {
      businessId: boundBusiness.id,
      customerId: boundCustomer.id,
      summary: "Oldest unknown outside the bound",
      createdAt: new Date(2020, 0, 1),
    },
  });

  const bounded = await loadRequestSourceReport(prisma, boundAccess);
  check(
    "Request query is bounded at 200 and flags truncation",
    bounded.truncated === true &&
      bounded.sampledRequestCount === REQUEST_SOURCE_REPORT_REQUEST_TAKE &&
      bounded.requestLimit === 200 &&
      REQUEST_SOURCE_REPORT_TRUNCATED_MESSAGE.includes("200"),
  );
  check(
    "Oldest unknown request outside the bound is omitted",
    !bounded.rows.some((item) => item.source === "unknown") &&
      row(bounded, "FACEBOOK")?.requests === REQUEST_SOURCE_REPORT_REQUEST_TAKE,
  );
  check(
    "Bounded sample stays on the bound business",
    bounded.rows.length === 1 && row(bounded, "WEBSITE") == null && row(bounded, "GOOGLE") == null,
  );

  const childBusiness = await prisma.business.create({
    data: { name: "Child Bound Sources", slug: `child-bound-sources-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const childOwnerUser = await prisma.user.create({
    data: { name: "Child Bound Owner", email: `child-bound-sources-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const childMem = await prisma.membership.create({
    data: { userId: childOwnerUser.id, businessId: childBusiness.id, role: "OWNER" },
  });
  const childAccess = makeAccess(childBusiness.id, "OWNER", childMem.id);
  const childCustomer = await prisma.customer.create({
    data: { businessId: childBusiness.id, name: "Child Bound Homeowner" },
  });
  const childRequest = await prisma.serviceRequest.create({
    data: {
      businessId: childBusiness.id,
      customerId: childCustomer.id,
      summary: "One request with over-bound estimates",
      leadSource: "OTHER",
      originalLeadSource: "OTHER",
    },
  });
  await prisma.estimate.createMany({
    data: Array.from({ length: REQUEST_SOURCE_REPORT_CHILD_TAKE + 1 }, () => ({
      businessId: childBusiness.id,
      customerId: childCustomer.id,
      serviceRequestId: childRequest.id,
      status: "DRAFT",
      total: 10,
      publicToken: randomUUID(),
    })),
  });
  const childReport = await loadRequestSourceReport(prisma, childAccess);
  check(
    "Estimate query is bounded at 400 and flags child truncation",
    childReport.childTruncated === true &&
      childReport.estimateLimit === 400 &&
      row(childReport, "OTHER")?.requests === 1 &&
      row(childReport, "OTHER")?.estimates === 1,
  );

  console.log(
    failures === 0
      ? "\nAll request-source report checks passed."
      : `\n${failures} request-source report check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
