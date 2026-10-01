/**
 * Founder Handyman owner morning attention.
 *
 * Proves Dashboard / Today load deposits, first-awaiting, and conflicts
 * through src/lib/owner-daily-attention-data.ts — the same helpers the
 * pages import. Disposable local Postgres only. No new dashboard.
 *
 * Run with:
 *   TZ=America/New_York node --experimental-strip-types scripts/check-owner-daily-ops.mjs
 */
process.env.TZ = "America/New_York";

import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

const { Prisma } = await import("@prisma/client");
const { DEFAULT_AVAILABILITY_SETTINGS } = await import("@/lib/availability");
const { JOB_CALLBACK_OPEN_STATUSES } = await import("@/lib/job-callback");
const { unpaidMaterialDepositWarning } = await import("@/lib/project-payments");
const { DEFAULT_SCHEDULING_POLICY } = await import("@/lib/workforce");
const { detectScheduleConflicts } = await import("@/lib/workforce-conflicts");
const { roleHasCapability, CAPABILITIES } = await import("@/lib/authorization");
const {
  OWNER_DAILY_ATTENTION_TAKE,
  OWNER_DAILY_CONFLICT_JOBS_TAKE,
  OWNER_DAILY_GROUP_TITLES,
  OWNER_DAILY_MORE_NOT_SHOWN,
  buildOwnerDailyAdditionalWorkAttention,
  buildOwnerDailyCallbackAttention,
  buildOwnerDailyChangeOrderAttention,
  buildOwnerDailyMaterialDepositAttention,
  buildOwnerDailyRunningTimeAttention,
  buildOwnerDailyScheduleConflictAttention,
  isUnscheduledApprovedWork,
  ownerDailyAttentionItemHolds,
  ownerDailyConflictTruncationLabel,
  ownerDailyUnpaidInvoiceWhere,
  ownerDailyUnscheduledApprovedWhere,
  scheduleConflictNeedsOwnerAttention,
} = await import("@/lib/owner-daily-attention");
const {
  loadOwnerDailyActionableAttention,
  loadOwnerDailyConflictJobs,
  loadOwnerDailyFirstAwaitingJobs,
  loadOwnerDailyMaterialDepositAttention,
  loadOwnerDailyScheduleConflictAttention,
  ownerDailyFirstAwaitingCandidateWhere,
  projectOwnerDailyFirstAwaitingAttention,
} = await import("@/lib/owner-daily-attention-data");

const CASE = process.env.OWNER_DAILY_OPS_CASE || "";
const MUTATION_CHILD = CASE.length > 0;

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
const dataSrc = readRepo("src/lib/owner-daily-attention-data.ts");
const listSrc = readRepo("src/components/today/owner-daily-attention-list.tsx");
const selfSrc = readRepo("scripts/check-owner-daily-ops.mjs");

