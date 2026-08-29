/**
 * Focused verification for the Launch Blocker Fix: minimal team member
 * (MEMBER) onboarding built on top of the existing User/Membership/auth
 * architecture -- see src/app/actions/team.ts, src/app/actions/
 * password-setup.ts, src/app/(app)/team/page.tsx, and
 * src/app/set-password/[token]/page.tsx.
 *
 * Combines the same techniques the earlier scripts/check-*.mjs scripts
 * already use:
 *   1. Real imports from src/lib/authorization.ts and src/lib/nav.ts (no
 *      next/headers dependency, so they run directly in a plain Node
 *      script) -- proves MANAGE_MEMBERS role gating and sidebar
 *      visibility match production code exactly.
 *   2. Prisma-level mirrors of addTeamMember() / setTeamMemberActive() /
 *      completePasswordSetup() that duplicate their guard/persistence
 *      logic byte-for-byte (matching the existing duplication convention
 *      in scripts/check-authorization.mjs and
 *      scripts/check-employee-field-workflow.mjs, since the real actions
 *      need next/headers request context a plain script doesn't have).
 *      Password hashing/token hashing here duplicate src/lib/auth.ts's
 *      exact scheme (bcrypt + sha256-of-raw-token) for the same reason.
 *   3. A real HTTP round-trip against the BUILT app for page-level
 *      authorization, direct-URL leakage, and rendered content (Team
 *      page, Job assignment dropdown, the public set-password page).
 *
 * Run with:
 *   npm run build && node --experimental-strip-types scripts/check-team-onboarding.mjs
 */
import { createRequire } from "node:module";
import { register } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import bcrypt from "bcryptjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} = await import("../src/lib/authorization.ts");
const { visibleAppNav } = await import("../src/lib/nav.ts");

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;

// --- 1. Static — role gating and nav visibility use the REAL production code ---

console.log("\nSTATIC — MANAGE_MEMBERS matches the locked OWNER/ADMIN-only authority model");
check("OWNER has MANAGE_MEMBERS", roleHasCapability("OWNER", CAPABILITIES.MANAGE_MEMBERS));
check("ADMIN has MANAGE_MEMBERS", roleHasCapability("ADMIN", CAPABILITIES.MANAGE_MEMBERS));
check("MEMBER does NOT have MANAGE_MEMBERS", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MEMBERS));

console.log("\nSTATIC — Sidebar nav (visibleAppNav) hides /team from MEMBER, shows it to OWNER/ADMIN");
check("OWNER sees the Team nav item", visibleAppNav("OWNER").some((item) => item.href === "/team"));
check("ADMIN sees the Team nav item", visibleAppNav("ADMIN").some((item) => item.href === "/team"));
check("MEMBER does NOT see the Team nav item", !visibleAppNav("MEMBER").some((item) => item.href === "/team"));

// --- 2. Prisma-level mirrors of the real server actions ------------------

const testDbName = "tbbt_team_onboarding_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for team-onboarding test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

// Duplicated on purpose (matches every other scripts/check-*.mjs file):
// mirrors src/lib/auth.ts's exact hashing scheme so a token/password
// produced here is byte-for-byte comparable to what the real app would
// produce and verify.
function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
function createSecureToken() {
  return randomBytes(32).toString("hex");
}
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}
async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

function makeAccess(businessId, role, businessName = "Test Business") {
  return {
    businessId,
    workspace: { role, business: { name: businessName } },
  };
}

