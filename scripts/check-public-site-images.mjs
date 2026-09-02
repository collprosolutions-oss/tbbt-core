/**
 * Focused verification for owner/admin public-website marketing photos.
 * Recent Projects stay on real portfolio photos and are not owner-editable.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-public-site-images.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const { assertSettingsBusinessScope } = await import("@/lib/settings-ops");
const { HOME_FEATURED_PROJECT_IDS, publicCategoryPhoto } = await import("@/lib/public-site");
const { selectPublicProjectsById } = await import("@/lib/public-projects");
const {
  PUBLIC_HOME_HERO_DEFAULT_POSITION,
  PUBLIC_SITE_HOME_PAGE,
  PUBLIC_SITE_SERVICES_PAGE,
  PUBLIC_SITE_HERO_SLOT,
  PublicSiteImageError,
  buildPublicHomeImagePresentation,
  buildPublicServicesImagePresentation,
  categoryImageSlot,
  formatObjectPosition,
  parseCategoryImageSlot,
  resolvePublicSiteImage,
  resetPublicSiteImageOp,
  upsertPublicSiteImageOp,
} = await import("@/lib/public-site-images");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_public_site_images_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for public-site image test database.");
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

async function expectForbidden(label, fn) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, error instanceof ForbiddenError);
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const homeSrc = readRepo("src/components/public/public-home.tsx");
const editorSrc = readRepo("src/components/settings/website-photos-editor.tsx");
const opsSrc = readRepo("src/lib/public-site-images.ts");
const storageSrc = readRepo("src/lib/storage.ts");
const actionSrc = readRepo("src/app/actions/public-site-images.ts");

console.log("\nSTATIC — Home photo editor boundaries");
check("Website Photos editor exists for owners", editorSrc.includes("Edit Website Photos") || editorSrc.includes("Home page"));
check("Editor can replace, reposition, and reset",
  editorSrc.includes("Replace Image") &&
    editorSrc.includes("Save Position") &&
    editorSrc.includes("Reset to Default"));
check("Home page has no owner replace/reset controls",
  !homeSrc.includes("Replace Image") && !homeSrc.includes("Reset to Default"));
check("Recent Projects stay on real portfolio photos",
  homeSrc.includes("selectPublicProjectsById") &&
    HOME_FEATURED_PROJECT_IDS.length === 6 &&
    selectPublicProjectsById(HOME_FEATURED_PROJECT_IDS).every((project) =>
      project.src.startsWith("/brand/projects/"),
    ));
check("Home Recent Projects use a 3-column desktop grid", homeSrc.includes("lg:grid-cols-3"));
check("Uploads reuse the existing Blob helper",
  storageSrc.includes("uploadPublicSitePhoto") &&
    actionSrc.includes("uploadPublicSitePhoto") &&
    actionSrc.includes("isStorageConfigured"));
check("Private job photos are not auto-promoted into Home slots",
  !opsSrc.includes("prisma.jobPhoto") &&
    !opsSrc.includes("grantJobPhotoMarketingPermission") &&
    !actionSrc.includes("uploadJobPhoto"));
check("Browser businessId is not authorization proof",
  actionSrc.includes("assertSettingsBusinessScope"));

console.log("\nPURE — Slot mapping and defaults");
const defaultHero = resolvePublicSiteImage({
  defaultSrc: "/brand/illustrative/craftsman-hero.jpg",
  defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
  row: null,
});
check("Missing override keeps the default hero",
  defaultHero.src === "/brand/illustrative/craftsman-hero.jpg" && !defaultHero.isOverride);
check("Category slots stay keyed to the real category name",
  categoryImageSlot("Doors & Locks") === "category:Doors & Locks" &&
    parseCategoryImageSlot("category:Doors & Locks") === "Doors & Locks");
check("Object position formats as CSS percents",
  formatObjectPosition(70, 50) === "70% 50%");

const groups = [
  { category: "Doors & Locks", items: [] },
  { category: "Mounting & Hanging", items: [] },
];
const presented = buildPublicHomeImagePresentation(groups, [
  {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: categoryImageSlot("Doors & Locks"),
    imageUrl: "/brand/projects/door-install.jpg",
    objectPosition: "20% 80%",
  },
]);
check("Only the overridden category image changes",
  presented.categories["Doors & Locks"]?.src === "/brand/projects/door-install.jpg" &&
    presented.categories["Mounting & Hanging"]?.src === publicCategoryPhoto("Mounting & Hanging"));
check("Category labels are not invented to fill eight slots",
  Object.keys(presented.categories).join("|") === "Doors & Locks|Mounting & Hanging");

const servicesPresented = buildPublicServicesImagePresentation(groups, []);
check("Services hero and category slots start on catalog defaults",
  servicesPresented.hero.src.includes("tools-services") &&
    servicesPresented.categories["Doors & Locks"]?.src === publicCategoryPhoto("Doors & Locks"));

try {
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-psi-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-psi-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-psi-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-psi-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: `alpha-psi-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: `beta-psi-${randomUUID()}`, tradeCode: "HANDYMAN" },
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
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Door Adjustment",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(75),
      active: true,
    },
  });
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "TV Mounting",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(150),
      active: true,
    },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  console.log("\nDB — Authorization and persistence");
  await expectForbidden("MEMBER cannot pass the public-image settings gate", () => {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_SETTINGS);
  });
  await expectForbidden("MEMBER cannot save a Home image override", () =>
    upsertPublicSiteImageOp(prisma, memberA, {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/projects/lanai-porch.jpg",
      objectPosition: "40% 40%",
    }),
  );
  await expectForbidden("Foreign businessId in the form is rejected", () => {
    assertSettingsBusinessScope(ownerA, businessB.id);
  });

  const savedHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    imageUrl: "/brand/projects/lanai-porch.jpg",
    objectPosition: "30% 60%",
  });
  check("OWNER can replace the Home hero",
    savedHero.imageUrl === "/brand/projects/lanai-porch.jpg" &&
      savedHero.objectPosition === "30% 60%");

  const savedCategory = await upsertPublicSiteImageOp(prisma, adminA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: categoryImageSlot("Doors & Locks"),
    imageUrl: "/brand/projects/door-install.jpg",
    objectPosition: "10% 90%",
  });
  check("ADMIN can replace one category image",
    savedCategory.slot === "category:Doors & Locks" &&
      savedCategory.imageUrl === "/brand/projects/door-install.jpg");

  try {
    await upsertPublicSiteImageOp(prisma, ownerA, {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: categoryImageSlot("Made Up Category"),
      imageUrl: "/brand/projects/closet.jpg",
    });
    check("Fake categories cannot be created as image slots", false);
  } catch (error) {
    check(
      "Fake categories cannot be created as image slots",
      error instanceof PublicSiteImageError,
    );
  }

  const aRows = await prisma.publicSiteImage.findMany({ where: { businessId: businessA.id } });
  const bRows = await prisma.publicSiteImage.findMany({ where: { businessId: businessB.id } });
  check("Overrides stay on the owning business", aRows.length === 2 && bRows.length === 0);

  const loaded = buildPublicHomeImagePresentation(groups, aRows);
  check("Hero override is used on Home",
    loaded.hero.src === "/brand/projects/lanai-porch.jpg" &&
      loaded.hero.objectPosition === "30% 60%");
  check("Untouched category keeps its default image",
    loaded.categories["Mounting & Hanging"]?.src === publicCategoryPhoto("Mounting & Hanging") &&
      loaded.categories["Doors & Locks"]?.src === "/brand/projects/door-install.jpg");

  const reset = await resetPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
  });
  const heroAfterReset = await prisma.publicSiteImage.findUnique({
    where: {
      businessId_page_slot: {
        businessId: businessA.id,
        page: PUBLIC_SITE_HOME_PAGE,
        slot: PUBLIC_SITE_HERO_SLOT,
      },
    },
  });
  check("Reset removes the hero override", reset.unchanged === false && heroAfterReset === null);

  const ownerBWrite = await upsertPublicSiteImageOp(prisma, ownerB, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    imageUrl: "/brand/projects/closet.jpg",
  });
  check("Business B writes only its own image row",
    ownerBWrite.businessId === businessB.id &&
      ownerBWrite.imageUrl === "/brand/projects/closet.jpg");
  const stillA = await prisma.publicSiteImage.findMany({ where: { businessId: businessA.id } });
  check("Business A category override is unchanged by Business B",
    stillA.length === 1 && stillA[0]?.slot === "category:Doors & Locks");

  await expectForbidden("MEMBER cannot reset a public image", () =>
    resetPublicSiteImageOp(prisma, memberA, {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: categoryImageSlot("Doors & Locks"),
    }),
  );

  await expectForbidden("MEMBER cannot save a Services image override", () =>
    upsertPublicSiteImageOp(prisma, memberA, {
      page: PUBLIC_SITE_SERVICES_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/projects/door-install.jpg",
    }),
  );

  const savedServicesHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_SERVICES_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    imageUrl: "/brand/projects/feature-wall-tv.jpg",
    objectPosition: "25% 40%",
  });
  check("OWNER can replace the Services hero",
    savedServicesHero.page === PUBLIC_SITE_SERVICES_PAGE &&
      savedServicesHero.imageUrl === "/brand/projects/feature-wall-tv.jpg");

  const savedServicesCategory = await upsertPublicSiteImageOp(prisma, adminA, {
    page: PUBLIC_SITE_SERVICES_PAGE,
    slot: categoryImageSlot("Doors & Locks"),
    imageUrl: "/brand/projects/door-install.jpg",
  });
  check("ADMIN can replace a Services category image",
    savedServicesCategory.page === PUBLIC_SITE_SERVICES_PAGE &&
      savedServicesCategory.slot === "category:Doors & Locks");

  try {
    await upsertPublicSiteImageOp(prisma, ownerA, {
      page: "about",
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/projects/closet.jpg",
    });
    check("Unregistered public pages cannot receive photo slots", false);
  } catch (error) {
    check(
      "Unregistered public pages cannot receive photo slots",
      error instanceof PublicSiteImageError,
    );
  }
} finally {
  await prisma.$disconnect();
  spawnSync("psql", [baseUrl, "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`], {
    stdio: "ignore",
  });
}

if (failures > 0) {
  console.error(`\n${failures} public-site image check(s) failed.`);
  process.exit(1);
}
console.log("\nPublic-site image checks passed.");
