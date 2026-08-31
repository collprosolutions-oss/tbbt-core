/**
 * Marketing Studio domain + isolation verification.
 *
 * Imports the REAL production helpers from src/lib/marketing.ts,
 * src/lib/marketing-ops.ts, and src/lib/marketing-data.ts.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-marketing.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const {
  CHANNELS_DISCONNECTED_MESSAGE,
  PERFORMANCE_UNAVAILABLE_MESSAGE,
  LEAD_SOURCE_UNTRACKED_MESSAGE,
  CALENDAR_INTERNAL_MESSAGE,
  canSelectPhotoForMarketing,
  jobMarketingReadiness,
  marketingAiAssistAvailable,
  nextContentStatus,
  parseMarketingArea,
} = await import("@/lib/marketing");
const {
  createMarketingContent,
  grantJobPhotoMarketingPermission,
  MarketingError,
  setMarketingContentPlannedFor,
  advanceMarketingContentStatus,
} = await import("@/lib/marketing-ops");
const { loadMarketingSource } = await import("@/lib/marketing-data");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for marketing test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

try {
  console.log("\nSTATIC — Marketing domain helpers");
  check("Invalid area falls back to overview", parseMarketingArea("reviews") === "overview");
  check("Private photo cannot be selected", !canSelectPhotoForMarketing({ marketingPermissionStatus: "PRIVATE" }));
  check("Approved photo can be selected", canSelectPhotoForMarketing({ marketingPermissionStatus: "APPROVED" }));
  check("Job with private-only photos needs permission", jobMarketingReadiness({ photoCount: 2, approvedPhotoCount: 0 }) === "needs_permission");
  check("Job with an approved photo is ready", jobMarketingReadiness({ photoCount: 2, approvedPhotoCount: 1 }) === "ready");
  check("DRAFT advances to READY_FOR_REVIEW", nextContentStatus("DRAFT") === "READY_FOR_REVIEW");
  check("READY_FOR_REVIEW advances to APPROVED", nextContentStatus("READY_FOR_REVIEW") === "APPROVED");
  check("APPROVED has no next publish state", nextContentStatus("APPROVED") === null);
  check("AI assist is not enabled in this step", marketingAiAssistAvailable() === false);
  check("FOUNDER_PAGE_KEYS includes marketing", FOUNDER_PAGE_KEYS.includes("marketing"));
  check("Marketing has 4 KPI cards", KPI_CARD_COUNTS.marketing === 4);
  check(
    "Marketing founder regions match the implemented boxes",
    FOUNDER_REGIONS.marketing.map((region) => region.id).join(",") ===
      "summary,nav,opportunities,content,calendar,rail,page",
  );
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Marketing nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/marketing"));
  check("Marketing nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/marketing"));
  check("Marketing nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/marketing"));
  check("MEMBER does not have MANAGE_MARKETING", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MARKETING));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Marketing", slug: `alpha-mkt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Marketing", slug: `beta-mkt-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-mkt-${randomUUID()}@example.com`, passwordHash: "x" },
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
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_MARKETING);
    check("MEMBER MANAGE_MARKETING is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_MARKETING is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.MANAGE_MARKETING);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_MARKETING);
  check("OWNER and ADMIN pass MANAGE_MARKETING", true);

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
  const openJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "IN_PROGRESS",
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

  const privatePhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "BEFORE",
      url: "https://example.test/private.jpg",
      caption: "Private before",
    },
  });
  const otherPhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "AFTER",
      url: "https://example.test/after.jpg",
      caption: "After",
    },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: businessB.id,
      jobId: betaJob.id,
      stage: "AFTER",
      url: "https://example.test/beta.jpg",
    },
  });

  console.log("\nTEST — Completed job opportunity and photo permission");
  const beforeGrant = await loadMarketingSource(prisma, businessA.id);
  check("Completed job appears as a marketing opportunity", beforeGrant.opportunities.some((row) => row.jobId === job.id));
  check("In-progress job is not a marketing opportunity", !beforeGrant.opportunities.some((row) => row.jobId === openJob.id));
  check("New photos default to PRIVATE", privatePhoto.marketingPermissionStatus === "PRIVATE");
  check("Opportunity reports photos need permission", beforeGrant.opportunities.find((row) => row.jobId === job.id)?.readiness === "needs_permission");

  await expectError(
    "Private photo cannot be attached to content",
    () =>
      createMarketingContent(prisma, ownerA, {
        contentType: "COMPLETED_JOB",
        title: "Should fail",
        jobId: job.id,
        photoIds: [privatePhoto.id],
      }),
    (error) => error instanceof MarketingError && /Private/.test(error.message),
  );

  await expectError(
    "MEMBER cannot grant marketing permission",
    () => grantJobPhotoMarketingPermission(prisma, memberA, { photoId: otherPhoto.id }),
    (error) => error instanceof ForbiddenError,
  );

  const approved = await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: otherPhoto.id });
  check("Grant records APPROVED status", approved.marketingPermissionStatus === "APPROVED");
  check("Grant records who approved", approved.marketingPermissionGrantedByMembershipId === ownerMem.id);
  check("Grant records a timestamp", approved.marketingPermissionGrantedAt instanceof Date);

  const afterGrant = await loadMarketingSource(prisma, businessA.id);
  const opportunity = afterGrant.opportunities.find((row) => row.jobId === job.id);
  check("Approved photo can be selected", opportunity?.photos.some((photo) => photo.id === otherPhoto.id && photo.marketingPermissionStatus === "APPROVED"));
  check("Private photo remains unselectable", opportunity?.photos.some((photo) => photo.id === privatePhoto.id && photo.marketingPermissionStatus === "PRIVATE"));
  check("Job is marketing-ready after one approved photo", opportunity?.readiness === "ready");

  console.log("\nTEST — Content draft lifecycle and internal calendar");
  const draft = await createMarketingContent(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Faucet before and after",
    body: "Work completed. No customer contact details.",
    channelIntent: "INSTAGRAM",
    jobId: job.id,
    photoIds: [otherPhoto.id],
    plannedFor: "2026-09-15",
  });
  check("Draft is created as DRAFT", draft.status === "DRAFT");
  check("Draft stores the approved photo only", draft.photos.length === 1 && draft.photos[0].jobPhotoId === otherPhoto.id);
  check(
    "Internal planning date persists on create",
    draft.plannedFor?.getFullYear() === 2026 &&
      draft.plannedFor?.getMonth() === 8 &&
      draft.plannedFor?.getDate() === 15,
  );

  const ready = await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  check("DRAFT → READY_FOR_REVIEW", ready.status === "READY_FOR_REVIEW");
  const approvedContent = await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  check("READY_FOR_REVIEW → APPROVED", approvedContent.status === "APPROVED");
  check("Approval records reviewer", approvedContent.reviewedByMembershipId === ownerMem.id);

  await expectError(
    "APPROVED has no fake PUBLISHED next step",
    () => advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id }),
    (error) => error instanceof MarketingError && /not available/.test(error.message),
  );

  const replanned = await setMarketingContentPlannedFor(prisma, ownerA, {
    contentId: draft.id,
    plannedFor: "2026-09-22",
  });
  check(
    "Internal calendar date can be updated",
    replanned.plannedFor?.getFullYear() === 2026 &&
      replanned.plannedFor?.getMonth() === 8 &&
      replanned.plannedFor?.getDate() === 22,
  );

  const sourceA = await loadMarketingSource(prisma, businessA.id);
  check("Overview counts 1 approved content", sourceA.counts.approved === 1);
  check("No social channel is fabricated", sourceA.channels.connected === false && sourceA.channels.message === CHANNELS_DISCONNECTED_MESSAGE);
  check("No performance is fabricated", sourceA.performance.available === false && sourceA.performance.message === PERFORMANCE_UNAVAILABLE_MESSAGE);
  check("Lead source is not invented", sourceA.leadSources.tracked === false && sourceA.leadSources.message === LEAD_SOURCE_UNTRACKED_MESSAGE);
  check("Calendar disclaimer is exact", CALENDAR_INTERNAL_MESSAGE.includes("will not publish"));
  check("Business A does not see Beta's completed job", sourceA.opportunities.every((row) => row.jobId !== betaJob.id));

  const sourceB = await loadMarketingSource(prisma, businessB.id);
  check("Business B does not see Ada or A's content", sourceB.contents.length === 0 && sourceB.opportunities.every((row) => row.jobId !== job.id));
  check("Business B completed job is only its own", sourceB.opportunities.some((row) => row.jobId === betaJob.id));

  await expectError(
    "Business B cannot grant permission on A's photo",
    () => grantJobPhotoMarketingPermission(prisma, ownerB, { photoId: otherPhoto.id }),
    (error) => error instanceof Error,
  );

  console.log(
    failures === 0 ? "\nAll marketing checks passed." : `\n${failures} marketing check(s) failed.`,
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