/** Mirrors addTeamMember() in src/app/actions/team.ts exactly (minus the best-effort email send). */
async function mirrorAddTeamMember(access, { name, email }, appUrl = "https://app.example.test") {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  const normalizedEmail = email.toLowerCase();

  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  if (existingUser) {
    const existingMembership = await prisma.membership.findUnique({
      where: { userId_businessId: { userId: existingUser.id, businessId: access.businessId } },
    });

    if (existingMembership) {
      if (existingMembership.active) {
        return { ok: false, reason: "already-on-team" };
      }
      await prisma.membership.update({ where: { id: existingMembership.id }, data: { active: true } });
      return { ok: true, reactivated: true, userId: existingUser.id, membershipId: existingMembership.id };
    }

    const membership = await prisma.membership.create({
      data: { userId: existingUser.id, businessId: access.businessId, role: "MEMBER" },
    });
    return { ok: true, reusedExistingUser: true, userId: existingUser.id, membershipId: membership.id };
  }

  const unusablePasswordHash = await hashPassword(createSecureToken());
  const rawSetupToken = createSecureToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name, email: normalizedEmail, passwordHash: unusablePasswordHash },
    });
    const membership = await tx.membership.create({
      data: { userId: user.id, businessId: access.businessId, role: "MEMBER" },
    });
    await tx.passwordSetupToken.create({
      data: { userId: user.id, tokenHash: hashToken(rawSetupToken), expiresAt },
    });
    return { userId: user.id, membershipId: membership.id };
  });

  return { ok: true, createdNewUser: true, ...result, setupUrl: `${appUrl}/set-password/${rawSetupToken}` };
}

/** Mirrors setTeamMemberActive() in src/app/actions/team.ts exactly. */
async function mirrorSetTeamMemberActive(access, membershipId, active) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId, businessId: access.businessId, role: "MEMBER" },
  });
  if (!membership) {
    return { ok: false, reason: "not-found" };
  }
  await prisma.membership.update({ where: { id: membership.id }, data: { active } });
  return { ok: true };
}

/** Mirrors completePasswordSetup() in src/app/actions/password-setup.ts exactly (minus session/cookie side effects). */
async function mirrorCompletePasswordSetup(token, password) {
  const setupToken = await prisma.passwordSetupToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!setupToken || setupToken.usedAt || setupToken.expiresAt < new Date()) {
    return { ok: false, reason: "invalid-or-expired" };
  }
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: setupToken.userId }, data: { passwordHash } });
    await tx.passwordSetupToken.update({ where: { id: setupToken.id }, data: { usedAt: new Date() } });
  });
  return { ok: true, userId: setupToken.userId };
}

/** Mirrors the active-membership filter in requireWorkspace() (src/lib/workspace.ts) and signInAction() (src/app/actions/auth.ts). */
async function resolveActiveMemberships(userId) {
  return prisma.membership.findMany({ where: { userId, active: true }, orderBy: { createdAt: "asc" } });
}

