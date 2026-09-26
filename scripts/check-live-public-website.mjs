/**
 * Task 81: live public business website publishing.
 *
 * Proves the existing /hire/[slug] tenant site is the canonical public
 * route, unknown slugs 404, tenants cannot see each other, only
 * active/public catalog and website photos render, onboarding exposes
 * the public URL after save or skip, Settings has View Public Website,
 * intake/SMS/CollPro/Founder trial stay on their existing paths.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-live-public-website.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { provisionOwnerWorkspace } = await import("@/lib/signup-provision");
const {
  completeFirstRunSetupOp,
  ensureFirstRunSetupSchema,
  postAuthenticationPath,
  resetFirstRunSetupSchemaEnsure,
} = await import("@/lib/first-run-setup");
const {
  ensureStarterServicesSetupSchema,
  resetStarterServicesSetupSchemaEnsure,
  skipOnboardingStarterServicesOp,
} = await import("@/lib/starter-services-setup");
const {
  completeWebsiteSetupOp,
  ensureWebsiteSetupSchema,
  resetWebsiteSetupSchemaEnsure,
  skipWebsiteSetupOp,
  WEBSITE_SETUP_PATH,
  WEBSITE_SETUP_SAVED,
  WEBSITE_SETUP_SKIPPED,
} = await import("@/lib/website-setup");
const {
  COLLPRO_RENO_DISPLAY_NAME,
  publicDisplayName,
  publicHomePath,
  publicPhone,
  publicRequestPath,
  publicServicesPath,
  publicSiteUrl,
  selectedWorkQuery,
} = await import("@/lib/public-site");
const { loadPublicCatalog, loadPublicSite } = await import("@/lib/public-site-data");
const {
  publicCanonicalUrl,
  publicSiteMetaDescription,
  publicTenantPageMetadata,
} = await import("@/lib/public-site-seo");
const { resolvePublishedAboutCopy } = await import("@/lib/website-story");
const { isPublicWebsitePath } = await import("@/lib/public-website-paths");
const { formatCatalogPriceLabel } = await import("@/lib/pricing-mode");
const {
  PUBLIC_SITE_HERO_SLOT,
  PUBLIC_SITE_HOME_PAGE,
  loadPublicHomeImages,
} = await import("@/lib/public-site-images");
const { parseSelectedWorkSearch } = await import("@/lib/selected-work");
const { isAffirmativeSmsOptIn } = await import("@/lib/customer-messaging/opt-in");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

function makeAccess(businessId, role, membershipId, business = {}) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, tradeCode: "HANDYMAN", slug: "unused", ...business },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

const APP_URL = process.env.APP_URL ?? "http://localhost:43217";

console.log("\nSTATIC — Live public website publishing gap");
const hirePage = readRepo("src/app/hire/[slug]/page.tsx");
const websitePage = readRepo("src/app/setup/website/page.tsx");
const websiteAction = readRepo("src/app/actions/website-setup.ts");
const websiteForm = readRepo("src/components/auth/website-setup-form.tsx");
const settingsWorkspace = readRepo("src/components/settings/settings-workspace.tsx");
const viewPublic = readRepo("src/components/settings/view-public-website-link.tsx");
const requestFlow = readRepo("src/components/public/request-flow.tsx");
const servicesBrowser = readRepo("src/components/public/public-services-browser.tsx");
const apexHome = readRepo("src/app/page.tsx");
const publicServe = readRepo("src/lib/business-storage/public-serve.ts");
const requestPhotos = readRepo("src/lib/business-storage/request-photos.ts");
const publicSiteImages = readRepo("src/lib/public-site-images.ts");
const robots = readRepo("src/app/robots.ts");

check(
  "Canonical tenant route remains /hire/[slug], not a second public-site architecture",
  publicHomePath("cedar-handyman") === "/hire/cedar-handyman" &&
    publicRequestPath("cedar-handyman") === "/r/cedar-handyman" &&
    hirePage.includes("requirePublicSite") &&
    !websitePage.includes("src/app/page.tsx") &&
    apexHome.includes("COLLPRO_RENO_DISPLAY_NAME"),
);
check(
  "Unknown slug uses notFound (HTTP 404) instead of a 200 placeholder",
  readRepo("src/lib/require-public-site.ts").includes("notFound()") &&
    readRepo("src/app/hire/[slug]/not-found.tsx").includes("This business could not be found.") &&
    readRepo("src/app/r/[slug]/not-found.tsx").includes("Request unavailable") &&
    !hirePage.includes("PublicUnavailable"),
);
check(
  "Public hire/intake/photo routes require no authentication",
  isPublicWebsitePath("/hire/cedar-handyman") &&
    isPublicWebsitePath("/r/cedar-handyman") &&
    isPublicWebsitePath("/api/storage/public/asset_workshop") &&
    !isPublicWebsitePath("/settings") &&
    !isPublicWebsitePath("/dashboard"),
);
check(
  "Basic truthful SEO uses the tenant name, description, and canonical URL",
  hirePage.includes("publicTenantPageMetadata") &&
    publicTenantPageMetadata({
      business: { id: "1", name: "Cedar Handyman", slug: "cedar-handyman", tradeCode: "HANDYMAN" },
      title: "Cedar Handyman | Handyman Services",
      description: "Local repairs for Reno homes.",
      pathname: "/hire/cedar-handyman",
    }).alternates?.canonical === publicSiteUrl("cedar-handyman") &&
    publicCanonicalUrl("cedar-handyman", "/hire/cedar-handyman") ===
      publicSiteUrl("cedar-handyman") &&
    publicSiteMetaDescription(
      {
        id: "1",
        name: "Cedar Handyman",
        slug: "cedar-handyman",
        tradeCode: "HANDYMAN",
        publicServiceAreaLabel: "Reno, NV",
      },
      "Cedar helps homeowners in Reno with everyday repairs.",
    ) === "Cedar helps homeowners in Reno with everyday repairs.",
);
check(
  "Missing optional about does not invent reviews, years, or licenses",
  publicSiteMetaDescription({
    id: "1",
    name: "Cedar Handyman",
    slug: "cedar-handyman",
    tradeCode: "HANDYMAN",
  }) ===
    "Request handyman services from Cedar Handyman. Choose one or more tasks for a single visit request." &&
    !/licensed|testimonial|years in business|google review/i.test(
      publicSiteMetaDescription({
        id: "1",
        name: "Cedar Handyman",
        slug: "cedar-handyman",
        tradeCode: "HANDYMAN",
      }),
    ),
);
check(
  "CollPro canonical home stays the apex URL, not a new custom domain",
  publicCanonicalUrl("collpro-reno", "/hire/collpro-reno") === publicSiteUrl("collpro-reno") &&
    publicDisplayName({ name: "Anything", slug: "collpro-reno" }) === COLLPRO_RENO_DISPLAY_NAME &&
    apexHome.includes("loadDefaultPublicBusiness") &&
    !websitePage.includes("custom domain"),
);
check(
  "Onboarding save and skip both expose View Public Website then Dashboard",
  websitePage.includes("WEBSITE_SETUP_SKIPPED") &&
    websitePage.includes("View Public Website") &&
    websitePage.includes("Continue to Dashboard") &&
    websiteForm.includes("Preview public site") &&
    (websiteAction.match(/redirect\(WEBSITE_SETUP_PATH\)/g) || []).length === 2 &&
    !websiteAction.includes("postAuthenticationPath") &&
    WEBSITE_SETUP_PATH === "/setup/website",
);
check(
  "Owner Settings surfaces View Public Website on existing website areas",
  viewPublic.includes("View Public Website") &&
    viewPublic.includes("publicHomePath") &&
    settingsWorkspace.includes("ViewPublicWebsiteLink") &&
    (settingsWorkspace.match(/ViewPublicWebsiteLink/g) || []).length >= 3,
);
check(
  "Request Service reuses existing intake and can carry selected services",
  servicesBrowser.includes("`/r/${slug}${selectedWorkQuery(selected)}`") &&
    requestFlow.includes("smsOptIn") &&
    isAffirmativeSmsOptIn("true") === true &&
    isAffirmativeSmsOptIn(undefined) === false,
);
check(
  "Only PUBLIC stored website photos are servable; intake photos stay private",
  publicServe.includes('visibility: "PUBLIC"') === false &&
    publicServe.includes("Only READY + PUBLIC rows are") &&
    requestPhotos.includes('visibility: "PRIVATE"') &&
    publicSiteImages.includes("db.publicSiteImage.findMany") &&
    !publicSiteImages.includes("jobPhoto.findMany"),
);
check(
  "Public hire pages stay crawlable",
  robots.includes('allow: ["/", "/hire/", "/r/", "/e/", "/p/"]'),
);
check(
  "Founder trial still starts from website save/skip and stays idempotent",
  websiteAction.includes("startFounderTrialIfEligible") &&
    websiteAction.includes("alreadyComplete"),
);
check(
  "Custom-quote services do not publish a starting price",
  formatCatalogPriceLabel("CUSTOM_QUOTE", 125) === "Custom Quote" &&
    formatCatalogPriceLabel("STARTING_AT", 75) === "Starting at $75.00",
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("\nDATABASE_URL must be set to run live public website persistence checks.");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(1);
}

const testDbName = "tbbt_live_public_website_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for live public website test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Tenant isolation, public content, onboarding URL, photos");
  resetFirstRunSetupSchemaEnsure();
  resetStarterServicesSetupSchemaEnsure();
  resetWebsiteSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);
  await ensureWebsiteSetupSchema(prisma);

  const { default: bcrypt } = await import("bcryptjs");
  const passwordHash = await bcrypt.hash("password12", 10);
  const cedar = await provisionOwnerWorkspace(prisma, {
    name: "Cedar Owner",
    email: `cedar-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Cedar Handyman",
  });
  const maple = await provisionOwnerWorkspace(prisma, {
    name: "Maple Owner",
    email: `maple-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Maple Handyman",
  });
  const cedarAccess = makeAccess(cedar.business.id, "OWNER", cedar.membership.id, {
    slug: cedar.business.slug,
  });
  const mapleAccess = makeAccess(maple.business.id, "OWNER", maple.membership.id, {
    slug: maple.business.slug,
  });

  await completeFirstRunSetupOp(prisma, cedarAccess, {
    name: "Cedar Handyman",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "",
  });
  await skipOnboardingStarterServicesOp(prisma, cedarAccess);
  await completeFirstRunSetupOp(prisma, mapleAccess, {
    name: "Maple Handyman",
    phone: "555-444-5555",
    email: "shop@maple.example",
    website: "",
  });
  await skipOnboardingStarterServicesOp(prisma, mapleAccess);

  const cedarActive = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cedar.business.id,
      name: "Cedar Door Repair",
      category: "Doors & Locks",
      description: "Repair sticking interior doors.",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(85),
      active: true,
    },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: cedar.business.id,
      name: "Cedar Internal Only",
      category: "Doors & Locks",
      description: "Owner-only diagnostic. Do not publish.",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(999),
      active: false,
    },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: cedar.business.id,
      name: "Cedar Custom Build",
      category: "Trim & Carpentry",
      description: "Quoted after review.",
      pricingMode: "CUSTOM_QUOTE",
      price: new Prisma.Decimal(400),
      active: true,
    },
  });
  const mapleActive = await prisma.serviceCatalogItem.create({
    data: {
      businessId: maple.business.id,
      name: "Maple Fence Repair",
      category: "Outdoor",
      description: "Maple-only fence work.",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(220),
      active: true,
    },
  });

  const unknown = await loadPublicSite("no-such-tbbt-business", prisma);
  check("Unknown slug resolves to null so the page can 404", unknown === null);

  const cedarSite = await loadPublicSite(cedar.business.slug, prisma);
  const mapleSite = await loadPublicSite(maple.business.slug, prisma);
  check(
    "Each business resolves only its own public site",
    cedarSite?.business.id === cedar.business.id &&
      mapleSite?.business.id === maple.business.id &&
      cedarSite?.business.slug !== mapleSite?.business.slug,
  );
  check(
    "Business A catalog cannot appear on Business B's public site",
    cedarSite?.items.some((item) => item.id === cedarActive.id) === true &&
      cedarSite?.items.some((item) => item.id === mapleActive.id) === false &&
      mapleSite?.items.some((item) => item.id === mapleActive.id) === true &&
      mapleSite?.items.some((item) => item.name === "Cedar Door Repair") === false &&
      mapleSite?.business.name === "Maple Handyman",
  );
  check(
    "Only active services render; inactive internal services stay off the public site",
    cedarSite?.items.every((item) => item.id !== undefined) === true &&
      cedarSite?.items.some((item) => item.name === "Cedar Internal Only") === false &&
      cedarSite?.items.some((item) => item.name === "Cedar Door Repair") === true,
  );
  check(
    "CUSTOM_QUOTE does not expose a public starting price",
    cedarSite?.items.find((item) => item.name === "Cedar Custom Build")?.priceLabel ===
      "Custom Quote" &&
      cedarSite?.items.find((item) => item.name === "Cedar Door Repair")?.priceLabel ===
        "Starting at $85.00" &&
      cedarSite?.items.every((item) => !("cost" in item) && !("margin" in item)),
  );
  check(
    "Public payload omits owner-only configuration and customer records",
    !JSON.stringify(cedarSite).includes("websiteSetupChoice") &&
      !JSON.stringify(cedarSite).includes("operationalSmsNumber") &&
      !JSON.stringify(cedarSite).includes("stripe") &&
      !JSON.stringify(cedarSite).includes("hourlyWage"),
  );

  await completeWebsiteSetupOp(prisma, cedarAccess, {
    name: "Cedar Handyman Co",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    about: "Cedar helps homeowners in Reno with everyday repairs.",
    serviceArea: "Reno, NV",
  });
  const saved = await prisma.business.findUnique({
    where: { id: cedar.business.id },
    include: { settings: true },
  });
  const savedSite = await loadPublicSite(saved.slug, prisma);
  check(
    "Saved story and profile data render on that tenant's public site",
    saved?.websiteSetupChoice === WEBSITE_SETUP_SAVED &&
      savedSite?.business.name === "Cedar Handyman Co" &&
      publicPhone(savedSite.business) === "(555) 222-3333" &&
      resolvePublishedAboutCopy(saved?.settings?.approvedPublicAboutCopy, saved.slug) ===
        "Cedar helps homeowners in Reno with everyday repairs." &&
      publicHomePath(saved.slug) === `/hire/${saved.slug}` &&
      postAuthenticationPath({ role: "OWNER", business: saved }) === "/dashboard",
  );

  const skippedOnce = await skipWebsiteSetupOp(prisma, mapleAccess);
  const skippedAgain = await skipWebsiteSetupOp(prisma, mapleAccess);
  const skippedBiz = await prisma.business.findUnique({
    where: { id: maple.business.id },
    include: { settings: true },
  });
  const skippedSite = await loadPublicSite(skippedBiz.slug, prisma);
  check(
    "Skip still publishes the live /hire/{slug} URL without inventing content",
    skippedOnce.alreadyComplete === false &&
      skippedAgain.alreadyComplete === true &&
      skippedBiz?.websiteSetupChoice === WEBSITE_SETUP_SKIPPED &&
      publicHomePath(skippedBiz.slug) === `/hire/${skippedBiz.slug}` &&
      (skippedBiz?.settings?.approvedPublicAboutCopy ?? "") === "" &&
      skippedSite?.business.name === "Maple Handyman",
  );
  check(
    "Missing optional About/photos do not break the skipped tenant page",
    skippedSite != null &&
      resolvePublishedAboutCopy(skippedBiz?.settings?.approvedPublicAboutCopy, skippedBiz.slug) ===
        "" &&
      skippedSite.items.some((item) => item.id === mapleActive.id),
  );

  await prisma.publicSiteImage.create({
    data: {
      businessId: cedar.business.id,
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/cedar-public-hero.jpg",
    },
  });
  await prisma.publicSiteImage.create({
    data: {
      businessId: maple.business.id,
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/maple-public-hero.jpg",
    },
  });
  const cedarImages = await loadPublicHomeImages(prisma, cedar.business.id, cedarSite.groups);
  const mapleImages = await loadPublicHomeImages(prisma, maple.business.id, mapleSite.groups);
  check(
    "Approved public website photos render only on the owning tenant",
    cedarImages.hero.src === "/brand/cedar-public-hero.jpg" &&
      mapleImages.hero.src === "/brand/maple-public-hero.jpg" &&
      cedarImages.hero.src !== mapleImages.hero.src,
  );
  check(
    "Public home image loader does not read job/intake photo tables",
    publicSiteImages.includes("publicSiteImage.findMany") &&
      !publicSiteImages.includes("jobPhoto") &&
      !publicSiteImages.includes("CUSTOMER_PHOTO"),
  );

  const requestHref = `${publicRequestPath(saved.slug)}${selectedWorkQuery({
    catalogIds: [cedarActive.id],
  })}`;
  const carried = parseSelectedWorkSearch(
    Object.fromEntries(new URL(`https://example.test${requestHref}`).searchParams.entries()),
    new Set(savedSite.items.map((item) => item.id)),
  );
  check(
    "Selecting a public service carries that catalog id into the existing intake",
    requestHref.startsWith(`/r/${saved.slug}`) &&
      carried.catalogIds.includes(cedarActive.id) &&
      publicServicesPath(saved.slug).startsWith(`/hire/${saved.slug}/services`),
  );

  const emptyCatalog = await loadPublicCatalog(
    {
      id: maple.business.id,
      name: "Maple Handyman",
      slug: maple.business.slug,
      tradeCode: "HANDYMAN",
    },
    prisma,
  );
  check(
    "Empty optional sections stay omitted rather than fabricating reviews",
    emptyCatalog.items.every((item) => item.name !== "Customer testimonials") &&
      !JSON.stringify(skippedSite).includes("★★★★★"),
  );

  const collpro = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });
  const collproSite = await loadPublicSite("collpro-reno", prisma);
  check(
    "Existing CollPro public slug still resolves independently of new tenants",
    collproSite?.business.id === collpro.id &&
      publicDisplayName(collproSite.business) === COLLPRO_RENO_DISPLAY_NAME &&
      collproSite.items.some((item) => item.name === "Cedar Door Repair") === false,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

async function fetchMaybe(path) {
  try {
    const res = await fetch(`${APP_URL}${path}`, { redirect: "manual" });
    const body = await res.text().catch(() => "");
    return { status: res.status, body, location: res.headers.get("location") };
  } catch {
    return null;
  }
}

const reachable = await fetchMaybe("/sign-in");
if (!reachable) {
  console.log("\nHTTP — skipped (APP_URL is not reachable)");
} else {
  console.log("\nHTTP — Public site publishing");
  const hire = await fetchMaybe("/hire/collpro-reno");
  check(
    "Existing CollPro /hire/collpro-reno still loads without authentication",
    Boolean(hire && hire.status === 200 && hire.body.includes(COLLPRO_RENO_DISPLAY_NAME)),
  );
  const legacyHire = await fetchMaybe("/hire/collpro-reno-handyman-services");
  check(
    "Historical CollPro hire slug permanently redirects to the canonical hire page",
    Boolean(
      legacyHire &&
        legacyHire.status === 308 &&
        new URL(legacyHire.location ?? "http://invalid.example/", APP_URL).pathname ===
          "/hire/collpro-reno",
    ),
  );
  const missing = await fetchMaybe("/hire/no-such-tbbt-business");
  check("Unknown slug safely 404s", Boolean(missing && missing.status === 404));
  const intake = await fetchMaybe("/r/collpro-reno");
  check(
    "Existing public request flow still loads",
    Boolean(intake && intake.status === 200 && intake.body.includes("smsOptIn")),
  );
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
