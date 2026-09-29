/**
 * OWNER Marketing Studio content calendar.
 *
 * Bounded recorded-package view, OWNER-only planned publication day
 * in Business.timezone, approval/export status, write-time package
 * recheck, concurrent-edit claims, tenant isolation, and no approve /
 * publish / post / message / provider-connection side effects.
 *
 * Run with:
 *   npm run test:marketing-content-calendar
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for marketing content calendar checks.");
  process.exit(generateEarly.status ?? 1);
}

const { CAPABILITIES, ForbiddenError, requireBusinessCapability } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { formatISODateInTimeZone } = await import("@/lib/business-timezone");
const {
  CALENDAR_INTERNAL_MESSAGE,
  OWNER_STUDIO_CALENDAR_MESSAGE,
  STUDIO_CALENDAR_EXPORT_EXPORTED_LABEL,
  STUDIO_CALENDAR_EXPORT_NOT_EXPORTED_LABEL,
  STUDIO_CALENDAR_UNSCHEDULED_LABEL,
  STUDIO_CONTENT_CALENDAR_LIMIT,
  STUDIO_CONTENT_CALENDAR_LIMITS_MESSAGE,
  STUDIO_CONTENT_CALENDAR_MESSAGE,
  STUDIO_PLANNED_DAY_INVALID_MESSAGE,
  STUDIO_PLANNED_DAY_SAVED_MESSAGE,
  STUDIO_PLANNED_DAY_STALE_MESSAGE,
  boundStudioContentCalendar,
  canPlanStudioPublicationDay,
  groupStudioContentCalendarDays,
  parseStudioPublicationDay,
  presentStudioContentCalendar,
  studioCalendarApprovalLabel,
  studioCalendarExportLabel,
  studioContentCalendarLimits,
  studioContentCalendarMeta,
  studioPublicationDayKey,
} = await import("@/lib/marketing");
const {
  advanceMarketingContentStatus,
  approveMarketingStudioPackage,
  createMarketingStudioPackage,
  exportMarketingCreatorPackage,
  grantJobPhotoMarketingPermission,
  MarketingError,
  planStudioPublicationDay,
} = await import("@/lib/marketing-ops");
const { loadMarketingSource } = await import("@/lib/marketing-data");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const domainSrc = readSrc("src/lib/marketing.ts");
const opsSrc = readSrc("src/lib/marketing-ops.ts");
const dataSrc = readSrc("src/lib/marketing-data.ts");
const actionSrc = readSrc("src/app/actions/marketing.ts");
const calendarUiSrc = readSrc("src/components/marketing/studio-content-calendar.tsx");
const formUiSrc = readSrc("src/components/marketing/studio-publication-day-form.tsx");
const workspaceSrc = readSrc("src/components/marketing/marketing-workspace.tsx");

const planFnSrc = opsSrc.slice(
  opsSrc.indexOf("function requireOwnerStudioCalendar"),
  opsSrc.indexOf("export async function createMarketingCampaign"),
);
const planWriteSrc = planFnSrc.slice(
  planFnSrc.indexOf("updateMany"),
  planFnSrc.indexOf("if (claimed.count"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_content_calendar_test";
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
  console.error("Failed to push schema for marketing content calendar test database.");
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
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function holdPlanClaim(db) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let notifyReached;
  const reached = new Promise((resolve) => {
    notifyReached = resolve;
  });
  const racingDb = db.$extends({
    query: {
      marketingContent: {
        async updateMany({ args, query }) {
          if (args.data?.plannedFor) {
            notifyReached();
            await gate;
          }
          return query(args);
        },
      },
    },
  });
  return { racingDb, reached, release };
}

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

try {
  console.log("\nSTATIC — Content calendar helpers and limits");
  check("Calendar limit is 50", STUDIO_CONTENT_CALENDAR_LIMIT === 50);
  check("OWNER can plan a publication day", canPlanStudioPublicationDay("OWNER") === true);
  check("ADMIN cannot plan a publication day", canPlanStudioPublicationDay("ADMIN") === false);
  check("MEMBER cannot plan a publication day", canPlanStudioPublicationDay("MEMBER") === false);
  check("Draft approval label stays Draft", studioCalendarApprovalLabel("DRAFT") === "Draft");
  check(
    "Ready approval label stays Ready for review",
    studioCalendarApprovalLabel("READY_FOR_REVIEW") === "Ready for review",
  );
  check("Approved approval label stays Approved", studioCalendarApprovalLabel("APPROVED") === "Approved");
  check("Missing export is labeled not exported", studioCalendarExportLabel(null) === STUDIO_CALENDAR_EXPORT_NOT_EXPORTED_LABEL);
  check(
    "Stored export is labeled exported",
    studioCalendarExportLabel(new Date("2026-09-22T17:00:00.000Z")) === STUDIO_CALENDAR_EXPORT_EXPORTED_LABEL,
  );
  const bounded = boundStudioContentCalendar(Array.from({ length: 51 }, (_, index) => index));
  check("In-memory bound keeps 50 items", bounded.items.length === 50 && bounded.limit === 50);
  check("In-memory bound marks overflow", bounded.truncated === true);
  const meta = studioContentCalendarMeta(51);
  check("Calendar meta reports truncation", meta.truncated === true && meta.total === 51 && meta.limit === 50);
  check(
    "Calendar message forbids approve, publish, post, send, and provider claim",
    STUDIO_CONTENT_CALENDAR_MESSAGE.includes("will not approve") &&
      STUDIO_CONTENT_CALENDAR_MESSAGE.includes("publish") &&
      STUDIO_CONTENT_CALENDAR_MESSAGE.includes("post") &&
      STUDIO_CONTENT_CALENDAR_MESSAGE.includes("send a message") &&
      STUDIO_CONTENT_CALENDAR_MESSAGE.includes("provider connection"),
  );
  check("Calendar limits mention 50 recorded packages", STUDIO_CONTENT_CALENDAR_LIMITS_MESSAGE.includes("50"));
  check("Internal calendar still refuses automatic publish", CALENDAR_INTERNAL_MESSAGE.includes("will not publish"));
  const limits = studioContentCalendarLimits();
  check(
    "Calendar limits never claim publish, post, approve, send, or a provider",
    limits.published === false &&
      limits.posted === false &&
      limits.approvedByPlanning === false &&
      limits.customerMessageSent === false &&
      limits.providerConnectionClaimed === false &&
      limits.socialPublishingConnected === false,
  );

  console.log("\nSTATIC — Timezone civil-day boundaries");
  const laDay = parseStudioPublicationDay("2026-09-22", "America/Los_Angeles");
  const aucklandDay = parseStudioPublicationDay("2026-09-22", "Pacific/Auckland");
  const utcMidnight = new Date("2026-09-22T00:00:00.000Z");
  check("Los Angeles accepts 2026-09-22", laDay instanceof Date);
  check("Auckland accepts 2026-09-22", aucklandDay instanceof Date);
  check(
    "Same civil day stores different instants across timezones",
    Boolean(laDay && aucklandDay && laDay.getTime() !== aucklandDay.getTime()),
  );
  check(
    "Los Angeles day is not UTC midnight",
    Boolean(laDay && laDay.getTime() !== utcMidnight.getTime()),
  );
  check(
    "Los Angeles display key stays 2026-09-22",
    Boolean(laDay && studioPublicationDayKey(laDay, "America/Los_Angeles") === "2026-09-22"),
  );
  check(
    "Auckland display key stays 2026-09-22",
    Boolean(aucklandDay && studioPublicationDayKey(aucklandDay, "Pacific/Auckland") === "2026-09-22"),
  );
  check(
    "UTC midnight would display as 2026-09-21 in Los Angeles",
    formatISODateInTimeZone(utcMidnight, "America/Los_Angeles") === "2026-09-21",
  );
  check("February 30 is rejected", parseStudioPublicationDay("2026-02-30", "America/Los_Angeles") === null);
  check("Empty day is rejected", parseStudioPublicationDay("", "America/Los_Angeles") === null);
  check("Non-date text is rejected", parseStudioPublicationDay("tomorrow", "America/New_York") === null);
  const presented = presentStudioContentCalendar({
    timeZone: "America/Los_Angeles",
    total: 2,
    rows: [
      {
        id: "planned",
        contentType: "COMPLETED_JOB",
        title: "Planned package",
        channelIntent: "UNASSIGNED",
        status: "READY_FOR_REVIEW",
        plannedFor: laDay,
        exportedAt: null,
        updatedAt: new Date("2026-09-20T12:00:00.000Z"),
      },
      {
        id: "open",
        contentType: "GENERAL_POST",
        title: "Unscheduled package",
        channelIntent: "UNASSIGNED",
        status: "DRAFT",
        plannedFor: null,
        exportedAt: new Date("2026-09-21T12:00:00.000Z"),
        updatedAt: new Date("2026-09-21T12:00:00.000Z"),
      },
    ],
  });
  check("Presenter keeps the business timezone", presented.timeZone === "America/Los_Angeles");
  check(
    "Presenter shows approval and export status",
    presented.items[0]?.approvalLabel === "Ready for review" &&
      presented.items[0]?.exportLabel === STUDIO_CALENDAR_EXPORT_NOT_EXPORTED_LABEL &&
      presented.items[1]?.approvalLabel === "Draft" &&
      presented.items[1]?.exportLabel === STUDIO_CALENDAR_EXPORT_EXPORTED_LABEL,
  );
  const days = groupStudioContentCalendarDays(presented.items);
  check(
    "Presenter groups the planned day and unscheduled packages",
    days[0]?.day === "2026-09-22" && days[1]?.label === STUDIO_CALENDAR_UNSCHEDULED_LABEL,
  );

  console.log("\nSTATIC — Reads, writes, and UI stay internal");
  check(
    "Calendar loader is business-scoped and bounded",
    dataSrc.includes("STUDIO_CONTENT_CALENDAR_LIMIT") &&
      dataSrc.includes("take: STUDIO_CONTENT_CALENDAR_LIMIT") &&
      dataSrc.includes("presentStudioContentCalendar") &&
      dataSrc.includes("timezone: true"),
  );
  const calendarQuerySrc = dataSrc.slice(
    dataSrc.indexOf("take: STUDIO_CONTENT_CALENDAR_LIMIT"),
    dataSrc.indexOf("prisma.marketingContent.count({ where: scope })"),
  );
  check(
    "Calendar loader does not include customer, estimate, or photo captions",
    calendarQuerySrc.includes("exportedAt: true") &&
      !calendarQuerySrc.includes("customer") &&
      !calendarQuerySrc.includes("estimate") &&
      !calendarQuerySrc.includes("caption"),
  );
  check(
    "Loader does not approve, export, or send",
    !dataSrc.includes("planStudioPublicationDay") &&
      !dataSrc.includes("approveMarketingStudioPackage") &&
      !dataSrc.includes("exportMarketingCreatorPackage") &&
      !dataSrc.includes("sendCustomer") &&
      !dataSrc.includes("PUBLISHED"),
  );
  check(
    "Plan is OWNER-gated and business-scoped",
    planFnSrc.includes("requireBusinessCapability") &&
      planFnSrc.includes('requireBusinessRole(access, "OWNER")') &&
      planFnSrc.includes("...access.scope") &&
      planFnSrc.includes("access.assertOwned") &&
      planFnSrc.includes("OWNER_STUDIO_CALENDAR_MESSAGE") &&
      planFnSrc.includes("resolveBusinessTimeZone") &&
      planFnSrc.includes("parseStudioPublicationDay"),
  );
  check(
    "Plan rechecks package state in a write transaction before claiming updatedAt",
    planFnSrc.includes("runInTransaction") &&
      planFnSrc.includes("isMarketingContentStatus") &&
      planFnSrc.includes("studioCalendarWriteWhere") &&
      planFnSrc.includes("updateMany") &&
      planFnSrc.includes("content.updatedAt") &&
      planFnSrc.indexOf("runInTransaction") < planFnSrc.indexOf("isMarketingContentStatus") &&
      planFnSrc.indexOf("isMarketingContentStatus") < planFnSrc.indexOf("updateMany"),
  );
  check(
    "Plan writes only plannedFor",
    planWriteSrc.includes("data: { plannedFor }") &&
      !planWriteSrc.includes("status") &&
      !planWriteSrc.includes("exportedAt") &&
      !planWriteSrc.includes("reviewedByMembershipId") &&
      !planFnSrc.includes("approveMarketingStudioPackage") &&
      !planFnSrc.includes("exportMarketing") &&
      !planFnSrc.includes("smsSendClaimed") &&
      !planFnSrc.includes("PUBLISHED") &&
      !/\bsms\b/.test(planFnSrc) &&
      !/\bemail\b/.test(planFnSrc),
  );
  check(
    "Server action exposes the OWNER calendar write",
    actionSrc.includes("planStudioPublicationDayAction") &&
      actionSrc.includes("OWNER_STUDIO_CALENDAR_MESSAGE") &&
      actionSrc.includes("STUDIO_PLANNED_DAY_SAVED_MESSAGE") &&
      actionSrc.includes("expectedUpdatedAt"),
  );
  check(
    "Calendar UI shows approval and export status and the OWNER form",
    calendarUiSrc.includes("Approval:") &&
      calendarUiSrc.includes("Export:") &&
      calendarUiSrc.includes("StudioPublicationDayForm") &&
      calendarUiSrc.includes("canPlanStudioPublicationDay") &&
      formUiSrc.includes("planStudioPublicationDayAction") &&
      formUiSrc.includes("expectedUpdatedAt") &&
      !calendarUiSrc.includes("approveMarketingStudioPackage") &&
      !calendarUiSrc.includes("exportMarketingCreatorPackage") &&
      !formUiSrc.includes("Approve"),
  );
  check(
    "Workspace surfaces the recorded-package calendar",
    workspaceSrc.includes("StudioContentCalendar") &&
      workspaceSrc.includes("source.contentCalendar") &&
      calendarUiSrc.includes("STUDIO_CONTENT_CALENDAR_MESSAGE"),
  );
  check("Saved-day copy does not claim approve or publish", STUDIO_PLANNED_DAY_SAVED_MESSAGE.includes("was not approved"));

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Calendar",
      slug: `alpha-cal-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Calendar",
      slug: `beta-cal-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "Pacific/Auckland",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-cal-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-cal-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-cal-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-cal-${randomUUID()}@example.com`, passwordHash: "x" },
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

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const photo = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "AFTER",
      url: "https://example.test/calendar-after.jpg",
    },
  });
  const betaPhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessB.id,
      jobId: betaJob.id,
      stage: "AFTER",
      url: "https://example.test/beta-calendar.jpg",
    },
  });
  await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: photo.id });
  await grantJobPhotoMarketingPermission(prisma, ownerB, { photoId: betaPhoto.id });

  const studio = await createMarketingStudioPackage(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Alpha faucet package",
    body: "Recorded faucet repair only.",
    jobId: job.id,
    photoIds: [photo.id],
  });
  const betaStudio = await createMarketingStudioPackage(prisma, ownerB, {
    contentType: "COMPLETED_JOB",
    title: "Beta only package",
    body: "Beta secret caption.",
    jobId: betaJob.id,
    photoIds: [betaPhoto.id],
  });

  console.log("\nTEST — Authorization: ADMIN and MEMBER cannot plan a day");
  await expectError(
    "MEMBER cannot plan a publication day",
    () =>
      planStudioPublicationDay(prisma, memberA, {
        contentId: studio.id,
        plannedFor: "2026-09-22",
        expectedUpdatedAt: studio.updatedAt,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot plan a publication day",
    () =>
      planStudioPublicationDay(prisma, adminA, {
        contentId: studio.id,
        plannedFor: "2026-09-22",
        expectedUpdatedAt: studio.updatedAt,
      }),
    (error) => error instanceof MarketingError && error.message === OWNER_STUDIO_CALENDAR_MESSAGE,
  );
  const stillUnplanned = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  check("Rejected ADMIN/MEMBER writes leave plannedFor empty", stillUnplanned?.plannedFor == null);
  check("Rejected writes do not change status", stillUnplanned?.status === "DRAFT");
  check("Rejected writes do not export", stillUnplanned?.exportedAt == null);
  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_MARKETING);
    check("MEMBER MANAGE_MARKETING is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_MARKETING is forbidden", error instanceof ForbiddenError);
  }

  console.log("\nTEST — Tenant isolation");
  await expectError(
    "Business B cannot plan A's package",
    () =>
      planStudioPublicationDay(prisma, ownerB, {
        contentId: studio.id,
        plannedFor: "2026-09-22",
        expectedUpdatedAt: studio.updatedAt,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business A cannot plan B's package",
    () =>
      planStudioPublicationDay(prisma, ownerA, {
        contentId: betaStudio.id,
        plannedFor: "2026-09-22",
        expectedUpdatedAt: betaStudio.updatedAt,
      }),
    (error) => error instanceof Error,
  );
  const sourceBefore = await loadMarketingSource(prisma, businessA.id);
  const sourceBeforeB = await loadMarketingSource(prisma, businessB.id);
  check(
    "Business A calendar contains only A packages",
    sourceBefore.contentCalendar.items.some((row) => row.id === studio.id) &&
      sourceBefore.contentCalendar.items.every((row) => row.id !== betaStudio.id),
  );
  check(
    "Business B calendar contains only B packages",
    sourceBeforeB.contentCalendar.items.some((row) => row.id === betaStudio.id) &&
      sourceBeforeB.contentCalendar.items.every((row) => row.id !== studio.id),
  );
  check(
    "Calendar payload omits the other tenant title",
    sourceBefore.contentCalendar.items.every((row) => !row.title.includes("Beta only")) &&
      sourceBeforeB.contentCalendar.items.every((row) => !row.title.includes("Alpha faucet")),
  );
  check("Business A calendar uses Los Angeles", sourceBefore.contentCalendar.timeZone === "America/Los_Angeles");
  check("Business B calendar uses Auckland", sourceBeforeB.contentCalendar.timeZone === "Pacific/Auckland");

  console.log("\nTEST — OWNER plans a day in Business.timezone without publishing");
  const planned = await planStudioPublicationDay(prisma, ownerA, {
    contentId: studio.id,
    plannedFor: "2026-09-22",
    expectedUpdatedAt: stillUnplanned?.updatedAt,
  });
  check("OWNER can assign a planned publication day", planned.plannedDay === "2026-09-22");
  check(
    "Stored Los Angeles day is the zoned start, not UTC midnight",
    planned.plannedFor.getTime() === laDay?.getTime(),
  );
  check("Planning leaves the package as DRAFT", planned.status === "DRAFT");
  check("Planning does not export", planned.exportedAt == null);
  check("Planning does not record a reviewer", planned.reviewedByMembershipId == null);
  check(
    "Planning result never claims publish, post, send, or a provider",
    planned.published === false &&
      planned.posted === false &&
      planned.customerMessageSent === false &&
      planned.providerConnectionClaimed === false,
  );

  const changed = await planStudioPublicationDay(prisma, ownerA, {
    contentId: studio.id,
    plannedFor: "2026-09-29",
    expectedUpdatedAt: planned.updatedAt,
  });
  check("OWNER can change the planned publication day", changed.plannedDay === "2026-09-29");
  check("Changing the day still leaves the package as DRAFT", changed.status === "DRAFT");

  const ready = await advanceMarketingContentStatus(prisma, adminA, { contentId: studio.id });
  check("ADMIN can still send the planned package for review", ready.status === "READY_FOR_REVIEW");
  const plannedReady = await planStudioPublicationDay(prisma, ownerA, {
    contentId: studio.id,
    plannedFor: "2026-10-06",
    expectedUpdatedAt: ready.updatedAt,
  });
  check("OWNER can replan a package awaiting review", plannedReady.status === "READY_FOR_REVIEW");
  check("Replanning a ready package does not approve it", plannedReady.reviewedByMembershipId == null);

  const approved = await approveMarketingStudioPackage(prisma, ownerA, { contentId: studio.id });
  const plannedApproved = await planStudioPublicationDay(prisma, ownerA, {
    contentId: studio.id,
    plannedFor: "2026-10-13",
    expectedUpdatedAt: approved.updatedAt,
  });
  check("OWNER can replan an approved package", plannedApproved.status === "APPROVED");
  check("Replanning does not clear the reviewer", plannedApproved.reviewedByMembershipId === ownerMem.id);
  const exported = await exportMarketingCreatorPackage(prisma, ownerA, { contentId: studio.id });
  check("Export still requires the separate handoff path", exported.package.limits.published === false);
  const afterExport = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  const replannedExport = await planStudioPublicationDay(prisma, ownerA, {
    contentId: studio.id,
    plannedFor: "2026-10-20",
    expectedUpdatedAt: afterExport?.updatedAt,
  });
  check("Planning after export keeps the export timestamp", Boolean(replannedExport.exportedAt));
  check("Planning after export keeps APPROVED", replannedExport.status === "APPROVED");

  const sourceA = await loadMarketingSource(prisma, businessA.id);
  const calendarItem = sourceA.contentCalendar.items.find((row) => row.id === studio.id);
  check(
    "Calendar shows approval and export status for the recorded package",
    calendarItem?.approvalLabel === "Approved" &&
      calendarItem.exportLabel === STUDIO_CALENDAR_EXPORT_EXPORTED_LABEL &&
      calendarItem.plannedDay === "2026-10-20",
  );
  check("Load after planning does not invent a connected channel", sourceA.channels.connected === false);
  check(
    "Calendar limits stay disconnected",
    sourceA.contentCalendar.limits.published === false &&
      sourceA.contentCalendar.limits.posted === false &&
      sourceA.contentCalendar.limits.providerConnectionClaimed === false &&
      sourceA.contentCalendar.limits.socialPublishingConnected === false,
  );

  const betaPlanned = await planStudioPublicationDay(prisma, ownerB, {
    contentId: betaStudio.id,
    plannedFor: "2026-09-22",
    expectedUpdatedAt: betaStudio.updatedAt,
  });
  check("Auckland stores a different instant for the same civil day", betaPlanned.plannedFor.getTime() === aucklandDay?.getTime());
  check("Auckland display day stays 2026-09-22", betaPlanned.plannedDay === "2026-09-22");
  check(
    "Los Angeles and Auckland planned instants stay distinct",
    planned.plannedFor.getTime() !== betaPlanned.plannedFor.getTime(),
  );

  await expectError(
    "Invalid civil day is rejected",
    () =>
      planStudioPublicationDay(prisma, ownerA, {
        contentId: studio.id,
        plannedFor: "2026-02-30",
        expectedUpdatedAt: replannedExport.updatedAt,
      }),
    (error) => error instanceof MarketingError && error.message === STUDIO_PLANNED_DAY_INVALID_MESSAGE,
  );
  const afterInvalid = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  check(
    "Invalid day leaves the previous planned instant intact",
    afterInvalid?.plannedFor?.getTime() === replannedExport.plannedFor.getTime(),
  );

  console.log("\nTEST — Concurrent edits recheck package state");
  const racePackage = await createMarketingStudioPackage(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Race faucet package",
    body: "Recorded faucet repair only.",
    jobId: job.id,
    photoIds: [photo.id],
  });
  const hold = holdPlanClaim(prisma);
  const stalePlan = planStudioPublicationDay(hold.racingDb, ownerA, {
    contentId: racePackage.id,
    plannedFor: "2026-11-01",
    expectedUpdatedAt: racePackage.updatedAt,
  });
  await hold.reached;
  const winner = await planStudioPublicationDay(prisma, ownerA, {
    contentId: racePackage.id,
    plannedFor: "2026-11-03",
    expectedUpdatedAt: racePackage.updatedAt,
  });
  check("First committed plan wins the publication day", winner.plannedDay === "2026-11-03");
  hold.release();
  await expectError(
    "Stale concurrent plan fails after the winner commits",
    () => stalePlan,
    (error) => error instanceof MarketingError && error.message === STUDIO_PLANNED_DAY_STALE_MESSAGE,
  );
  const afterRace = await prisma.marketingContent.findFirst({
    where: { id: racePackage.id, businessId: businessA.id },
  });
  check(
    "Stale plan does not overwrite the winning day or status",
    afterRace?.status === "DRAFT" &&
      afterRace.plannedFor?.getTime() === winner.plannedFor.getTime() &&
      afterRace.exportedAt == null &&
      afterRace.reviewedByMembershipId == null,
  );
  await expectError(
    "Stale expectedUpdatedAt is rejected without a race hold",
    () =>
      planStudioPublicationDay(prisma, ownerA, {
        contentId: racePackage.id,
        plannedFor: "2026-11-10",
        expectedUpdatedAt: racePackage.updatedAt,
      }),
    (error) => error instanceof MarketingError && error.message === STUDIO_PLANNED_DAY_STALE_MESSAGE,
  );

  const missingId = randomUUID();
  await expectError(
    "Unknown package is rejected at write time",
    () =>
      planStudioPublicationDay(prisma, ownerA, {
        contentId: missingId,
        plannedFor: "2026-11-10",
      }),
    (error) => error instanceof Error,
  );

  console.log("\nTEST — Bounded calendar of recorded packages");
  const overflowTitles = Array.from({ length: 51 }, (_, index) => `Calendar overflow ${String(index).padStart(2, "0")}`);
  await prisma.marketingContent.createMany({
    data: overflowTitles.map((title) => ({
      businessId: businessA.id,
      contentType: "GENERAL_POST",
      title,
      status: "DRAFT",
      createdByMembershipId: adminMem.id,
    })),
  });
  const statusesBefore = await prisma.marketingContent.findMany({
    where: { businessId: businessA.id },
    select: { id: true, status: true, plannedFor: true, exportedAt: true },
    orderBy: { id: "asc" },
  });
  const overflowSource = await loadMarketingSource(prisma, businessA.id);
  const statusesAfter = await prisma.marketingContent.findMany({
    where: { businessId: businessA.id },
    select: { id: true, status: true, plannedFor: true, exportedAt: true },
    orderBy: { id: "asc" },
  });
  check("Bounded calendar returns at most 50 packages", overflowSource.contentCalendar.items.length === 50);
  check("Bounded calendar reports the full recorded total", overflowSource.contentCalendar.total >= 53);
  check("Bounded calendar is truncated", overflowSource.contentCalendar.truncated === true);
  check("Bounded calendar limit is 50", overflowSource.contentCalendar.limit === 50);
  check(
    "Page load does not approve, plan, or export packages",
    statusesBefore.length === statusesAfter.length &&
      statusesBefore.every(
        (row, index) =>
          row.id === statusesAfter[index]?.id &&
          row.status === statusesAfter[index]?.status &&
          row.plannedFor?.getTime() === statusesAfter[index]?.plannedFor?.getTime() &&
          row.exportedAt?.getTime() === statusesAfter[index]?.exportedAt?.getTime(),
      ),
  );
  check(
    "Business B still cannot see A's overflow packages",
    (await loadMarketingSource(prisma, businessB.id)).contentCalendar.items.every(
      (row) => !row.title.startsWith("Calendar overflow"),
    ),
  );

  console.log(
    failures === 0
      ? "\nAll marketing content calendar checks passed."
      : `\n${failures} marketing content calendar check(s) failed.`,
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
