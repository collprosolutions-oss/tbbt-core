/**
 * Weekly Marketing Studio approval queue.
 *
 * OWNER-only approve / return-for-changes against existing creator
 * packages and READY_FOR_REVIEW / APPROVED / DRAFT states. Reads and
 * writes stay business-scoped. ADMIN and MEMBER cannot approve. The
 * queue is bounded, never auto-approves, and never publishes, posts,
 * or sends customer messages.
 *
 * Run with:
 *   npm run test:marketing-approval-queue
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
  console.error("Failed to generate Prisma client for marketing approval queue checks.");
  process.exit(generateEarly.status ?? 1);
}

const { CAPABILITIES, ForbiddenError, requireBusinessCapability } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  OWNER_STUDIO_APPROVAL_MESSAGE,
  STUDIO_APPROVAL_QUEUE_LIMIT,
  STUDIO_APPROVAL_QUEUE_STATUS,
  STUDIO_APPROVE_NOT_READY_MESSAGE,
  STUDIO_APPROVED_INTERNAL_MESSAGE,
  STUDIO_RETURN_FOR_CHANGES_MESSAGE,
  STUDIO_RETURN_NOT_READY_MESSAGE,
  STUDIO_RETURNED_MESSAGE,
  WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE,
  boundStudioApprovalQueue,
  canActOnStudioApprovalQueue,
  canApproveStudioPackage,
  canReturnStudioPackage,
  isStudioApprovalQueueStatus,
  studioApprovalQueueMeta,
} = await import("@/lib/marketing");
const {
  advanceMarketingContentStatus,
  approveMarketingStudioPackage,
  createMarketingStudioPackage,
  grantJobPhotoMarketingPermission,
  MarketingError,
  returnMarketingStudioPackage,
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
const queueUiSrc = readSrc("src/components/marketing/studio-approval-queue.tsx");
const actionUiSrc = readSrc("src/components/marketing/studio-approval-actions.tsx");
const workspaceSrc = readSrc("src/components/marketing/marketing-workspace.tsx");

const approveFnSrc = opsSrc.slice(
  opsSrc.indexOf("export async function approveMarketingStudioPackage"),
  opsSrc.indexOf("export async function returnMarketingStudioPackage"),
);
const returnFnSrc = opsSrc.slice(
  opsSrc.indexOf("export async function returnMarketingStudioPackage"),
  opsSrc.indexOf("export async function exportMarketingCreatorPackage"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_approval_queue_test";
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
  console.error("Failed to push schema for marketing approval queue test database.");
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

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

try {
  console.log("\nSTATIC — Weekly approval queue helpers and limits");
  check("Queue limit is 50", STUDIO_APPROVAL_QUEUE_LIMIT === 50);
  check("Queue status is READY_FOR_REVIEW", STUDIO_APPROVAL_QUEUE_STATUS === "READY_FOR_REVIEW");
  check("READY_FOR_REVIEW is a queue status", isStudioApprovalQueueStatus("READY_FOR_REVIEW"));
  check("DRAFT is not a queue status", isStudioApprovalQueueStatus("DRAFT") === false);
  check("APPROVED is not a queue status", isStudioApprovalQueueStatus("APPROVED") === false);
  check("OWNER can act on the queue", canActOnStudioApprovalQueue("OWNER") === true);
  check("ADMIN cannot act on the queue", canActOnStudioApprovalQueue("ADMIN") === false);
  check("MEMBER cannot act on the queue", canActOnStudioApprovalQueue("MEMBER") === false);
  check(
    "OWNER can approve a ready package with eligible photos",
    canApproveStudioPackage({
      status: "READY_FOR_REVIEW",
      role: "OWNER",
      photos: [{ approved: true }],
    }) === true,
  );
  check(
    "ADMIN cannot approve a ready package",
    canApproveStudioPackage({
      status: "READY_FOR_REVIEW",
      role: "ADMIN",
      photos: [{ approved: true }],
    }) === false,
  );
  check(
    "MEMBER cannot approve a ready package",
    canApproveStudioPackage({
      status: "READY_FOR_REVIEW",
      role: "MEMBER",
      photos: [{ approved: true }],
    }) === false,
  );
  check(
    "OWNER cannot approve a draft",
    canApproveStudioPackage({
      status: "DRAFT",
      role: "OWNER",
      photos: [{ approved: true }],
    }) === false,
  );
  check(
    "OWNER can return a ready package",
    canReturnStudioPackage({ status: "READY_FOR_REVIEW", role: "OWNER" }) === true,
  );
  check(
    "ADMIN cannot return a ready package",
    canReturnStudioPackage({ status: "READY_FOR_REVIEW", role: "ADMIN" }) === false,
  );
  check(
    "MEMBER cannot return a ready package",
    canReturnStudioPackage({ status: "READY_FOR_REVIEW", role: "MEMBER" }) === false,
  );
  const bounded = boundStudioApprovalQueue(Array.from({ length: 51 }, (_, index) => index));
  check("In-memory bound keeps 50 items", bounded.items.length === 50 && bounded.limit === 50);
  check("In-memory bound marks overflow", bounded.truncated === true);
  const meta = studioApprovalQueueMeta(51);
  check("Queue meta reports truncation", meta.truncated === true && meta.total === 51 && meta.limit === 50);
  check("Weekly queue message forbids auto-approve and send", WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE.includes("will not auto-approve") && WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE.includes("send customer messages"));
  check("Approved message does not claim publish or send", STUDIO_APPROVED_INTERNAL_MESSAGE.includes("has not been published") && STUDIO_APPROVED_INTERNAL_MESSAGE.includes("sent to a customer"));
  check("Returned message keeps the package a draft", STUDIO_RETURNED_MESSAGE.includes("DRAFT"));

  console.log("\nSTATIC — Reads, writes, and UI stay internal");
  check(
    "Queue loader is business-scoped and bounded",
    dataSrc.includes("approvalQueueWhere") &&
      dataSrc.includes("STUDIO_APPROVAL_QUEUE_LIMIT") &&
      dataSrc.includes("take: STUDIO_APPROVAL_QUEUE_LIMIT") &&
      dataSrc.includes("status: STUDIO_APPROVAL_QUEUE_STATUS"),
  );
  const queueQuerySrc = dataSrc.slice(
    dataSrc.indexOf("where: approvalQueueWhere"),
    dataSrc.indexOf("prisma.marketingContent.count({ where: approvalQueueWhere })"),
  );
  check(
    "Queue loader does not include customer or estimate records",
    queueQuerySrc.includes("take: STUDIO_APPROVAL_QUEUE_LIMIT") &&
      !queueQuerySrc.includes("customer") &&
      !queueQuerySrc.includes("estimate") &&
      !queueQuerySrc.includes("caption"),
  );
  check(
    "Loader does not auto-approve or send",
    !dataSrc.includes("approveMarketingStudioPackage") &&
      !dataSrc.includes("advanceMarketingContentStatus") &&
      !dataSrc.includes("returnMarketingStudioPackage") &&
      !dataSrc.includes("sendCustomer") &&
      !dataSrc.includes("PUBLISHED"),
  );
  check(
    "Approve is OWNER-gated and business-scoped",
    approveFnSrc.includes("requireBusinessCapability") &&
      approveFnSrc.includes('requireBusinessRole(access, "OWNER")') &&
      approveFnSrc.includes("...access.scope") &&
      approveFnSrc.includes("access.assertOwned") &&
      approveFnSrc.includes("OWNER_STUDIO_APPROVAL_MESSAGE") &&
      approveFnSrc.includes('status: "APPROVED"'),
  );
  check(
    "Return is OWNER-gated and business-scoped",
    returnFnSrc.includes("requireBusinessCapability") &&
      returnFnSrc.includes('requireBusinessRole(access, "OWNER")') &&
      returnFnSrc.includes("...access.scope") &&
      returnFnSrc.includes("access.assertOwned") &&
      returnFnSrc.includes("STUDIO_RETURN_FOR_CHANGES_MESSAGE") &&
      returnFnSrc.includes('status: "DRAFT"'),
  );
  check(
    "Approve and return do not publish, post, or send",
    !approveFnSrc.includes("PUBLISHED") &&
      !approveFnSrc.includes("exportedAt") &&
      !approveFnSrc.includes("send") &&
      !approveFnSrc.includes("email") &&
      !approveFnSrc.includes("sms") &&
      !returnFnSrc.includes("PUBLISHED") &&
      !returnFnSrc.includes("exportedAt") &&
      !returnFnSrc.includes("send") &&
      !returnFnSrc.includes("email") &&
      !returnFnSrc.includes("sms"),
  );
  check(
    "Server actions expose explicit approve and return",
    actionSrc.includes("approveMarketingStudioPackageAction") &&
      actionSrc.includes("returnMarketingStudioPackageAction") &&
      actionSrc.includes("STUDIO_APPROVED_INTERNAL_MESSAGE") &&
      actionSrc.includes("STUDIO_RETURNED_MESSAGE"),
  );
  check(
    "Queue UI has explicit approve and return actions",
    actionUiSrc.includes("Approve") &&
      actionUiSrc.includes("Return for changes") &&
      actionUiSrc.includes("approveMarketingStudioPackageAction") &&
      actionUiSrc.includes("returnMarketingStudioPackageAction"),
  );
  check(
    "Workspace surfaces the weekly queue",
    workspaceSrc.includes("StudioApprovalQueue") &&
      workspaceSrc.includes('area === "approval-queue"') &&
      queueUiSrc.includes("Weekly approval queue") &&
      queueUiSrc.includes("WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE"),
  );
  check(
    "Domain still uses the existing three studio statuses",
    domainSrc.includes('"DRAFT", "READY_FOR_REVIEW", "APPROVED"') &&
      !domainSrc.includes("PUBLISHED"),
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Queue", slug: `alpha-queue-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Queue", slug: `beta-queue-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-queue-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-queue-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-queue-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-queue-${randomUUID()}@example.com`, passwordHash: "x" },
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
      url: "https://example.test/queue-after.jpg",
    },
  });
  const betaPhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessB.id,
      jobId: betaJob.id,
      stage: "AFTER",
      url: "https://example.test/beta-queue.jpg",
    },
  });
  await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: photo.id });
  await grantJobPhotoMarketingPermission(prisma, ownerB, { photoId: betaPhoto.id });

  console.log("\nTEST — Authorization: ADMIN and MEMBER cannot approve or return");
  const studio = await createMarketingStudioPackage(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Ready faucet package",
    body: "Recorded faucet repair only.",
    jobId: job.id,
    photoIds: [photo.id],
  });
  const ready = await advanceMarketingContentStatus(prisma, adminA, { contentId: studio.id });
  check("ADMIN can still send a package for OWNER review", ready.status === "READY_FOR_REVIEW");

  await expectError(
    "MEMBER cannot approve",
    () => approveMarketingStudioPackage(prisma, memberA, { contentId: studio.id }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot return for changes",
    () => returnMarketingStudioPackage(prisma, memberA, { contentId: studio.id }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot approve",
    () => approveMarketingStudioPackage(prisma, adminA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === OWNER_STUDIO_APPROVAL_MESSAGE,
  );
  await expectError(
    "ADMIN cannot return for changes",
    () => returnMarketingStudioPackage(prisma, adminA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === STUDIO_RETURN_FOR_CHANGES_MESSAGE,
  );
  const stillReady = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  check("Rejected ADMIN/MEMBER writes leave the package READY_FOR_REVIEW", stillReady?.status === "READY_FOR_REVIEW");
  check("Rejected writes do not record a reviewer", stillReady?.reviewedByMembershipId == null);
  try {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_MARKETING);
    check("MEMBER MANAGE_MARKETING is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_MARKETING is forbidden", error instanceof ForbiddenError);
  }

  console.log("\nTEST — Tenant isolation");
  const betaStudio = await createMarketingStudioPackage(prisma, ownerB, {
    contentType: "COMPLETED_JOB",
    title: "Beta only package",
    body: "Beta secret caption.",
    jobId: betaJob.id,
    photoIds: [betaPhoto.id],
  });
  await advanceMarketingContentStatus(prisma, ownerB, { contentId: betaStudio.id });
  const sourceA = await loadMarketingSource(prisma, businessA.id);
  const sourceB = await loadMarketingSource(prisma, businessB.id);
  check(
    "Business A queue contains only A packages",
    sourceA.approvalQueue.items.some((row) => row.id === studio.id) &&
      sourceA.approvalQueue.items.every((row) => row.id !== betaStudio.id),
  );
  check(
    "Business B queue contains only B packages",
    sourceB.approvalQueue.items.some((row) => row.id === betaStudio.id) &&
      sourceB.approvalQueue.items.every((row) => row.id !== studio.id),
  );
  check(
    "Queue payload omits the other tenant caption",
    sourceA.approvalQueue.items.every((row) => !row.body.includes("Beta secret")) &&
      sourceB.approvalQueue.items.every((row) => !row.title.includes("Ready faucet")),
  );
  await expectError(
    "Business B cannot approve A's package",
    () => approveMarketingStudioPackage(prisma, ownerB, { contentId: studio.id }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business B cannot return A's package",
    () => returnMarketingStudioPackage(prisma, ownerB, { contentId: studio.id }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business A cannot approve B's package",
    () => approveMarketingStudioPackage(prisma, ownerA, { contentId: betaStudio.id }),
    (error) => error instanceof Error,
  );

  console.log("\nTEST — OWNER return and approve stay explicit and internal");
  const returned = await returnMarketingStudioPackage(prisma, ownerA, { contentId: studio.id });
  check("OWNER return moves READY_FOR_REVIEW to DRAFT", returned.status === "DRAFT");
  check("Return does not mark the package exported", returned.exportedAt == null);
  check("Return does not record an approval reviewer", returned.reviewedByMembershipId == null);
  await expectError(
    "OWNER cannot approve a draft from the queue",
    () => approveMarketingStudioPackage(prisma, ownerA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === STUDIO_APPROVE_NOT_READY_MESSAGE,
  );
  const resent = await advanceMarketingContentStatus(prisma, adminA, { contentId: studio.id });
  check("Returned package can be sent for review again", resent.status === "READY_FOR_REVIEW");
  const approved = await approveMarketingStudioPackage(prisma, ownerA, { contentId: studio.id });
  check("OWNER approve moves READY_FOR_REVIEW to APPROVED", approved.status === "APPROVED");
  check("OWNER approve records the owner reviewer", approved.reviewedByMembershipId === ownerMem.id);
  check("OWNER approve records a review timestamp", approved.reviewedAt instanceof Date);
  check("Approve does not export or publish", approved.exportedAt == null);
  await expectError(
    "Approved packages cannot be returned for changes",
    () => returnMarketingStudioPackage(prisma, ownerA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === STUDIO_RETURN_NOT_READY_MESSAGE,
  );
  await expectError(
    "Approved packages cannot be approved again",
    () => approveMarketingStudioPackage(prisma, ownerA, { contentId: studio.id }),
    (error) => error instanceof MarketingError && error.message === STUDIO_APPROVE_NOT_READY_MESSAGE,
  );
  const afterApprove = await loadMarketingSource(prisma, businessA.id);
  check(
    "Approved package leaves the weekly queue",
    afterApprove.approvalQueue.items.every((row) => row.id !== studio.id),
  );
  check("Load after approve does not invent a published state", afterApprove.channels.connected === false);
  const storedApproved = await prisma.marketingContent.findFirst({
    where: { id: studio.id, businessId: businessA.id },
  });
  check(
    "Stored approved package is still not published",
    storedApproved?.status === "APPROVED" && storedApproved.exportedAt == null,
  );

  console.log("\nTEST — Bounded queue and no auto-approve");
  const overflowTitles = Array.from({ length: 51 }, (_, index) => `Queue overflow ${String(index).padStart(2, "0")}`);
  await prisma.marketingContent.createMany({
    data: overflowTitles.map((title) => ({
      businessId: businessA.id,
      contentType: "GENERAL_POST",
      title,
      status: "READY_FOR_REVIEW",
      createdByMembershipId: adminMem.id,
    })),
  });
  await prisma.marketingContent.create({
    data: {
      businessId: businessA.id,
      contentType: "GENERAL_POST",
      title: "Still a draft",
      status: "DRAFT",
      createdByMembershipId: adminMem.id,
    },
  });
  const statusesBefore = await prisma.marketingContent.findMany({
    where: { businessId: businessA.id },
    select: { id: true, status: true },
    orderBy: { id: "asc" },
  });
  const overflowSource = await loadMarketingSource(prisma, businessA.id);
  const statusesAfter = await prisma.marketingContent.findMany({
    where: { businessId: businessA.id },
    select: { id: true, status: true },
    orderBy: { id: "asc" },
  });
  check("Bounded queue returns at most 50 packages", overflowSource.approvalQueue.items.length === 50);
  check("Bounded queue reports the full READY_FOR_REVIEW total", overflowSource.approvalQueue.total === 51);
  check("Bounded queue is truncated", overflowSource.approvalQueue.truncated === true);
  check("Bounded queue limit is 50", overflowSource.approvalQueue.limit === 50);
  check(
    "Queue excludes DRAFT and APPROVED packages",
    overflowSource.approvalQueue.items.every((row) => row.status === "READY_FOR_REVIEW") &&
      overflowSource.approvalQueue.items.every((row) => row.title !== "Still a draft") &&
      overflowSource.approvalQueue.items.every((row) => row.id !== studio.id),
  );
  check(
    "Page load does not auto-approve or change statuses",
    statusesBefore.length === statusesAfter.length &&
      statusesBefore.every((row, index) => row.id === statusesAfter[index]?.id && row.status === statusesAfter[index]?.status),
  );
  check(
    "Business B still cannot see A's overflow packages",
    (await loadMarketingSource(prisma, businessB.id)).approvalQueue.items.every(
      (row) => !row.title.startsWith("Queue overflow"),
    ),
  );

  console.log(
    failures === 0
      ? "\nAll marketing approval queue checks passed."
      : `\n${failures} marketing approval queue check(s) failed.`,
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