if (!MUTATION_CHILD) {
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
    "Both pages import the shared owner-daily loaders",
    dashboardSrc.includes("loadOwnerDailyActionableAttention") &&
      todaySrc.includes("loadOwnerDailyActionableAttention") &&
      dashboardSrc.includes("projectOwnerDailyFirstAwaitingAttention") &&
      selfSrc.includes('from "@/lib/owner-daily-attention-data"'),
  );
  check(
    "Pages do not inline the broken deposit / unbounded conflict queries",
    !dashboardSrc.includes('status: "APPROVED"') &&
      !todaySrc.includes('status: "APPROVED"') &&
      !dashboardSrc.includes("loadCapacityJobs") &&
      !todaySrc.includes("loadCapacityJobs") &&
      !dashboardSrc.includes("ownerTodayAppointmentCandidateWhere") &&
      dataSrc.includes("OWNER_DAILY_DEPOSIT_ESTIMATE_SELECT") &&
      dataSrc.includes("approvedOptionId: true") &&
      helperSrc.includes("resolveChosenCommercialScope") &&
      dataSrc.includes("ownerDailyFirstAwaitingCandidateWhere"),
  );
  check(
    "Deposit select includes approved option/version and option-tagged lines",
    dataSrc.includes("approvedOption:") &&
      dataSrc.includes("approvedVersion:") &&
      dataSrc.includes("optionId: true"),
  );
  check(
    "Queries stay business-scoped and bounded",
    dashboardSrc.includes("...access.scope") &&
      todaySrc.includes("...access.scope") &&
      dashboardSrc.includes("OWNER_DAILY_ATTENTION_TAKE") &&
      todaySrc.includes("OWNER_DAILY_ATTENTION_TAKE") &&
      helperSrc.includes("if (row.businessId !== businessId) return null") &&
      dataSrc.includes("OWNER_DAILY_CONFLICT_JOBS_TAKE + 1"),
  );
  check(
    "Dashboard first-time awaiting uses the tight first-awaiting where, not the wide candidate OR",
    dashboardSrc.includes("includeFirstAwaiting: true") &&
      dataSrc.includes('appointmentConfirmationStatus: "AWAITING_CUSTOMER"') &&
      dataSrc.includes("appointmentChangeRequestNote: null") &&
      !ownerDailyFirstAwaitingCandidateWhere(new Date()).OR &&
      dashboardSrc.includes("OwnerTodayAppointmentAttention") &&
      dashboardSrc.includes("dashboardAppointmentAttentionItems"),
  );
  check(
    "Attention items are links into existing records, not a new dashboard",
    listSrc.includes("href={item.href}") &&
      listSrc.includes("OWNER_DAILY_MORE_NOT_SHOWN") &&
      helperSrc.includes("href: `/jobs/${job.id}`") &&
      helperSrc.includes("href: `/estimates/${estimate.id}`") &&
      helperSrc.includes("href: `/jobs/${job.id}/change-orders/${row.id}`") &&
      dashboardSrc.includes("OWNER_DAILY_MORE_NOT_SHOWN") &&
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
  check(
    "This verifier uses the disposable harness and asserts localhost first",
    selfSrc.includes('from "./disposable-test-database.mjs"') &&
      selfSrc.includes("openDisposableTestDatabase") &&
      selfSrc.includes("session.cleanup()") &&
      selfSrc.includes("assertLocalDatabaseUrl") &&
      selfSrc.indexOf("assertLocalDatabaseUrl(") < selfSrc.indexOf("openDisposableTestDatabase("),
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

  const optionBChosen = buildOwnerDailyMaterialDepositAttention(
    [
      {
        id: "est-opt",
        businessId: "biz-a",
        status: "APPROVED",
        total: 400,
        approvedOptionId: "opt-b",
        customer: { name: "Chosen B" },
        lineItems: [
          { type: "LABOR", total: 200, description: "Labor A", optionId: "opt-a" },
          { type: "MATERIAL", total: 300, description: "Material A", optionId: "opt-a" },
          { type: "LABOR", total: 400, description: "Labor B", optionId: "opt-b" },
        ],
        approvedOption: { id: "opt-b", name: "B", total: 400 },
        approvedVersion: {
          total: 400,
          lineItems: [
            { type: "LABOR", total: 200, description: "Labor A", optionId: "opt-a" },
            { type: "MATERIAL", total: 300, description: "Material A", optionId: "opt-a" },
            { type: "LABOR", total: 400, description: "Labor B", optionId: "opt-b" },
          ],
        },
      },
    ],
    new Map([["est-opt", 0]]),
    "biz-a",
  );
  const liveAllOptions = buildOwnerDailyMaterialDepositAttention(
    [
      {
        id: "est-opt",
        businessId: "biz-a",
        status: "APPROVED",
        total: 400,
        customer: { name: "Chosen B" },
        lineItems: [
          { type: "LABOR", total: 200, description: "Labor A" },
          { type: "MATERIAL", total: 300, description: "Material A" },
          { type: "LABOR", total: 400, description: "Labor B" },
        ],
      },
    ],
    new Map([["est-opt", 0]]),
    "biz-a",
  );
  check(
    "Chosen option B with no materials is not a material-deposit alert",
    optionBChosen.length === 0,
  );
  check(
    "Live all-option lines plus estimate.total would falsely alert — that is why chosen scope is required",
    liveAllOptions.length === 1 &&
      liveAllOptions[0].meta === unpaidMaterialDepositWarning(300),
  );

  check(
    "Unscheduled approved work requires an approved estimate binding",
    isUnscheduledApprovedWork({ status: "UNSCHEDULED", estimateId: "est-1" }) &&
      !isUnscheduledApprovedWork({ status: "UNSCHEDULED" }) &&
      !isUnscheduledApprovedWork({ status: "SCHEDULED", estimateId: "est-1" }) &&
      ownerDailyUnscheduledApprovedWhere().status === "UNSCHEDULED",
  );

  const overlapStart = new Date("2026-10-01T18:00:00.000Z");
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
      scheduledAt: new Date("2026-10-01T19:00:00.000Z"),
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
    timeZone: "America/New_York",
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

  const turnaroundConflicts = detectScheduleConflicts({
    jobs: [
      {
        id: "job-ta",
        scheduledAt: new Date("2026-10-01T18:00:00.000Z"),
        scheduledDurationMinutes: 60,
        assignedMembershipId: "mem-a",
        status: "SCHEDULED",
        customerName: "Turn A",
      },
      {
        id: "job-tb",
        scheduledAt: new Date("2026-10-01T19:10:00.000Z"),
        scheduledDurationMinutes: 60,
        assignedMembershipId: "mem-a",
        status: "SCHEDULED",
        customerName: "Turn B",
      },
    ],
    settings: DEFAULT_AVAILABILITY_SETTINGS,
    policy: DEFAULT_SCHEDULING_POLICY,
    timeZone: "America/New_York",
  });
  const outsideConflicts = detectScheduleConflicts({
    jobs: [
      {
        id: "job-out",
        scheduledAt: new Date("2026-10-01T10:00:00.000Z"),
        scheduledDurationMinutes: 60,
        status: "SCHEDULED",
        customerName: "Early",
      },
    ],
    settings: DEFAULT_AVAILABILITY_SETTINGS,
    policy: DEFAULT_SCHEDULING_POLICY,
    timeZone: "America/New_York",
  });
  check(
    "Seeded INSUFFICIENT_TURNAROUND and OUTSIDE_AVAILABILITY are WARNING and excluded",
    turnaroundConflicts.some((row) => row.kind === "INSUFFICIENT_TURNAROUND" && row.severity === "WARNING") &&
      outsideConflicts.some((row) => row.kind === "OUTSIDE_AVAILABILITY" && row.severity === "WARNING") &&
      turnaroundConflicts.every((row) => !scheduleConflictNeedsOwnerAttention(row)) &&
      outsideConflicts.every((row) => !scheduleConflictNeedsOwnerAttention(row)) &&
      buildOwnerDailyScheduleConflictAttention(
        [...turnaroundConflicts, ...outsideConflicts],
        new Map([
          ["job-ta", { id: "job-ta", businessId: "biz-a", customerName: "Turn A" }],
          ["job-tb", { id: "job-tb", businessId: "biz-a", customerName: "Turn B" }],
          ["job-out", { id: "job-out", businessId: "biz-a", customerName: "Early" }],
        ]),
        "biz-a",
      ).length === 0,
  );
  check(
    "Only ERROR DOUBLE_BOOKING / OVERLAP need owner attention",
    scheduleConflictNeedsOwnerAttention({
      kind: "DOUBLE_BOOKING",
      severity: "ERROR",
      jobId: "j1",
      explanation: "x",
    }) &&
      !scheduleConflictNeedsOwnerAttention({
        kind: "OVERLAP",
        severity: "WARNING",
        jobId: "j1",
        explanation: "x",
      }) &&
      !scheduleConflictNeedsOwnerAttention({
        kind: "DURATION_EXCEEDS_DAY",
        severity: "ERROR",
        jobId: "j1",
        explanation: "x",
      }) &&
      !scheduleConflictNeedsOwnerAttention({
        kind: "INSUFFICIENT_TURNAROUND",
        severity: "WARNING",
        jobId: "j1",
        explanation: "x",
      }),
  );
  check(
    "Conflict truncation label is honest",
    ownerDailyConflictTruncationLabel(30, 25) === "30 conflicts, showing 25" &&
      ownerDailyConflictTruncationLabel(25, 25) === null &&
      OWNER_DAILY_MORE_NOT_SHOWN === "more not shown" &&
      OWNER_DAILY_CONFLICT_JOBS_TAKE === 200 &&
      OWNER_DAILY_ATTENTION_TAKE === 25,
  );

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
    ["draft invoice treated as unpaid", ownerDailyUnpaidInvoiceWhere().status !== "SENT"],
    ["unscheduled job without approved work included", isUnscheduledApprovedWork({ status: "UNSCHEDULED" })],
    [
      "paid deposit still listed",
      buildOwnerDailyMaterialDepositAttention(
        [depositEstimates[1]],
        new Map([["est-paid", 200]]),
        "biz-a",
      ).length > 0,
    ],
    [
      "chosen option B still listed as a $300 material deposit",
      optionBChosen.length > 0,
    ],
    [
      "WARNING turnaround treated as owner attention",
      scheduleConflictNeedsOwnerAttention({
        kind: "INSUFFICIENT_TURNAROUND",
        severity: "WARNING",
        jobId: "j1",
        explanation: "x",
      }),
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
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nDB skipped — DATABASE_URL is not set");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

assertLocalDatabaseUrl(baseUrl, "owner-daily-ops disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_owner_daily_ops",
  setProcessEnv: true,
});
try {
  const { prisma, testUrl } = session;
  assertLocalDatabaseUrl(testUrl, "owner-daily-ops disposable test URL");

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

    async function makeCustomer(businessId, name) {
      return prisma.customer.create({
        data: {
          businessId,
          name,
          email: `${randomUUID()}@example.com`,
        },
      });
    }

    async function makeJob(businessId, extras = {}) {
      const customer =
        extras.customerId
          ? { id: extras.customerId }
          : await makeCustomer(businessId, extras.customerName ?? "Stanley");
      return prisma.job.create({
        data: {
          businessId,
          customerId: customer.id,
          projectToken: extras.projectToken ?? randomUUID(),
          status: extras.status ?? "SCHEDULED",
          scheduledAt: extras.scheduledAt ?? new Date("2026-10-01T18:00:00.000Z"),
          scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
          estimateId: extras.estimateId ?? null,
          assignedMembershipId: extras.assignedMembershipId ?? null,
          ...(extras.appointmentConfirmationStatus
            ? { appointmentConfirmationStatus: extras.appointmentConfirmationStatus }
            : {}),
          ...(extras.appointmentChangeRequestNote
            ? { appointmentChangeRequestNote: extras.appointmentChangeRequestNote }
            : {}),
          ...(extras.appointmentConfirmedForProposalId != null
            ? { appointmentConfirmedForProposalId: extras.appointmentConfirmedForProposalId }
            : {}),
          ...extras.job,
        },
      });
    }

    async function makeApprovedEstimate(businessId, customerId, extras = {}) {
      return prisma.estimate.create({
        data: {
          businessId,
          customerId,
          publicToken: randomUUID(),
          status: "APPROVED",
          total: extras.total ?? 500,
          lineItems: extras.lineItems
            ? { create: extras.lineItems.map((line) => ({ businessId, ...line })) }
            : undefined,
        },
      });
    }

    const run = (name) => !CASE || CASE === name;

    if (run("inclusion")) {
      console.log("\nDB — Tenant scope and recorded-state inclusion via real loaders");
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
      await prisma.additionalWorkRequest.create({
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
        ) && dbAdditional.length === 1,
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
      const dbCos = buildOwnerDailyChangeOrderAttention(
        await prisma.changeOrder.findMany({
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
        }),
        businessA.id,
      );
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
      const dbCallbacks = buildOwnerDailyCallbackAttention(
        await prisma.jobCallback.findMany({
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
        }),
        businessA.id,
      );
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
      const dbRunning = buildOwnerDailyRunningTimeAttention(
        await prisma.timeEntry.findMany({
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
        }),
        businessA.id,
      );
      check(
        "DB: running clock appears; stopped and foreign do not",
        dbRunning.some((item) => item.key === runningEntry.id && item.name === "Mia Member") &&
          dbRunning.length === 1,
      );

      const approvedCustomer = await makeCustomer(businessA.id, "Deposit Pat");
      const dueEstimate = await makeApprovedEstimate(businessA.id, approvedCustomer.id, {
        total: 500,
        lineItems: [
          {
            type: "MATERIAL",
            description: "Lumber",
            quantity: 1,
            unitPrice: 200,
            total: 200,
          },
        ],
      });
      const paidEstimate = await makeApprovedEstimate(businessA.id, approvedCustomer.id, {
        total: 500,
        lineItems: [
          {
            type: "MATERIAL",
            description: "Lumber",
            quantity: 1,
            unitPrice: 200,
            total: 200,
          },
        ],
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
      const depositBundle = await loadOwnerDailyMaterialDepositAttention(prisma, businessA.id);
      check(
        "DB loader: unpaid approved deposit appears; paid deposit does not",
        depositBundle.items.some((item) => item.key === dueEstimate.id && item.href === `/estimates/${dueEstimate.id}`) &&
          depositBundle.items.every((item) => item.key !== paidEstimate.id),
      );

      const approvedUnscheduled = await makeApprovedEstimate(businessA.id, approvedCustomer.id, {
        total: 120,
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
    }

    if (run("deposit-window")) {
      console.log("\nDB — Deposit window uses unpaid filter before the take");
      const business = await makeBusiness(`dep-win-${randomUUID()}`);
      const customer = await makeCustomer(business.id, "Window Pat");
      const oldUnpaid = await makeApprovedEstimate(business.id, customer.id, {
        total: 300,
        lineItems: [
          {
            type: "MATERIAL",
            description: "Lumber",
            quantity: 1,
            unitPrice: 300,
            total: 300,
          },
        ],
      });
      await prisma.$executeRaw`
        UPDATE "Estimate"
        SET "updatedAt" = ${new Date("2026-09-01T12:00:00.000Z")}
        WHERE id = ${oldUnpaid.id}
      `;
      for (let i = 0; i < 26; i += 1) {
        await makeApprovedEstimate(business.id, customer.id, {
          total: 80,
          lineItems: [
            {
              type: "LABOR",
              description: `Newer labor ${i}`,
              quantity: 1,
              unitPrice: 80,
              total: 80,
            },
          ],
        });
      }
      const broken = await prisma.estimate.findMany({
        where: { businessId: business.id, status: "APPROVED" },
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });
      const loaded = await loadOwnerDailyMaterialDepositAttention(prisma, business.id);
      check(
        "Broken take-25-before-filter drops the older unpaid $300 deposit",
        broken.length === 25 && broken.every((row) => row.id !== oldUnpaid.id),
      );
      check(
        "Shared deposit loader finds the older unpaid $300 deposit",
        loaded.items.some(
          (item) =>
            item.key === oldUnpaid.id &&
            item.meta === unpaidMaterialDepositWarning(300),
        ),
      );
    }

    if (run("deposit-scope")) {
      console.log("\nDB — Deposit scope uses chosen commercial option");
      const business = await makeBusiness(`dep-scope-${randomUUID()}`);
      const customer = await makeCustomer(business.id, "Option Pat");
      const estimate = await prisma.estimate.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          publicToken: randomUUID(),
          status: "APPROVED",
          total: 400,
        },
      });
      const optA = await prisma.estimateOption.create({
        data: { businessId: business.id, estimateId: estimate.id, name: "A", sortOrder: 1 },
      });
      const optB = await prisma.estimateOption.create({
        data: { businessId: business.id, estimateId: estimate.id, name: "B", sortOrder: 2 },
      });
      await prisma.lineItem.createMany({
        data: [
          {
            businessId: business.id,
            estimateId: estimate.id,
            optionId: optA.id,
            type: "LABOR",
            description: "Labor A",
            quantity: 1,
            unitPrice: 200,
            total: 200,
          },
          {
            businessId: business.id,
            estimateId: estimate.id,
            optionId: optA.id,
            type: "MATERIAL",
            description: "Material A",
            quantity: 1,
            unitPrice: 300,
            total: 300,
          },
          {
            businessId: business.id,
            estimateId: estimate.id,
            optionId: optB.id,
            type: "LABOR",
            description: "Labor B",
            quantity: 1,
            unitPrice: 400,
            total: 400,
          },
        ],
      });
      const version = await prisma.estimateVersion.create({
        data: {
          businessId: business.id,
          estimateId: estimate.id,
          versionNumber: 1,
          total: 400,
          laborMinimumWaived: false,
          laborMinimumAdjustment: 0,
        },
      });
      const vOptA = await prisma.estimateVersionOption.create({
        data: {
          businessId: business.id,
          estimateVersionId: version.id,
          sourceOptionId: optA.id,
          name: "A",
          sortOrder: 1,
          total: 500,
          laborMinimumAdjustment: 0,
        },
      });
      const vOptB = await prisma.estimateVersionOption.create({
        data: {
          businessId: business.id,
          estimateVersionId: version.id,
          sourceOptionId: optB.id,
          name: "B",
          sortOrder: 2,
          total: 400,
          laborMinimumAdjustment: 0,
        },
      });
      await prisma.estimateVersionLineItem.createMany({
        data: [
          {
            businessId: business.id,
            estimateVersionId: version.id,
            optionId: vOptA.id,
            type: "LABOR",
            description: "Labor A",
            quantity: 1,
            unitPrice: 200,
            total: 200,
          },
          {
            businessId: business.id,
            estimateVersionId: version.id,
            optionId: vOptA.id,
            type: "MATERIAL",
            description: "Material A",
            quantity: 1,
            unitPrice: 300,
            total: 300,
          },
          {
            businessId: business.id,
            estimateVersionId: version.id,
            optionId: vOptB.id,
            type: "LABOR",
            description: "Labor B",
            quantity: 1,
            unitPrice: 400,
            total: 400,
          },
        ],
      });
      await prisma.estimate.update({
        where: { id: estimate.id },
        data: { approvedVersionId: version.id, approvedOptionId: vOptB.id },
      });
      const liveLines = await prisma.lineItem.findMany({
        where: { estimateId: estimate.id },
        select: { type: true, total: true, description: true },
      });
      const falseAlert = buildOwnerDailyMaterialDepositAttention(
        [
          {
            id: estimate.id,
            businessId: business.id,
            status: "APPROVED",
            total: 400,
            customer: { name: "Option Pat" },
            lineItems: liveLines,
          },
        ],
        new Map([[estimate.id, 0]]),
        business.id,
      );
      const loaded = await loadOwnerDailyMaterialDepositAttention(prisma, business.id);
      check(
        "Live all-option lines falsely alert $300 on approved option B",
        falseAlert.some((item) => item.meta === unpaidMaterialDepositWarning(300)),
      );
      check(
        "Shared deposit loader uses chosen option B and does not alert",
        loaded.items.every((item) => item.key !== estimate.id),
      );
    }

    if (run("first-awaiting")) {
      console.log("\nDB — First awaiting excludes different-time jobs before the take");
      const business = await makeBusiness(`await-${randomUUID()}`);
      const start = new Date("2026-10-01T00:00:00.000Z");
      for (let i = 0; i < 26; i += 1) {
        await makeJob(business.id, {
          customerName: `Different ${i}`,
          scheduledAt: new Date(start.getTime() + (i + 1) * 60 * 60 * 1000),
          appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
          appointmentChangeRequestNote: "Please move this",
        });
      }
      const awaiting = await makeJob(business.id, {
        customerName: "First Await",
        scheduledAt: new Date(start.getTime() + 30 * 60 * 60 * 1000),
        appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      });
      const broken = await prisma.job.findMany({
        where: {
          businessId: business.id,
          scheduledAt: { gte: start },
          status: { not: "COMPLETED" },
          OR: [
            { appointmentConfirmationStatus: "AWAITING_CUSTOMER" },
            { appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED" },
            { appointmentChangeRequestNote: { not: null } },
          ],
        },
        orderBy: { scheduledAt: "asc" },
        take: 25,
        select: { id: true, appointmentConfirmationStatus: true },
      });
      const loaded = await loadOwnerDailyFirstAwaitingJobs(
        prisma,
        { businessId: business.id },
        start,
      );
      const projected = projectOwnerDailyFirstAwaitingAttention(loaded, {
        businessId: business.id,
        start,
        timeZone: "America/New_York",
      });
      check(
        "Broken wide-where take-25 hides the later AWAITING_CUSTOMER job",
        broken.length === 25 &&
          broken.every((row) => row.id !== awaiting.id) &&
          broken.every((row) => row.appointmentConfirmationStatus === "DIFFERENT_TIME_REQUESTED"),
      );
      check(
        "Shared first-awaiting loader returns the later AWAITING_CUSTOMER job",
        loaded.some((row) => row.id === awaiting.id) &&
          projected.some((item) => item.jobId === awaiting.id && item.kind === "AWAITING_CUSTOMER"),
      );
    }

    if (run("conflicts")) {
      console.log("\nDB — Conflicts are bounded, capped, and ERROR DOUBLE_BOOKING only");
      const business = await makeBusiness(`conf-${randomUUID()}`);
      const worker = await makeMember(business.id, "Casey");
      const range = {
        start: new Date("2026-10-01T00:00:00.000Z"),
        end: new Date("2026-10-22T00:00:00.000Z"),
      };
      const pairIds = [];
      for (let i = 0; i < 26; i += 1) {
        const day = new Date(
          Date.UTC(2026, 9, 3 + Math.floor(i / 2), 13 + (i % 2) * 5, 0, 0),
        );
        const a = await makeJob(business.id, {
          customerName: `Conflict A ${i}`,
          assignedMembershipId: worker.id,
          scheduledAt: day,
          scheduledDurationMinutes: 120,
        });
        const b = await makeJob(business.id, {
          customerName: `Conflict B ${i}`,
          assignedMembershipId: worker.id,
          scheduledAt: new Date(day.getTime() + 60 * 60 * 1000),
          scheduledDurationMinutes: 120,
        });
        pairIds.push(a.id, b.id);
      }
      const turnA = await makeJob(business.id, {
        customerName: "Turnaround A",
        assignedMembershipId: worker.id,
        scheduledAt: new Date("2026-10-01T18:00:00.000Z"),
        scheduledDurationMinutes: 60,
      });
      const turnB = await makeJob(business.id, {
        customerName: "Turnaround B",
        assignedMembershipId: worker.id,
        scheduledAt: new Date("2026-10-01T19:10:00.000Z"),
        scheduledDurationMinutes: 60,
      });
      const early = await makeJob(business.id, {
        customerName: "Outside hours",
        scheduledAt: new Date("2026-10-02T10:00:00.000Z"),
        scheduledDurationMinutes: 60,
      });
      const loaded = await loadOwnerDailyScheduleConflictAttention(prisma, business.id, {
        range,
        timeZone: "America/New_York",
      });
      check(
        "Conflict attention is capped at 25 with a true count above the cap",
        loaded.items.length === OWNER_DAILY_ATTENTION_TAKE &&
          loaded.count > OWNER_DAILY_ATTENTION_TAKE &&
          loaded.truncated &&
          ownerDailyConflictTruncationLabel(loaded.count, loaded.items.length) ===
            `${loaded.count} conflicts, showing ${loaded.items.length}`,
      );
      check(
        "INSUFFICIENT_TURNAROUND and OUTSIDE_AVAILABILITY jobs are not listed",
        loaded.items.every(
          (item) =>
            !item.key.includes(turnA.id) &&
            !item.key.includes(turnB.id) &&
            !item.key.includes(early.id),
        ),
      );

      const scanBusiness = await makeBusiness(`scan-${randomUUID()}`);
      for (let i = 0; i < OWNER_DAILY_CONFLICT_JOBS_TAKE + 10; i += 1) {
        await makeJob(scanBusiness.id, {
          customerName: `Scan ${i}`,
          scheduledAt: new Date(range.start.getTime() + i * 60 * 60 * 1000),
          scheduledDurationMinutes: 30,
        });
      }
      const scanned = await loadOwnerDailyConflictJobs(prisma, scanBusiness.id, range);
      check(
        "Conflict job scan is bounded to the window take",
        scanned.scannedJobCount === OWNER_DAILY_CONFLICT_JOBS_TAKE &&
          scanned.jobScanTruncated,
      );

      const bundle = await loadOwnerDailyActionableAttention(prisma, {
        businessId: business.id,
        scope: { businessId: business.id },
        todayStart: range.start,
        conflictRange: range,
        timeZone: "America/New_York",
        includeFirstAwaiting: false,
      });
      check(
        "Actionable bundle reuses the same capped conflict helper",
        bundle.scheduleConflicts.items.length === loaded.items.length &&
          bundle.scheduleConflicts.count === loaded.count,
      );
      check(
        "Double-booking pairs were actually created for the cap test",
        pairIds.length === 52,
      );
    }

    if (run("conflict-filter")) {
      console.log("\nDB — WARNING turnaround / outside-hours conflicts stay off the list");
      const business = await makeBusiness(`cfilter-${randomUUID()}`);
      const worker = await makeMember(business.id, "Riley");
      const range = {
        start: new Date("2026-10-01T00:00:00.000Z"),
        end: new Date("2026-10-22T00:00:00.000Z"),
      };
      await makeJob(business.id, {
        customerName: "Turnaround A",
        assignedMembershipId: worker.id,
        scheduledAt: new Date("2026-10-01T18:00:00.000Z"),
        scheduledDurationMinutes: 60,
      });
      await makeJob(business.id, {
        customerName: "Turnaround B",
        assignedMembershipId: worker.id,
        scheduledAt: new Date("2026-10-01T19:10:00.000Z"),
        scheduledDurationMinutes: 60,
      });
      await makeJob(business.id, {
        customerName: "Outside hours",
        scheduledAt: new Date("2026-10-02T10:00:00.000Z"),
        scheduledDurationMinutes: 60,
      });
      const loaded = await loadOwnerDailyScheduleConflictAttention(prisma, business.id, {
        range,
        timeZone: "America/New_York",
      });
      check(
        "Real loader excludes seeded INSUFFICIENT_TURNAROUND and OUTSIDE_AVAILABILITY",
        loaded.items.length === 0 && loaded.count === 0,
      );
    }
} finally {
  await session.cleanup();
}

if (!MUTATION_CHILD) {
  console.log("\nMUTATION-REVERT — each fix fails its real-loader test when reverted");
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const attentionPath = `${repoRoot}src/lib/owner-daily-attention.ts`;
  const dataPath = `${repoRoot}src/lib/owner-daily-attention-data.ts`;
  const originals = {
    [attentionPath]: readFileSync(attentionPath, "utf8"),
    [dataPath]: readFileSync(dataPath, "utf8"),
  };

  function replaceMarked(src, begin, end, body) {
    const start = src.indexOf(begin);
    const stop = src.indexOf(end);
    if (start < 0 || stop < 0) {
      throw new Error(`missing markers ${begin} / ${end}`);
    }
    return `${src.slice(0, start)}${begin}\n${body}\n${src.slice(stop)}`;
  }

  const reverts = [
    {
      id: "deposit-window",
      file: dataPath,
      begin: "// OWNER_DAILY_DEPOSIT_WINDOW_BEGIN",
      end: "// OWNER_DAILY_DEPOSIT_WINDOW_END",
      body: `  const batch = (await db.estimate.findMany({
    where: { businessId, status: "APPROVED" },
    select: OWNER_DAILY_DEPOSIT_ESTIMATE_SELECT,
    orderBy: { updatedAt: "desc" },
    take,
  })) as OwnerDailyDepositEstimateRecord[];
  const paid = await depositPaidByEstimateIds(
    db,
    businessId,
    batch.map((estimate) => estimate.id),
  );
  unpaid.push(...buildOwnerDailyMaterialDepositAttention(batch, paid, businessId));
  done = true;`,
    },
    {
      id: "deposit-scope",
      file: attentionPath,
      begin: "// OWNER_DAILY_DEPOSIT_SCOPE_BEGIN",
      end: "// OWNER_DAILY_DEPOSIT_SCOPE_END",
      body: `  const deposit = resolveMaterialDeposit({
    lines: estimate.lineItems,
    total: estimate.total,
  });`,
    },
    {
      id: "first-awaiting",
      file: dataPath,
      begin: "// OWNER_DAILY_FIRST_AWAITING_WHERE_BEGIN",
      end: "// OWNER_DAILY_FIRST_AWAITING_WHERE_END",
      body: `  return {
    scheduledAt: { gte: start },
    status: { not: "COMPLETED" as const },
    OR: [
      { appointmentConfirmationStatus: "AWAITING_CUSTOMER" },
      { appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED" },
      { appointmentChangeRequestNote: { not: null } },
    ],
  };`,
    },
    {
      id: "conflicts",
      file: dataPath,
      apply(src) {
        let next = replaceMarked(
          src,
          "// OWNER_DAILY_CONFLICT_JOB_TAKE_BEGIN",
          "// OWNER_DAILY_CONFLICT_JOB_TAKE_END",
          "    take: 100000,",
        );
        next = replaceMarked(
          next,
          "// OWNER_DAILY_CONFLICT_DISPLAY_CAP_BEGIN",
          "// OWNER_DAILY_CONFLICT_DISPLAY_CAP_END",
          "  const items = allItems;",
        );
        return next;
      },
    },
    {
      id: "conflict-filter",
      file: attentionPath,
      begin: "// OWNER_DAILY_CONFLICT_FILTER_BEGIN",
      end: "// OWNER_DAILY_CONFLICT_FILTER_END",
      body: "  return true;",
    },
  ];

  const scriptPath = fileURLToPath(import.meta.url);
  for (const revert of reverts) {
    try {
      writeFileSync(attentionPath, originals[attentionPath]);
      writeFileSync(dataPath, originals[dataPath]);
      const current = readFileSync(revert.file, "utf8");
      const patched = revert.apply
        ? revert.apply(current)
        : replaceMarked(current, revert.begin, revert.end, revert.body);
      if (patched === current) {
        check(`mutation-revert ${revert.id} applied a change`, false);
        continue;
      }
      writeFileSync(revert.file, patched);
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", scriptPath],
        {
          env: {
            ...process.env,
            OWNER_DAILY_OPS_CASE: revert.id,
            TZ: "America/New_York",
          },
          encoding: "utf8",
        },
      );
      check(
        `mutation-revert ${revert.id} fails its real-loader test`,
        child.status !== 0,
      );
      if (child.status === 0) {
        console.error(child.stdout);
        console.error(child.stderr);
      }
    } finally {
      writeFileSync(attentionPath, originals[attentionPath]);
      writeFileSync(dataPath, originals[dataPath]);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
