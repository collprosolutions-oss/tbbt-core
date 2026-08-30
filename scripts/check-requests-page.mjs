/**
 * Requests page layout verification: Schedule & Calendar sits under the
 * Request Table (same main-list width), not in a narrow third column.
 * Request Details stay beside the table. Today / Quick Actions stay in
 * the supporting column. Request/scheduling calculations are unchanged.
 *
 * Static checks always run. HTTP checks run when APP_URL is reachable.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-requests-page.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");
const { KPI_CARD_COUNTS, PAGE_HAS_PANEL, PANEL_WIDTH_DEFAULTS } = await import("@/lib/founder-design");

const APP_URL = process.env.APP_URL ?? "http://localhost:43217";

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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const pageSrc = readRepo("src/app/(app)/requests/page.tsx");
const workspaceSrc = readRepo("src/components/requests/requests-workspace.tsx");

const workspaceUse = pageSrc.indexOf("<RequestsWorkspace");
const calendarOpen = pageSrc.indexOf('<FounderRegion id="calendar">');
const todayOpen = pageSrc.indexOf('<FounderRegion id="today">');
const actionsOpen = pageSrc.indexOf('<FounderRegion id="actions">');
const oldThirdColumn = pageSrc.includes("xl:grid-cols-[minmax(0,1fr)_250px]");
const calendarRow = pageSrc.indexOf(
  "lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,280px)]",
);

console.log("\nSTATIC — Schedule & Calendar is under the Request Table, not a third column");
check("RequestsWorkspace is still the table + details primary row", workspaceUse >= 0);
check("Schedule & Calendar region exists", calendarOpen >= 0);
check("Today region exists", todayOpen >= 0);
check("Quick Actions region exists", actionsOpen >= 0);
check(
  "The old 250px third-column wrapper is gone",
  !oldThirdColumn,
);
check(
  "Calendar row uses the same main-list + details column template as the table",
  calendarRow >= 0,
);
check(
  "Schedule & Calendar is rendered AFTER the Request Table workspace",
  workspaceUse >= 0 && calendarOpen > workspaceUse,
);
check(
  "Today stays after the calendar (supporting column, not a third calendar column)",
  todayOpen > calendarOpen,
);
check(
  "Quick Actions stay after Today",
  actionsOpen > todayOpen,
);
check(
  "Request Table + Request Details remain side-by-side in the workspace",
  workspaceSrc.includes('lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,280px)]') &&
    workspaceSrc.includes('<FounderRegion id="table">') &&
    workspaceSrc.includes('<FounderRegion id="details"'),
);
check(
  "Request Details are still a desktop panel, not moved under the table",
  workspaceSrc.includes('id="details" className="hidden lg:block"'),
);
check(
  "Mobile Request Details remain a bottom sheet",
  workspaceSrc.includes('SheetContent side="bottom"') &&
    workspaceSrc.includes("lg:hidden"),
);

console.log("\nSTATIC — Existing Requests / schedule behavior is unchanged");
check("Page title is still Requests / New Leads", pageSrc.includes('const PAGE_TITLE = "Requests / New Leads"'));
check("Search form is unchanged", pageSrc.includes('placeholder="Search requests..."'));
check("Service filter is unchanged", pageSrc.includes("ServiceFilterSelect"));
check("Status tabs are still new / estimate-sent / converted", pageSrc.includes('const TAB_KEYS = ["new", "estimate-sent", "converted"]'));
check("MonthView is the existing schedule month view", pageSrc.includes("<MonthView"));
check("Calendar still uses monthGridRange / groupJobsByDay / findScheduleConflicts",
  pageSrc.includes("monthGridRange") &&
    pageSrc.includes("groupJobsByDay") &&
    pageSrc.includes("findScheduleConflicts"));
check("Today still lists today's jobs and links to /jobs",
  pageSrc.includes("todayJobs") && pageSrc.includes('href="/jobs"'));
check("Quick Actions still link to estimates/new, estimates, and jobs",
  pageSrc.includes('href="/estimates/new"') &&
    pageSrc.includes('href="/estimates"') &&
    pageSrc.includes('href="/jobs"'));
check("Open estimate action is unchanged", workspaceSrc.includes("Open estimate"));
check("Row selection still only updates local client state",
  workspaceSrc.includes("setSelectedId") &&
    workspaceSrc.includes("selecting a row only changes local"));

console.log("\nSTATIC — Founder Design Mode regions are preserved");
check("Requests still has 4 KPI cards", KPI_CARD_COUNTS.requests === 4);
check("Requests still has a tunable details panel", PAGE_HAS_PANEL.requests === true);
check("Requests details default width is still 280px", PANEL_WIDTH_DEFAULTS.requests === 280);
check(
  "Requests region ids are unchanged",
  FOUNDER_REGIONS.requests.map((region) => region.id).join(",") ===
    "kpi,tabs,table,details,calendar,today,actions,page",
);
check(
  "Schedule & Calendar is still a real Requests region",
  FOUNDER_REGIONS.requests.some((region) => region.id === "calendar" && region.label === "Schedule & Calendar"),
);

async function fetchMaybe(path, cookie) {
  try {
    const res = await fetch(`${APP_URL}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body };
  } catch {
    return null;
  }
}

const reachable = await fetchMaybe("/sign-in");
if (!reachable) {
  console.log("\nHTTP — skipped (APP_URL is not reachable)");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

const { prisma } = await import("@/lib/prisma");

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function makeSession(userId) {
  const token = randomUUID();
  const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: farFuture },
  });
  return token;
}

function cookieHeader(token, businessId) {
  return `tbbt_session=${token}; tbbt_workspace=${businessId ?? ""}`;
}

console.log(`\nHTTP — Requests page against ${APP_URL}`);
const owner = await prisma.user.findUnique({ where: { email: "owner@collpro-test.example" } });
const member = await prisma.user.findUnique({ where: { email: "john@collpro-test.example" } });
const founder = await prisma.user.findUnique({ where: { email: "founder@tbbt.dev" } });

if (!owner) {
  console.log("  (skipped HTTP role checks — expected test owner is missing)");
} else {
  const ownerMembership = await prisma.membership.findFirst({
    where: { userId: owner.id, active: true },
  });
  const ownerToken = await makeSession(owner.id);
  const ownerPage = await fetchMaybe("/requests", cookieHeader(ownerToken, ownerMembership?.businessId));

  check("OWNER Requests page returns 200", ownerPage?.status === 200);
  const body = ownerPage?.body ?? "";
  check("OWNER page still says Requests / New Leads", body.includes("Requests / New Leads"));
  check("OWNER page still says Schedule & Calendar", body.includes("Schedule") && body.includes("Calendar"));
  check("OWNER page still says Today", body.includes("Today"));
  check("OWNER page still says Quick actions", body.includes("Quick actions"));
  check(
    "Rendered request heading appears before Schedule & Calendar",
    body.indexOf("Requests / New Leads") >= 0 &&
      body.indexOf("Schedule") > body.indexOf("Requests / New Leads"),
  );
  check("OWNER without founder flag does not see Founder Design Mode", !body.includes("Founder Design Mode"));

  if (member) {
    const memberMembership = await prisma.membership.findFirst({
      where: { userId: member.id, active: true },
    });
    const memberToken = await makeSession(member.id);
    const memberPage = await fetchMaybe("/requests", cookieHeader(memberToken, memberMembership?.businessId));
    check(
      "MEMBER is redirected away from Requests (management console)",
      memberPage != null && memberPage.status >= 300 && memberPage.status < 400,
    );
  }

  if (founder) {
    const founderMembership = await prisma.membership.findFirst({
      where: { userId: founder.id, active: true },
    });
    const founderToken = await makeSession(founder.id);
    const founderPage = await fetchMaybe("/requests", cookieHeader(founderToken, founderMembership?.businessId));
    check("Founder Requests page returns 200", founderPage?.status === 200);
    check("Founder sees Founder Design Mode on Requests", Boolean(founderPage?.body.includes("Founder Design Mode")));
    const listed = founderPage?.body.match(/data-founder-regions="([^"]+)"/)?.[1] ?? "";
    check(
      "Founder region list is unchanged (calendar is still a real Requests region)",
      listed === "kpi,tabs,table,details,calendar,today,actions,page",
    );
  }
}

await prisma.$disconnect().catch(() => {});
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
