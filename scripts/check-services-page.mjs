/**
 * Services page verification: real catalog metrics, persisted categories,
 * no fabricated website-publish or market-pricing UI, Founder Design Mode
 * wired to the actual Services regions, and OWNER/ADMIN vs MEMBER access.
 *
 * Static checks always run. HTTP checks run when APP_URL is reachable
 * (same pattern as scripts/check-founder-design-mode.mjs).
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-services-page.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  FOUNDER_PAGE_KEYS,
  KPI_CARD_COUNTS,
  PAGE_HAS_TABLE,
  PAGE_HAS_PANEL,
  sanitizeFounderPageTokens,
} = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");
const {
  groupServiceCatalogItemsByCategory,
} = await import("@/lib/service-catalog-category");
const {
  formatCatalogPriceLabel,
  pricingModeDescription,
  pricingModeLabel,
} = await import("@/lib/pricing-mode");

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

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

console.log("\nSTATIC — Founder Design Mode includes the real Services page");
check("FOUNDER_PAGE_KEYS includes services", FOUNDER_PAGE_KEYS.includes("services"));
check("Services has 4 real KPI cards", KPI_CARD_COUNTS.services === 4);
check("Services has no fabricated table tokens", PAGE_HAS_TABLE.services === false);
check("Services catalog width is a real panel", PAGE_HAS_PANEL.services === true);
check(
  "Services regions match the implemented boxes",
  FOUNDER_REGIONS.services.map((region) => region.id).join(",") ===
    "kpi,presentation,pricing,catalog,page",
);

const forged = sanitizeFounderPageTokens("services", {
  tableDensity: "compact",
  regions: {
    presentation: { paddingY: 8 },
    table: { paddingY: 8 },
    invented: { paddingY: 8 },
  },
});
check(
  "Services rejects table-density tokens (no table on this page)",
  forged.tableDensity === undefined,
);
check(
  "Services keeps the real presentation region and drops invented/table ids",
  forged.regions?.presentation?.paddingY === 8 &&
    forged.regions?.table === undefined &&
    forged.regions?.invented === undefined,
);

console.log("\nSTATIC — Pricing modes stay the three-mode framework");
check("FIXED customer wording", formatCatalogPriceLabel("FIXED", 150) === "Fixed $150.00");
check(
  "STARTING_AT customer wording",
  formatCatalogPriceLabel("STARTING_AT", 150) === "Starting at $150.00",
);
check(
  "CUSTOM_QUOTE customer wording",
  formatCatalogPriceLabel("CUSTOM_QUOTE", 150) === "Custom Quote",
);
check("FIXED label/description", pricingModeLabel("FIXED") === "Fixed" && pricingModeDescription("FIXED").includes("predictable"));
check(
  "STARTING_AT label/description",
  pricingModeLabel("STARTING_AT") === "Starting at" &&
    pricingModeDescription("STARTING_AT").includes("variable"),
);
check(
  "CUSTOM_QUOTE label/description",
  pricingModeLabel("CUSTOM_QUOTE") === "Custom Quote" &&
    pricingModeDescription("CUSTOM_QUOTE").includes("highly variable"),
);

console.log("\nSTATIC — Catalog grouping uses persisted category, not service name");
const grouped = groupServiceCatalogItemsByCategory(
  [
    { id: "1", name: "Ceiling Fan Replacement", category: "Custom Carpentry" },
    { id: "2", name: "Other Work", category: "Fans & Fixtures" },
  ],
  ["Fans & Fixtures", "Custom Carpentry"],
);
check(
  "Ceiling Fan Replacement stays in its persisted Custom Carpentry category",
  grouped[1]?.category === "Custom Carpentry" &&
    grouped[1]?.items[0]?.name === "Ceiling Fan Replacement",
);
check(
  "Name-similar services do not steal another item's persisted category",
  grouped[0]?.category === "Fans & Fixtures" && grouped[0]?.items[0]?.name === "Other Work",
);

console.log("\nSTATIC — Services UI source does not fabricate website publish or market data");
const pageSrc = readRepo("src/app/(app)/services/page.tsx");
const workspaceSrc = readRepo("src/components/services/services-workspace.tsx");
const presentationSrc = readRepo("src/components/services/service-presentation-panel.tsx");
const pricingSrc = readRepo("src/components/services/service-pricing-panel.tsx");
const catalogSrc = readRepo("src/components/services/service-catalog-panel.tsx");
const combined = [pageSrc, workspaceSrc, presentationSrc, pricingSrc, catalogSrc].join("\n");

check("Page title is Services", pageSrc.includes('title="Services"') && pageSrc.includes("<PageHeader"));
check("Page does not say Time Cards", !combined.includes("Time Cards"));
check("No Publish Changes action", !combined.includes("Publish Changes"));
check("No Show on website toggle", !combined.includes("Show on") && !combined.includes("Show on website"));
check("No fabricated local/state/national market ranges", !combined.includes("Fort Myers") && !combined.includes("National (United States)"));
check("No Refresh Market action", !combined.includes("Refresh Market"));
check("Website section is explicitly not connected", presentationSrc.includes("Website publishing is not connected yet"));
check("Market section is explicitly not connected", pricingSrc.includes("Market comparison") && pricingSrc.includes("not connected yet"));
check("Catalog search exists", catalogSrc.includes("Search services"));
check("Collapse All / Expand All exist", catalogSrc.includes("Collapse All") && catalogSrc.includes("Expand All"));
check("Add Service uses existing catalog form", workspaceSrc.includes("AddServiceSheet"));
check("Existing CatalogItemRow edit form is reused", pricingSrc.includes("CatalogItemRow"));
check("Labor minimum uses the business setting, not a hardcoded $120", !pricingSrc.includes("$120") && pricingSrc.includes("laborMinimum"));
check("Page header title is Services", pageSrc.includes("<PageHeader") && pageSrc.includes('title="Services"'));

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

console.log(`\nHTTP — Services page against ${APP_URL}`);
const owner = await prisma.user.findUnique({ where: { email: "owner@collpro-test.example" } });
const member = await prisma.user.findUnique({ where: { email: "john@collpro-test.example" } });
const founder = await prisma.user.findUnique({ where: { email: "founder@tbbt.dev" } });

if (!owner || !member) {
  console.log("  (skipped HTTP role checks — expected test users are missing)");
} else {
  const ownerMembership = await prisma.membership.findFirst({
    where: { userId: owner.id, active: true },
  });
  const memberMembership = await prisma.membership.findFirst({
    where: { userId: member.id, active: true },
  });
  const ownerToken = await makeSession(owner.id);
  const memberToken = await makeSession(member.id);
  const ownerPage = await fetchMaybe(
    "/services",
    cookieHeader(ownerToken, ownerMembership?.businessId),
  );
  const memberPage = await fetchMaybe(
    "/services",
    cookieHeader(memberToken, memberMembership?.businessId),
  );

  check("OWNER Services page returns 200", ownerPage?.status === 200);
  check("OWNER page contains Services heading", Boolean(ownerPage?.body.includes("Services")));
  check("OWNER page does not say Time Cards", !ownerPage?.body.includes("Time Cards"));
  check(
    "OWNER page does not contain a functional Publish Changes control",
    !ownerPage?.body.includes("Publish Changes"),
  );
  check(
    "OWNER page does not invent Fort Myers / national market ranges",
    !ownerPage?.body.includes("Fort Myers") && !ownerPage?.body.includes("$145"),
  );
  check(
    "OWNER page states website publishing is not connected",
    Boolean(ownerPage?.body.includes("Website publishing is not connected yet")),
  );
  check(
    "OWNER page states market comparison is not connected",
    Boolean(ownerPage?.body.includes("not connected yet")),
  );
  check(
    "OWNER without founder flag does not see Founder Design Mode",
    !ownerPage?.body.includes("Founder Design Mode"),
  );

  const ceilingFan = ownerMembership
    ? await prisma.serviceCatalogItem.findFirst({
        where: {
          businessId: ownerMembership.businessId,
          name: "Ceiling Fan Replacement",
        },
      })
    : null;
  if (ceilingFan) {
    check(
      "Ceiling Fan Replacement is still $150 starting labor when present",
      ceilingFan.pricingMode === "STARTING_AT" &&
        Number(ceilingFan.price?.toString()) === 150,
    );
    check(
      "OWNER page still renders Ceiling Fan Replacement",
      Boolean(ownerPage?.body.includes("Ceiling Fan Replacement")),
    );
  }

  check(
    "MEMBER is redirected away from Services (no catalog body)",
    memberPage != null &&
      memberPage.status >= 300 &&
      memberPage.status < 400 &&
      !memberPage.body.includes("Service Catalog"),
  );

  if (founder) {
    const founderMembership = await prisma.membership.findFirst({
      where: { userId: founder.id, active: true },
    });
    const founderToken = await makeSession(founder.id);
    const founderPage = await fetchMaybe(
      "/services",
      cookieHeader(founderToken, founderMembership?.businessId),
    );
    check("Founder Services page returns 200", founderPage?.status === 200);
    check(
      "Founder sees Founder Design Mode on Services",
      Boolean(founderPage?.body.includes("Founder Design Mode")),
    );
    const listed = founderPage?.body.match(/data-founder-regions="([^"]+)"/)?.[1] ?? "";
    check(
      "Founder region list is the real Services regions",
      listed === "kpi,presentation,pricing,catalog,page",
    );
  }
}

await prisma.$disconnect().catch(() => {});
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
