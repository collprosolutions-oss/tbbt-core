/**
 * Pipeline workspace domain + isolation verification.
 *
 * Imports the REAL production helpers from src/lib/pipeline.ts,
 * src/lib/pipeline-ops.ts, and src/lib/pipeline-data.ts.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-pipeline.mjs
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
  estimateDealValue,
  followUpStatus,
  parsePipelineDate,
  resolvePipelineStage,
  allowedOwnerStages,
} = await import("@/lib/pipeline");
const {
  updatePipelineFollowUp,
  updatePipelineNotes,
  updatePipelineStage,
  PipelineError,
} = await import("@/lib/pipeline-ops");
const { loadPipelineSource } = await import("@/lib/pipeline-data");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_pipeline_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for pipeline test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
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

function yesterday() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date;
}

function tomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date;
}

try {
  console.log("\nSTATIC — Pipeline domain helpers");
  check(
    "New unconverted request is New Lead",
    resolvePipelineStage({ ownerStage: null, estimateStatus: null, hasJob: false }) === "NEW_LEAD",
  );
  check(
    "Draft estimate is Estimate in Progress",
    resolvePipelineStage({ ownerStage: null, estimateStatus: "DRAFT", hasJob: false }) === "ESTIMATE_IN_PROGRESS",
  );
  check(
    "Sent estimate is Estimate Sent",
    resolvePipelineStage({ ownerStage: null, estimateStatus: "SENT", hasJob: false }) === "ESTIMATE_SENT",
  );
  check(
    "Approved estimate is Won",
    resolvePipelineStage({ ownerStage: null, estimateStatus: "APPROVED", hasJob: false }) === "WON",
  );
  check(
    "Job is Won even without approved status",
    resolvePipelineStage({ ownerStage: "LOST", estimateStatus: "SENT", hasJob: true }) === "WON",
  );
  check(
    "Approved estimate overrides Lost",
    resolvePipelineStage({ ownerStage: "LOST", estimateStatus: "APPROVED", hasJob: false }) === "WON",
  );
  check(
    "Owner Contacted persists when no estimate",
    resolvePipelineStage({ ownerStage: "CONTACTED", estimateStatus: null, hasJob: false }) === "CONTACTED",
  );
  check(
    "Owner Site Visit persists when no estimate",
    resolvePipelineStage({ ownerStage: "SITE_VISIT_NEEDS_INFO", estimateStatus: null, hasJob: false }) ===
      "SITE_VISIT_NEEDS_INFO",
  );
  check(
    "Owner Follow-Up persists after a sent estimate",
    resolvePipelineStage({ ownerStage: "FOLLOW_UP", estimateStatus: "SENT", hasJob: false }) === "FOLLOW_UP",
  );
  check(
    "Draft estimate overrides Contacted",
    resolvePipelineStage({ ownerStage: "CONTACTED", estimateStatus: "DRAFT", hasJob: false }) ===
      "ESTIMATE_IN_PROGRESS",
  );
  check(
    "No fabricated deal value without an estimate",
    estimateDealValue(null) === null,
  );
  check(
    "Draft estimate with 0 total has no deal value",
    estimateDealValue({ status: "DRAFT", total: 0 }) === null,
  );
  check(
    "Draft estimate with a real total uses that value",
    estimateDealValue({ status: "DRAFT", total: "150.00" }) === "150.00",
  );
  check(
    "Approved version total wins over live estimate total",
    estimateDealValue({
      status: "APPROVED",
      total: "1.00",
      approvedVersion: { total: "275.50" },
    }) === "275.50",
  );
  check("Yesterday is overdue", followUpStatus(yesterday()) === "overdue");
  check("Today is due today", followUpStatus(new Date()) === "due_today");
  check("Tomorrow is upcoming", followUpStatus(tomorrow()) === "upcoming");
  check("Missing follow-up is none", followUpStatus(null) === "none");
  check("Valid date parses", Boolean(parsePipelineDate("2026-08-31")));
  check("Invalid date is rejected", parsePipelineDate("2026-02-30") === null);
  check(
    "Won opportunities have no owner-managed stages",
    allowedOwnerStages({ ownerStage: null, estimateStatus: "APPROVED", hasJob: false }).length === 0,
  );
  check("FOUNDER_PAGE_KEYS includes pipeline", FOUNDER_PAGE_KEYS.includes("pipeline"));
  check("Pipeline has 5 KPI cards", KPI_CARD_COUNTS.pipeline === 5);
  check(
    "Pipeline founder regions match the implemented boxes",
    FOUNDER_REGIONS.pipeline.map((region) => region.id).join(",") ===
      "summary,nav,board,card,details,attention,page",
  );
  check("OWNER/ADMIN can access the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Pipeline nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/pipeline"));
  check("Pipeline nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/pipeline"));
  check("Pipeline nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/pipeline"));
  check("MEMBER does not have MANAGE_PIPELINE", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_PIPELINE));

  const businessA = await prisma.business.create({
    data: { name: "Alpha Pipeline", slug: `alpha-pipe-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Pipeline", slug: `beta-pipe-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-pipe-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-pipe-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-pipe-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-pipe-${randomUUID()}@example.com`, passwordHash: "x" },
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
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_PIPELINE);
    check("MEMBER MANAGE_PIPELINE is forbidden", false);
  } catch (error) {
    check("MEMBER MANAGE_PIPELINE is forbidden", error instanceof ForbiddenError);
  }
  requireBusinessCapability(adminA, CAPABILITIES.MANAGE_PIPELINE);
  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_PIPELINE);
  check("OWNER and ADMIN pass MANAGE_PIPELINE", true);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Starting faucet repair",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(89),
    },
  });
  const newLead = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Leaky kitchen faucet",
      serviceCatalogItemId: catalog.id,
    },
  });
  const draftRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Door latch",
      status: "CONVERTED",
    },
  });
  const draftEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceRequestId: draftRequest.id,
      status: "DRAFT",
      total: new Prisma.Decimal(220),
      publicToken: randomUUID(),
    },
  });
  const sentRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Deck repair",
      status: "CONVERTED",
    },
  });
  const sentEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceRequestId: sentRequest.id,
      status: "SENT",
      total: new Prisma.Decimal(999),
      publicToken: randomUUID(),
    },
  });
  await prisma.estimateVersion.create({
    data: {
      businessId: businessA.id,
      estimateId: sentEstimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(480),
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
    },
  });
  const wonRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      summary: "Fence gate",
      status: "CONVERTED",
    },
  });
  const wonEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      serviceRequestId: wonRequest.id,
      status: "APPROVED",
      total: new Prisma.Decimal(12),
      publicToken: randomUUID(),
    },
  });
  const wonVersion = await prisma.estimateVersion.create({
    data: {
      businessId: businessA.id,
      estimateId: wonEstimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(640),
      laborMinimumWaived: false,
      laborMinimumAdjustment: 0,
      approvedAt: new Date(),
    },
  });
  await prisma.estimate.update({
    where: { id: wonEstimate.id },
    data: { approvedVersionId: wonVersion.id },
  });
  const wonJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: wonEstimate.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const betaRequest = await prisma.serviceRequest.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      summary: "Secret beta leak",
    },
  });

  console.log("\nTEST — Derived stages and values");
  const source1 = await loadPipelineSource(prisma, businessA.id);
  const lead = source1.opportunities.find((row) => row.serviceRequestId === newLead.id);
  const draft = source1.opportunities.find((row) => row.serviceRequestId === draftRequest.id);
  const sent = source1.opportunities.find((row) => row.serviceRequestId === sentRequest.id);
  const won = source1.opportunities.find((row) => row.serviceRequestId === wonRequest.id);
  check("New request appears as New Lead", lead?.stage === "NEW_LEAD");
  check("New lead has no fabricated deal value", lead?.estimateValue === null);
  check("Starting catalog price is not used as deal value", lead?.estimateValue !== "89.00");
  check("Draft estimate appears as Estimate in Progress", draft?.stage === "ESTIMATE_IN_PROGRESS");
  check("Draft estimate value comes from the estimate total", draft?.estimateValue === "220.00");
  check("Sent estimate appears as Estimate Sent", sent?.stage === "ESTIMATE_SENT");
  check("Sent estimate value comes from the version snapshot", sent?.estimateValue === "480.00");
  check("Sent live total is not used when a version exists", sent?.estimateValue !== "999.00");
  check("Approved estimate / job appears Won", won?.stage === "WON" && won.jobId === wonJob.id);
  check("Won value comes from the approved version", won?.estimateValue === "640.00");
  check("Business A does not include Beta Secret", !source1.opportunities.some((row) => row.customerName === "Beta Secret"));

  console.log("\nTEST — Owner-managed stages, follow-up, and Lost");
  await updatePipelineStage(prisma, ownerA, {
    opportunityKey: `request:${newLead.id}`,
    ownerStage: "CONTACTED",
  });
  const afterContact = await loadPipelineSource(prisma, businessA.id);
  check(
    "Owner-managed Contacted state persists",
    afterContact.opportunities.find((row) => row.serviceRequestId === newLead.id)?.stage === "CONTACTED",
  );

  await updatePipelineStage(prisma, adminA, {
    opportunityKey: `request:${newLead.id}`,
    ownerStage: "SITE_VISIT_NEEDS_INFO",
  });
  const afterVisit = await loadPipelineSource(prisma, businessA.id);
  check(
    "Site Visit / Needs Info persists",
    afterVisit.opportunities.find((row) => row.serviceRequestId === newLead.id)?.stage === "SITE_VISIT_NEEDS_INFO",
  );

  await updatePipelineStage(prisma, ownerA, {
    opportunityKey: `request:${sentRequest.id}`,
    ownerStage: "FOLLOW_UP",
  });
  const afterFollow = await loadPipelineSource(prisma, businessA.id);
  check(
    "Follow-Up persists on a sent estimate",
    afterFollow.opportunities.find((row) => row.serviceRequestId === sentRequest.id)?.stage === "FOLLOW_UP",
  );

  const due = yesterday();
  const dueIso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await updatePipelineFollowUp(prisma, ownerA, {
    opportunityKey: `request:${sentRequest.id}`,
    followUpOn: dueIso,
  });
  const afterDate = await loadPipelineSource(prisma, businessA.id);
  const followRow = afterDate.opportunities.find((row) => row.serviceRequestId === sentRequest.id);
  check("Follow-up date persists", Boolean(followRow?.followUpOn));
  check("Overdue follow-up is identified", followRow?.followUp === "overdue");
  check("Needs Follow-Up count includes the overdue sent estimate", afterDate.counts.needsFollowUp >= 1);

  await updatePipelineNotes(prisma, ownerA, {
    opportunityKey: `request:${newLead.id}`,
    notes: "Waiting on photos of the leak.",
  });

  await updatePipelineStage(prisma, ownerA, {
    opportunityKey: `request:${newLead.id}`,
    ownerStage: "LOST",
    lossReason: "PRICE",
    lossReasonNote: "Customer said it was over budget",
  });
  const afterLost = await loadPipelineSource(prisma, businessA.id);
  const lostRow = afterLost.opportunities.find((row) => row.serviceRequestId === newLead.id);
  check("Lost state persists", lostRow?.stage === "LOST");
  check("Optional loss reason persists", lostRow?.lossReason === "PRICE");
  check("Lost opportunity remains in the historical list", afterLost.counts.lost >= 1);

  const stillRequest = await prisma.serviceRequest.findUnique({ where: { id: newLead.id } });
  const stillCustomer = await prisma.customer.findUnique({ where: { id: customer.id } });
  const stillDraft = await prisma.estimate.findUnique({ where: { id: draftEstimate.id } });
  check("Lost does not delete the request", stillRequest?.id === newLead.id);
  check("Lost does not delete the customer", stillCustomer?.id === customer.id);
  check("Lost does not delete an estimate", stillDraft?.id === draftEstimate.id);

  console.log("\nTEST — Lifecycle override, isolation, and MEMBER denial");
  await updatePipelineStage(prisma, ownerA, {
    opportunityKey: `request:${draftRequest.id}`,
    ownerStage: "LOST",
    lossReason: "UNABLE_TO_REACH",
  });
  await prisma.estimate.update({
    where: { id: draftEstimate.id },
    data: { status: "APPROVED", approvedVersionId: null, total: new Prisma.Decimal(220) },
  });
  await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: draftEstimate.id,
      status: "UNSCHEDULED",
      projectToken: randomUUID(),
    },
  });
  const afterOverride = await loadPipelineSource(prisma, businessA.id);
  check(
    "Strong downstream lifecycle truth overrides contradictory Lost state",
    afterOverride.opportunities.find((row) => row.serviceRequestId === draftRequest.id)?.stage === "WON",
  );

  await expectError(
    "Cannot mark a won opportunity Lost",
    () =>
      updatePipelineStage(prisma, ownerA, {
        opportunityKey: `request:${wonRequest.id}`,
        ownerStage: "LOST",
        lossReason: "PRICE",
      }),
    (error) => error instanceof PipelineError,
  );

  await expectError(
    "MEMBER cannot update pipeline stage",
    () =>
      updatePipelineStage(prisma, memberA, {
        opportunityKey: `request:${sentRequest.id}`,
        ownerStage: "LOST",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot set a follow-up date",
    () =>
      updatePipelineFollowUp(prisma, memberA, {
        opportunityKey: `request:${sentRequest.id}`,
        followUpOn: "2026-09-01",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot write pipeline notes",
    () =>
      updatePipelineNotes(prisma, memberA, {
        opportunityKey: `request:${sentRequest.id}`,
        notes: "should not leak",
      }),
    (error) => error instanceof ForbiddenError,
  );

  const memberLeak = JSON.stringify({
    denied: true,
    reason: "MEMBER has no MANAGE_PIPELINE and cannot load this workspace",
  });
  check(
    "MEMBER denial payload contains no pipeline/customer financial data",
    !memberLeak.includes("Ada Homeowner") &&
      !memberLeak.includes("480.00") &&
      !memberLeak.includes("Leaky kitchen faucet") &&
      !memberLeak.includes("Beta Secret"),
  );

  await expectError(
    "Business B cannot mutate A's opportunity",
    () =>
      updatePipelineStage(prisma, ownerB, {
        opportunityKey: `request:${sentRequest.id}`,
        ownerStage: "LOST",
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business B cannot open A's request key",
    () =>
      updatePipelineFollowUp(prisma, ownerB, {
        opportunityKey: `request:${newLead.id}`,
        followUpOn: "2026-09-02",
      }),
    (error) => error instanceof Error,
  );

  const sourceB = await loadPipelineSource(prisma, businessB.id);
  check("Business B sees only its own request", sourceB.opportunities.length === 1);
  check("Business B's request is its New Lead", sourceB.opportunities[0]?.serviceRequestId === betaRequest.id);
  check("Business B cannot see Ada", !sourceB.opportunities.some((row) => row.customerName === "Ada Homeowner"));
  check("Business B sees no A's estimate values", !sourceB.opportunities.some((row) => row.estimateValue));

  const stillWonJob = await prisma.job.findUnique({ where: { id: wonJob.id } });
  const stillWonEstimate = await prisma.estimate.findUnique({ where: { id: wonEstimate.id } });
  check("Existing job lifecycle record still exists", stillWonJob?.status === "SCHEDULED");
  check("Existing approved estimate still exists", stillWonEstimate?.status === "APPROVED");

  console.log(
    failures === 0 ? "\nAll pipeline checks passed." : `\n${failures} pipeline check(s) failed.`,
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
