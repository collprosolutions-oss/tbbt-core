/**
 * Founder Handyman owner morning attention.
 *
 * Proves Dashboard / Today surface existing Core states that were missing,
 * wrong, or non-actionable: unscheduled approved work, SENT invoices (not
 * drafts), additional-work, change orders, running time, unpaid material
 * deposits, scheduling conflicts, and open callbacks. Tenant isolation
 * stays fail-closed. No new dashboard or invented metrics.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-owner-daily-ops.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { Prisma } = await import("@prisma/client");
const { DEFAULT_AVAILABILITY_SETTINGS } = await import("@/lib/availability");
const { JOB_CALLBACK_OPEN_STATUSES } = await import("@/lib/job-callback");
const { unpaidMaterialDepositWarning } = await import("@/lib/project-payments");
const { DEFAULT_SCHEDULING_POLICY } = await import("@/lib/workforce");
const { detectScheduleConflicts } = await import("@/lib/workforce-conflicts");
const { roleHasCapability, CAPABILITIES } = await import("@/lib/authorization");
const {
  OWNER_DAILY_GROUP_TITLES,
  buildOwnerDailyAdditionalWorkAttention,
  buildOwnerDailyCallbackAttention,
  buildOwnerDailyChangeOrderAttention,
  buildOwnerDailyMaterialDepositAttention,
  buildOwnerDailyRunningTimeAttention,
  buildOwnerDailyScheduleConflictAttention,
  isUnscheduledApprovedWork,
  ownerDailyAttentionItemHolds,
  ownerDailyUnpaidInvoiceWhere,
  ownerDailyUnscheduledApprovedWhere,
} = await import("@/lib/owner-daily-attention");

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

const dashboardSrc = readRepo("src/app/(app)/dashboard/page.tsx");
const todaySrc = readRepo("src/app/(app)/today/page.tsx");
const helperSrc = readRepo("src/lib/owner-daily-attention.ts");
const listSrc = readRepo("src/components/today/owner-daily-attention-list.tsx");

console.log("\nSTATIC — Existing morning surfaces reuse canonical builders");
check(
  "Dashboard and Today stay management-gated",
  dashboardSrc.includes("requireManagementPageAccess()") &&
    todaySrc.includes("requireManagementPageAccess()") &&
    !dashboardSrc.includes("requireFieldWorkspace") &&
    !todaySrc.includes("requireFieldWorkspace"),
);
check(
  "Dashboard unpaid invoices are SENT only, not every non-PAID row",
  dashboardSrc.includes("ownerDailyUnpaidInvoiceWhere()") &&
    ownerDailyUnpaidInvoiceWhere().status === "SENT" &&
    !dashboardSrc.includes('status: { not: "PAID" }'),
);
check(
  "Dashboard unscheduled jobs require approved work",
  dashboardSrc.includes("ownerDailyUnscheduledApprovedWhere()") &&
    helperSrc.includes('status: "UNSCHEDULED"') &&
    helperSrc.includes("estimateId: { not: null }"),
);
check(
  "Both pages project additional-work, change orders, callbacks, running time, deposits, and conflicts",
  [
    "buildOwnerDailyAdditionalWorkAttention",
    "buildOwnerDailyChangeOrderAttention",
    "buildOwnerDailyCallbackAttention",
    "buildOwnerDailyRunningTimeAttention",
    "buildOwnerDailyMaterialDepositAttention",
    "buildOwnerDailyScheduleConflictAttention",
  ].every((name) => dashboardSrc.includes(name) && todaySrc.includes(name)),
);
check(
  "Queries stay business-scoped and bounded",
  dashboardSrc.includes("...access.scope") &&
    todaySrc.includes("...access.scope") &&
    dashboardSrc.includes("OWNER_DAILY_ATTENTION_TAKE") &&
    todaySrc.includes("OWNER_DAILY_ATTENTION_TAKE") &&
    helperSrc.includes("if (row.businessId !== businessId) return null"),
);
check(
  "Dashboard first-time awaiting uses Today appointment attention, not a second confirmation model",
  dashboardSrc.includes("buildOwnerTodayAppointmentAttention") &&
    dashboardSrc.includes('item.kind === "AWAITING_CUSTOMER"') &&
    dashboardSrc.includes("OwnerTodayAppointmentAttention") &&
    dashboardSrc.includes("dashboardAppointmentAttentionItems"),
);
check(
  "Attention items are links into existing records, not a new dashboard",
  listSrc.includes("href={item.href}") &&
    helperSrc.includes("href: `/jobs/${job.id}`") &&
    helperSrc.includes("href: `/estimates/${estimate.id}`") &&
    helperSrc.includes("href: `/jobs/${job.id}/change-orders/${row.id}`") &&
    !helperSrc.includes("Chief of Staff") &&
    !helperSrc.includes("recommend") &&
    !dashboardSrc.includes("new dashboard"),
);
check(
  "MEMBER still has no management capabilities",
  Object.values(CAPABILITIES).every((capability) => !roleHasCapability("MEMBER", capability)),
);
check(
  "Existing Dashboard KPI and draft/unscheduled/unpaid titles remain",
  dashboardSrc.includes('label: "Open Requests"') &&
    dashboardSrc.includes('"Draft estimates"') &&
    dashboardSrc.includes('"Unscheduled jobs"') &&
    dashboardSrc.includes('"Unpaid invoices"') &&
    dashboardSrc.includes("OWNER_DAILY_GROUP_TITLES.additionalWork") &&
    dashboardSrc.includes("OWNER_DAILY_GROUP_TITLES.callbacks") &&
    OWNER_DAILY_GROUP_TITLES.additionalWork === "Additional-work requests" &&
    OWNER_DAILY_GROUP_TITLES.callbacks === "Customer-reported callbacks",
);

console.log("\nPURE — Inclusion, tenant fail-closed, and actionable hrefs");
const additionalWork = buildOwnerDailyAdditionalWorkAttention(
  [
    {
      id: "aw-open",
      businessId: "biz-a",
      jobId: "job-a",
      status: "OPEN",
      source: "CUSTOMER",
      description: "Add a grab bar",
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
      items: [],
    },
    {
      id: "aw-dismissed",
      businessId: "biz-a",
      jobId: "job-a",
      status: "DISMISSED",
      source: "CUSTOMER",
      description: "Old request",
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "aw-foreign",
      businessId: "biz-b",
      jobId: "job-b",
      status: "OPEN",
      source: "EMPLOYEE",
      description: "Other tenant",
      job: { id: "job-b", businessId: "biz-b", customer: { name: "Other" } },
    },
  ],
  "biz-a",
);
check(
  "OPEN additional-work appears; dismissed and foreign do not",
  additionalWork.length === 1 &&
    additionalWork[0].key === "aw-open" &&
    additionalWork[0].href === "/jobs/job-a" &&
    additionalWork[0].name === "Pat" &&
    additionalWork[0].action === "Review",
);

const changeOrders = buildOwnerDailyChangeOrderAttention(
  [
    {
      id: "co-draft",
      businessId: "biz-a",
      jobId: "job-a",
      status: "DRAFT",
      title: "Extra tile",
      total: 40,
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "co-sent",
      businessId: "biz-a",
      jobId: "job-a",
      status: "SENT",
      title: "Extra paint",
      total: 25,
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "co-approved",
      businessId: "biz-a",
      jobId: "job-a",
      status: "APPROVED",
      title: "Done",
      total: 10,
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "co-foreign",
      businessId: "biz-b",
      jobId: "job-b",
      status: "SENT",
      title: "Foreign",
      total: 99,
      job: { id: "job-b", businessId: "biz-b", customer: { name: "Other" } },
    },
  ],
  "biz-a",
);
check(
  "Draft and SENT change orders appear with Work Order hrefs; approved/foreign do not",
  changeOrders.length === 2 &&
    changeOrders.some((item) => item.key === "co-draft" && item.href === "/jobs/job-a/change-orders/co-draft") &&
    changeOrders.some((item) => item.key === "co-sent" && item.meta.includes("Awaiting customer")) &&
    changeOrders.every((item) => item.key !== "co-approved" && item.key !== "co-foreign"),
);

const callbacks = buildOwnerDailyCallbackAttention(
  [
    {
      id: "cb-open",
      businessId: "biz-a",
      jobId: "job-a",
      status: "RECORDED",
      description: "Leak returned",
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "cb-closed",
      businessId: "biz-a",
      jobId: "job-a",
      status: "OUTCOME_RECORDED",
      description: "Closed",
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "cb-foreign",
      businessId: "biz-b",
      jobId: "job-b",
      status: "UNDER_REVIEW",
      description: "Foreign callback",
      job: { id: "job-b", businessId: "biz-b", customer: { name: "Other" } },
    },
  ],
  "biz-a",
);
check(
  "Open callbacks appear; outcome-recorded and foreign do not",
  callbacks.length === 1 &&
    callbacks[0].key === "cb-open" &&
    callbacks[0].href === "/jobs/job-a" &&
    JOB_CALLBACK_OPEN_STATUSES.includes("RECORDED"),
);

const startedAt = new Date("2026-09-30T13:00:00.000Z");
const running = buildOwnerDailyRunningTimeAttention(
  [
    {
      id: "te-run",
      businessId: "biz-a",
      membershipId: "mem-a",
      jobId: "job-a",
      status: "RUNNING",
      endedAt: null,
      startedAt,
      activityType: "JOB",
      membership: { user: { name: "Mia" } },
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "te-stopped",
      businessId: "biz-a",
      membershipId: "mem-a",
      jobId: "job-a",
      status: "READY",
      endedAt: new Date("2026-09-30T14:00:00.000Z"),
      startedAt,
      activityType: "JOB",
      membership: { user: { name: "Mia" } },
      job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
    },
    {
      id: "te-foreign",
      businessId: "biz-b",
      membershipId: "mem-b",
      jobId: "job-b",
      status: "RUNNING",
      endedAt: null,
      startedAt,
      activityType: "TRAVEL",
      membership: { user: { name: "Bree" } },
      job: { id: "job-b", businessId: "biz-b", customer: { name: "Other" } },
    },
  ],
  "biz-a",
);
check(
  "Running unfinished time appears; stopped and foreign do not",
  running.length === 1 &&
    running[0].key === "te-run" &&
    running[0].name === "Mia" &&
    running[0].href === "/jobs/job-a",
);

const depositEstimates = [
  {
    id: "est-due",
    businessId: "biz-a",
    status: "APPROVED",
    total: 500,
    customer: { name: "Pat" },
    lineItems: [{ type: "MATERIAL", total: 200, description: "Lumber" }],
  },
  {
    id: "est-paid",
    businessId: "biz-a",
    status: "APPROVED",
    total: 500,
    customer: { name: "Paid Pat" },
    lineItems: [{ type: "MATERIAL", total: 200, description: "Lumber" }],
  },
  {
    id: "est-draft",
    businessId: "biz-a",
    status: "DRAFT",
    total: 500,
    customer: { name: "Draft Pat" },
    lineItems: [{ type: "MATERIAL", total: 200, description: "Lumber" }],
  },
  {
    id: "est-foreign",
    businessId: "biz-b",
    status: "APPROVED",
    total: 500,
    customer: { name: "Other" },
    lineItems: [{ type: "MATERIAL", total: 200, description: "Lumber" }],
  },
];
const deposits = buildOwnerDailyMaterialDepositAttention(
  depositEstimates,
  new Map([
    ["est-due", 0],
    ["est-paid", 200],
    ["est-draft", 0],
    ["est-foreign", 0],
  ]),
  "biz-a",
);
check(
  "Unpaid approved material deposits appear; paid, draft, and foreign do not",
  deposits.length === 1 &&
    deposits[0].key === "est-due" &&
    deposits[0].href === "/estimates/est-due" &&
    deposits[0].meta === unpaidMaterialDepositWarning(200),
);

check(
  "Unscheduled approved work requires an approved estimate binding",
  isUnscheduledApprovedWork({ status: "UNSCHEDULED", estimateId: "est-1" }) &&
    !isUnscheduledApprovedWork({ status: "UNSCHEDULED" }) &&
    !isUnscheduledApprovedWork({ status: "SCHEDULED", estimateId: "est-1" }) &&
    ownerDailyUnscheduledApprovedWhere().status === "UNSCHEDULED",
);

const overlapStart = new Date("2026-09-30T14:00:00.000Z");
const conflictJobs = [
  {
    id: "job-1",
    scheduledAt: overlapStart,
    scheduledDurationMinutes: 120,
    assignedMembershipId: "mem-a",
    status: "SCHEDULED",
    customerName: "Pat",
  },
  {
    id: "job-2",
    scheduledAt: new Date("2026-09-30T15:00:00.000Z"),
    scheduledDurationMinutes: 120,
    assignedMembershipId: "mem-a",
    status: "SCHEDULED",
    customerName: "Riley",
  },
];
const conflicts = detectScheduleConflicts({
  jobs: conflictJobs,
  settings: DEFAULT_AVAILABILITY_SETTINGS,
  policy: DEFAULT_SCHEDULING_POLICY,
  timeZone: "UTC",
});
const conflictItems = buildOwnerDailyScheduleConflictAttention(
  conflicts,
  new Map([
    ["job-1", { id: "job-1", businessId: "biz-a", customerName: "Pat" }],
    ["job-2", { id: "job-2", businessId: "biz-a", customerName: "Riley" }],
  ]),
  "biz-a",
);
check(
  "Recorded double-booking becomes an owner-actionable conflict link",
  conflicts.some((row) => row.kind === "DOUBLE_BOOKING") &&
    conflictItems.length >= 1 &&
    conflictItems.every((item) => item.href.startsWith("/jobs/")),
);
const foreignConflicts = buildOwnerDailyScheduleConflictAttention(
  conflicts,
  new Map([
    ["job-1", { id: "job-1", businessId: "biz-b", customerName: "Other" }],
    ["job-2", { id: "job-2", businessId: "biz-b", customerName: "Other 2" }],
  ]),
  "biz-a",
);
check("Foreign conflict jobs do not appear for this business", foreignConflicts.length === 0);

console.log("\nMUTATION — each inclusion rule fails when its fact is wrong");
const goodAdditional = additionalWork[0];
const mutations = [
  [
    "foreign additional-work still projected",
    ownerDailyAttentionItemHolds({
      viewerBusinessId: "biz-a",
      recordBusinessId: "biz-b",
      actionable: true,
      item: goodAdditional,
      expectedHrefPrefix: "/jobs/",
    }),
  ],
  [
    "dismissed additional-work still projected",
    ownerDailyAttentionItemHolds({
      viewerBusinessId: "biz-a",
      recordBusinessId: "biz-a",
      actionable: false,
      item: goodAdditional,
      expectedHrefPrefix: "/jobs/",
    }),
  ],
  [
    "missing additional-work item when OPEN and owned",
    ownerDailyAttentionItemHolds({
      viewerBusinessId: "biz-a",
      recordBusinessId: "biz-a",
      actionable: true,
      item: null,
      expectedHrefPrefix: "/jobs/",
    }),
  ],
  [
    "external href leaked",
    ownerDailyAttentionItemHolds({
      viewerBusinessId: "biz-a",
      recordBusinessId: "biz-a",
      actionable: true,
      item: { ...goodAdditional, href: "https://evil.example/jobs/job-a" },
      expectedHrefPrefix: "/jobs/",
    }),
  ],
  [
    "protocol-relative href leaked",
    ownerDailyAttentionItemHolds({
      viewerBusinessId: "biz-a",
      recordBusinessId: "biz-a",
      actionable: true,
      item: { ...goodAdditional, href: "//evil.example/jobs/job-a" },
      expectedHrefPrefix: "/jobs/",
    }),
  ],
  [
    "draft invoice treated as unpaid",
    ownerDailyUnpaidInvoiceWhere().status !== "SENT",
  ],
  [
    "unscheduled job without approved work included",
    isUnscheduledApprovedWork({ status: "UNSCHEDULED" }),
  ],
  [
    "paid deposit still listed",
    buildOwnerDailyMaterialDepositAttention(
      [depositEstimates[1]],
      new Map([["est-paid", 200]]),
      "biz-a",
    ).length > 0,
  ],
  [
    "stopped clock still listed",
    buildOwnerDailyRunningTimeAttention(
      [
        {
          id: "te-stopped",
          businessId: "biz-a",
          membershipId: "mem-a",
          jobId: "job-a",
          status: "READY",
          endedAt: new Date("2026-09-30T14:00:00.000Z"),
          startedAt,
          activityType: "JOB",
        },
      ],
      "biz-a",
    ).length > 0,
  ],
  [
    "closed callback still listed",
    buildOwnerDailyCallbackAttention(
      [
        {
          id: "cb-closed",
          businessId: "biz-a",
          jobId: "job-a",
          status: "OUTCOME_RECORDED",
          description: "Closed",
          job: { id: "job-a", businessId: "biz-a", customer: { name: "Pat" } },
        },
      ],
      "biz-a",
    ).length > 0,
  ],
];
for (const [label, poisoned] of mutations) {
  check(`MUTATION — ${label} is rejected`, poisoned === false);
}
check(
  "MUTATION — valid owned OPEN additional-work still holds",
  ownerDailyAttentionItemHolds({
    viewerBusinessId: "biz-a",
    recordBusinessId: "biz-a",
    actionable: true,
    item: goodAdditional,
    expectedHrefPrefix: "/jobs/",
  }) === true,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nDB skipped — DATABASE_URL is not set");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const testDbName = "tbbt_owner_daily_ops_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for owner-daily-ops test database.");
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

async function makeMember(businessId, name, role = "MEMBER") {
  const user = await prisma.user.create({
    data: {
      name,
      email: `${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  return prisma.membership.create({
    data: { userId: user.id, businessId, role },
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
      scheduledAt: extras.scheduledAt ?? new Date("2026-09-30T14:00:00.000Z"),
      scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
      estimateId: extras.estimateId ?? null,
      assignedMembershipId: extras.assignedMembershipId ?? null,
      ...extras.job,
    },
  });
}

console.log("\nDB — Tenant scope and recorded-state inclusion");
try {
  const businessA = await makeBusiness(`daily-a-${randomUUID()}`);
  const businessB = await makeBusiness(`daily-b-${randomUUID()}`);
  const mia = await makeMember(businessA.id, "Mia Member");
  const bree = await makeMember(businessB.id, "Bree Member");
  const jobA = await makeJob(businessA.id, { customerName: "Pat Rivera" });
  const jobB = await makeJob(businessB.id, { customerName: "Other Tenant" });

  const openWork = await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      description: "Add a grab bar",
      source: "CUSTOMER",
      status: "OPEN",
    },
  });
  await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      description: "Already dismissed",
      source: "CUSTOMER",
      status: "DISMISSED",
    },
  });
  const foreignWork = await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      description: "Foreign request",
      source: "EMPLOYEE",
      status: "OPEN",
    },
  });
  const additionalRows = await prisma.additionalWorkRequest.findMany({
    where: { businessId: businessA.id, status: "OPEN" },
    select: {
      id: true,
      businessId: true,
      jobId: true,
      status: true,
      source: true,
      description: true,
      job: {
        select: { id: true, businessId: true, customer: { select: { name: true } } },
      },
      items: {
        select: {
          quantity: true,
          customDescription: true,
          serviceCatalogItem: { select: { name: true } },
        },
      },
    },
  });
  const dbAdditional = buildOwnerDailyAdditionalWorkAttention(additionalRows, businessA.id);
  check(
    "DB: OPEN same-tenant additional-work appears with Work Order link",
    dbAdditional.some(
      (item) =>
        item.key === openWork.id &&
        item.href === `/jobs/${jobA.id}` &&
        item.name === "Pat Rivera",
    ),
  );
  check(
    "DB: dismissed and foreign additional-work stay off",
    dbAdditional.every((item) => item.key !== foreignWork.id) &&
      dbAdditional.length === 1,
  );

  const sentCo = await prisma.changeOrder.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      status: "SENT",
      title: "Extra tile",
      total: 40,
    },
  });
  await prisma.changeOrder.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      status: "APPROVED",
      title: "Already approved",
      total: 15,
      approvedAt: new Date(),
    },
  });
  await prisma.changeOrder.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      status: "SENT",
      title: "Foreign CO",
      total: 80,
    },
  });
  const coRows = await prisma.changeOrder.findMany({
    where: { businessId: businessA.id, status: { in: ["DRAFT", "SENT"] } },
    select: {
      id: true,
      businessId: true,
      jobId: true,
      status: true,
      title: true,
      total: true,
      job: {
        select: { id: true, businessId: true, customer: { select: { name: true } } },
      },
    },
  });
  const dbCos = buildOwnerDailyChangeOrderAttention(coRows, businessA.id);
  check(
    "DB: SENT change order appears; approved and foreign do not",
    dbCos.some((item) => item.key === sentCo.id && item.href === `/jobs/${jobA.id}/change-orders/${sentCo.id}`) &&
      dbCos.length === 1,
  );

  const openCallback = await prisma.jobCallback.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      customerId: jobA.customerId,
      description: "Customer reported a leak",
      reportedVia: "PHONE",
      status: "RECORDED",
      recordedByMembershipId: mia.id,
    },
  });
  await prisma.jobCallback.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      customerId: jobB.customerId,
      description: "Foreign callback",
      reportedVia: "EMAIL",
      status: "UNDER_REVIEW",
      recordedByMembershipId: bree.id,
    },
  });
  const callbackRows = await prisma.jobCallback.findMany({
    where: { businessId: businessA.id, status: { in: [...JOB_CALLBACK_OPEN_STATUSES] } },
    select: {
      id: true,
      businessId: true,
      jobId: true,
      status: true,
      description: true,
      job: {
        select: { id: true, businessId: true, customer: { select: { name: true } } },
      },
    },
  });
  const dbCallbacks = buildOwnerDailyCallbackAttention(callbackRows, businessA.id);
  check(
    "DB: open callback appears; foreign callback does not",
    dbCallbacks.some((item) => item.key === openCallback.id && item.href === `/jobs/${jobA.id}`) &&
      dbCallbacks.length === 1,
  );

  const runningEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: mia.id,
      jobId: jobA.id,
      activityType: "JOB",
      status: "RUNNING",
      startedAt: new Date("2026-09-30T13:00:00.000Z"),
      source: "CLOCK",
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: mia.id,
      jobId: jobA.id,
      activityType: "JOB",
      status: "READY",
      startedAt: new Date("2026-09-30T11:00:00.000Z"),
      endedAt: new Date("2026-09-30T12:00:00.000Z"),
      source: "CLOCK",
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: businessB.id,
      membershipId: bree.id,
      jobId: jobB.id,
      activityType: "TRAVEL",
      status: "RUNNING",
      startedAt: new Date("2026-09-30T13:00:00.000Z"),
      source: "CLOCK",
    },
  });
  const timeRows = await prisma.timeEntry.findMany({
    where: { businessId: businessA.id, status: "RUNNING", endedAt: null },
    select: {
      id: true,
      businessId: true,
      membershipId: true,
      jobId: true,
      status: true,
      endedAt: true,
      startedAt: true,
      activityType: true,
      membership: { select: { user: { select: { name: true } } } },
      job: {
        select: { id: true, businessId: true, customer: { select: { name: true } } },
      },
    },
  });
  const dbRunning = buildOwnerDailyRunningTimeAttention(timeRows, businessA.id);
  check(
    "DB: running clock appears; stopped and foreign do not",
    dbRunning.some((item) => item.key === runningEntry.id && item.name === "Mia Member") &&
      dbRunning.length === 1,
  );

  const approvedCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Deposit Pat",
      email: `${randomUUID()}@example.com`,
    },
  });
  const dueEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: approvedCustomer.id,
      publicToken: randomUUID(),
      status: "APPROVED",
      total: 500,
      lineItems: {
        create: [
          {
            businessId: businessA.id,
            type: "MATERIAL",
            description: "Lumber",
            quantity: 1,
            unitPrice: 200,
            total: 200,
          },
        ],
      },
    },
    include: { lineItems: true, customer: true },
  });
  const paidEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: approvedCustomer.id,
      publicToken: randomUUID(),
      status: "APPROVED",
      total: 500,
      lineItems: {
        create: [
          {
            businessId: businessA.id,
            type: "MATERIAL",
            description: "Lumber",
            quantity: 1,
            unitPrice: 200,
            total: 200,
          },
        ],
      },
    },
    include: { lineItems: true, customer: true },
  });
  await prisma.payment.create({
    data: {
      businessId: businessA.id,
      estimateId: paidEstimate.id,
      amount: new Prisma.Decimal(200),
      method: "CASH",
      purpose: "MATERIAL_DEPOSIT",
      receivedAt: new Date("2026-09-29T12:00:00.000Z"),
    },
  });
  const dbDeposits = buildOwnerDailyMaterialDepositAttention(
    [dueEstimate, paidEstimate],
    new Map([
      [dueEstimate.id, 0],
      [paidEstimate.id, 200],
    ]),
    businessA.id,
  );
  check(
    "DB: unpaid approved deposit appears; paid deposit does not",
    dbDeposits.some((item) => item.key === dueEstimate.id && item.href === `/estimates/${dueEstimate.id}`) &&
      dbDeposits.every((item) => item.key !== paidEstimate.id),
  );

  const approvedUnscheduled = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: approvedCustomer.id,
      publicToken: randomUUID(),
      status: "APPROVED",
      total: 120,
    },
  });
  const unscheduledApproved = await makeJob(businessA.id, {
    customerName: "Unscheduled Pat",
    status: "UNSCHEDULED",
    estimateId: approvedUnscheduled.id,
    scheduledAt: null,
  });
  const unscheduledBare = await makeJob(businessA.id, {
    customerName: "Bare job",
    status: "UNSCHEDULED",
    scheduledAt: null,
  });
  const unscheduledRows = await prisma.job.findMany({
    where: { businessId: businessA.id, ...ownerDailyUnscheduledApprovedWhere() },
    select: { id: true, status: true, estimateId: true },
  });
  check(
    "DB: unscheduled approved work includes the estimate-bound job only",
    unscheduledRows.some((row) => row.id === unscheduledApproved.id) &&
      unscheduledRows.every((row) => row.id !== unscheduledBare.id),
  );

  const sentInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      status: "SENT",
      kind: "ORIGINAL",
      total: 90,
    },
  });
  const draftInvoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: unscheduledBare.id,
      status: "DRAFT",
      kind: "ORIGINAL",
      total: 90,
    },
  });
  const unpaidRows = await prisma.invoice.findMany({
    where: { businessId: businessA.id, ...ownerDailyUnpaidInvoiceWhere() },
    select: { id: true, status: true },
  });
  check(
    "DB: SENT invoice is unpaid attention; DRAFT is not",
    unpaidRows.some((row) => row.id === sentInvoice.id) &&
      unpaidRows.every((row) => row.id !== draftInvoice.id),
  );

  const overlapA = await makeJob(businessA.id, {
    customerName: "Overlap A",
    assignedMembershipId: mia.id,
    scheduledAt: new Date("2026-09-30T14:00:00.000Z"),
    scheduledDurationMinutes: 120,
  });
  const overlapB = await makeJob(businessA.id, {
    customerName: "Overlap B",
    assignedMembershipId: mia.id,
    scheduledAt: new Date("2026-09-30T15:00:00.000Z"),
    scheduledDurationMinutes: 120,
  });
  const dbConflicts = detectScheduleConflicts({
    jobs: [
      {
        id: overlapA.id,
        scheduledAt: overlapA.scheduledAt,
        scheduledDurationMinutes: overlapA.scheduledDurationMinutes,
        assignedMembershipId: mia.id,
        status: "SCHEDULED",
        customerName: "Overlap A",
      },
      {
        id: overlapB.id,
        scheduledAt: overlapB.scheduledAt,
        scheduledDurationMinutes: overlapB.scheduledDurationMinutes,
        assignedMembershipId: mia.id,
        status: "SCHEDULED",
        customerName: "Overlap B",
      },
    ],
    settings: DEFAULT_AVAILABILITY_SETTINGS,
    policy: DEFAULT_SCHEDULING_POLICY,
    timeZone: "UTC",
  });
  const dbConflictItems = buildOwnerDailyScheduleConflictAttention(
    dbConflicts,
    new Map([
      [overlapA.id, { id: overlapA.id, businessId: businessA.id, customerName: "Overlap A" }],
      [overlapB.id, { id: overlapB.id, businessId: businessA.id, customerName: "Overlap B" }],
    ]),
    businessA.id,
  );
  check(
    "DB: overlapping assigned jobs surface as a scheduling conflict",
    dbConflictItems.some((item) => item.href === `/jobs/${overlapA.id}` || item.href === `/jobs/${overlapB.id}`),
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
