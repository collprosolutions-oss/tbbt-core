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
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
