/**
 * Task 3: Public website onboarding for the existing /hire/[slug] site.
 *
 * Proves starter-complete OWNERs continue to website setup, About/service
 * area persist on the correct Business, skip does not invent content,
 * completion is explicit, preview uses /hire/{slug}, new tenants do not
 * inherit CollPro identity, existing/CollPro tenants are not trapped, and
 * MEMBER/ADMIN are not routed through OWNER onboarding.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-website-setup.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  completeFirstRunSetupOp,
  ensureFirstRunSetupSchema,
  ownerNeedsFirstRunSetup,
  postAuthenticationPath,
  resetFirstRunSetupSchemaEnsure,
} = await import("@/lib/first-run-setup");
const { provisionOwnerWorkspace } = await import("@/lib/signup-provision");
const { ForbiddenError } = await import("@/lib/authorization");
const { parsePublicServiceAreaLabel } = await import("@/lib/business-contact");
const {
  COLLPRO_RENO_DISPLAY_NAME,
  COLLPRO_RENO_PHONE,
  DEFAULT_PUBLIC_ABOUT_STORY,
  GENERIC_SERVICE_AREA_COPY,
  SERVICE_AREA_COPY,
  publicDisplayName,
  publicHomePath,
  publicLogoSrc,
  publicPhone,
  resolveHowItWorksSteps,
  resolvePublicServiceAreaCopy,
} = await import("@/lib/public-site");
const { resolvePublishedAboutCopy } = await import("@/lib/website-story");
const { resolveBusinessServiceArea } = await import("@/lib/business-service-area");
const {
  ensureStarterServicesSetupSchema,
  ownerNeedsStarterServicesSetup,
  resetStarterServicesSetupSchemaEnsure,
  skipOnboardingStarterServicesOp,
  STARTER_SERVICES_SETUP_PATH,
} = await import("@/lib/starter-services-setup");
const {
  completeWebsiteSetupOp,
  ensureWebsiteSetupSchema,
  hasCompletedWebsiteSetup,
  ownerNeedsWebsiteSetup,
  resetWebsiteSetupSchemaEnsure,
  skipWebsiteSetupOp,
  WEBSITE_SETUP_ENSURE_SQL,
  WEBSITE_SETUP_PATH,
  WEBSITE_SETUP_SAVED,
  WEBSITE_SETUP_SKIPPED,
} = await import("@/lib/website-setup");

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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

console.log("\nSTATIC — Onboarding continues to website setup after Task 2");
const appLayout = readRepo("src/app/(app)/layout.tsx");
const fieldLayout = readRepo("src/app/field/layout.tsx");
const starterAction = readRepo("src/app/actions/starter-services-setup.ts");
const starterPage = readRepo("src/app/setup/services/page.tsx");
const websitePage = readRepo("src/app/setup/website/page.tsx");
const websiteForm = readRepo("src/components/auth/website-setup-form.tsx");
const websiteLib = readRepo("src/lib/website-setup.ts");
const apexHome = readRepo("src/app/page.tsx");
check(
  "Starter-services skip and continue use postAuthenticationPath so Task 3 is next",
  starterAction.includes("postAuthenticationPath") &&
    starterPage.includes("continueHref") &&
    WEBSITE_SETUP_PATH === "/setup/website" &&
    STARTER_SERVICES_SETUP_PATH === "/setup/services",
);
check(
  "Management console and Field send incomplete website-setup OWNERs to /setup/website",
  appLayout.includes("ownerNeedsWebsiteSetup") &&
    appLayout.includes("WEBSITE_SETUP_PATH") &&
    fieldLayout.includes("ownerNeedsWebsiteSetup"),
);
check(
  "Website setup collects About and service area, reuses name/phone/email, and previews /hire/{slug}",
  websiteForm.includes("approvedPublicAboutCopy") &&
    websiteForm.includes("publicServiceAreaLabel") &&
    websiteForm.includes("Preview public site") &&
    websitePage.includes("publicHomePath") &&
    !websitePage.includes("publicSiteUrl") &&
    websiteForm.includes("Skip for now"),
);
check(
  "Save and skip both land on the public-site handoff with View Public Website",
  websitePage.includes("WEBSITE_SETUP_SKIPPED") &&
    websitePage.includes("View Public Website") &&
    websitePage.includes("Continue to Dashboard") &&
    websitePage.includes("Public website ready") &&
    (readRepo("src/app/actions/website-setup.ts").match(/redirect\(WEBSITE_SETUP_PATH\)/g) || [])
      .length === 2 &&
    !readRepo("src/app/actions/website-setup.ts").includes("postAuthenticationPath"),
);
check(
  "Task 3 does not add custom domains, Stripe Billing, Cleaning, AI copy, or a site builder",
  !websitePage.includes("custom domain") &&
    !websiteForm.includes("subdomain") &&
    !websiteLib.includes("Stripe") &&
    !websitePage.includes("Cleaning") &&
    !websiteForm.includes("generateText") &&
    !websitePage.includes("drag-and-drop") &&
    !websitePage.includes("theme builder"),
);
check(
  "CollPro apex / remains the CollPro homepage, not the reusable tenant site",
  apexHome.includes("COLLPRO_RENO_DISPLAY_NAME") &&
    apexHome.includes("PublicHome") &&
    !websitePage.includes("src/app/page.tsx"),
);

console.log("\nUNIT — Explicit website completion, tenant identity, and routing");
check(
  "Starter-complete Handyman OWNER is routed to website setup",
  postAuthenticationPath({
    role: "OWNER",
    business: {
      slug: "new-handyman",
      tradeCode: "HANDYMAN",
      firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
      starterServicesSetupCompletedAt: new Date("2026-01-02T00:00:00Z"),
      websiteSetupCompletedAt: null,
    },
  }) === "/setup/website" &&
    ownerNeedsWebsiteSetup({
      role: "OWNER",
      business: { slug: "new-handyman", websiteSetupCompletedAt: null },
    }) === true,
);
check(
  "Task 1 → Task 2 → Task 3 ordering remains correct",
  postAuthenticationPath({
    role: "OWNER",
    business: { slug: "new-handyman", tradeCode: "HANDYMAN", firstRunSetupCompletedAt: null },
  }) === "/setup" &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
        starterServicesSetupCompletedAt: null,
      },
    }) === "/setup/services" &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
        starterServicesSetupCompletedAt: new Date("2026-01-02T00:00:00Z"),
        websiteSetupCompletedAt: null,
      },
    }) === "/setup/website" &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
        starterServicesSetupCompletedAt: new Date("2026-01-02T00:00:00Z"),
        websiteSetupCompletedAt: new Date("2026-01-03T00:00:00Z"),
      },
    }) === "/dashboard",
);
check(
  "About or service-area text does not complete website onboarding",
  ownerNeedsWebsiteSetup({
    role: "OWNER",
    business: { slug: "new-handyman", websiteSetupCompletedAt: null },
  }) === true &&
    hasCompletedWebsiteSetup({ slug: "new-handyman", websiteSetupCompletedAt: null }) === false,
);
check(
  "Saved or skipped timestamp completes the step",
  hasCompletedWebsiteSetup({
    slug: "new-handyman",
    websiteSetupCompletedAt: new Date("2026-01-03T00:00:00Z"),
    websiteSetupChoice: WEBSITE_SETUP_SKIPPED,
  }) === true &&
    ownerNeedsWebsiteSetup({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        websiteSetupCompletedAt: new Date("2026-01-03T00:00:00Z"),
        websiteSetupChoice: WEBSITE_SETUP_SAVED,
      },
    }) === false,
);
check(
  "Existing CollPro is not forced through website onboarding",
  hasCompletedWebsiteSetup({ slug: "collpro-reno", websiteSetupCompletedAt: null }) === true &&
    ownerNeedsWebsiteSetup({
      role: "OWNER",
      business: { slug: "collpro-reno", websiteSetupCompletedAt: null },
    }) === false &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "collpro-reno",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: null,
        starterServicesSetupCompletedAt: null,
        websiteSetupCompletedAt: null,
      },
    }) === "/dashboard",
);
check(
  "MEMBER and ADMIN cannot be forced into OWNER website onboarding",
  ownerNeedsWebsiteSetup({
    role: "MEMBER",
    business: { slug: "new-handyman", websiteSetupCompletedAt: null },
  }) === false &&
    ownerNeedsWebsiteSetup({
      role: "ADMIN",
      business: { slug: "new-handyman", websiteSetupCompletedAt: null },
    }) === false &&
    postAuthenticationPath({
      role: "MEMBER",
      business: { slug: "new-handyman", websiteSetupCompletedAt: null },
    }) === "/field" &&
    postAuthenticationPath({
      role: "ADMIN",
      business: { slug: "new-handyman", websiteSetupCompletedAt: null },
    }) === "/dashboard",
);
check(
  "Preview path is the existing /hire/{slug} route, not a custom domain",
  publicHomePath("cedar-handyman") === "/hire/cedar-handyman" &&
    !websiteForm.includes("custom domain") &&
    websitePage.includes("publicHomePath(workspace.business.slug)"),
);
check(
  "Stored service-area label publishes for that tenant only",
  resolvePublicServiceAreaCopy({
    slug: "cedar-handyman",
    publicServiceAreaLabel: "Reno, NV",
  }).includes("Reno, NV") &&
    !/Fort Myers|Cape Coral|Lee County|CollPro/.test(
      resolvePublicServiceAreaCopy({
        slug: "cedar-handyman",
        publicServiceAreaLabel: "Reno, NV",
      }),
    ) &&
    resolvePublicServiceAreaCopy("other-handyman") === GENERIC_SERVICE_AREA_COPY,
);
check(
  "CollPro service-area copy stays Fort Myers even if a label is present",
  resolvePublicServiceAreaCopy({
    slug: "collpro-reno",
    publicServiceAreaLabel: "Reno, NV",
  }) === SERVICE_AREA_COPY,
);
check(
  "New non-CollPro tenant displays none of CollPro's identity/content/defaults",
  publicDisplayName({ name: "Cedar Handyman", slug: "cedar-handyman" }) === "Cedar Handyman" &&
    publicDisplayName({ name: "Anything", slug: "collpro-reno" }) === COLLPRO_RENO_DISPLAY_NAME &&
    publicPhone("cedar-handyman") === null &&
    publicPhone("collpro-reno") === "(239) 357-8199" &&
    publicLogoSrc("cedar-handyman") === null &&
    resolvePublishedAboutCopy(null, "cedar-handyman") === "" &&
    resolvePublishedAboutCopy(null, "collpro-reno") === DEFAULT_PUBLIC_ABOUT_STORY &&
    resolveBusinessServiceArea({ slug: "cedar-handyman" }).cities.length === 0 &&
    !resolveHowItWorksSteps("cedar-handyman").some((step) => /CollPro Reno/.test(step.body)),
);
check(
  "Public site displays the new tenant's stored identity",
  publicDisplayName({ name: "Cedar Handyman", slug: "cedar-handyman" }) === "Cedar Handyman" &&
    publicPhone({ slug: "cedar-handyman", publicPhone: "555-222-3333" }) === "(555) 222-3333" &&
    resolvePublishedAboutCopy("Local repairs for Reno homes.", "cedar-handyman") ===
      "Local repairs for Reno homes.",
);
check(
  "Service-area parser stores a free-text label and rejects oversized input",
  parsePublicServiceAreaLabel("  Reno, NV  ") === "Reno, NV" &&
    parsePublicServiceAreaLabel(" ") === null,
);
try {
  parsePublicServiceAreaLabel("x".repeat(121));
  check("Oversized service-area label is rejected", false);
} catch (error) {
  check(
    "Oversized service-area label is rejected",
    error instanceof Error && /too long/i.test(error.message),
  );
}

const projectsGallery = readRepo("src/components/public/public-projects-gallery.tsx");
const hireProjects = readRepo("src/app/hire/[slug]/projects/page.tsx");
const publicAbout = readRepo("src/components/public/public-about.tsx");
check(
  "CollPro project photos stay CollPro-only on the hire projects page",
  hireProjects.includes("PublicProjectsGallery slug={site.business.slug}") &&
    projectsGallery.includes("isCollProRenoSlug") &&
    projectsGallery.includes("Project photos will appear here"),
);
check(
  "Empty About copy uses generic instructional text, not the CollPro story",
  publicAbout.includes("This business has not published an About story yet.") &&
    publicAbout.includes("Why Homeowners Choose CollPro Reno") &&
    publicAbout.includes("isCollProRenoSlug"),
);
check(
  "Migration and preview ensure share the one-shot backfill, not a repeating UPDATE",
  readRepo("prisma/migrations/20260915160000_add_website_setup/migration.sql").includes(
    "information_schema.columns",
  ) &&
    WEBSITE_SETUP_ENSURE_SQL.includes("information_schema.columns") &&
    WEBSITE_SETUP_ENSURE_SQL.includes('ADD COLUMN "websiteSetupCompletedAt"') &&
    (WEBSITE_SETUP_ENSURE_SQL.match(/UPDATE "Business"/g) || []).length === 1,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("\nDATABASE_URL must be set to run website setup persistence checks.");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(1);
}

const testDbName = "tbbt_website_setup_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for website setup test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Save, skip, isolation, and existing tenants");
  resetFirstRunSetupSchemaEnsure();
  resetStarterServicesSetupSchemaEnsure();
  resetWebsiteSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);
  await ensureWebsiteSetupSchema(prisma);

  const passwordHash = await bcrypt.hash("password12", 10);
  const provisioned = await provisionOwnerWorkspace(prisma, {
    name: "New Owner",
    email: `owner-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Cedar Handyman",
  });
  const ownerAccess = makeAccess(
    provisioned.business.id,
    "OWNER",
    provisioned.membership.id,
    { slug: provisioned.business.slug },
  );

  await completeFirstRunSetupOp(prisma, ownerAccess, {
    name: "Cedar Handyman",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "https://cedar.example",
  });
  await skipOnboardingStarterServicesOp(prisma, ownerAccess);
  const afterStarter = await prisma.business.findUnique({
    where: { id: provisioned.business.id },
  });
  check(
    "New OWNER proceeds from starter-services setup to website setup",
    afterStarter?.starterServicesSetupCompletedAt instanceof Date &&
      afterStarter?.websiteSetupCompletedAt === null &&
      postAuthenticationPath({ role: "OWNER", business: afterStarter }) === "/setup/website",
  );

  const memberUser = await prisma.user.create({
    data: {
      name: "Field Tech",
      email: `member-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash,
    },
  });
  const memberMembership = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: provisioned.business.id,
      role: "MEMBER",
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Office Admin",
      email: `admin-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash,
    },
  });
  const adminMembership = await prisma.membership.create({
    data: {
      userId: adminUser.id,
      businessId: provisioned.business.id,
      role: "ADMIN",
    },
  });

  await expectError(
    "MEMBER cannot save OWNER website setup",
    () =>
      completeWebsiteSetupOp(
        prisma,
        makeAccess(provisioned.business.id, "MEMBER", memberMembership.id, {
          slug: provisioned.business.slug,
        }),
        {
          name: "Hijacked",
          phone: "555-000-0000",
          email: "nope@example.com",
          about: "Nope",
          serviceArea: "Nowhere",
        },
      ),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot save OWNER website setup",
    () =>
      completeWebsiteSetupOp(
        prisma,
        makeAccess(provisioned.business.id, "ADMIN", adminMembership.id, {
          slug: provisioned.business.slug,
        }),
        {
          name: "Hijacked",
          phone: "555-000-0000",
          email: "nope@example.com",
          about: "Nope",
          serviceArea: "Nowhere",
        },
      ),
    (error) => error instanceof ForbiddenError,
  );

  const other = await provisionOwnerWorkspace(prisma, {
    name: "Other Owner",
    email: `other-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Maple Handyman",
  });
  const otherAccess = makeAccess(
    other.business.id,
    "OWNER",
    other.membership.id,
    { slug: other.business.slug },
  );
  await completeFirstRunSetupOp(prisma, otherAccess, {
    name: "Maple Handyman",
    phone: "555-444-5555",
    email: "shop@maple.example",
    website: "",
  });
  await skipOnboardingStarterServicesOp(prisma, otherAccess);

  const collpro = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
      publicPhone: COLLPRO_RENO_PHONE,
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: collpro.id,
      approvedPublicAboutCopy: DEFAULT_PUBLIC_ABOUT_STORY,
    },
  });

  await completeWebsiteSetupOp(prisma, ownerAccess, {
    name: "Cedar Handyman Co",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    about: "Cedar helps homeowners in Reno with everyday repairs.",
    serviceArea: "Reno, NV",
  });

  const saved = await prisma.business.findUnique({
    where: { id: provisioned.business.id },
    include: { settings: true },
  });
  const otherAfterSave = await prisma.business.findUnique({
    where: { id: other.business.id },
    include: { settings: true },
  });
  const collproAfterSave = await prisma.business.findUnique({
    where: { id: collpro.id },
    include: { settings: true },
  });
  check(
    "Website setup is tenant-scoped",
    saved?.name === "Cedar Handyman Co" &&
      otherAfterSave?.name === "Maple Handyman" &&
      otherAfterSave?.publicServiceAreaLabel == null &&
      (otherAfterSave?.settings?.approvedPublicAboutCopy ?? "") === "",
  );
  check(
    "About/service-area information persists for the correct Business",
    saved?.publicServiceAreaLabel === "Reno, NV" &&
      saved?.settings?.approvedPublicAboutCopy ===
        "Cedar helps homeowners in Reno with everyday repairs." &&
      saved?.publicPhone === "555-222-3333" &&
      saved?.publicEmail === "shop@cedar.example" &&
      saved?.publicWebsite === "https://cedar.example",
  );
  check(
    "Completion persists explicitly as SAVED",
    saved?.websiteSetupCompletedAt instanceof Date &&
      saved?.websiteSetupChoice === WEBSITE_SETUP_SAVED &&
      postAuthenticationPath({ role: "OWNER", business: saved }) === "/dashboard" &&
      publicHomePath(saved.slug) === `/hire/${saved.slug}`,
  );
  check(
    "Public site displays the saved tenant identity and not CollPro defaults",
    publicDisplayName(saved) === "Cedar Handyman Co" &&
      publicPhone(saved) === "(555) 222-3333" &&
      resolvePublishedAboutCopy(saved.settings?.approvedPublicAboutCopy, saved.slug) ===
        "Cedar helps homeowners in Reno with everyday repairs." &&
      resolvePublicServiceAreaCopy(saved).includes("Reno, NV") &&
      !/Fort Myers|CollPro Reno/.test(resolvePublicServiceAreaCopy(saved)) &&
      publicLogoSrc(saved.slug) === null,
  );
  check(
    "Existing CollPro public site behavior remains unchanged",
    collproAfterSave?.publicPhone === COLLPRO_RENO_PHONE &&
      collproAfterSave?.settings?.approvedPublicAboutCopy === DEFAULT_PUBLIC_ABOUT_STORY &&
      resolvePublicServiceAreaCopy(collproAfterSave) === SERVICE_AREA_COPY &&
      publicDisplayName(collproAfterSave) === COLLPRO_RENO_DISPLAY_NAME &&
      ownerNeedsWebsiteSetup({ role: "OWNER", business: collproAfterSave }) === false,
  );

  await skipWebsiteSetupOp(prisma, otherAccess);
  const skippedBiz = await prisma.business.findUnique({
    where: { id: other.business.id },
    include: { settings: true },
  });
  check(
    "Skip persists without inventing business content",
    skippedBiz?.websiteSetupCompletedAt instanceof Date &&
      skippedBiz?.websiteSetupChoice === WEBSITE_SETUP_SKIPPED &&
      skippedBiz?.publicServiceAreaLabel == null &&
      (skippedBiz?.settings?.approvedPublicAboutCopy ?? "") === "" &&
      resolvePublishedAboutCopy(skippedBiz?.settings?.approvedPublicAboutCopy, skippedBiz.slug) ===
        "" &&
      resolvePublicServiceAreaCopy(skippedBiz) === GENERIC_SERVICE_AREA_COPY &&
      postAuthenticationPath({ role: "OWNER", business: skippedBiz }) === "/dashboard",
  );

  const populatedWithoutCompletion = await provisionOwnerWorkspace(prisma, {
    name: "Story Owner",
    email: `story-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Story Handyman",
  });
  await prisma.business.update({
    where: { id: populatedWithoutCompletion.business.id },
    data: {
      firstRunSetupCompletedAt: new Date(),
      starterServicesSetupCompletedAt: new Date(),
      publicServiceAreaLabel: "Reno, NV",
    },
  });
  await prisma.businessSettings.create({
    data: {
      businessId: populatedWithoutCompletion.business.id,
      approvedPublicAboutCopy: "We already wrote an About story.",
    },
  });
  const populatedRow = await prisma.business.findUnique({
    where: { id: populatedWithoutCompletion.business.id },
  });
  check(
    "Completion is not inferred from populated About or service-area fields",
    populatedRow?.websiteSetupCompletedAt === null &&
      populatedRow?.publicServiceAreaLabel === "Reno, NV" &&
      ownerNeedsWebsiteSetup({ role: "OWNER", business: populatedRow }) === true &&
      postAuthenticationPath({ role: "OWNER", business: populatedRow }) === "/setup/website",
  );

  check(
    "MEMBER and ADMIN stay out of OWNER website routing after a live business exists",
    ownerNeedsWebsiteSetup({
      role: "MEMBER",
      business: afterStarter,
    }) === false &&
      ownerNeedsFirstRunSetup({ role: "ADMIN", business: afterStarter }) === false &&
      ownerNeedsStarterServicesSetup({ role: "ADMIN", business: afterStarter }) === false &&
      postAuthenticationPath({ role: "MEMBER", business: afterStarter }) === "/field",
  );

  const preexisting = await prisma.business.create({
    data: {
      name: "Already Live Co",
      slug: `already-live-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Business" DROP COLUMN IF EXISTS "websiteSetupChoice"`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Business" DROP COLUMN IF EXISTS "websiteSetupCompletedAt"`,
  );
  resetWebsiteSetupSchemaEnsure();
  await ensureWebsiteSetupSchema(prisma);
  const backfilled = await prisma.business.findUnique({
    where: { id: preexisting.id },
  });
  check(
    "Existing businesses are backfilled and not forced through Task 3",
    backfilled?.websiteSetupCompletedAt instanceof Date &&
      ownerNeedsWebsiteSetup({ role: "OWNER", business: backfilled }) === false,
  );

  const later = await provisionOwnerWorkspace(prisma, {
    name: "Later Owner",
    email: `later-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Later Handyman",
  });
  resetWebsiteSetupSchemaEnsure();
  await ensureWebsiteSetupSchema(prisma);
  const laterAfterEnsure = await prisma.business.findUnique({
    where: { id: later.business.id },
  });
  check(
    "Later signup stays incomplete after a second ensure",
    laterAfterEnsure?.websiteSetupCompletedAt === null &&
      ownerNeedsWebsiteSetup({
        role: "OWNER",
        business: laterAfterEnsure,
      }) === true,
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

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
