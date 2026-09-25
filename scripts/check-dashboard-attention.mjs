/**
 * Dashboard Needs attention for PR #57 appointment owner states.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-dashboard-attention.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ownerAppointmentAttention } = await import("@/lib/appointment-confirmation");
const { formatAppointmentWhen } = await import("@/lib/format");
const {
  DASHBOARD_DIFFERENT_TIME_ATTENTION_TITLE,
  DASHBOARD_RECONFIRMATION_ATTENTION_TITLE,
  dashboardAppointmentAttentionCandidateWhere,
  dashboardAppointmentAttentionHref,
  dashboardAppointmentAttentionItems,
} = await import("@/lib/dashboard-appointment-attention");
const {
  OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL,
  OWNER_TODAY_CREATE_INVOICE_LABEL,
  buildOwnerTodayAppointmentAttention,
  buildOwnerTodayHandoffItems,
  buildOwnerTodayJobs,
  ownerTodayInvoiceActionLabel,
  ownerTodayOwnedActionRefs,
  ownerTodayScheduledWhere,
} = await import("@/lib/owner-today");
const { completedJobBillingAttention } = await import("@/lib/revenue-integrity");
const { roleHasCapability, CAPABILITIES } = await import("@/lib/authorization");

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
const helperSrc = readRepo("src/lib/dashboard-appointment-attention.ts");
const itemSrc = readRepo("src/components/dashboard/appointment-attention-items.tsx");

console.log("\nSTATIC — Dashboard reuses appointment attention helpers");
check(
  "Dashboard Needs attention uses the appointment-attention helper",
  dashboardSrc.includes("dashboardAppointmentAttentionItems") &&
    dashboardSrc.includes("dashboardAppointmentAttentionCandidateWhere") &&
    dashboardSrc.includes("DashboardAppointmentAttentionItems") &&
    !dashboardSrc.includes("appointmentConfirmationStatus === \"DIFFERENT_TIME_REQUESTED\""),
);
check(
  "Dashboard appointment query is scoped to the current business",
  dashboardSrc.includes("...access.scope") &&
    dashboardSrc.includes("dashboardAppointmentAttentionCandidateWhere()"),
);
check(
  "Helper delegates inclusion to ownerAppointmentAttention",
  helperSrc.includes("ownerAppointmentAttention(job)") &&
    !helperSrc.includes("if (job.appointmentConfirmationStatus === \"CONFIRMED\")"),
);
check(
  "Amber attention items link to the owner Work Order",
  itemSrc.includes("href={item.href}") &&
    itemSrc.includes("border-amber-300") &&
    itemSrc.includes("AlertTriangle") &&
    !itemSrc.includes("destructive"),
);
check(
  "Existing Dashboard KPI cards remain unchanged",
  dashboardSrc.includes('label: "Open Requests"') &&
    dashboardSrc.includes('href: "/requests"') &&
    dashboardSrc.includes('label: "Estimates Awaiting Approval"') &&
    dashboardSrc.includes('href: "/estimates"') &&
    dashboardSrc.includes('label: "Upcoming Jobs"') &&
    dashboardSrc.includes('href: "/jobs"') &&
    dashboardSrc.includes('label: "Jobs In Progress"') &&
    dashboardSrc.includes('href: "/jobs?view=list"') &&
    dashboardSrc.includes('label: "Outstanding Invoices"') &&
    dashboardSrc.includes('href: "/invoices"') &&
    dashboardSrc.includes("Outstanding uses the invoice's own stored total"),
);
check(
  "Existing draft/unscheduled/unpaid attention groups remain",
  dashboardSrc.includes('"Requests without an estimate"') &&
    dashboardSrc.includes('"Draft estimates"') &&
    dashboardSrc.includes('"Unscheduled jobs"') &&
    dashboardSrc.includes('"Unpaid invoices"'),
);
check(
  "Dashboard surfaces completed jobs with unbilled approved work",
  dashboardSrc.includes('"Completed jobs with unbilled work"') &&
    dashboardSrc.includes("completedJobBillingAttention") &&
    dashboardSrc.includes("completedJobsForBilling"),
);

const todayPageSrc = readRepo("src/app/(app)/today/page.tsx");
const todayHelperSrc = readRepo("src/lib/owner-today.ts");
const todayCardSrc = readRepo("src/components/today/owner-today-job-card.tsx");
const todayHandoffSrc = readRepo("src/components/today/owner-today-handoff-card.tsx");
const fieldAccessSrc = readRepo("src/lib/field-access.ts");
const invoiceActionSrc = readRepo("src/app/actions/invoice.ts");
const startJobSrc = readRepo("src/components/jobs/start-job-button.tsx");

console.log("\nSTATIC — Owner Today reuses existing truth and stays management-only");
check(
  "Today page is OWNER/ADMIN management-gated",
  todayPageSrc.includes("requireManagementPageAccess()") &&
    !todayPageSrc.includes("requireFieldWorkspace") &&
    !todayPageSrc.includes("assignedJobWhere("),
);
check(
  "Today queries stay business-scoped and bounded",
  todayPageSrc.includes("...access.scope") &&
    todayPageSrc.includes("ownerTodayScheduledWhere(todayRange)") &&
    todayPageSrc.includes("OWNER_TODAY_JOBS_TAKE") &&
    todayPageSrc.includes("OWNER_TODAY_HANDOFF_TAKE") &&
    todayHelperSrc.includes("completedJobBillingAttention("),
);
check(
  "Today handoff uses Revenue Integrity fact and existing invoice action",
  todayHelperSrc.includes("completedJobBillingAttention") &&
    todayHandoffSrc.includes("CreateInvoiceButton") &&
    todayHandoffSrc.includes("item.invoiceActionLabel") &&
    !todayHelperSrc.includes("sendDraftInvoiceIfNeeded") &&
    !todayPageSrc.includes("sendDraftInvoiceIfNeeded") &&
    !todayPageSrc.includes("createInvoiceFromJob") &&
    !todayPageSrc.includes("completeJobAndSendInvoice") &&
    !todayHelperSrc.includes("formatMoney"),
);
check(
  "Today copy/open actions use owned job/customer refs",
  todayCardSrc.includes("job.jobHref") &&
    todayCardSrc.includes("job.customerHref") &&
    todayCardSrc.includes("CopyProjectLinkButton") &&
    todayCardSrc.includes("job.projectToken") &&
    todayHelperSrc.includes("if (job.businessId !== businessId) return null"),
);
check(
  "Today start/assign reuse existing guarded actions",
  todayCardSrc.includes("StartJobButton") &&
    todayCardSrc.includes("AssignJobMemberForm") &&
    startJobSrc.includes("startWithoutConfirmation") &&
    !todayCardSrc.includes("startAssignedJob"),
);
check(
  "MEMBER capabilities and assigned-job field rule are unchanged",
  Object.values(CAPABILITIES).every((capability) => !roleHasCapability("MEMBER", capability)) &&
    /function assignedJobWhere[\s\S]*businessId: field.businessId[\s\S]*assignedMembershipId: field.membershipId/.test(
      fieldAccessSrc,
    ),
);
check(
  "Existing invoice action still requires an explicit owner create — Today does not auto-send",
  invoiceActionSrc.includes("export async function createInvoiceFromJob") &&
    !todayPageSrc.includes("markInvoiceSent") &&
    !todayHelperSrc.includes("markInvoiceSent"),
);
check(
  "Dashboard Today reuses the owner-today helper without rebuilding KPIs",
  dashboardSrc.includes("buildOwnerTodayJobs") &&
    dashboardSrc.includes("OwnerTodayJobCard") &&
    dashboardSrc.includes('label: "Open Requests"'),
);

const slot = {
  scheduledAt: new Date("2026-09-16T13:00:00.000Z"),
  scheduledDurationMinutes: 60,
  appointmentConfirmationStatus: "CONFIRMED",
  appointmentProposalId: 2,
  appointmentConfirmedForProposalId: 2,
  appointmentConfirmationSource: "PORTAL",
  appointmentChangeRequestNote: null,
  propertyAccessMethod: "CUSTOMER_PRESENT",
  propertyAccessInstructions: null,
  propertyAccessContactName: null,
  propertyAccessContactInfo: null,
  propertyAccessPickupLocation: null,
  propertyAccessNote: null,
};

function jobRow(extras = {}) {
  return {
    id: extras.id ?? "job-home",
    businessId: extras.businessId ?? "biz-a",
    updatedAt: extras.updatedAt ?? new Date("2026-09-13T12:00:00.000Z"),
    customer: { name: extras.customerName ?? "Stanley" },
    ...slot,
    ...extras,
  };
}

console.log("\nPURE — Appointment attention items");
const changeRequested = dashboardAppointmentAttentionItems(
  [
    jobRow({
      id: "job-change",
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentChangeRequestNote: "make it back for 8 am",
      scheduledAt: new Date("2026-09-16T13:00:00.000Z"),
    }),
  ],
  "biz-a",
);
check(
  "DIFFERENT_TIME_REQUESTED appears in Dashboard Needs attention",
  changeRequested.length === 1 &&
    changeRequested[0].kind === "DIFFERENT_TIME" &&
    changeRequested[0].title === DASHBOARD_DIFFERENT_TIME_ATTENTION_TITLE &&
    changeRequested[0].customerName === "Stanley" &&
    changeRequested[0].customerNote === "make it back for 8 am" &&
    ownerAppointmentAttention(jobRow({
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentChangeRequestNote: "make it back for 8 am",
    })) === "DIFFERENT_TIME",
);
check(
  "Change-request item names the current appointment and note",
  changeRequested[0].whenLabel ===
    formatAppointmentWhen(new Date("2026-09-16T13:00:00.000Z")) &&
    changeRequested[0].whenLabel.includes("2026"),
);

const reconfirm = dashboardAppointmentAttentionItems(
  [
    jobRow({
      id: "job-reconfirm",
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentProposalId: 2,
      appointmentConfirmedForProposalId: 1,
      appointmentChangeRequestNote: null,
      scheduledAt: new Date("2026-09-16T12:00:00.000Z"),
    }),
  ],
  "biz-a",
);
check(
  "Rescheduled appointment awaiting reconfirmation appears",
  reconfirm.length === 1 &&
    reconfirm[0].kind === "RECONFIRMATION" &&
    reconfirm[0].title === DASHBOARD_RECONFIRMATION_ATTENTION_TITLE &&
    reconfirm[0].customerNote == null,
);

const confirmed = dashboardAppointmentAttentionItems(
  [jobRow({ id: "job-confirmed" })],
  "biz-a",
);
check("Confirmed appointment does not appear", confirmed.length === 0);

const afterReconfirm = dashboardAppointmentAttentionItems(
  [
    jobRow({
      id: "job-reconfirmed",
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentProposalId: 2,
      appointmentConfirmedForProposalId: 2,
      appointmentChangeRequestNote: null,
    }),
  ],
  "biz-a",
);
check("After customer reconfirmation, the item disappears", afterReconfirm.length === 0);

check(
  "Each item links to the correct /jobs/{jobId} owner Work Order",
  changeRequested[0].href === "/jobs/job-change" &&
    reconfirm[0].href === "/jobs/job-reconfirm" &&
    dashboardAppointmentAttentionHref("job-change") === "/jobs/job-change",
);

const foreign = dashboardAppointmentAttentionItems(
  [
    jobRow({
      id: "job-other",
      businessId: "biz-b",
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
    }),
  ],
  "biz-a",
);
check("Cross-business jobs do not appear", foreign.length === 0);

const firstAwaiting = dashboardAppointmentAttentionItems(
  [
    jobRow({
      id: "job-first",
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentProposalId: 1,
      appointmentConfirmedForProposalId: null,
    }),
  ],
  "biz-a",
);
check(
  "First-time awaiting confirmation is not owner Needs attention",
  firstAwaiting.length === 0,
);

const newer = new Date("2026-09-13T18:00:00.000Z");
const older = new Date("2026-09-13T10:00:00.000Z");
const ordered = dashboardAppointmentAttentionItems(
  [
    jobRow({
      id: "job-old",
      updatedAt: older,
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
    }),
    jobRow({
      id: "job-new",
      updatedAt: newer,
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentProposalId: 3,
      appointmentConfirmedForProposalId: 2,
    }),
  ],
  "biz-a",
);
check(
  "Multiple jobs list individually, newest changed first",
  ordered.length === 2 &&
    ordered[0].jobId === "job-new" &&
    ordered[1].jobId === "job-old",
);

const todayStart = new Date("2026-09-25T00:00:00.000Z");
const todayRange = {
  start: todayStart,
  end: new Date("2026-09-26T00:00:00.000Z"),
};
const appointmentFields = {
  scheduledDurationMinutes: 60,
  arrivalWindowMinutes: null,
  pickupDurationMinutes: null,
  appointmentConfirmationStatus: "CONFIRMED",
  appointmentProposalId: 1,
  appointmentConfirmedForProposalId: 1,
  appointmentConfirmationSource: "PORTAL",
  appointmentChangeRequestNote: null,
  appointmentNotificationStatus: "SENT",
  appointmentNotificationError: null,
  appointmentNotifiedForProposalId: 1,
  propertyAccessMethod: "CUSTOMER_PRESENT",
  propertyAccessInstructions: null,
  propertyAccessContactName: null,
  propertyAccessContactInfo: null,
  propertyAccessPickupLocation: null,
  propertyAccessNote: null,
};

function todayJob(extras = {}) {
  return {
    id: extras.id ?? "job-today",
    businessId: extras.businessId ?? "biz-a",
    customerId: extras.customerId ?? "cust-a",
    status: extras.status ?? "SCHEDULED",
    scheduledAt: extras.scheduledAt ?? new Date("2026-09-25T15:00:00.000Z"),
    assignedMembershipId: extras.assignedMembershipId ?? "mem-1",
    projectToken: extras.projectToken ?? "portal-today",
    customer: { id: extras.customerId ?? "cust-a", name: extras.customerName ?? "Pat" },
    property: extras.property ?? {
      addressLine1: "10 Main St",
      city: "Austin",
      region: "TX",
      postalCode: "78701",
    },
    assignedMembership: extras.assignedMembership ?? { user: { name: "Alex" } },
    ...appointmentFields,
    ...extras,
  };
}

console.log("\nPURE — Owner Today jobs, appointment attention, and #114 handoff");
const todayViews = buildOwnerTodayJobs(
  [
    todayJob({ id: "job-today" }),
    todayJob({
      id: "job-tomorrow",
      scheduledAt: new Date("2026-09-26T15:00:00.000Z"),
      customerName: "Tomorrow",
    }),
  ],
  { businessId: "biz-a", range: todayRange },
);
check(
  "today job appears",
  todayViews.length === 1 && todayViews[0].jobId === "job-today" && todayViews[0].customerName === "Pat",
);
check(
  "tomorrow job does not appear in today's section",
  todayViews.every((job) => job.jobId !== "job-tomorrow"),
);

const unassignedViews = buildOwnerTodayJobs(
  [todayJob({ id: "job-open", assignedMembershipId: null, assignedMembership: null })],
  { businessId: "biz-a", range: todayRange },
);
check(
  "unassigned today surfaces",
  unassignedViews.length === 1 && unassignedViews[0].assignment.kind === "UNASSIGNED",
);

const awaitingAttention = buildOwnerTodayAppointmentAttention(
  [
    todayJob({
      id: "job-awaiting",
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentConfirmedForProposalId: null,
      appointmentNotificationStatus: "NOT_CONFIGURED",
    }),
  ],
  { businessId: "biz-a", start: todayRange.start },
);
check(
  "awaiting confirmation surfaces",
  awaitingAttention.length === 1 &&
    awaitingAttention[0].kind === "AWAITING_CUSTOMER" &&
    awaitingAttention[0].title === "Unconfirmed appointment" &&
    awaitingAttention[0].notificationMessage ===
      "Email delivery is not configured, so the customer was not notified.",
);

const differentTimeAttention = buildOwnerTodayAppointmentAttention(
  [
    todayJob({
      id: "job-change",
      appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
      appointmentChangeRequestNote: "please move to 8am",
    }),
  ],
  { businessId: "biz-a", start: todayRange.start },
);
check(
  "different-time request surfaces",
  differentTimeAttention.length === 1 &&
    differentTimeAttention[0].kind === "DIFFERENT_TIME_REQUESTED" &&
    differentTimeAttention[0].customerNote === "please move to 8am",
);

const upcomingAwaiting = buildOwnerTodayAppointmentAttention(
  [
    todayJob({
      id: "job-upcoming-awaiting",
      scheduledAt: new Date("2026-09-26T15:00:00.000Z"),
      appointmentConfirmationStatus: "AWAITING_CUSTOMER",
      appointmentConfirmedForProposalId: null,
    }),
  ],
  { businessId: "biz-a", start: todayRange.start },
);
check(
  "upcoming unconfirmed appointment surfaces in attention, not Today's jobs",
  upcomingAwaiting.some((item) => item.jobId === "job-upcoming-awaiting") &&
    buildOwnerTodayJobs(
      [
        todayJob({
          id: "job-upcoming-awaiting",
          scheduledAt: new Date("2026-09-26T15:00:00.000Z"),
        }),
      ],
      { businessId: "biz-a", range: todayRange },
    ).length === 0,
);

const now = new Date("2026-09-20T12:00:00.000Z");
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
  "completed/unbilled job surfaces via #114 truth",
  unbilledHandoff.length === 1 &&
    unbilledHandoff[0].invoiceActionLabel === OWNER_TODAY_CREATE_INVOICE_LABEL &&
    completedJobBillingAttention({
      jobStatus: "COMPLETED",
      originalApprovedTotal: 200,
      invoices: [],
      changeOrders: [],
    }).unbilled === true,
);

const billedHandoff = buildOwnerTodayHandoffItems(
  [
    {
      id: "job-billed",
      businessId: "biz-a",
      status: "COMPLETED",
      estimate: { total: 200 },
      invoices: [
        { id: "inv-1", status: "SENT", kind: "ORIGINAL", createdAt: now, total: 200 },
      ],
      changeOrders: [],
      customer: { name: "Paid" },
    },
  ],
  "biz-a",
);
check("fully billed completed job does not", billedHandoff.length === 0);

const supplementalHandoff = buildOwnerTodayHandoffItems(
  [
    {
      id: "job-co",
      businessId: "biz-a",
      status: "COMPLETED",
      estimate: { total: 200 },
      invoices: [
        { id: "inv-1", status: "PAID", kind: "ORIGINAL", createdAt: now, total: 200 },
      ],
      changeOrders: [
        {
          id: "co-1",
          status: "APPROVED",
          total: 75,
          invoiceId: null,
          approvedAt: new Date("2026-09-21T12:00:00.000Z"),
          createdAt: new Date("2026-09-21T12:00:00.000Z"),
        },
      ],
      customer: { name: "Late CO" },
    },
  ],
  "biz-a",
);
check(
  "supplemental/unbilled CO case surfaces",
  supplementalHandoff.length === 1 &&
    supplementalHandoff[0].invoiceActionLabel === OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL &&
    ownerTodayInvoiceActionLabel(
      completedJobBillingAttention({
        jobStatus: "COMPLETED",
        originalApprovedTotal: 200,
        invoices: [
          { id: "inv-1", status: "PAID", kind: "ORIGINAL", createdAt: now, total: 200 },
        ],
        changeOrders: [
          {
            id: "co-1",
            status: "APPROVED",
            total: 75,
            invoiceId: null,
            approvedAt: new Date("2026-09-21T12:00:00.000Z"),
            createdAt: new Date("2026-09-21T12:00:00.000Z"),
          },
        ],
      }),
    ) === OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL,
);

const ownedTodayActions = ownerTodayOwnedActionRefs(todayJob({ id: "job-owned", projectToken: "tok-a" }), "biz-a", "mem-1");
const foreignTodayActions = ownerTodayOwnedActionRefs(
  todayJob({ id: "job-other", businessId: "biz-b", projectToken: "tok-b" }),
  "biz-a",
);
check(
  "copy/open actions use owned records",
  ownedTodayActions?.jobHref === "/jobs/job-owned" &&
    ownedTodayActions.customerHref === "/customers/cust-a" &&
    ownedTodayActions.projectToken === "tok-a" &&
    ownedTodayActions.directionsHref?.includes("10%20Main%20St") &&
    ownedTodayActions.fieldHref === "/field/jobs/job-owned" &&
    foreignTodayActions === null,
);
check(
  "tenant isolation keeps foreign today/handoff rows out",
  buildOwnerTodayJobs([todayJob({ id: "job-b", businessId: "biz-b" })], {
    businessId: "biz-a",
    range: todayRange,
  }).length === 0 &&
    buildOwnerTodayHandoffItems(
      [
        {
          id: "job-b-unbilled",
          businessId: "biz-b",
          status: "COMPLETED",
          estimate: { total: 40 },
          invoices: [],
          changeOrders: [],
        },
      ],
      "biz-a",
    ).length === 0,
);
check(
  "Today scheduled where is the same day-range filter Dashboard already used",
  JSON.stringify(ownerTodayScheduledWhere(todayRange)) ===
    JSON.stringify({ scheduledAt: { gte: todayRange.start, lt: todayRange.end } }),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.log("\nDB skipped — DATABASE_URL is not set");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const testDbName = "tbbt_dashboard_attention_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for dashboard-attention test database.");
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
      scheduledAt: extras.scheduledAt ?? new Date("2026-09-16T13:00:00.000Z"),
      scheduledDurationMinutes: extras.scheduledDurationMinutes ?? 60,
      appointmentProposalId: extras.appointmentProposalId ?? 1,
      appointmentConfirmationStatus: extras.appointmentConfirmationStatus ?? "NONE",
      ...extras.job,
    },
  });
}

async function loadAttention(businessId) {
  const jobs = await prisma.job.findMany({
    where: { businessId, ...dashboardAppointmentAttentionCandidateWhere() },
    select: {
      id: true,
      businessId: true,
      updatedAt: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      appointmentConfirmationStatus: true,
      appointmentProposalId: true,
      appointmentConfirmedForProposalId: true,
      appointmentConfirmationSource: true,
      appointmentChangeRequestNote: true,
      propertyAccessMethod: true,
      propertyAccessInstructions: true,
      propertyAccessContactName: true,
      propertyAccessContactInfo: true,
      propertyAccessPickupLocation: true,
      propertyAccessNote: true,
      customer: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return dashboardAppointmentAttentionItems(jobs, businessId);
}

console.log("\nDB — Tenant scope and confirmation lifecycle");
try {
  const businessA = await makeBusiness(`dash-a-${randomUUID()}`);
  const businessB = await makeBusiness(`dash-b-${randomUUID()}`);

  const changeJob = await makeJob(businessA.id, {
    appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
    job: {
      appointmentConfirmedForProposalId: 1,
      appointmentChangeRequestNote: "make it back for 8 am",
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const reconfirmJob = await makeJob(businessA.id, {
    appointmentProposalId: 2,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    job: {
      appointmentConfirmedForProposalId: 1,
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const confirmedJob = await makeJob(businessA.id, {
    appointmentProposalId: 2,
    appointmentConfirmationStatus: "CONFIRMED",
    job: {
      appointmentConfirmedForProposalId: 2,
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const otherBizJob = await makeJob(businessB.id, {
    appointmentConfirmationStatus: "DIFFERENT_TIME_REQUESTED",
    customerName: "Other Tenant",
    job: {
      appointmentChangeRequestNote: "please move this",
    },
  });

  const items = await loadAttention(businessA.id);
  check(
    "DB: DIFFERENT_TIME_REQUESTED appears for the current business",
    items.some(
      (item) =>
        item.jobId === changeJob.id &&
        item.kind === "DIFFERENT_TIME" &&
        item.href === `/jobs/${changeJob.id}` &&
        item.customerNote === "make it back for 8 am",
    ),
  );
  check(
    "DB: reconfirmation appears and links to the Work Order",
    items.some(
      (item) =>
        item.jobId === reconfirmJob.id &&
        item.kind === "RECONFIRMATION" &&
        item.href === `/jobs/${reconfirmJob.id}`,
    ),
  );
  check(
    "DB: confirmed appointment does not appear",
    !items.some((item) => item.jobId === confirmedJob.id),
  );
  check(
    "DB: cross-business jobs do not appear",
    !items.some((item) => item.jobId === otherBizJob.id) &&
      (await loadAttention(businessB.id)).every((item) => item.jobId === otherBizJob.id),
  );

  const reconfirmed = await prisma.job.update({
    where: { id: reconfirmJob.id },
    data: {
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedForProposalId: 2,
      appointmentChangeRequestNote: null,
    },
  });
  const after = await loadAttention(businessA.id);
  check(
    "DB: after customer reconfirmation the item disappears",
    ownerAppointmentAttention(reconfirmed) === null &&
      !after.some((item) => item.jobId === reconfirmJob.id) &&
      after.some((item) => item.jobId === changeJob.id),
  );

  const todayAt = new Date("2026-09-25T15:00:00.000Z");
  const tomorrowAt = new Date("2026-09-26T15:00:00.000Z");
  const dbRange = {
    start: new Date("2026-09-25T00:00:00.000Z"),
    end: new Date("2026-09-26T00:00:00.000Z"),
  };
  const todayJobRow = await makeJob(businessA.id, {
    customerName: "Today Pat",
    scheduledAt: todayAt,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
    job: { pickupDurationMinutes: 30 },
  });
  const tomorrowJobRow = await makeJob(businessA.id, {
    customerName: "Tomorrow Pat",
    scheduledAt: tomorrowAt,
    appointmentConfirmationStatus: "CONFIRMED",
    job: {
      appointmentProposalId: 1,
      appointmentConfirmedForProposalId: 1,
      propertyAccessMethod: "CUSTOMER_PRESENT",
    },
  });
  const otherToday = await makeJob(businessB.id, {
    customerName: "Other Today",
    scheduledAt: todayAt,
    appointmentConfirmationStatus: "AWAITING_CUSTOMER",
  });
  const completedUnbilled = await makeJob(businessA.id, {
    customerName: "Unbilled Closeout",
    scheduledAt: todayAt,
    job: { status: "COMPLETED" },
  });
  const unbilledEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: (
        await prisma.job.findUnique({
          where: { id: completedUnbilled.id },
          select: { customerId: true },
        })
      ).customerId,
      publicToken: randomUUID(),
      status: "APPROVED",
      total: 180,
    },
  });
  await prisma.job.update({
    where: { id: completedUnbilled.id },
    data: { estimateId: unbilledEstimate.id },
  });
  const completedBilled = await makeJob(businessA.id, {
    customerName: "Billed Closeout",
    scheduledAt: todayAt,
    job: { status: "COMPLETED" },
  });
  const billedEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: (await prisma.job.findUnique({
        where: { id: completedBilled.id },
        select: { customerId: true },
      })).customerId,
      publicToken: randomUUID(),
      status: "APPROVED",
      total: 90,
    },
  });
  await prisma.job.update({
    where: { id: completedBilled.id },
    data: { estimateId: billedEstimate.id },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: completedBilled.id,
      status: "SENT",
      kind: "ORIGINAL",
      total: 90,
    },
  });
  const completedCo = await makeJob(businessA.id, {
    customerName: "CO Closeout",
    scheduledAt: todayAt,
    job: { status: "COMPLETED" },
  });
  const coEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: (await prisma.job.findUnique({
        where: { id: completedCo.id },
        select: { customerId: true },
      })).customerId,
      publicToken: randomUUID(),
      status: "APPROVED",
      total: 100,
    },
  });
  await prisma.job.update({
    where: { id: completedCo.id },
    data: { estimateId: coEstimate.id },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      jobId: completedCo.id,
      status: "PAID",
      kind: "ORIGINAL",
      total: 100,
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    },
  });
  await prisma.changeOrder.create({
    data: {
      businessId: businessA.id,
      jobId: completedCo.id,
      status: "APPROVED",
      title: "Extra work",
      total: 40,
      approvedAt: new Date("2026-09-22T12:00:00.000Z"),
    },
  });

  const scopedToday = await prisma.job.findMany({
    where: { businessId: businessA.id, ...ownerTodayScheduledWhere(dbRange) },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      status: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      arrivalWindowMinutes: true,
      pickupDurationMinutes: true,
      assignedMembershipId: true,
      projectToken: true,
      appointmentConfirmationStatus: true,
      appointmentProposalId: true,
      appointmentConfirmedForProposalId: true,
      appointmentConfirmationSource: true,
      appointmentChangeRequestNote: true,
      appointmentNotificationStatus: true,
      appointmentNotificationError: true,
      appointmentNotifiedForProposalId: true,
      propertyAccessMethod: true,
      propertyAccessInstructions: true,
      propertyAccessContactName: true,
      propertyAccessContactInfo: true,
      propertyAccessPickupLocation: true,
      propertyAccessNote: true,
      customer: { select: { id: true, name: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      assignedMembership: { select: { id: true, user: { select: { name: true } } } },
    },
  });
  const dbToday = buildOwnerTodayJobs(scopedToday, {
    businessId: businessA.id,
    range: dbRange,
  });
  check(
    "DB: today job appears and tomorrow job does not",
    dbToday.some((job) => job.jobId === todayJobRow.id) &&
      dbToday.every((job) => job.jobId !== tomorrowJobRow.id) &&
      dbToday.every((job) => job.jobId !== otherToday.id),
  );
  check(
    "DB: unassigned today and awaiting confirmation surface",
    dbToday.some((job) => job.jobId === todayJobRow.id && job.assignment.kind === "UNASSIGNED") &&
      buildOwnerTodayAppointmentAttention(scopedToday, {
        businessId: businessA.id,
        start: dbRange.start,
      }).some((item) => item.jobId === todayJobRow.id && item.kind === "AWAITING_CUSTOMER"),
  );

  const completedRows = await prisma.job.findMany({
    where: { businessId: businessA.id, status: "COMPLETED" },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      estimateId: true,
      status: true,
      customer: { select: { name: true } },
      invoices: {
        select: { id: true, status: true, kind: true, createdAt: true, total: true },
      },
      changeOrders: {
        select: { id: true, status: true, total: true, invoiceId: true, approvedAt: true, createdAt: true },
      },
      estimate: { select: { total: true } },
      approvedEstimateVersion: { select: { total: true } },
    },
  });
  const dbHandoff = buildOwnerTodayHandoffItems(completedRows, businessA.id);
  check(
    "DB: completed/unbilled and unbilled CO surface; fully billed does not",
    dbHandoff.some(
      (item) =>
        item.jobId === completedUnbilled.id &&
        item.invoiceActionLabel === OWNER_TODAY_CREATE_INVOICE_LABEL,
    ) &&
      dbHandoff.some(
        (item) =>
          item.jobId === completedCo.id &&
          item.invoiceActionLabel === OWNER_TODAY_CREATE_BALANCE_INVOICE_LABEL,
      ) &&
      dbHandoff.every((item) => item.jobId !== completedBilled.id),
  );
  check(
    "DB: tenant isolation keeps business B off business A Today",
    dbToday.every((job) => job.jobId !== otherToday.id) &&
      buildOwnerTodayHandoffItems(completedRows, businessB.id).length === 0,
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