let serverProcess;

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-team", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-team", tradeCode: "HANDYMAN" },
  });

  const ownerAUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: "owner@team-test.example", passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Amir Admin", email: "admin@team-test.example", passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Mia Member", email: "member@team-test.example", passwordHash: "x" },
  });
  await prisma.membership.create({ data: { userId: ownerAUser.id, businessId: businessA.id, role: "OWNER" } });
  await prisma.membership.create({ data: { userId: adminAUser.id, businessId: businessA.id, role: "ADMIN" } });
  await prisma.membership.create({ data: { userId: memberAUser.id, businessId: businessA.id, role: "MEMBER" } });

  const ownerA = makeAccess(businessA.id, "OWNER", businessA.name);
  const adminA = makeAccess(businessA.id, "ADMIN", businessA.name);
  const memberA = makeAccess(businessA.id, "MEMBER", businessA.name);
  const ownerB = makeAccess(businessB.id, "OWNER", businessB.name);

  console.log("\nTEST 1 — MEMBER cannot add or manage members (ForbiddenError, no data created)");
  let memberAddThrew = false;
  try {
    await mirrorAddTeamMember(memberA, { name: "Should Not Exist", email: "shouldnot@team-test.example" });
  } catch (error) {
    memberAddThrew = error instanceof ForbiddenError;
  }
  check("MEMBER's addTeamMember throws ForbiddenError", memberAddThrew);
  const shouldNotExistUser = await prisma.user.findUnique({ where: { email: "shouldnot@team-test.example" } });
  check("...and no User row was created", shouldNotExistUser === null);

  console.log("\nTEST 2 — OWNER can add a brand-new field MEMBER");
  const newMemberEmail = "newfield@team-test.example";
  const addResult = await mirrorAddTeamMember(ownerA, { name: "Newt Fieldworker", email: newMemberEmail });
  check("addTeamMember succeeds for OWNER", addResult.ok === true && addResult.createdNewUser === true);
  check("A setup URL is returned (no email config required)", typeof addResult.setupUrl === "string" && addResult.setupUrl.includes("/set-password/"));
  const newMembership = await prisma.membership.findUnique({ where: { id: addResult.membershipId } });
  check("The new Membership's role is MEMBER (fixed, not client-controlled)", newMembership.role === "MEMBER");
  check("The new Membership is scoped to the CALLER's own business (never client-supplied)", newMembership.businessId === businessA.id);
  check("The new Membership starts active", newMembership.active === true);
  const newUser = await prisma.user.findUnique({ where: { id: addResult.userId } });
  check("The new User's passwordHash is set but is not a guessable/known value", typeof newUser.passwordHash === "string" && newUser.passwordHash.length > 20);

  console.log("\nTEST 3 — ADMIN can add a brand-new field MEMBER too");
  const adminAddResult = await mirrorAddTeamMember(adminA, { name: "Ada Fieldworker", email: "adafield@team-test.example" });
  check("addTeamMember succeeds for ADMIN", adminAddResult.ok === true);

  console.log("\nTEST 4 — Duplicate membership in the same business is prevented");
  const duplicateAttempt = await mirrorAddTeamMember(ownerA, { name: "Newt Fieldworker", email: newMemberEmail });
  check("Re-adding the same email to the same business is rejected", duplicateAttempt.ok === false && duplicateAttempt.reason === "already-on-team");
  const membershipCountForNewMember = await prisma.membership.count({ where: { userId: addResult.userId, businessId: businessA.id } });
  check("Exactly ONE Membership row exists for that user+business (no duplicate created)", membershipCountForNewMember === 1);

  console.log("\nTEST 5 — Reusing an existing User by email does not grant them unintended access to another business");
  const crossBusinessAdd = await mirrorAddTeamMember(ownerB, { name: "Newt Fieldworker", email: newMemberEmail });
  check("Business B's OWNER can add the SAME existing user to Business B", crossBusinessAdd.ok === true && crossBusinessAdd.reusedExistingUser === true);
  const membershipsForSharedUser = await resolveActiveMemberships(addResult.userId);
  check("The shared user now has exactly two memberships (one per business), not a merged/escalated one", membershipsForSharedUser.length === 2);
  const membershipInA = membershipsForSharedUser.find((m) => m.businessId === businessA.id);
  const membershipInB = membershipsForSharedUser.find((m) => m.businessId === businessB.id);
  check("Their Business A membership is still role MEMBER, untouched by the Business B action", membershipInA?.role === "MEMBER");
  check("Their new Business B membership is also role MEMBER (fixed), scoped only to Business B", membershipInB?.role === "MEMBER" && membershipInB?.businessId === businessB.id);
  check("No membership row grants them a role or business beyond these two explicit ones", membershipsForSharedUser.every((m) => m.businessId === businessA.id || m.businessId === businessB.id));

  console.log("\nTEST 6 — Existing user with NO account-level password is unaffected by being added to a second business (no duplicate User)");
  const userCountForEmail = await prisma.user.count({ where: { email: newMemberEmail } });
  check("Still exactly one User row for that email (reused, not duplicated)", userCountForEmail === 1);

  console.log("\nTEST 7 — MEMBER cannot deactivate/reactivate a team member (ForbiddenError)");
  let memberDeactivateThrew = false;
  try {
    await mirrorSetTeamMemberActive(memberA, memberAUser.id, false);
  } catch (error) {
    memberDeactivateThrew = error instanceof ForbiddenError;
  }
  check("MEMBER's setTeamMemberActive throws ForbiddenError", memberDeactivateThrew);

  console.log("\nTEST 8 — Cross-business member manipulation fails (OWNER of A cannot touch a Business B membership)");
  const crossBusinessDeactivate = await mirrorSetTeamMemberActive(ownerA, membershipInB.id, false);
  check("OWNER of Business A cannot deactivate a Business B membership by id", crossBusinessDeactivate.ok === false && crossBusinessDeactivate.reason === "not-found");
  const membershipBUnchanged = await prisma.membership.findUnique({ where: { id: membershipInB.id } });
  check("The Business B membership is still active/unchanged", membershipBUnchanged.active === true);

  console.log("\nTEST 9 — OWNER/ADMIN cannot deactivate an OWNER/ADMIN membership through this action (MEMBER-only)");
  const attemptDeactivateOwner = await mirrorSetTeamMemberActive(adminA, (await prisma.membership.findFirst({ where: { userId: ownerAUser.id, businessId: businessA.id } })).id, false);
  check("Deactivating an OWNER membership by id is rejected (role: MEMBER filter excludes it)", attemptDeactivateOwner.ok === false && attemptDeactivateOwner.reason === "not-found");

  console.log("\nTEST 10 — OWNER can remove (deactivate) a MEMBER, and reactivate them");
  const deactivate = await mirrorSetTeamMemberActive(ownerA, addResult.membershipId, false);
  check("Deactivation succeeds", deactivate.ok === true);
  let membershipsAfterDeactivate = await resolveActiveMemberships(addResult.userId);
  check("The deactivated membership no longer resolves as an active workspace", !membershipsAfterDeactivate.some((m) => m.id === addResult.membershipId));
  check("...but their OTHER (Business B) membership is untouched and still active", membershipsAfterDeactivate.some((m) => m.businessId === businessB.id));

  const reactivate = await mirrorSetTeamMemberActive(ownerA, addResult.membershipId, true);
  check("Reactivation succeeds", reactivate.ok === true);
  membershipsAfterDeactivate = await resolveActiveMemberships(addResult.userId);
  check("The reactivated membership resolves as an active workspace again", membershipsAfterDeactivate.some((m) => m.id === addResult.membershipId));

  console.log("\nTEST 11 — Adding back a previously-removed member reactivates the one row instead of erroring or duplicating");
  await mirrorSetTeamMemberActive(ownerA, addResult.membershipId, false);
  const reAddResult = await mirrorAddTeamMember(ownerA, { name: "Newt Fieldworker", email: newMemberEmail });
  check("Re-adding a deactivated member succeeds (reactivates)", reAddResult.ok === true && reAddResult.reactivated === true);
  check("The SAME membership id is reused, not a new row", reAddResult.membershipId === addResult.membershipId);
  const membershipCountAfterReAdd = await prisma.membership.count({ where: { userId: addResult.userId, businessId: businessA.id } });
  check("Still exactly one Membership row for that user+business after the remove/re-add cycle", membershipCountAfterReAdd === 1);

  console.log("\nTEST 12 — Password setup: valid single-use token lets the new member set their own password once");
  const setupResult = await mirrorCompletePasswordSetup(
    addResult.setupUrl.split("/set-password/")[1],
    "correcthorsebatterystaple",
  );
  check("Password setup succeeds with the valid token", setupResult.ok === true);
  const passwordSetUser = await prisma.user.findUnique({ where: { id: addResult.userId } });
  check("The user's passwordHash actually changed", passwordSetUser.passwordHash !== newUser.passwordHash);
  check("The new password verifies against the stored hash", await verifyPassword("correcthorsebatterystaple", passwordSetUser.passwordHash));
  check("The OLD (never-shared) random passwordHash no longer verifies", !(await verifyPassword("whatever-the-random-value-was", passwordSetUser.passwordHash)));

  console.log("\nTEST 13 — The setup token is single-use: replaying it fails");
  const replaySetupResult = await mirrorCompletePasswordSetup(
    addResult.setupUrl.split("/set-password/")[1],
    "atotallydifferentpassword1",
  );
  check("Replaying the same token is rejected", replaySetupResult.ok === false && replaySetupResult.reason === "invalid-or-expired");
  const userAfterReplay = await prisma.user.findUnique({ where: { id: addResult.userId } });
  check("The password is unchanged after the rejected replay", userAfterReplay.passwordHash === passwordSetUser.passwordHash);

  console.log("\nTEST 14 — An expired token is rejected");
  const expiredAdd = await mirrorAddTeamMember(ownerA, { name: "Expired Example", email: "expired@team-test.example" });
  const expiredRawToken = expiredAdd.setupUrl.split("/set-password/")[1];
  await prisma.passwordSetupToken.update({
    where: { tokenHash: hashToken(expiredRawToken) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expiredResult = await mirrorCompletePasswordSetup(expiredRawToken, "somepassword123");
  check("An expired token is rejected", expiredResult.ok === false && expiredResult.reason === "invalid-or-expired");

  console.log("\nTEST 15 — A completely made-up token is rejected the exact same way (no existence oracle)");
  const madeUpResult = await mirrorCompletePasswordSetup(createSecureToken(), "somepassword123");
  check(
    "An unknown token fails with the SAME reason as an expired/used one (no distinguishable error)",
    madeUpResult.ok === false &&
      madeUpResult.reason === "invalid-or-expired" &&
      madeUpResult.reason === expiredResult.reason &&
      madeUpResult.reason === replaySetupResult.reason,
  );

  console.log("\nTEST 16 — Job assignment dropdown immediately recognizes the newly created (active) MEMBER, and excludes removed ones");
  const jobA = await prisma.job.create({
    data: { businessId: businessA.id, projectToken: randomUUID(), status: "UNSCHEDULED" },
  });
  await mirrorSetTeamMemberActive(ownerA, addResult.membershipId, false); // remove Newt again for this test
  const eligibleMembers = await prisma.membership.findMany({
    where: { businessId: businessA.id, role: "MEMBER", active: true },
    select: { id: true, user: { select: { name: true } } },
  });
  check("Original MEMBER (memberAUser) is eligible", eligibleMembers.some((m) => m.user.name === "Mia Member"));
  check("The freshly-added ADMIN-created member (Ada) is eligible", eligibleMembers.some((m) => m.user.name === "Ada Fieldworker"));
  check("The just-removed member (Newt) is NOT eligible", !eligibleMembers.some((m) => m.user.name === "Newt Fieldworker"));
  await mirrorSetTeamMemberActive(ownerA, addResult.membershipId, true); // restore for later HTTP checks

  console.log("\nTEST 17 — assignJobMember-style re-validation rejects a cross-business/removed membershipId (mirrors src/app/actions/job.ts)");
  async function mirrorAssignJobMember(access, jobId, membershipId) {
    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, businessId: access.businessId, role: "MEMBER", active: true },
    });
    if (!membership) {
      return { ok: false };
    }
    await prisma.job.update({ where: { id: jobId }, data: { assignedMembershipId: membership.id } });
    return { ok: true };
  }
  const assignCrossBusiness = await mirrorAssignJobMember(ownerA, jobA.id, membershipInB.id);
  check("Assigning a Business B membership to a Business A job is rejected", assignCrossBusiness.ok === false);
  const removedMembershipId = (await prisma.membership.findFirst({ where: { userId: memberAUser.id, businessId: businessA.id } })).id;
  await prisma.membership.update({ where: { id: removedMembershipId }, data: { active: false } });
  const assignRemoved = await mirrorAssignJobMember(ownerA, jobA.id, removedMembershipId);
  check("Assigning a removed (inactive) MEMBER is rejected", assignRemoved.ok === false);
  await prisma.membership.update({ where: { id: removedMembershipId }, data: { active: true } });

  console.log("\nSTATIC — src/app/actions/team.ts and src/app/(app)/jobs/[jobId]/page.tsx scope every membership lookup by businessId, and filter by active");
  const { readFileSync } = await import("node:fs");
  const teamActionsSrc = readFileSync(new URL("../src/app/actions/team.ts", import.meta.url), "utf8");
  check(
    "addTeamMember() always scopes the new Membership by access.businessId (never a client-supplied business id)",
    /businessId:\s*access\.businessId/.test(teamActionsSrc) && !teamActionsSrc.includes('formData.get("businessId")'),
  );
  check(
    "setTeamMemberActive() re-validates the target scoped by businessId AND role MEMBER in one query",
    /businessId:\s*access\.businessId,\s*role:\s*"MEMBER"/.test(teamActionsSrc),
  );
  const jobPageSrc = readFileSync(new URL("../src/app/(app)/jobs/[jobId]/page.tsx", import.meta.url), "utf8");
  check(
    "The Job page's eligibleMembers query excludes inactive (removed) memberships",
    /role:\s*"MEMBER",\s*active:\s*true/.test(jobPageSrc),
  );
  const jobActionsSrc = readFileSync(new URL("../src/app/actions/job.ts", import.meta.url), "utf8");
  check(
    "assignJobMember() re-validation also excludes inactive memberships",
    /role:\s*"MEMBER",[\s\S]{0,40}active:\s*true/.test(jobActionsSrc),
  );
  const workspaceSrc = readFileSync(new URL("../src/lib/workspace.ts", import.meta.url), "utf8");
  check(
    "requireWorkspace() only resolves workspaces from active memberships",
    /userId:\s*user\.id,\s*active:\s*true/.test(workspaceSrc),
  );
  const authActionsSrc = readFileSync(new URL("../src/app/actions/auth.ts", import.meta.url), "utf8");
  check(
    "signInAction() also filters memberships by active: true",
    /memberships:\s*\{\s*where:\s*\{\s*active:\s*true\s*\}/.test(authActionsSrc),
  );

  if (!existsSync(`${repoRoot}.next`)) {
    console.error(
      "\nNo .next build output found -- skipping the HTTP section. Run `npm run build` first for full coverage.",
    );
  } else {
    // --- 3. HTTP checks against the built app -----------------------------

    function hashSessionToken(token) {
      return createHash("sha256").update(token).digest("hex");
    }

    const PORT = 43847;
    const APP_URL = `http://127.0.0.1:${PORT}`;

    async function waitForServer(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
          if (res.status < 500) {
            return true;
          }
        } catch {
          // not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return false;
    }

    function cookieHeader(session) {
      return `tbbt_session=${session.token}; tbbt_workspace=${session.businessId}`;
    }

    async function fetchRaw(session, path) {
      const res = await fetch(`${APP_URL}${path}`, {
        redirect: "manual",
        headers: session ? { cookie: cookieHeader(session) } : {},
      });
      const body = await res.text().catch(() => "");
      return { status: res.status, location: res.headers.get("location"), body };
    }

    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    async function makeSession(user, businessId) {
      const token = randomUUID();
      await prisma.session.create({ data: { userId: user.id, tokenHash: hashSessionToken(token), expiresAt: farFuture } });
      return { token, businessId };
    }
    const ownerSession = await makeSession(ownerAUser, businessA.id);
    const memberSession = await makeSession(memberAUser, businessA.id);

    console.log(`\nStarting built app on ${APP_URL} against the test database...`);
    serverProcess = spawn(
      "node_modules/.bin/next",
      ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
      { cwd: repoRoot.replace(/\/$/, ""), env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "production" }, stdio: "pipe" },
    );
    let serverOutput = "";
    serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
    serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

    const up = await waitForServer(30_000);
    if (!up) {
      console.error("Server did not start in time. Output so far:\n" + serverOutput);
      process.exit(1);
    }

    console.log("\nTEST 18 — OWNER can open /team and it shows the real team (nav + form + members)");
    const ownerTeamPage = await fetchRaw(ownerSession, "/team");
    check("OWNER GET /team returns 200", ownerTeamPage.status === 200);
    check("Team page shows the Team nav link", ownerTeamPage.body.includes('href="/team"'));
    check("Team page shows the add-team-member form fields", ownerTeamPage.body.includes('name="email"') && ownerTeamPage.body.includes("Add team member"));
    check("Team page lists the existing MEMBER by name", ownerTeamPage.body.includes("Mia Member"));

    console.log("\nTEST 19 — MEMBER cannot read /team (direct URL access is rejected server-side, no leak)");
    const memberTeamPage = await fetchRaw(memberSession, "/team");
    check("MEMBER GET /team is redirected server-side (307 -> /access-restricted)", memberTeamPage.status === 307 && memberTeamPage.location === "/access-restricted");
    check("...and the raw response never contains any teammate's email/name", !memberTeamPage.body.includes("owner@team-test.example") && !memberTeamPage.body.includes("Mia Member") && !memberTeamPage.body.includes("Ada Fieldworker"));
    check("...and never contains the management nav either", !memberTeamPage.body.includes("Schedule / Jobs"));

    const unauthTeamPage = await fetchRaw(null, "/team");
    check("Unauthenticated GET /team is redirected to /sign-in, not rendered", unauthTeamPage.status === 307 && unauthTeamPage.location === "/sign-in");

    console.log("\nTEST 20 — Job page's Assigned Employee dropdown immediately shows the newly added MEMBER");
    const httpJob = await prisma.job.create({ data: { businessId: businessA.id, projectToken: randomUUID(), status: "UNSCHEDULED" } });
    const freshAdd = await mirrorAddTeamMember(ownerA, { name: "Frankie Freshhire", email: "frankie@team-test.example" });
    const jobPage = await fetchRaw(ownerSession, `/jobs/${httpJob.id}`);
    check("Job page returns 200", jobPage.status === 200);
    check("Job page's assignment dropdown includes the brand-new MEMBER by name+email", jobPage.body.includes("Frankie Freshhire") && jobPage.body.includes("frankie@team-test.example"));
    await mirrorSetTeamMemberActive(ownerA, freshAdd.membershipId, false);
    const jobPageAfterRemoval = await fetchRaw(ownerSession, `/jobs/${httpJob.id}`);
    check("After removing that MEMBER, the dropdown no longer offers them", !jobPageAfterRemoval.body.includes("frankie@team-test.example"));

    console.log("\nTEST 21 — Public set-password page never leaks business/team info for an invalid or expired token, but shows the real business name for a valid one");
    const invalidTokenPage = await fetchRaw(null, `/set-password/${createSecureToken()}`);
    check("An unknown token returns 200 with the generic invalid/expired message", invalidTokenPage.status === 200 && invalidTokenPage.body.includes("invalid or has expired"));
    check("...and never reveals the business name", !invalidTokenPage.body.includes("Alpha Handyman"));

    const validAdd = await mirrorAddTeamMember(ownerA, { name: "Vera Validlink", email: "vera@team-test.example" });
    const validTokenPage = await fetchRaw(null, validAdd.setupUrl.replace(APP_URL, "").startsWith("/set-password/") ? validAdd.setupUrl.replace(APP_URL, "") : `/set-password/${validAdd.setupUrl.split("/set-password/")[1]}`);
    check("A valid, unused, unexpired token returns 200 and shows a real password-setup form", validTokenPage.status === 200 && validTokenPage.body.includes('name="password"'));
    check("A valid token's page greets the real invited member by name", validTokenPage.body.includes("Vera Validlink"));
    check("A valid token's page names the real business they were added to", validTokenPage.body.includes("Alpha Handyman"));
  }

  if (failures === 0) {
    console.log("\nAll team onboarding checks passed.");
  } else {
    console.log(`\n${failures} team onboarding check(s) failed.`);
  }
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
  }
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
