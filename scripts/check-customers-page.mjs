/**
 * Customers page layout verification: Customer Overview is the top
 * summary strip (not a right-rail widget). Calculations, search, create,
 * filters, export, pagination, and Founder Design region ids stay the
 * same — this check only locks the relocated layout.
 *
 * Static checks always run. HTTP checks run when APP_URL is reachable.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-customers-page.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { FOUNDER_REGIONS, defaultFounderRegionId } = await import("@/lib/founder-regions");
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

const pageSrc = readRepo("src/app/(app)/customers/page.tsx");
const founderRegionsSrc = readRepo("src/lib/founder-regions.ts");

const overviewOpen = pageSrc.indexOf('<FounderRegion id="overview">');
const tableOpen = pageSrc.indexOf('<FounderRegion id="table"');
const activityOpen = pageSrc.indexOf('<FounderRegion id="activity">');
const servicesOpen = pageSrc.indexOf('<FounderRegion id="services">');
const workspaceGrid = pageSrc.indexOf(
  'xl:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]',
);
const overviewAfterGrid = pageSrc.indexOf('<FounderRegion id="overview">', workspaceGrid);

console.log("\nSTATIC — Customer Overview is the top summary, not the right rail");
check("Customer Overview region exists", overviewOpen >= 0);
check("Customer Table region exists", tableOpen >= 0);
check("Recent Activity region exists", activityOpen >= 0);
check("Top Services region exists", servicesOpen >= 0);
check("Supporting rail still uses --tbbt-panel-width (default 300px)", workspaceGrid >= 0);
check(
  "Customer Overview is rendered BEFORE the table + rail workspace grid",
  overviewOpen >= 0 && workspaceGrid >= 0 && overviewOpen < workspaceGrid,
);
check(
  "Customer Overview is not repeated inside the supporting rail",
  overviewAfterGrid === -1,
);
check(
  "Customer Table sits in the workspace grid (after overview)",
  tableOpen > workspaceGrid && tableOpen > overviewOpen,
);
check(
  "Recent Activity stays in the supporting rail (after the workspace grid starts)",
  activityOpen > workspaceGrid,
);
check(
  "Top Services stays in the supporting rail (after Recent Activity)",
  servicesOpen > activityOpen && servicesOpen > workspaceGrid,
);
check(
  "Add New Customer remains in the supporting rail",
  pageSrc.indexOf('label="Add New Customer"') > workspaceGrid,
);
check(
  "Desktop overview KPIs are a 4-across row (grid-cols-2 lg:grid-cols-4)",
  pageSrc.includes('gridClassName="grid-cols-2 lg:grid-cols-4"'),
);
check(
  "Overview is no longer the old 2-column rail widget",
  !pageSrc.includes('gridClassName="grid-cols-2"') &&
    !pageSrc.includes('flexBreakpointClassName="sm:flex sm:flex-wrap"'),
);

console.log("\nSTATIC — Existing Customer Overview metrics and page actions are unchanged");
check(
  "Exactly the four existing overview KPIs, in the same order",
  pageSrc.includes('label: "Customers"') &&
    pageSrc.includes('label: "Jobs This Month"') &&
    pageSrc.includes('label: "Revenue This Month"') &&
    pageSrc.includes('label: "Avg Job Value"') &&
    pageSrc.indexOf('label: "Customers"') < pageSrc.indexOf('label: "Jobs This Month"') &&
    pageSrc.indexOf('label: "Jobs This Month"') < pageSrc.indexOf('label: "Revenue This Month"') &&
    pageSrc.indexOf('label: "Revenue This Month"') < pageSrc.indexOf('label: "Avg Job Value"'),
);
check("Jobs This Month still counts jobs scheduled in the current month", pageSrc.includes("jobsThisMonthCount"));
check("Revenue This Month still sums paid invoices this month", pageSrc.includes("revenueThisMonthAgg"));
check("Avg Job Value still uses paid-invoice average", pageSrc.includes("avgJobValueAgg"));
check("Total-customer count still uses access.scope", pageSrc.includes("prisma.customer.count({ where: access.scope })"));
check("Header search is still the real GET form", pageSrc.includes('placeholder="Search customers..."'));
check("New Customer header action is unchanged", pageSrc.includes('<NewCustomerForm label="New Customer" />'));
check("Service-area filter is unchanged", pageSrc.includes("AreaFilterSelect"));
check("CSV export is unchanged", pageSrc.includes("ExportCustomersButton"));
check("Pagination / page size are unchanged", pageSrc.includes("PageSizeSelect") && pageSrc.includes("Rows per page"));
check("Row status still comes from the latest linked record", pageSrc.includes("STATUS_CAPTIONS"));
check("Total spent still sums paid invoices", pageSrc.includes("invoice.paidAt"));
check("Balance still sums SENT invoices", pageSrc.includes('invoice.status === "SENT"'));

console.log("\nSTATIC — Founder Design Mode regions match the corrected layout");
check("Customers still has 4 KPI cards", KPI_CARD_COUNTS.customers === 4);
check("Customers still has a tunable supporting rail", PAGE_HAS_PANEL.customers === true);
check("Customers rail default width is still 300px", PANEL_WIDTH_DEFAULTS.customers === 300);
check(
  "Customers region order is overview, table, activity, services, rail, page",
  FOUNDER_REGIONS.customers.map((region) => region.id).join(",") ===
    "overview,table,activity,services,rail,page",
);
check("Default selected Customers region is Customer Overview", defaultFounderRegionId("customers") === "overview");
check(
  "Right Rail Width remains a width-only page control",
  FOUNDER_REGIONS.customers.find((region) => region.id === "rail")?.hasWidth === true &&
    FOUNDER_REGIONS.customers.find((region) => region.id === "overview")?.hasWidth !== true,
);
check(
  "Founder region registry still names the real Customers boxes",
  founderRegionsSrc.includes('label: "Customer Overview"') &&
    founderRegionsSrc.includes('label: "Right Rail Width"'),
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

console.log(`\nHTTP — Customers page against ${APP_URL}`);
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
  const ownerPage = await fetchMaybe("/customers", cookieHeader(ownerToken, ownerMembership?.businessId));

  check("OWNER Customers page returns 200", ownerPage?.status === 200);
  const body = ownerPage?.body ?? "";
  check("OWNER page still says Customers", body.includes("Customers"));
  check("OWNER page still says Customer Overview", body.includes("Customer Overview"));
  check("OWNER page still says Recent Activity", body.includes("Recent Activity"));
  check("OWNER page still says Top Services", body.includes("Top Services"));
  check(
    "Rendered Customer Overview appears before Recent Activity",
    body.indexOf("Customer Overview") >= 0 &&
      body.indexOf("Recent Activity") > body.indexOf("Customer Overview"),
  );
  check(
    "Rendered Customer Overview appears before the All Customers workspace tab",
    body.indexOf("Customer Overview") >= 0 &&
      body.indexOf("All Customers") > body.indexOf("Customer Overview"),
  );
  check("OWNER without founder flag does not see Founder Design Mode", !body.includes("Founder Design Mode"));

  if (member) {
    const memberMembership = await prisma.membership.findFirst({
      where: { userId: member.id, active: true },
    });
    const memberToken = await makeSession(member.id);
    const memberPage = await fetchMaybe("/customers", cookieHeader(memberToken, memberMembership?.businessId));
    check(
      "MEMBER is redirected away from Customers (management console)",
      memberPage != null && memberPage.status >= 300 && memberPage.status < 400,
    );
  }

  if (founder) {
    const founderMembership = await prisma.membership.findFirst({
      where: { userId: founder.id, active: true },
    });
    const founderToken = await makeSession(founder.id);
    const founderPage = await fetchMaybe("/customers", cookieHeader(founderToken, founderMembership?.businessId));
    check("Founder Customers page returns 200", founderPage?.status === 200);
    check("Founder sees Founder Design Mode on Customers", Boolean(founderPage?.body.includes("Founder Design Mode")));
    const listed = founderPage?.body.match(/data-founder-regions="([^"]+)"/)?.[1] ?? "";
    check(
      "Founder region list starts with overview, then table and supporting rail",
      listed === "overview,table,activity,services,rail,page",
    );
  }
}

await prisma.$disconnect().catch(() => {});
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
