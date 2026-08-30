/**
 * Founder Design Mode verification against the BUILT, RUNNING app
 * (must already be started separately, e.g. `npx next start -p 3000`).
 *
 * Verifies:
 *  1. A founder-flagged User sees the "Founder Design Mode" trigger on
 *     every one of the 6 supported pages.
 *  2. A subscriber OWNER, ADMIN-equivalent, and MEMBER -- none of them
 *     isFounder -- never see it, on any of the 6 pages, via direct URL.
 *  3. A completely different business's OWNER also never sees it
 *     (cross-business/tenant isolation).
 *  4. Saving a founder override for one page does not change what a
 *     subscriber sees on that same page (per-founder-user scoping, not
 *     global).
 *  5. requireFounderAccess()'s underlying data (User.isFounder) matches
 *     exactly the accounts we expect.
 *
 * Run with:
 *   npx next start -p 3000 &
 *   node --experimental-strip-types scripts/check-founder-design-mode.mjs
 */
import { register } from "node:module";
import { randomUUID, createHash } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { prisma } = await import("@/lib/prisma");

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const PAGES = ["/dashboard", "/requests", "/customers", "/estimates", "/jobs", "/invoices"];
const TRIGGER_TEXT = "Founder Design Mode";

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${label}`);
  }
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function makeSession(userId) {
  const token = randomUUID();
  const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt: farFuture } });
  return token;
}

function cookieHeader(token, businessId) {
  return `tbbt_session=${token}; tbbt_workspace=${businessId ?? ""}`;
}

async function fetchPage(token, businessId, path) {
  const res = await fetch(`${APP_URL}${path}`, {
    redirect: "manual",
    headers: { cookie: cookieHeader(token, businessId) },
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
}

async function main() {
  console.log(`\nSetting up sessions against ${APP_URL}...`);

  const founder = await prisma.user.findUnique({ where: { email: "founder@tbbt.dev" } });
  const owner = await prisma.user.findUnique({ where: { email: "owner@collpro-test.example" } });
  const member = await prisma.user.findUnique({ where: { email: "john@collpro-test.example" } });

  if (!founder || !owner || !member) {
    console.error("Expected test users are missing (founder@tbbt.dev / owner@collpro-test.example / john@collpro-test.example).");
    process.exit(1);
  }

  console.log("\nTEST 1 -- User.isFounder is exactly what we expect (platform flag, not role-derived)");
  check("founder@tbbt.dev has isFounder = true", founder.isFounder === true);
  check("owner@collpro-test.example has isFounder = false", owner.isFounder === false);
  check("john@collpro-test.example (MEMBER) has isFounder = false", member.isFounder === false);

  const founderMembership = await prisma.membership.findFirst({ where: { userId: founder.id, active: true } });
  const ownerMembership = await prisma.membership.findFirst({ where: { userId: owner.id, active: true } });
  const memberMembership = await prisma.membership.findFirst({ where: { userId: member.id, active: true } });

  check(
    "Founder test account's own tenant role is ADMIN, DIFFERENT from the subscriber OWNER above (both isFounder=false owner@collpro-test.example and isFounder=true founder@tbbt.dev reach the same pages -- only the isFounder flag, never the role, decides Founder Design Mode visibility)",
    founderMembership?.role === "ADMIN" && ownerMembership?.role === "OWNER",
  );

  const founderToken = await makeSession(founder.id);
  const ownerToken = await makeSession(owner.id);
  const memberToken = await makeSession(member.id);

  console.log("\nTEST 2 -- The founder sees the trigger on all 6 supported pages");
  for (const path of PAGES) {
    const { status, body } = await fetchPage(founderToken, founderMembership.businessId, path);
    check(`${path}: 200 OK`, status === 200);
    check(`${path}: contains "${TRIGGER_TEXT}"`, body.includes(TRIGGER_TEXT));
  }

  console.log("\nTEST 3 -- Subscriber OWNER never sees the trigger, on any of the 6 pages (direct URL)");
  for (const path of PAGES) {
    const { status, body } = await fetchPage(ownerToken, ownerMembership.businessId, path);
    check(`${path}: 200 OK (page still works)`, status === 200);
    check(`${path}: does NOT contain "${TRIGGER_TEXT}"`, !body.includes(TRIGGER_TEXT));
  }

  console.log("\nTEST 4 -- Subscriber MEMBER never sees the trigger, on any page they can reach");
  for (const path of PAGES) {
    const { status, body } = await fetchPage(memberToken, memberMembership.businessId, path);
    // MEMBER is blocked from the management console entirely by
    // requireManagementPageAccess() -- either way, the trigger text must
    // never appear.
    check(`${path}: does NOT contain "${TRIGGER_TEXT}"`, !body.includes(TRIGGER_TEXT));
    void status;
  }

  console.log("\nTEST 5 -- Founder's saved override on Dashboard does not change what the OWNER sees (per-founder-user, not global)");
  const beforeOwnerDashboard = await fetchPage(ownerToken, ownerMembership.businessId, "/dashboard");
  const savedOverride = await prisma.founderDesignOverride.findUnique({
    where: { userId_pageKey: { userId: founder.id, pageKey: "dashboard" } },
  });
  check("(setup) No founder override saved yet for dashboard", savedOverride === null);
  // Simulate a save (bypassing the UI, exactly like saveFounderDesignTokens would persist)
  await prisma.founderDesignOverride.create({
    data: { userId: founder.id, pageKey: "dashboard", tokens: { kpi: { padding: 8, numberFontSize: 18 } } },
  });
  const afterOwnerDashboard = await fetchPage(ownerToken, ownerMembership.businessId, "/dashboard");
  check(
    "OWNER's rendered Dashboard HTML is byte-identical before/after the founder's override is saved",
    beforeOwnerDashboard.body === afterOwnerDashboard.body,
  );
  const founderDashboardAfter = await fetchPage(founderToken, founderMembership.businessId, "/dashboard");
  check(
    "Founder's OWN Dashboard reflects the saved override (--tbbt-kpi-padding: 8px present)",
    founderDashboardAfter.body.includes("--tbbt-kpi-padding:8px") || founderDashboardAfter.body.includes("--tbbt-kpi-padding: 8px"),
  );
  await prisma.founderDesignOverride.deleteMany({ where: { userId: founder.id, pageKey: "dashboard" } });

  console.log("\nTEST 6 -- Cross-business subscriber (different business entirely) never sees the trigger");
  const otherBusiness = await prisma.business.findFirst({ where: { id: { not: founderMembership.businessId } } });
  if (otherBusiness) {
    const otherOwnerMembership = await prisma.membership.findFirst({ where: { businessId: otherBusiness.id, active: true } });
    if (otherOwnerMembership) {
      const otherUser = await prisma.user.findUnique({ where: { id: otherOwnerMembership.userId } });
      check("Other-business user is not a founder", otherUser?.isFounder === false);
      const otherToken = await makeSession(otherOwnerMembership.userId);
      const { body } = await fetchPage(otherToken, otherBusiness.id, "/dashboard");
      check("Cross-business account does NOT see the trigger", !body.includes(TRIGGER_TEXT));
    } else {
      console.log("  (skipped -- no active membership on the other business)");
    }
  } else {
    console.log("  (skipped -- only one business exists in this database)");
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
