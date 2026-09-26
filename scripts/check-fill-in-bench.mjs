/**
 * Fill-In Bench owner-tool proofs.
 *
 * Extends the existing FillInBenchWorker model. Does not create a second
 * Membership/User engine, marketplace, login, assignment, or payroll path.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-fill-in-bench.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  describeRecordedBenchSkillFacts,
  loadOwnedFillInBench,
  recordedBenchSkillFacts,
} = await import("@/lib/fill-in-bench");
const { projectWorkforceFromSnapshot } = await import("@/lib/chief-of-staff/workforce-specialist");
const { loadWorkforceSnapshot } = await import("@/lib/workforce-data");
const {
  setFillInBenchActiveOp,
  upsertFillInBenchWorkerOp,
  WorkforceError,
} = await import("@/lib/workforce-ops");
const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { WORKFORCE_SKILL_KEYS } = await import("@/lib/workforce");

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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20260927010000_fill_in_bench_owner_fields/migration.sql");
const benchLib = readRepo("src/lib/fill-in-bench.ts");
const benchOps = readRepo("src/lib/workforce-ops.ts");
const benchActions = readRepo("src/app/actions/fill-in-bench.ts");
const workforceActions = readRepo("src/app/actions/workforce.ts");
const benchForm = readRepo("src/components/team/fill-in-bench-form.tsx");
const workspace = readRepo("src/components/team/fill-in-bench-workspace.tsx");
const teamPage = readRepo("src/app/(app)/team/page.tsx");
const benchPage = readRepo("src/app/(app)/team/bench/page.tsx");
const specialist = readRepo("src/lib/chief-of-staff/workforce-specialist.ts");
const fieldPage = readRepo("src/app/field/page.tsx");
const nav = readRepo("src/lib/nav.ts");

console.log("\nSTATIC — Canonical model, no duplicate engine, no automatic side effects");

check(
  "Fill-In Bench stays on the existing FillInBenchWorker model",
  schema.includes("model FillInBenchWorker") &&
    !schema.includes("model BenchWorker") &&
    !schema.includes("model FillInBenchUser") &&
    schema.includes("A bench row is not a User or Membership"),
);
check(
  "Migration is additive only and does not create User/Membership rows",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
    migration.includes('ADD COLUMN IF NOT EXISTS "workerType"') &&
    migration.includes('ADD COLUMN IF NOT EXISTS "locationNotes"') &&
    !migration.includes("CREATE TABLE") &&
    !migration.includes('"User"') &&
    !migration.includes('"Membership"'),
);
check(
  "Owner workspace separates active and inactive bench",
  workspace.includes("Available / active bench") &&
    workspace.includes("Inactive bench") &&
    workspace.includes("Regular team member") &&
    benchForm.includes("Deactivate") &&
    benchForm.includes("Reactivate"),
);
check(
  "Team and dedicated bench routes stay owner-gated",
  teamPage.includes("requireManagementPageAccess") &&
    teamPage.includes("never public") &&
    teamPage.includes("not a cross-business marketplace") &&
    benchPage.includes("requireManagementPageAccess") &&
    benchPage.includes("loadOwnedFillInBench") &&
    teamPage.includes("loadOwnedFillInBench"),
);
check(
  "Global nav is not given a new top-level Fill-In Bench item",
  !nav.includes("/team/bench") && nav.includes('href: "/team"'),
);
check(
  "MEMBER still cannot manage members or see the field-wide bench",
  !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MEMBERS) &&
    fieldPage.includes("Other workers and the Fill-In Bench stay hidden"),
);
check(
  "Canonical skills include the recorded trade keys used across verticals",
  WORKFORCE_SKILL_KEYS.includes("electrical") &&
    WORKFORCE_SKILL_KEYS.includes("plumbing") &&
    WORKFORCE_SKILL_KEYS.includes("cleaning") &&
    WORKFORCE_SKILL_KEYS.includes("hvac") &&
    WORKFORCE_SKILL_KEYS.includes("roofing") &&
    WORKFORCE_SKILL_KEYS.includes("landscaping"),
);
check(
  "Bench writes never create users, memberships, jobs, time cards, or messages",
  [benchLib, benchOps, benchActions, workforceActions, benchForm, workspace, benchPage].every(
    (src) =>
      !src.includes("prisma.user.create") &&
      !src.includes("prisma.membership.create") &&
      !src.includes("prisma.job.create") &&
      !src.includes("prisma.job.update") &&
      !src.includes("assignedMembershipId:") &&
      !src.includes("prisma.timeEntry") &&
      !src.includes("prisma.payroll") &&
      !src.includes("resend") &&
      !src.includes("twilio") &&
      !/\b(ALTER TABLE|CREATE TABLE|CREATE INDEX)\b/i.test(src),
  ),
);
check(
  "Workforce specialist states recorded bench skill facts only",
  specialist.includes("describeRecordedBenchSkillFacts") &&
    specialist.includes("benchSkillFacts") &&
    specialist.includes("Never names a person") &&
    !specialist.includes("is qualified") &&
    !specialist.includes("auto-assign"),
);

const electricalFacts = describeRecordedBenchSkillFacts(
  [
    { active: true, skills: ["electrical"] },
    { active: true, skills: ["electrical", "hvac"] },
    { active: true, skills: ["electrical"] },
    { active: false, skills: ["electrical"] },
    { active: true, skills: ["cleaning"] },
  ],
  ["electrical"],
);
const missingFacts = describeRecordedBenchSkillFacts(
  [
    { active: true, skills: ["cleaning"] },
    { active: false, skills: ["plumbing"] },
  ],
  ["plumbing"],
);
check(
  "Skill facts count only active recorded skills",
  electricalFacts === "3 active bench workers have Electrical skill recorded.",
);
check(
  "Missing recorded skill is stated as missing, not inferred",
  missingFacts === "No active Fill-In Bench worker has the required recorded skill.",
);
check(
  "Recorded skill facts omit zero-count skills when summarizing the roster",
  recordedBenchSkillFacts([
    { active: true, skills: ["electrical"] },
    { active: false, skills: ["plumbing"] },
  ]).every((row) => row.recordedActiveCount > 0 && row.skillKey !== "plumbing"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run Fill-In Bench Prisma checks.");
  process.exit(failed === 0 ? 1 : 1);
}

const testDbName = "tbbt_fill_in_bench_test";
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
  console.log("\nPRISMA — Owner/admin CRUD, MEMBER denial, tenant isolation, no side effects");

  const businessA = await prisma.business.create({
    data: { name: "Alpha Bench", slug: `alpha-bench-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Bench", slug: `beta-bench-${randomUUID().slice(0, 8)}`, tradeCode: "HVAC" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-bench-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Ada Admin", email: `admin-bench-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-bench-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-bench-${randomUUID()}@example.com`, passwordHash: "x" },
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
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });

  const usersBefore = await prisma.user.count();
  const membershipsBefore = await prisma.membership.count({ where: { businessId: businessA.id } });
  const jobsBefore = await prisma.job.count({ where: { businessId: businessA.id } });
  const timeCardsBefore = await prisma.timeEntry.count({ where: { businessId: businessA.id } });
  const payrollBefore = await prisma.payrollRun.count({ where: { businessId: businessA.id } });

  const created = await upsertFillInBenchWorkerOp(prisma, ownerA, {
    displayName: "Pat Helper",
    contactPreference: "PHONE",
    contactValue: "555-0100",
    skills: ["electrical", "hvac"],
    availabilityNotes: "Evenings",
    workerType: "HELPER",
    locationNotes: "North service area",
    approved: true,
    active: true,
    notes: "Internal only",
  });
  check(
    "Owner can create a tenant-scoped bench worker",
    created.businessId === businessA.id &&
      created.displayName === "Pat Helper" &&
      created.workerType === "HELPER" &&
      created.locationNotes === "North service area" &&
      created.skills.includes("electrical") &&
      created.membershipId == null,
  );

  const edited = await upsertFillInBenchWorkerOp(prisma, adminA, {
    id: created.id,
    displayName: "Pat Helper",
    contactPreference: "TEXT",
    contactValue: "555-0100",
    skills: ["electrical"],
    availabilityNotes: "Weekends",
    workerType: "SUBCONTRACTOR",
    locationNotes: "North and west",
    approved: true,
    active: true,
    notes: "Updated notes",
    membershipId: memberMem.id,
  });
  check(
    "Admin can edit and optionally link an existing Membership",
    edited.id === created.id &&
      edited.contactPreference === "TEXT" &&
      edited.workerType === "SUBCONTRACTOR" &&
      edited.membershipId === memberMem.id &&
      edited.skills === "electrical",
  );

  const deactivated = await setFillInBenchActiveOp(prisma, ownerA, { id: created.id, active: false });
  check("Owner can deactivate a bench worker", deactivated.active === false);
  const reactivated = await setFillInBenchActiveOp(prisma, adminA, { id: created.id, active: true });
  check("Admin can reactivate a bench worker", reactivated.active === true);

  try {
    await loadOwnedFillInBench(prisma, memberA);
    check("MEMBER cannot browse the full bench", false);
  } catch (error) {
    check("MEMBER cannot browse the full bench", error instanceof ForbiddenError);
  }

  try {
    await upsertFillInBenchWorkerOp(prisma, memberA, {
      displayName: "Stolen",
      contactPreference: "PHONE",
      contactValue: "",
      skills: ["electrical"],
      availabilityNotes: "",
      approved: true,
      active: true,
      notes: "",
    });
    check("MEMBER cannot manage the bench", false);
  } catch (error) {
    check("MEMBER cannot manage the bench", error instanceof ForbiddenError);
  }

  try {
    await setFillInBenchActiveOp(prisma, memberA, { id: created.id, active: false });
    check("MEMBER cannot deactivate a bench worker", false);
  } catch (error) {
    check("MEMBER cannot deactivate a bench worker", error instanceof ForbiddenError);
  }

  try {
    await upsertFillInBenchWorkerOp(prisma, ownerB, {
      id: created.id,
      displayName: "Stolen",
      contactPreference: "PHONE",
      contactValue: "",
      skills: [],
      availabilityNotes: "",
      approved: true,
      active: true,
      notes: "",
    });
    check("Foreign tenant cannot update another business bench row", false);
  } catch (error) {
    check(
      "Foreign tenant cannot update another business bench row",
      error instanceof ForbiddenError || error instanceof WorkforceError,
    );
  }

  const foreignBrowse = await loadOwnedFillInBench(prisma, ownerB);
  check("Foreign tenant browse does not include the other business bench", foreignBrowse.length === 0);

  try {
    await upsertFillInBenchWorkerOp(prisma, ownerA, {
      displayName: "Bad Skill",
      contactPreference: "PHONE",
      contactValue: "",
      skills: ["wizard"],
      availabilityNotes: "",
      approved: true,
      active: true,
      notes: "",
    });
    check("Unrecorded skill is rejected instead of inferred", false);
  } catch (error) {
    check("Unrecorded skill is rejected instead of inferred", error instanceof WorkforceError);
  }

  const second = await upsertFillInBenchWorkerOp(prisma, ownerA, {
    displayName: "Riley Electric",
    contactPreference: "EMAIL",
    contactValue: "riley@example.com",
    skills: ["electrical"],
    availabilityNotes: "",
    workerType: "BACKUP",
    locationNotes: "",
    approved: true,
    active: true,
    notes: "",
  });
  const third = await upsertFillInBenchWorkerOp(prisma, ownerA, {
    displayName: "Sam Future",
    contactPreference: "OTHER",
    contactValue: "",
    skills: ["electrical", "roofing"],
    availabilityNotes: "After notice",
    workerType: "FUTURE_HIRE",
    locationNotes: "",
    approved: true,
    active: true,
    notes: "",
  });
  await setFillInBenchActiveOp(prisma, ownerA, { id: second.id, active: false });

  const owned = await loadOwnedFillInBench(prisma, ownerA);
  const activeElectrical = describeRecordedBenchSkillFacts(owned, ["electrical"]);
  const missingPlumbing = describeRecordedBenchSkillFacts(owned, ["plumbing"]);
  check(
    "Owner browse sees the full tenant bench including inactive rows",
    owned.length === 3 && owned.some((row) => row.id === second.id && row.active === false),
  );
  check(
    "Linked bench row is marked as an existing regular team member",
    owned.some((row) => row.id === created.id && row.isRegularTeamMember === true && row.linkedMemberName === "Mia Member"),
  );
  check(
    "Unlinked bench rows are not treated as Memberships",
    owned.filter((row) => row.id !== created.id).every((row) => row.isRegularTeamMember === false && row.membershipId == null),
  );
  check(
    "Recorded electrical count ignores the inactive bench worker",
    activeElectrical === "2 active bench workers have Electrical skill recorded.",
  );
  check(
    "Required plumbing with no recorded active bench skill stays unknown",
    missingPlumbing === "No active Fill-In Bench worker has the required recorded skill.",
  );

  const snapshot = await loadWorkforceSnapshot(prisma, businessA.id);
  const projection = projectWorkforceFromSnapshot({
    snapshot,
    catalogKeys: ["workforce-staffing-shortage"],
    target: { status: "none" },
    canUseTeamProfiles: true,
    canTargetJob: true,
    canRecommendAssignees: true,
  });
  const rawProjection = JSON.stringify(projection);
  check(
    "Workforce specialist bench slice is counts and recorded skills, not contact",
    projection.teamSummary?.benchCount >= 1 &&
      projection.teamSummary.benchSkillFacts.some((row) => row.skillKey === "electrical" && row.recordedActiveCount === 2) &&
      !rawProjection.includes("555-0100") &&
      !rawProjection.includes("contactValue") &&
      !rawProjection.includes("riley@example.com") &&
      !rawProjection.includes("Pat Helper"),
  );

  const usersAfter = await prisma.user.count();
  const membershipsAfter = await prisma.membership.count({ where: { businessId: businessA.id } });
  const jobsAfter = await prisma.job.count({ where: { businessId: businessA.id } });
  const assignedAfter = await prisma.job.count({
    where: { businessId: businessA.id, assignedMembershipId: { not: null } },
  });
  const timeCardsAfter = await prisma.timeEntry.count({ where: { businessId: businessA.id } });
  const payrollAfter = await prisma.payrollRun.count({ where: { businessId: businessA.id } });
  const outreachAfter = await prisma.workforceOutreachTask.count({ where: { businessId: businessA.id } });
  check("No login/user is created by bench writes", usersAfter === usersBefore);
  check("Regular Membership is not duplicated by bench writes", membershipsAfter === membershipsBefore);
  check("No job is created or assigned by bench writes", jobsAfter === jobsBefore && assignedAfter === 0);
  check("No time card is created by bench writes", timeCardsAfter === timeCardsBefore);
  check("No payroll record is created by bench writes", payrollAfter === payrollBefore);
  check("No outreach/contact task is created by bench writes", outreachAfter === 0);
  void third;

  console.log(failed === 0 ? `\nAll Fill-In Bench checks passed (${passed}).` : `\n${failed} Fill-In Bench check(s) failed.`);
} catch (error) {
  failed += 1;
  console.error("FAIL - Fill-In Bench Prisma harness threw", error);
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

process.exit(failed === 0 ? 0 : 1);
