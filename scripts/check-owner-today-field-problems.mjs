/**
 * Today Needs attention — OPEN JobProblemReport surface.
 *
 * Proves the field "office has been notified" promise lands on /today
 * without rebuilding appointment attention, unassigned today, or the
 * Field → office billing handoff.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-owner-today-field-problems.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { formatDateTime } = await import("@/lib/format");
const {
  OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL,
  OWNER_TODAY_CREATE_INVOICE_LABEL,
  OWNER_TODAY_FIELD_COMPLETION_COPY,
  OWNER_TODAY_FIELD_PROBLEM_TAKE,
  buildOwnerTodayAppointmentAttention,
  buildOwnerTodayFieldProblemAttention,
  buildOwnerTodayHandoffItems,
  buildOwnerTodayJobs,
} = await import("@/lib/owner-today");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

const todayPageSrc = readRepo("src/app/(app)/today/page.tsx");
const todayHelperSrc = readRepo("src/lib/owner-today.ts");
const todayFieldProblemSrc = readRepo(
  "src/components/today/owner-today-field-problem-attention.tsx",
);
const todayAppointmentSrc = readRepo(
  "src/components/today/owner-today-appointment-attention.tsx",
);
const todayHandoffSrc = readRepo("src/components/today/owner-today-handoff-card.tsx");
const todayJobCardSrc = readRepo("src/components/today/owner-today-job-card.tsx");
const resolveActionSrc = readRepo("src/app/actions/job-problem-report.ts");

const ownedTodayFiles = [todayPageSrc, todayHelperSrc, todayFieldProblemSrc];

console.log("\nSTATIC — Query is tenant-scoped, OPEN-only, and bounded");
check(
  "Today queries OPEN JobProblemReport rows for the current businessId",
  todayPageSrc.includes("prisma.jobProblemReport.findMany") &&
    todayPageSrc.includes("businessId: access.businessId") &&
    todayPageSrc.includes('status: "OPEN"') &&
    todayPageSrc.includes("OWNER_TODAY_FIELD_PROBLEM_SELECT") &&
    todayPageSrc.includes("orderBy: { createdAt: \"desc\" }"),
);
check(
  "Query take is bounded at 25",
  OWNER_TODAY_FIELD_PROBLEM_TAKE === 25 &&
    todayPageSrc.includes("take: OWNER_TODAY_FIELD_PROBLEM_TAKE") &&
    todayHelperSrc.includes("export const OWNER_TODAY_FIELD_PROBLEM_TAKE = 25"),
);
check(
  "Select is limited to Today-needed report/job/reporter fields",
  todayHelperSrc.includes("OWNER_TODAY_FIELD_PROBLEM_SELECT") &&
    todayHelperSrc.includes("membership: { select: { user: { select: { name: true } } } }") &&
    todayHelperSrc.includes("customer: { select: { name: true } }") &&
    !todayHelperSrc.includes("resolvedAt: true") &&
    !todayPageSrc.includes("invoices:") &&
    !/prisma\.jobProblemReport\.findMany\([\s\S]*include:/.test(todayPageSrc),
);

console.log("\nSTATIC — Today projects OPEN reports and does not resolve them");
check(
  "Today uses the canonical owner-today field-problem projection",
  todayPageSrc.includes("buildOwnerTodayFieldProblemAttention") &&
    todayPageSrc.includes("OwnerTodayFieldProblemAttention") &&
    todayHelperSrc.includes("if (report.businessId !== options.businessId) return null") &&
    todayHelperSrc.includes("if (!job || job.businessId !== options.businessId) return null") &&
    todayHelperSrc.includes('if (report.status !== "OPEN") return null'),
);
check(
  "Today UI shows customer, reporter, description, timestamp, and Work Order link",
  todayFieldProblemSrc.includes("Field reports needing attention") &&
    todayFieldProblemSrc.includes("item.customerName") &&
    todayFieldProblemSrc.includes("Reported by {item.reporterName}") &&
    todayFieldProblemSrc.includes("item.description") &&
    todayFieldProblemSrc.includes("item.reportedAtLabel") &&
    todayFieldProblemSrc.includes("Open Work Order") &&
    todayFieldProblemSrc.includes("href={item.href}") &&
    todayHelperSrc.includes("href: `/jobs/${job.id}`") &&
    todayHelperSrc.includes("formatDateTime(report.createdAt, options.timeZone)"),
);
check(
  "No direct resolve mutation was added to Today",
  ownedTodayFiles.every(
    (src) =>
      !src.includes("resolveJobProblemReport") &&
      !src.includes("Mark Resolved") &&
      !src.includes('status: "RESOLVED"') &&
      !src.includes("resolvedAt") &&
      !src.includes("jobProblemReport.update") &&
      !src.includes("jobProblemReport.updateMany"),
  ) &&
    todayPageSrc.includes('href={`/jobs?view=day&date=${todayIso}`}') &&
    resolveActionSrc.includes("export async function resolveJobProblemReport"),
);
check(
  "Today does not fabricate severity, priority, or recommendations",
  !todayFieldProblemSrc.includes("severity") &&
    !todayFieldProblemSrc.includes("priority") &&
    !todayFieldProblemSrc.includes("recommend") &&
    !todayHelperSrc.includes("severity") &&
    !todayHelperSrc.includes("priority"),
);
check(
  "Open field reports count as Needs attention and copy mentions them",
  todayPageSrc.includes("fieldProblemAttention.length === 0") &&
    todayPageSrc.includes("Nothing waiting right now.") &&
    todayPageSrc.includes("open field reports") &&
    todayPageSrc.includes("OWNER_TODAY_FIELD_COMPLETION_COPY"),
);

console.log("\nSTATIC — Existing Today surfaces stay in place");
check(
  "Appointment attention remains",
  todayPageSrc.includes("buildOwnerTodayAppointmentAttention") &&
    todayPageSrc.includes("<OwnerTodayAppointmentAttention items={appointmentAttention} />") &&
    todayAppointmentSrc.includes("item.title") &&
    todayAppointmentSrc.includes("item.href") &&
    todayPageSrc.includes("ownerTodayAppointmentCandidateWhere(todayRange.start)"),
);
check(
  "Unassigned today remains",
  todayPageSrc.includes("Unassigned today") &&
    todayPageSrc.includes('job.assignment.kind === "UNASSIGNED"') &&
    todayPageSrc.includes(">Assign<") &&
    todayJobCardSrc.includes("AssignJobMemberForm"),
);
check(
  "Field → office billing handoff remains",
  todayPageSrc.includes("Field → office handoff") &&
    todayPageSrc.includes("buildOwnerTodayHandoffItems") &&
    todayPageSrc.includes("<OwnerTodayHandoffCard key={item.jobId} item={item} />") &&
    todayHandoffSrc.includes("CreateInvoiceButton") &&
    todayHandoffSrc.includes("Field completed — invoice action needed") &&
    OWNER_TODAY_CREATE_INVOICE_LABEL === "Create & send invoice" &&
    OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL === "Create & send balance invoice" &&
    OWNER_TODAY_FIELD_COMPLETION_COPY.includes(
      "Owner Complete Job leaves a draft — press Send when ready",
    ),
);
check(
  "Today jobs, assignment, Call/Directions, and Field View stay on the existing card",
  todayPageSrc.includes("<OwnerTodayJobCard") &&
    todayPageSrc.includes("showAssign") &&
    todayPageSrc.includes("showStart") &&
    todayPageSrc.includes("Open field view") &&
    todayJobCardSrc.includes("job.callHref") &&
    todayJobCardSrc.includes("CopyDirectionsLinkButton") &&
    todayJobCardSrc.includes("job.fieldHref"),
);

const reportedAt = new Date("2026-09-26T18:00:00.000Z");
const nyLabel = formatDateTime(reportedAt, "America/New_York");
const laLabel = formatDateTime(reportedAt, "America/Los_Angeles");

function reportRow(extras = {}) {
  return {
    id: extras.id ?? "rpt-open",
    businessId: extras.businessId ?? "biz-a",
    description: extras.description ?? "Gate was locked; no one answered.",
    createdAt: extras.createdAt ?? reportedAt,
    status: extras.status ?? "OPEN",
    membership: extras.membership ?? { user: { name: extras.reporterName ?? "Mia Member" } },
    job: extras.job ?? {
      id: extras.jobId ?? "job-a",
      businessId: extras.jobBusinessId ?? extras.businessId ?? "biz-a",
      customer: { name: extras.customerName ?? "Pat Rivera" },
    },
  };
}

const todayRange = {
  start: new Date("2026-09-25T00:00:00.000Z"),
  end: new Date("2026-09-26T00:00:00.000Z"),
};

function todayJob(extras = {}) {
  return {
    id: extras.id ?? "job-today",
    businessId: extras.businessId ?? "biz-a",
    customerId: extras.customerId ?? "cust-a",
    status: extras.status ?? "SCHEDULED",
    scheduledAt: extras.scheduledAt ?? new Date("2026-09-25T15:00:00.000Z"),
    scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
    arrivalWindowMinutes: extras.arrivalWindowMinutes ?? null,
    pickupDurationMinutes: extras.pickupDurationMinutes ?? null,
    assignedMembershipId: extras.assignedMembershipId ?? "mem-1",
    projectToken: extras.projectToken ?? "portal-today",
    appointmentConfirmationStatus: extras.appointmentConfirmationStatus ?? "CONFIRMED",
    appointmentProposalId: extras.appointmentProposalId ?? 2,
    appointmentConfirmedForProposalId: extras.appointmentConfirmedForProposalId ?? 2,
    appointmentConfirmationSource: extras.appointmentConfirmationSource ?? "PORTAL",
    appointmentChangeRequestNote: extras.appointmentChangeRequestNote ?? null,
    appointmentNotificationStatus: extras.appointmentNotificationStatus ?? null,
    appointmentNotificationError: extras.appointmentNotificationError ?? null,
    propertyAccessMethod: extras.propertyAccessMethod ?? "CUSTOMER_PRESENT",
    propertyAccessInstructions: extras.propertyAccessInstructions ?? null,
    propertyAccessContactName: extras.propertyAccessContactName ?? null,
    propertyAccessContactInfo: extras.propertyAccessContactInfo ?? null,
    propertyAccessPickupLocation: extras.propertyAccessPickupLocation ?? null,
    propertyAccessNote: extras.propertyAccessNote ?? null,
    customer: { id: extras.customerId ?? "cust-a", name: extras.customerName ?? "Pat" },
    property: extras.property ?? {
      addressLine1: "10 Main St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
    assignedMembership: extras.assignedMembership ?? { user: { name: "Alex" } },
    ...extras,
  };
}

console.log("\nPURE — OPEN / RESOLVED / tenant / display");
const openItems = buildOwnerTodayFieldProblemAttention(
  [reportRow({ id: "rpt-open", description: "Access issue: gate was locked." })],
  { businessId: "biz-a", timeZone: "America/New_York" },
);
check(
  "OPEN same-tenant report appears on Today",
  openItems.length === 1 &&
    openItems[0].reportId === "rpt-open" &&
    openItems[0].jobId === "job-a",
);
check(
  "Recorded employee name and report description are displayed",
  openItems[0]?.reporterName === "Mia Member" &&
    openItems[0]?.description === "Access issue: gate was locked." &&
    openItems[0]?.customerName === "Pat Rivera",
);
check(
  "Report links to the correct Work Order",
  openItems[0]?.href === "/jobs/job-a",
);
check(
  "Timestamp uses the business timezone",
  openItems[0]?.reportedAtLabel === nyLabel &&
    nyLabel.includes("2:00 PM") &&
    buildOwnerTodayFieldProblemAttention([reportRow()], {
      businessId: "biz-a",
      timeZone: "America/Los_Angeles",
    })[0]?.reportedAtLabel === laLabel &&
    laLabel.includes("11:00 AM") &&
    nyLabel !== laLabel,
);

const resolvedItems = buildOwnerTodayFieldProblemAttention(
  [reportRow({ id: "rpt-resolved", status: "RESOLVED" })],
  { businessId: "biz-a", timeZone: "America/New_York" },
);
check("RESOLVED report does not appear", resolvedItems.length === 0);

const foreignItems = buildOwnerTodayFieldProblemAttention(
  [
    reportRow({
      id: "rpt-b",
      businessId: "biz-b",
      jobId: "job-b",
      customerName: "Other Tenant",
      reporterName: "Bree Member",
    }),
  ],
  { businessId: "biz-a", timeZone: "America/New_York" },
);
const mismatchedJob = buildOwnerTodayFieldProblemAttention(
  [reportRow({ id: "rpt-mismatch", jobBusinessId: "biz-b" })],
  { businessId: "biz-a", timeZone: "America/New_York" },
);
check(
  "Foreign-tenant report does not appear",
  foreignItems.length === 0 && mismatchedJob.length === 0,
);

const mixed = buildOwnerTodayFieldProblemAttention(
  [
    reportRow({ id: "rpt-keep" }),
    reportRow({ id: "rpt-resolved", status: "RESOLVED" }),
    reportRow({
      id: "rpt-foreign",
      businessId: "biz-b",
      jobId: "job-b",
    }),
  ],
  { businessId: "biz-a", timeZone: "America/New_York" },
);
check(
  "Mixed batch keeps only the OPEN same-tenant report",
  mixed.length === 1 && mixed[0].reportId === "rpt-keep",
);

console.log("\nPURE — Existing Today builders still work");
const awaitingAttention = buildOwnerTodayAppointmentAttention(
  [
    todayJob({
      id: "job-awaiting",
      assignedMembershipId: null,
      assignedMembership: null,
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentConfirmedForProposalId: null,
    }),
  ],
  { businessId: "biz-a", start: todayRange.start },
);
check(
  "Existing appointment attention remains",
  awaitingAttention.length === 1 &&
    awaitingAttention[0].kind === "AWAITING_CUSTOMER" &&
    awaitingAttention[0].href === "/jobs/job-awaiting",
);
const unassignedViews = buildOwnerTodayJobs(
  [todayJob({ id: "job-open", assignedMembershipId: null, assignedMembership: null })],
  { businessId: "biz-a", range: todayRange },
);
check(
  "Existing unassigned today remains",
  unassignedViews.length === 1 && unassignedViews[0].assignment.kind === "UNASSIGNED",
);
const unbilledHandoff = buildOwnerTodayHandoffItems(
  [
    {
      id: "job-unbilled",
      businessId: "biz-a",
      status: "COMPLETED",
      estimate: { total: 200 },
      invoices: [],
      changeOrders: [],
      customer: { name: "Closeout" },
    },
  ],
  "biz-a",
);
check(
  "Existing Field → office billing handoff remains",
  unbilledHandoff.length === 1 &&
    unbilledHandoff[0].invoiceActionLabel === OWNER_TODAY_CREATE_INVOICE_LABEL &&
    unbilledHandoff[0].href === "/jobs/job-unbilled",
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nDB skipped — DATABASE_URL is not set");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const testDbName = "tbbt_owner_today_field_problems_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for owner-today field-problem test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

async function makeBusiness(slug) {
  return prisma.business.create({
    data: { name: `Biz ${slug}`, slug, tradeCode: "HANDYMAN" },
  });
}

async function makeMember(businessId, name) {
  const user = await prisma.user.create({
    data: {
      name,
      email: `${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  return prisma.membership.create({
    data: { userId: user.id, businessId, role: "MEMBER" },
  });
}

async function makeJob(businessId, extras = {}) {
  const customer = await prisma.customer.create({
    data: {
      businessId,
      name: extras.customerName ?? "Stanley",
      email: extras.email ?? `${randomUUID()}@example.com`,
    },
  });
  return prisma.job.create({
    data: {
      businessId,
      customerId: customer.id,
      projectToken: extras.projectToken ?? randomUUID(),
      status: extras.status ?? "SCHEDULED",
      scheduledAt: extras.scheduledAt ?? new Date("2026-09-25T15:00:00.000Z"),
    },
  });
}

async function loadTodayFieldProblems(businessId, timeZone) {
  const rows = await prisma.jobProblemReport.findMany({
    where: { businessId, status: "OPEN" },
    select: {
      id: true,
      businessId: true,
      description: true,
      createdAt: true,
      status: true,
      membership: { select: { user: { select: { name: true } } } },
      job: {
        select: {
          id: true,
          businessId: true,
          customer: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: OWNER_TODAY_FIELD_PROBLEM_TAKE,
  });
  return buildOwnerTodayFieldProblemAttention(rows, { businessId, timeZone });
}

console.log("\nDB — OPEN / RESOLVED / tenant / bound");
try {
  const businessA = await makeBusiness(`field-a-${randomUUID()}`);
  const businessB = await makeBusiness(`field-b-${randomUUID()}`);
  const mia = await makeMember(businessA.id, "Mia Member");
  const bree = await makeMember(businessB.id, "Bree Member");
  const jobA = await makeJob(businessA.id, { customerName: "Pat Rivera" });
  const jobB = await makeJob(businessB.id, { customerName: "Other Tenant" });

  const openReport = await prisma.jobProblemReport.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      membershipId: mia.id,
      description: "Access issue: gate was locked.",
      status: "OPEN",
    },
  });
  const resolvedReport = await prisma.jobProblemReport.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      membershipId: mia.id,
      description: "Already handled on the Work Order.",
      status: "RESOLVED",
      resolvedAt: new Date("2026-09-26T16:00:00.000Z"),
    },
  });
  const foreignReport = await prisma.jobProblemReport.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      membershipId: bree.id,
      description: "Foreign tenant should never appear.",
      status: "OPEN",
    },
  });

  const items = await loadTodayFieldProblems(businessA.id, "America/New_York");
  check(
    "DB: OPEN same-tenant report appears with name, text, Work Order link",
    items.some(
      (item) =>
        item.reportId === openReport.id &&
        item.jobId === jobA.id &&
        item.customerName === "Pat Rivera" &&
        item.reporterName === "Mia Member" &&
        item.description === "Access issue: gate was locked." &&
        item.href === `/jobs/${jobA.id}` &&
        item.reportedAtLabel === formatDateTime(openReport.createdAt, "America/New_York"),
    ),
  );
  check(
    "DB: RESOLVED report does not appear",
    items.every((item) => item.reportId !== resolvedReport.id),
  );
  check(
    "DB: foreign-tenant report does not appear",
    items.every((item) => item.reportId !== foreignReport.id) &&
      (await loadTodayFieldProblems(businessB.id, "America/New_York")).every(
        (item) => item.reportId === foreignReport.id,
      ),
  );

  const extras = [];
  for (let i = 0; i < 26; i += 1) {
    extras.push(
      prisma.jobProblemReport.create({
        data: {
          businessId: businessA.id,
          jobId: jobA.id,
          membershipId: mia.id,
          description: `Bounded extra ${i}`,
          status: "OPEN",
          createdAt: new Date(Date.UTC(2026, 8, 26, 12, i)),
        },
      }),
    );
  }
  await Promise.all(extras);
  const bounded = await prisma.jobProblemReport.findMany({
    where: { businessId: businessA.id, status: "OPEN" },
    orderBy: { createdAt: "desc" },
    take: OWNER_TODAY_FIELD_PROBLEM_TAKE,
    select: { id: true },
  });
  const openCount = await prisma.jobProblemReport.count({
    where: { businessId: businessA.id, status: "OPEN" },
  });
  check(
    "DB: query is bounded at 25 even when more OPEN reports exist",
    openCount > 25 && bounded.length === 25,
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
