/**
 * BSOS Business Health + Coach verification.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-bsos.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, requireBusinessCapability, roleHasCapability } = await import(
  "@/lib/authorization"
);
const { visibleAppNav } = await import("@/lib/nav");
const { buildBsosRecommendations, coachSummary, parseBsosArea } = await import("@/lib/bsos");
const { createBusinessGoal, createBusinessActionItem, BsosError } = await import("@/lib/bsos-ops");
const { loadBsosWorkspace } = await import("@/lib/bsos-data");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_bsos_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
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
  console.log("\nSTATIC — BSOS helpers");
  check("Unknown area falls back to health", parseBsosArea("nope") === "health");
  check("Business Health nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/business-health"));
  check("Business Health nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/business-health"));
  check("MEMBER does not have VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));

  const empty = buildBsosRecommendations({
    unpaidInvoices: { count: 0, amount: 0 },
    sentEstimates: { count: 0 },
    draftEstimates: { count: 0 },
    unscheduledJobs: { count: 0 },
    completedJobsWithoutReview: { count: 0 },
    completedJobsReadyForMarketing: { count: 0 },
    lowMarginJobs: { count: 0 },
    missingWageEntries: { count: 0 },
    availableCapacityDays: { count: 0 },
    repeatCustomers: { count: 0 },
    outsideAreaRequests: { count: 0 },
    recurringExpenses: { count: 0, amount: 0 },
    paidRevenue: { amount: 0 },
    recordedExpenses: { amount: 0 },
  });
  check("No recommendations when no recorded facts", empty.length === 0);
  check("Coach distinguishes empty facts", /No prioritized recommendations/.test(coachSummary(empty)));

  const recs = buildBsosRecommendations({
    unpaidInvoices: { count: 2, amount: 150 },
    sentEstimates: { count: 1 },
    draftEstimates: { count: 0 },
    unscheduledJobs: { count: 0 },
    completedJobsWithoutReview: { count: 0 },
    completedJobsReadyForMarketing: { count: 0 },
    lowMarginJobs: { count: 0 },
    missingWageEntries: { count: 1 },
    availableCapacityDays: { count: 0 },
    repeatCustomers: { count: 0 },
    outsideAreaRequests: { count: 0 },
    recurringExpenses: { count: 0, amount: 0 },
    paidRevenue: { amount: 400 },
    recordedExpenses: { amount: 40 },
  });
  check("Unpaid invoices become a recommendation", recs.some((row) => row.key === "collect-unpaid-invoices"));
  check("Recommendations include recorded facts", recs[0].facts.length > 0 && recs[0].kind === "recommendation");

  const businessA = await prisma.business.create({
    data: { name: "Alpha BSOS", slug: `alpha-bsos-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta BSOS", slug: `beta-bsos-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-bsos-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-bsos-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-bsos-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  try {
    requireBusinessCapability(memberA, CAPABILITIES.VIEW_REPORTS);
    check("MEMBER VIEW_REPORTS is forbidden", false);
  } catch (error) {
    check("MEMBER VIEW_REPORTS is forbidden", error instanceof ForbiddenError);
  }

  await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      status: "SENT",
      total: 80,
      publicToken: randomUUID(),
    },
  });
  const workspaceA = await loadBsosWorkspace(prisma, businessA.id);
  check("Health metrics are facts", workspaceA.metrics.every((row) => row.kind === "fact"));
  check("Unpaid invoice fact appears", workspaceA.facts.unpaidInvoices.count === 1);
  check("Recommendation explains why", workspaceA.recommendations.some((row) => /SENT invoices/.test(row.why)));

  const goal = await createBusinessGoal(prisma, ownerA, { title: "Collect overdue invoices", recommendationKey: "collect-unpaid-invoices" });
  check("Goal is tenant-scoped", goal.businessId === businessA.id);
  try {
    await createBusinessGoal(prisma, memberA, { title: "Nope" });
    check("MEMBER cannot create a goal", false);
  } catch (error) {
    check("MEMBER cannot create a goal", error instanceof ForbiddenError || error instanceof BsosError);
  }

  const action = await createBusinessActionItem(prisma, ownerA, {
    title: "Call the unpaid invoice customer",
    recommendationKey: "collect-unpaid-invoices",
    goalId: goal.id,
  });
  check("Action item belongs to A", action.businessId === businessA.id);

  const workspaceB = await loadBsosWorkspace(prisma, businessB.id);
  check("Business B does not see A's unpaid invoice", workspaceB.facts.unpaidInvoices.count === 0);
  check("Business B does not see A's goal", workspaceB.goals.length === 0);

  try {
    await createBusinessActionItem(prisma, ownerB, {
      title: "Steal",
      recommendationKey: "x",
      goalId: goal.id,
    });
    check("Business B cannot attach to A's goal", false);
  } catch {
    check("Business B cannot attach to A's goal", true);
  }

  console.log(failures === 0 ? "\nAll BSOS checks passed." : `\n${failures} BSOS check(s) failed.`);
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
