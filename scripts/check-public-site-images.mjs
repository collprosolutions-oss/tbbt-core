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
import { existsSync, readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const { assertSettingsBusinessScope } = await import("@/lib/settings-ops");
const {
  COLLPRO_ABOUT_HERO_IMAGE,
  HOME_FEATURED_PROJECT_IDS,
  PUBLIC_ABOUT_HERO_IMAGE,
  publicAboutHeroImage,
  publicCategoryPhoto,
} = await import("@/lib/public-site");
const { selectPublicProjectsById } = await import("@/lib/public-projects");
const {
  PUBLIC_HOME_HERO_DEFAULT_POSITION,
  PUBLIC_SITE_ABOUT_PAGE,
  PUBLIC_SITE_HOME_PAGE,
  PUBLIC_SITE_SERVICES_PAGE,
  PUBLIC_SITE_HERO_SLOT,
  PUBLIC_SITE_STORY_SLOT,
  PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  PUBLIC_SITE_IMAGE_FILE_ACCEPT,
  PUBLIC_SITE_IMAGE_MAX_ZOOM,
  PUBLIC_SITE_IMAGE_MIN_ZOOM,
  PUBLIC_SITE_IMAGE_ZOOM_STEP,
  buildPublicAboutImagePresentation,
  PublicSiteImageError,
  buildPublicHomeImagePresentation,
  buildPublicServicesImagePresentation,
  categoryImageSlot,
  clampObjectZoom,
  clampPercent,
  evaluateWebsitePhotoSelection,
  formatObjectPosition,
  parseCategoryImageSlot,
  publicImageBypassesOptimizer,
  publicImageFrameModel,
  publicImageObjectStyle,
  resolvePublicSiteImage,
  resolveSavedPublicSiteImageSrc,
  resolveSupportedImageMimeType,
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
const fittedSrc = readRepo("src/components/public/public-fitted-image.tsx");
const opsSrc = readRepo("src/lib/public-site-images.ts");
const storageSrc = readRepo("src/lib/storage.ts");
const actionSrc = readRepo("src/app/actions/public-site-images.ts");

console.log("\nSTATIC — Home photo editor boundaries");
check("Website Photos editor exists for owners", editorSrc.includes("Home Hero") && editorSrc.includes("Service Categories"));
check("Editor can replace, save crop, and reset",
  editorSrc.includes("Replace Image") &&
    editorSrc.includes("Save Changes") &&
    editorSrc.includes("Zoom") &&
    editorSrc.includes("Move Left / Right") &&
    editorSrc.includes("Move Up / Down") &&
    editorSrc.includes("Reset"));
check("Editor does not persist every slider movement",
  editorSrc.includes("Save Changes") && !editorSrc.includes("Save Position"));
check("Home page has no owner replace/reset controls",
  !homeSrc.includes("Replace Image") && !homeSrc.includes("Reset to Default"));
check("Recent Projects stay on real portfolio photos",
  homeSrc.includes("selectPublicProjectsById") &&
    HOME_FEATURED_PROJECT_IDS.length === 6 &&
    selectPublicProjectsById(HOME_FEATURED_PROJECT_IDS).every((project) =>
      project.src.startsWith("/brand/projects/"),
    ));
check("Home Recent Projects use a 3-column desktop grid", homeSrc.includes("lg:grid-cols-3"));
check("Website Photos use the business storage service, not Vercel Blob",
  actionSrc.includes("replaceWebsitePhotoFromBytes") &&
    actionSrc.includes("isBusinessStorageConfigured") &&
    !actionSrc.includes("uploadPublicSitePhoto") &&
    !actionSrc.includes("BLOB_READ_WRITE_TOKEN"));
check("Private job photos are not auto-promoted into Home slots",
  !opsSrc.includes("prisma.jobPhoto") &&
    !opsSrc.includes("grantJobPhotoMarketingPermission") &&
    !actionSrc.includes("uploadJobPhoto"));
check("Browser businessId is not authorization proof",
  actionSrc.includes("assertSettingsBusinessScope"));
check("Replace Image stays disabled until a file is chosen",
  editorSrc.includes("canReplace") &&
    editorSrc.includes("onFileSelected") &&
    editorSrc.includes("createObjectURL") &&
    editorSrc.includes("disabled={!canReplace}"));
check("Choose Photo uses a real file input triggered through a ref",
  editorSrc.includes("Choose Photo") &&
    editorSrc.includes('type="file"') &&
    editorSrc.includes("fileInputRef") &&
    editorSrc.includes("input.click()") &&
    editorSrc.includes("className=\"sr-only\"") &&
    !editorSrc.includes("Choose File"));
check("Selected photo filename and local preview stay in React state",
  editorSrc.includes("Selected: ${selectedFile.name}") &&
    editorSrc.includes("No photo selected") &&
    editorSrc.includes("setSelectedFile(file)") &&
    editorSrc.includes("URL.createObjectURL(file)") &&
    editorSrc.includes("authorizeWebsitePhotoUpload") &&
    editorSrc.includes("finalizeWebsitePhotoUpload"));
check("Editor accepts JPEG PNG and WebP from the computer",
  PUBLIC_SITE_IMAGE_FILE_ACCEPT ===
    "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" &&
    editorSrc.includes("PUBLIC_SITE_IMAGE_FILE_ACCEPT") &&
    editorSrc.includes("JPEG, PNG, or WebP"));
const nextConfigSrc = readRepo("next.config.ts");
check("Server Action body limit allows the existing 4 MB photo cap",
  nextConfigSrc.includes('bodySizeLimit: "4.5mb"'));
check("JPG alias and filename extensions resolve to supported types",
  resolveSupportedImageMimeType({ type: "image/jpg", name: "hero.jpg" }) === "image/jpeg" &&
    resolveSupportedImageMimeType({ type: "", name: "card.PNG" }) === "image/png" &&
    resolveSupportedImageMimeType({ type: "image/webp", name: "wall.webp" }) === "image/webp");
check("Invalid file types are rejected before upload",
  resolveSupportedImageMimeType({ type: "application/pdf", name: "notes.pdf" }) == null &&
    resolveSupportedImageMimeType({ type: "text/plain", name: "readme.txt" }) == null);

console.log("\nPURE — Slot mapping and defaults");
const defaultHero = resolvePublicSiteImage({
  defaultSrc: "/brand/illustrative/craftsman-hero.jpg",
  defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
  row: null,
});
check("Missing override keeps the default hero",
  defaultHero.src === "/brand/illustrative/craftsman-hero.jpg" &&
    !defaultHero.isOverride &&
    defaultHero.objectZoom === PUBLIC_SITE_IMAGE_DEFAULT_ZOOM &&
    defaultHero.objectPosition === PUBLIC_HOME_HERO_DEFAULT_POSITION);
check("Saved Website Photo uses the stored public path, not the default hero",
  resolvePublicSiteImage({
    defaultSrc: "/brand/illustrative/craftsman-hero.jpg",
    defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
    row: {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/api/storage/public/asset_workshop",
      storedAssetId: "asset_workshop",
      objectPosition: "42% 35%",
      objectZoom: 0.7,
    },
  }).src === "/api/storage/public/asset_workshop");
check("Stored asset id recovers the public path when imageUrl is missing",
  resolveSavedPublicSiteImageSrc({
    imageUrl: null,
    storedAssetId: "asset_workshop",
  }) === "/api/storage/public/asset_workshop" &&
    resolvePublicSiteImage({
      defaultSrc: "/brand/illustrative/craftsman-hero.jpg",
      defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
      row: {
        page: PUBLIC_SITE_HOME_PAGE,
        slot: PUBLIC_SITE_HERO_SLOT,
        imageUrl: null,
        storedAssetId: "asset_workshop",
        objectPosition: "42% 35%",
        objectZoom: 0.7,
      },
    }).src === "/api/storage/public/asset_workshop");
check("Absolute preview URLs collapse to the managed public path",
  resolveSavedPublicSiteImageSrc({
    imageUrl: "https://collpro-reno.vercel.app/api/storage/public/asset_workshop",
    storedAssetId: "asset_workshop",
  }) === "/api/storage/public/asset_workshop");
check("A disallowed imageUrl still uses the same-row stored asset, not craftsman",
  resolvePublicSiteImage({
    defaultSrc: "/brand/illustrative/craftsman-hero.jpg",
    defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
    row: {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "businesses/other/website/hero.jpg",
      storedAssetId: "asset_workshop",
      objectPosition: "20% 80%",
      objectZoom: 1.25,
    },
  }).src === "/api/storage/public/asset_workshop");
check("Public Home query selects the stored asset id with crop metadata",
  opsSrc.includes("storedAssetId: true") &&
    opsSrc.includes("objectPosition: true") &&
    opsSrc.includes("objectZoom: true"));
check("Public fitted images serve managed storage URLs without the optimizer",
  publicImageBypassesOptimizer("/api/storage/public/asset_workshop") &&
    publicImageBypassesOptimizer("https://example.public.blob.vercel-storage.com/hero.jpg") &&
    !publicImageBypassesOptimizer("/brand/illustrative/craftsman-hero.jpg") &&
    fittedSrc.includes("publicImageBypassesOptimizer") &&
    fittedSrc.includes("unoptimized={publicImageBypassesOptimizer(src)}"));
check("Public Home and hire pages load images for the resolved business only",
  readRepo("src/app/page.tsx").includes("loadPublicHomeImages(prisma, business.id, catalog.groups)") &&
    readRepo("src/app/hire/[slug]/page.tsx").includes(
      "loadPublicHomeImages(prisma, site.business.id, site.groups)",
    ));
check("Category slots stay keyed to the real category name",
  categoryImageSlot("Doors & Locks") === "category:Doors & Locks" &&
    parseCategoryImageSlot("category:Doors & Locks") === "Doors & Locks");
check("Object position formats as CSS percents",
  formatObjectPosition(70, 50) === "70% 50%");
check("Invalid percents clamp to 0-100",
  formatObjectPosition(-20, 140) === "0% 100%" && clampPercent(Number.NaN) === 50);
check("Zoom range is 0.50 default 1.00 max 3.00 step 0.05",
  PUBLIC_SITE_IMAGE_MIN_ZOOM === 0.5 &&
    PUBLIC_SITE_IMAGE_DEFAULT_ZOOM === 1 &&
    PUBLIC_SITE_IMAGE_MAX_ZOOM === 3 &&
    PUBLIC_SITE_IMAGE_ZOOM_STEP === 0.05 &&
    editorSrc.includes("PUBLIC_SITE_IMAGE_MIN_ZOOM") &&
    editorSrc.includes("PUBLIC_SITE_IMAGE_ZOOM_STEP"));
check("Valid zoom values below 1 are accepted and not forced to 1",
  clampObjectZoom(0.5) === 0.5 &&
    clampObjectZoom(0.75) === 0.75 &&
    clampObjectZoom(0.7) === 0.7 &&
    clampObjectZoom(1) === 1 &&
    clampObjectZoom(1.25) === 1.25 &&
    clampObjectZoom(2) === 2 &&
    clampObjectZoom(3) === 3);
check("Invalid zoom clamps to the safe 0.50-3 range",
  clampObjectZoom(Number.NaN) === 1 &&
    clampObjectZoom(-4) === 0.5 &&
    clampObjectZoom(0) === 0.5 &&
    clampObjectZoom(9) === 3 &&
    clampObjectZoom(1.555) === 1.56);
check("Valid file selection captures the filename",
  evaluateWebsitePhotoSelection({ type: "image/jpeg", name: "walls-drywall.jpg", size: 1200 }).ok === true &&
    evaluateWebsitePhotoSelection({ type: "image/jpeg", name: "walls-drywall.jpg", size: 1200 }).fileName ===
      "walls-drywall.jpg" &&
    evaluateWebsitePhotoSelection({ type: "image/png", name: "hero.png", size: 800 }).ok === true &&
    evaluateWebsitePhotoSelection({ type: "image/webp", name: "card.webp", size: 800 }).ok === true &&
    evaluateWebsitePhotoSelection({ type: "", name: "porch.JPEG", size: 800 }).ok === true);
check("Invalid or empty file selection is rejected",
  evaluateWebsitePhotoSelection(null).ok === false &&
    evaluateWebsitePhotoSelection({ type: "application/pdf", name: "notes.pdf", size: 800 }).ok === false &&
    evaluateWebsitePhotoSelection({ type: "image/jpeg", name: "huge.jpg", size: 5 * 1024 * 1024 }).ok === false);
check("Default zoom keeps cover fill without a scale transform",
  publicImageFrameModel("70% 50%", 1).image.objectFit === "cover" &&
    publicImageFrameModel("70% 50%", 1).image.transform == null &&
    publicImageObjectStyle("70% 50%", 1).transform == null);
check("Zoom above 1 still scales the cover image",
  publicImageFrameModel("30% 60%", 1.5).image.transform === "scale(1.5)" &&
    publicImageFrameModel("30% 60%", 1.5).image.objectFit === "cover" &&
    publicImageObjectStyle("30% 60%", 1.5).transform === "scale(1.5)");
check("Zoom below 1 shrinks the photo box and uses contain",
  publicImageFrameModel("42% 35%", 0.5).box.width === "50%" &&
    publicImageFrameModel("42% 35%", 0.75).box.width === "75%" &&
    publicImageFrameModel("42% 35%", 0.7).box.width === "70%" &&
    publicImageFrameModel("42% 35%", 0.7).box.height === "70%" &&
    publicImageFrameModel("42% 35%", 0.7).box.left === "42%" &&
    publicImageFrameModel("42% 35%", 0.7).box.top === "35%" &&
    publicImageFrameModel("42% 35%", 0.7).image.objectFit === "contain" &&
    publicImageFrameModel("42% 35%", 0.7).image.transform == null);
check("Settings preview and public rendering share the same frame model",
  fittedSrc.includes("publicImageFrameModel") &&
    fittedSrc.includes("data-public-site-image-frame") &&
    editorSrc.includes("publicImageFrameModel") &&
    editorSrc.includes("data-public-site-image-frame") &&
    editorSrc.includes("previewFrame.image") &&
    editorSrc.includes("resetCropLocally") &&
    editorSrc.includes("setZoom(clampObjectZoom(slot.defaultZoom))"));
check("Home public rendering consumes saved zoom",
  homeSrc.includes("objectZoom={hero.objectZoom}") &&
    homeSrc.includes("objectZoom={visual.objectZoom}"));
check("Hero and service-card public rendering use saved zoom",
  readRepo("src/components/public/public-page-hero.tsx").includes("objectZoom={objectZoom}") &&
    readRepo("src/components/public/public-services-browser.tsx").includes(
      "objectZoom={categoryImage.objectZoom}",
    ));

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
    presented.categories["Mounting & Hanging"]?.src === publicCategoryPhoto("Mounting & Hanging") &&
    presented.hero.objectZoom === PUBLIC_SITE_IMAGE_DEFAULT_ZOOM &&
    presented.categories["Mounting & Hanging"]?.objectZoom === PUBLIC_SITE_IMAGE_DEFAULT_ZOOM);
check("Category labels are not invented to fill eight slots",
  Object.keys(presented.categories).join("|") === "Doors & Locks|Mounting & Hanging");

const servicesPresented = buildPublicServicesImagePresentation(groups, []);
check("Services hero and category slots start on catalog defaults",
  servicesPresented.hero.src.includes("tools-services") &&
    servicesPresented.categories["Doors & Locks"]?.src === publicCategoryPhoto("Doors & Locks"));
const aboutPresented = buildPublicAboutImagePresentation([]);
check("About hero and story slots start on company/handyman defaults",
  aboutPresented.hero.src.includes("craftsman-hero") &&
    aboutPresented.story.src.includes("door-install"));
check("Unbranded TBBT About hero fallback stays generic",
  PUBLIC_ABOUT_HERO_IMAGE === "/brand/illustrative/craftsman-hero.jpg" &&
    publicAboutHeroImage("acme-handyman") === PUBLIC_ABOUT_HERO_IMAGE);
const collproAbout = buildPublicAboutImagePresentation([], "collpro-reno");
check("CollPro About hero default is the CollPro-specific asset",
  publicAboutHeroImage("collpro-reno") === COLLPRO_ABOUT_HERO_IMAGE &&
    collproAbout.hero.src === COLLPRO_ABOUT_HERO_IMAGE &&
    !collproAbout.hero.isOverride);
check("Another subscriber does not inherit the CollPro About hero",
  buildPublicAboutImagePresentation([], "other-handyman").hero.src ===
    PUBLIC_ABOUT_HERO_IMAGE);
check("CollPro About hero asset is stored on disk",
  existsSync(new URL("../public/brand/collpro/about-hero.png", import.meta.url)));

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
    objectZoom: 1.45,
  });
  check("OWNER can replace the Home hero",
    savedHero.imageUrl === "/brand/projects/lanai-porch.jpg" &&
      savedHero.objectPosition === "30% 60%" &&
      savedHero.objectZoom === 1.45);

  const zoomedOutHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    objectPosition: "42% 35%",
    objectZoom: 0.7,
  });
  check("Home Hero accepts saved zoom below 1.00",
    zoomedOutHero.objectPosition === "42% 35%" && zoomedOutHero.objectZoom === 0.7);
  const halfZoomHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    objectZoom: 0.5,
  });
  check("Home Hero accepts the minimum zoom 0.50",
    halfZoomHero.objectZoom === 0.5 && halfZoomHero.objectPosition === "42% 35%");
  const midZoomHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    objectZoom: 0.75,
  });
  check("Home Hero accepts zoom 0.75", midZoomHero.objectZoom === 0.75);

  const zoomedHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    objectPosition: "15% 80%",
    objectZoom: 99,
  });
  check("Home Hero zoom and x/y save, and invalid zoom clamps",
    zoomedHero.objectPosition === "15% 80%" && zoomedHero.objectZoom === 3);

  const replacedHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    imageUrl: "/brand/projects/closet.jpg",
  });
  check("Replacing the hero image keeps the saved crop metadata",
    replacedHero.imageUrl === "/brand/projects/closet.jpg" &&
      replacedHero.objectPosition === "15% 80%" &&
      replacedHero.objectZoom === 3);

  try {
    await upsertPublicSiteImageOp(prisma, ownerA, {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "https://evil.example/not-allowed.jpg",
    });
    check("Failed replacement leaves the previous hero image intact", false);
  } catch (error) {
    const stillHero = await prisma.publicSiteImage.findUnique({
      where: {
        businessId_page_slot: {
          businessId: businessA.id,
          page: PUBLIC_SITE_HOME_PAGE,
          slot: PUBLIC_SITE_HERO_SLOT,
        },
      },
    });
    check(
      "Failed replacement leaves the previous hero image intact",
      error instanceof PublicSiteImageError &&
        stillHero?.imageUrl === "/brand/projects/closet.jpg" &&
        stillHero?.objectZoom === 3,
    );
  }

  const savedCategory = await upsertPublicSiteImageOp(prisma, adminA, {
    page: PUBLIC_SITE_HOME_PAGE,
    slot: categoryImageSlot("Doors & Locks"),
    imageUrl: "/brand/projects/door-install.jpg",
    objectPosition: "10% 90%",
    objectZoom: 1.2,
  });
  check("ADMIN can replace one category image",
    savedCategory.slot === "category:Doors & Locks" &&
      savedCategory.imageUrl === "/brand/projects/door-install.jpg" &&
      savedCategory.objectZoom === 1.2);

  const heroAfterCategory = await prisma.publicSiteImage.findUnique({
    where: {
      businessId_page_slot: {
        businessId: businessA.id,
        page: PUBLIC_SITE_HOME_PAGE,
        slot: PUBLIC_SITE_HERO_SLOT,
      },
    },
  });
  check("Category crop does not change the Home Hero crop",
    heroAfterCategory?.objectPosition === "15% 80%" &&
      heroAfterCategory?.objectZoom === 3 &&
      savedCategory.objectPosition === "10% 90%");

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
  const zoomedOutPresentation = buildPublicHomeImagePresentation(groups, [
    {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/projects/closet.jpg",
      objectPosition: "42% 35%",
      objectZoom: 0.7,
    },
  ]);
  check("Saved zoom below 1 reaches public Home hero rendering",
    zoomedOutPresentation.hero.objectZoom === 0.7 &&
      zoomedOutPresentation.hero.objectPosition === "42% 35%" &&
      publicImageFrameModel(
        zoomedOutPresentation.hero.objectPosition,
        zoomedOutPresentation.hero.objectZoom,
      ).box.width === "70%");
  check("Hero override is used on Home",
    loaded.hero.src === "/brand/projects/closet.jpg" &&
      loaded.hero.objectPosition === "15% 80%" &&
      loaded.hero.objectZoom === 3);
  const storedHero = buildPublicHomeImagePresentation(groups, [
    {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/api/storage/public/asset_workshop",
      storedAssetId: "asset_workshop",
      objectPosition: "42% 35%",
      objectZoom: 0.7,
    },
  ]);
  check("Public Home hero binds the Website Photos storage path and crop",
    storedHero.hero.src === "/api/storage/public/asset_workshop" &&
      storedHero.hero.usesCustomUpload &&
      storedHero.hero.objectPosition === "42% 35%" &&
      storedHero.hero.objectZoom === 0.7 &&
      publicImageFrameModel(
        storedHero.hero.objectPosition,
        storedHero.hero.objectZoom,
      ).box.width === "70%");
  check("Public site consumes the uploaded hero image",
    loaded.hero.src === "/brand/projects/closet.jpg" && loaded.hero.isOverride);
  check("Service-card positioning stays independent",
    loaded.categories["Doors & Locks"]?.objectPosition === "10% 90%" &&
      loaded.categories["Doors & Locks"]?.objectZoom === 1.2 &&
      loaded.categories["Mounting & Hanging"]?.objectZoom === PUBLIC_SITE_IMAGE_DEFAULT_ZOOM);
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

  const savedAboutHero = await upsertPublicSiteImageOp(prisma, ownerA, {
    page: PUBLIC_SITE_ABOUT_PAGE,
    slot: PUBLIC_SITE_HERO_SLOT,
    imageUrl: "/brand/illustrative/craftsman-hero.jpg",
    objectPosition: "80% 40%",
  });
  check("OWNER can replace the About hero",
    savedAboutHero.page === PUBLIC_SITE_ABOUT_PAGE &&
      savedAboutHero.slot === PUBLIC_SITE_HERO_SLOT);

  const savedAboutStory = await upsertPublicSiteImageOp(prisma, adminA, {
    page: PUBLIC_SITE_ABOUT_PAGE,
    slot: PUBLIC_SITE_STORY_SLOT,
    imageUrl: "/brand/projects/door-install.jpg",
  });
  check("ADMIN can replace the About story image",
    savedAboutStory.page === PUBLIC_SITE_ABOUT_PAGE &&
      savedAboutStory.slot === PUBLIC_SITE_STORY_SLOT);

  await expectForbidden("MEMBER cannot save an About image override", () =>
    upsertPublicSiteImageOp(prisma, memberA, {
      page: PUBLIC_SITE_ABOUT_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      imageUrl: "/brand/projects/closet.jpg",
    }),
  );

  try {
    await upsertPublicSiteImageOp(prisma, ownerA, {
      page: "careers",
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
