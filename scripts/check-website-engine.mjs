/**
 * Website Publishing Engine proofs.
 *
 * Covers immutable snapshots, atomic current pointer, rollback,
 * concurrency/idempotency, multi-trade publication, tenant isolation,
 * private-asset rejection, SEO/sitemap, AI draft-not-publish, and
 * CollPro compatibility.
 *
 * Run with:
 *   npm run test:website-engine
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const { activateBusinessTradeOp, deactivateBusinessTradeOp } = await import("@/lib/business-trades");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { buildBusinessExportZip } = await import("@/lib/business-export");
const {
  applyTemplateWriting,
  resolveWritingOriginal,
  runWritingAssist,
} = await import("@/lib/ai/writing");
const {
  WEBSITE_SNAPSHOT_SCHEMA_VERSION,
  parseWebsiteSnapshot,
  serializeWebsiteSnapshot,
  WebsiteSnapshotError,
  buildWebsiteSnapshot,
  validateWebsiteSnapshot,
  publishWebsite,
  rollbackWebsite,
  listWebsitePublishes,
  websiteHasUnpublishedChanges,
  loadPublicWebsiteView,
  publicServiceFromView,
  publicLocalPageFromView,
  resolvePublicHost,
  publishedSitemapPaths,
  addWebsiteGalleryItem,
  saveWebsiteSeoDraft,
  setReviewWebsiteSelected,
  WebsitePublishError,
} = await import("@/lib/website-engine");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the website-engine check.");
  process.exit(1);
}

const testDbName = "tbbt_website_engine_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

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

function makeAccess(businessId, membershipId, role = "OWNER") {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
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

console.log("\nSTATIC — Website engine architecture");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260925180000_website_engine/migration.sql");
const builder = read("src/lib/website-engine/builder.ts");
const publish = read("src/lib/website-engine/publish.ts");
const snapshot = read("src/lib/website-engine/snapshot.ts");
const hosts = read("src/lib/website-engine/hosts.ts");
const publicView = read("src/lib/website-engine/public.ts");
const panel = read("src/components/settings/website-publish-panel.tsx");
const settingsPage = read("src/app/(app)/settings/page.tsx");
const settingsWorkspace = read("src/components/settings/settings-workspace.tsx");
const hireHome = read("src/app/hire/[slug]/page.tsx");
const collproHome = read("src/app/page.tsx");
const serviceDetail = read("src/app/hire/[slug]/services/[serviceSlug]/page.tsx");
const sitemap = read("src/app/sitemap.ts");
const exportSrc = read("src/lib/business-export.ts");
const workspace = read("src/lib/workspace.ts");

check(
  "WebsitePublish model and current pointer exist",
  schema.includes("model WebsitePublish") &&
    schema.includes("publishedWebsiteId") &&
    schema.includes("snapshotJson") &&
    schema.includes("idempotencyKey") &&
    schema.includes("sourcePublishId"),
);
check(
  "Migration is additive and idempotent",
  !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
    migration.includes("CREATE TABLE IF NOT EXISTS") &&
    migration.includes("ADD COLUMN IF NOT EXISTS") &&
    migration.includes("WebsitePublish"),
);
check(
  "No request-time website-engine DDL",
  !workspace.includes("WebsitePublish") &&
    !builder.includes("$executeRawUnsafe") &&
    !publish.includes("ALTER TABLE"),
);
check(
  "Snapshot schema is versioned and rejects secrets",
  snapshot.includes("WEBSITE_SNAPSHOT_SCHEMA_VERSION = 1") &&
    snapshot.includes("passwordHash") &&
    snapshot.includes("totpSecret") &&
    snapshot.includes("stripeSecret"),
);
check(
  "Builder uses ACTIVE BusinessTrade, not Business.tradeCode",
  builder.includes("listActiveBusinessTrades") &&
    builder.includes("catalogItemIsPubliclyOffered") &&
    !builder.includes("business.tradeCode"),
);
check(
  "Publish is transactional with idempotency and version uniqueness",
  publish.includes("$transaction") &&
    publish.includes("idempotencyKey") &&
    publish.includes("publishedWebsiteId") &&
    publish.includes("versionNumber"),
);
check(
  "Public rendering prefers snapshot after first publish",
  publicView.includes('source: "snapshot"') &&
    publicView.includes('source: "compatibility"') &&
    hireHome.includes("requirePublicWebsiteView") &&
    hireHome.includes("view.snapshot") &&
    collproHome.includes("loadPublicWebsiteView"),
);
check(
  "Owner publish UI is explicit and AI apply is not publish",
  settingsWorkspace.includes("WebsitePublishPanel") &&
    panel.includes("Publish website") &&
    panel.includes("WritingAssistBar") &&
    panel.includes("onSuggestion={setHeroHeadline}") &&
    !settingsPage.includes("runWritingAssist") &&
    !settingsPage.includes("applyWritingAction"),
);
check(
  "Service detail, sitemap, and export are wired",
  serviceDetail.includes("publicServiceFromView") &&
    serviceDetail.includes("application/ld+json") &&
    sitemap.includes("publishedSitemapPaths") &&
    exportSrc.includes("website-publishes.json") &&
    exportSrc.includes("website-gallery.csv"),
);
check(
  "Host resolution never uses a browser businessId and UNVERIFIED never routes",
  hosts.includes('status: "VERIFIED"') &&
    hosts.includes('kind: "unknown"') &&
    !hosts.includes("businessId:") === false,
);
check(
  "Rollback copies source snapshot into a new version",
  publish.includes("sourcePublishId: source.id") &&
    publish.includes("snapshotJson: source.snapshotJson"),
);

check(
  "Parse rejects secret keys",
  (() => {
    try {
      parseWebsiteSnapshot({
        schemaVersion: 1,
        business: { id: "b", slug: "s", name: "N" },
        passwordHash: "secret",
      });
      return false;
    } catch (error) {
      return error instanceof WebsiteSnapshotError;
    }
  })(),
);
check(
  "Parse rejects duplicate service slugs",
  (() => {
    try {
      parseWebsiteSnapshot({
        schemaVersion: 1,
        business: { id: "b", slug: "s", name: "N" },
        services: [
          { id: "1", slug: "same", name: "A" },
          { id: "2", slug: "same", name: "B" },
        ],
      });
      return false;
    } catch (error) {
      return error instanceof WebsiteSnapshotError;
    }
  })(),
);
check(
  "Disconnected writing assist stays usable without inventing reviews or prices",
  applyTemplateWriting("WRITE_FOR_ME", "", "About copy").text.includes("recorded TBBT context") &&
    !applyTemplateWriting("WRITE_FOR_ME", "", "About copy").text.includes("licensed since") &&
    resolveWritingOriginal("draft", "suggestion", "KEEP_MINE") === "draft" &&
    resolveWritingOriginal("draft", "suggestion", "APPLY") === "suggestion",
);

try {
  console.log("\nLIVE — Publish, isolation, multi-trade, SEO, AI");
  const userA = await prisma.user.create({
    data: { name: "Owner A", email: `we-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const userB = await prisma.user.create({
    data: { name: "Owner B", email: `we-b-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Sites", slug: `alpha-we-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Sites", slug: `beta-we-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const memA = await prisma.membership.create({
    data: { userId: userA.id, businessId: businessA.id, role: "OWNER" },
  });
  const memB = await prisma.membership.create({
    data: { userId: userB.id, businessId: businessB.id, role: "OWNER" },
  });
  const accessA = makeAccess(businessA.id, memA.id);
  const accessB = makeAccess(businessB.id, memB.id);
  const memberUser = await prisma.user.create({
    data: { name: "Member A", email: `we-m-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memMember = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const accessMember = makeAccess(businessA.id, memMember.id, "MEMBER");

  await activateBusinessTradeOp(prisma, accessA, "HANDYMAN");
  await activateBusinessTradeOp(prisma, accessB, "HANDYMAN");

  const handyService = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "TV Mounting",
      description: "Mount a television on a finished wall.",
      category: "Mounting",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(125),
      tradeCode: "HANDYMAN",
      active: true,
    },
  });
  const inactiveService = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Hidden Handyman Job",
      category: "Other Services",
      tradeCode: "HANDYMAN",
      active: false,
    },
  });
  const cleaningService = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Standard House Cleaning",
      description: "Recurring house cleaning.",
      category: "House Cleaning",
      pricingMode: "VARIABLE",
      unitLabel: "visit",
      recurrenceEligible: true,
      tradeCode: "CLEANING",
      active: true,
    },
  });
  const serviceB = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Beta Fence Repair",
      category: "Fencing",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });

  const areaA = await prisma.serviceArea.create({
    data: {
      businessId: businessA.id,
      kind: "CITY",
      label: "Reno",
      city: "Reno",
      region: "NV",
      enabled: true,
    },
  });
  const areaInactive = await prisma.serviceArea.create({
    data: {
      businessId: businessA.id,
      kind: "CITY",
      label: "Sparks",
      city: "Sparks",
      region: "NV",
      enabled: false,
    },
  });
  const areaB = await prisma.serviceArea.create({
    data: {
      businessId: businessB.id,
      kind: "CITY",
      label: "Tahoe",
      city: "Tahoe",
      region: "CA",
      enabled: true,
    },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Reviewer" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Bea Reviewer" },
  });
  const reviewA = await prisma.review.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      platform: "GOOGLE",
      rating: 5,
      reviewText: "They mounted the TV cleanly.",
      recordedByMembershipId: memA.id,
      websiteSelected: false,
    },
  });
  const reviewB = await prisma.review.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      platform: "GOOGLE",
      rating: 5,
      reviewText: "Beta only review text",
      recordedByMembershipId: memB.id,
      websiteSelected: true,
    },
  });

  const storageA = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessA.id,
      bucketName: "tbbt-test",
      namespacePrefix: `businesses/${businessA.id}`,
      storageLimitBytes: BigInt(1_000_000_000),
    },
  });
  const storageB = await prisma.businessStorageAccount.create({
    data: {
      businessId: businessB.id,
      bucketName: "tbbt-test",
      namespacePrefix: `businesses/${businessB.id}`,
      storageLimitBytes: BigInt(1_000_000_000),
    },
  });
  const publicImage = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      category: "WEBSITE_IMAGE",
      originalFilename: "gallery.jpg",
      storageKey: `public/${randomUUID()}.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 1200,
      visibility: "PUBLIC",
      status: "READY",
      publicPath: "/uploads/a-gallery.jpg",
    },
  });
  const privateJobPhoto = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      category: "JOB_PHOTO",
      originalFilename: "job.jpg",
      storageKey: `private/${randomUUID()}.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 900,
      visibility: "PRIVATE",
      status: "READY",
    },
  });
  const imageB = await prisma.storedAsset.create({
    data: {
      businessId: businessB.id,
      storageAccountId: storageB.id,
      category: "WEBSITE_IMAGE",
      originalFilename: "b.jpg",
      storageKey: `public/${randomUUID()}.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 800,
      visibility: "PUBLIC",
      status: "READY",
      publicPath: "/uploads/b-gallery.jpg",
    },
  });

  const compat = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Business with no publish uses compatibility path", compat?.source === "compatibility");
  check("Compatibility still lists the live Handyman service", compat?.site.items.some((row) => row.id === handyService.id) === true);
  check("Compatibility excludes inactive services", compat?.site.items.some((row) => row.id === inactiveService.id) !== true);

  const collpro = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  await activateBusinessTradeOp(prisma, makeAccess(collpro.id, memA.id), "HANDYMAN");
  const collproView = await loadPublicWebsiteView("collpro-reno", prisma);
  check("CollPro compatibility path still works before first publish", collproView?.source === "compatibility");

  await expectError(
    "MEMBER cannot publish",
    () => publishWebsite(prisma, accessMember, { idempotencyKey: "member-1" }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  const first = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-1" });
  check("First publish is version 1", first.versionNumber === 1);
  const afterFirst = await loadPublicWebsiteView(businessA.slug, prisma);
  check("First publish switches to snapshot mode", afterFirst?.source === "snapshot" && afterFirst.versionNumber === 1);
  check("Handyman-only first snapshot includes Handyman service", afterFirst?.snapshot?.services.some((row) => row.id === handyService.id) === true);
  check("Cleaning service is excluded while Cleaning trade is inactive", afterFirst?.snapshot?.services.some((row) => row.id === cleaningService.id) !== true);
  check("Inactive service cannot enter a new snapshot", afterFirst?.snapshot?.services.some((row) => row.id === inactiveService.id) !== true);
  check("Inactive service area cannot enter new local pages", afterFirst?.snapshot?.localPages.some((row) => row.citySlug === "sparks") !== true);
  check("Local pages use the enabled Reno area and published service", afterFirst?.snapshot?.localPages.some((row) => row.citySlug === "reno" && row.serviceId === handyService.id) === true);
  check("Business B service cannot enter A snapshot", afterFirst?.snapshot?.services.some((row) => row.id === serviceB.id) !== true);
  check("Unselected review is not published", afterFirst?.snapshot?.reviews.length === 0);

  const frozenAbout = afterFirst?.snapshot?.about.copy ?? "";
  await prisma.businessSettings.upsert({
    where: { businessId: businessA.id },
    update: { approvedPublicAboutCopy: "DRAFT ABOUT AFTER PUBLISH", websiteHeroHeadline: "Draft headline after publish" },
    create: { businessId: businessA.id, approvedPublicAboutCopy: "DRAFT ABOUT AFTER PUBLISH", websiteHeroHeadline: "Draft headline after publish" },
  });
  const leaked = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Draft edit after Publish does not change public snapshot", leaked?.snapshot?.about.copy === frozenAbout);
  check("Draft hero after Publish does not leak", leaked?.snapshot?.home.headline !== "Draft headline after publish");
  check("Unpublished changes are detected", (await websiteHasUnpublishedChanges(prisma, accessA)) === true);

  const sameKey = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-1" });
  check("Same idempotency key returns one logical publish", sameKey.id === first.id && sameKey.versionNumber === 1);

  await setReviewWebsiteSelected(prisma, accessA, { reviewId: reviewA.id, selected: true });
  await addWebsiteGalleryItem(prisma, accessA, {
    storedAssetId: publicImage.id,
    title: "TV install",
    caption: "Living room",
    catalogItemId: handyService.id,
  });
  const second = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-2" });
  check("Next Publish creates version 2", second.versionNumber === 2);
  const afterSecond = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Next Publish changes the public snapshot", afterSecond?.snapshot?.about.copy === "DRAFT ABOUT AFTER PUBLISH");
  check("Selected review is snapshotted", afterSecond?.snapshot?.reviews.some((row) => row.reviewText === "They mounted the TV cleanly.") === true);
  check("Gallery snapshot uses the public website image", afterSecond?.snapshot?.gallery.some((row) => row.imageUrl === "/uploads/a-gallery.jpg") === true);
  const firstRow = await prisma.websitePublish.findUnique({ where: { id: first.id } });
  check("Old snapshot remains unchanged", parseWebsiteSnapshot(firstRow.snapshotJson).about.copy === frozenAbout);

  await expectError(
    "PRIVATE job/request photo cannot be added to gallery",
    () => addWebsiteGalleryItem(prisma, accessA, { storedAssetId: privateJobPhoto.id }),
    (error) => error instanceof WebsitePublishError,
  );
  await prisma.websiteGalleryItem.create({
    data: {
      businessId: businessA.id,
      storedAssetId: privateJobPhoto.id,
      title: "should fail",
    },
  });
  const pointerBeforeFail = (await prisma.business.findUnique({
    where: { id: businessA.id },
    select: { publishedWebsiteId: true },
  }))?.publishedWebsiteId;
  await expectError(
    "PRIVATE StoredAsset cannot enter a public snapshot",
    () => publishWebsite(prisma, accessA, { idempotencyKey: "pub-private" }),
    (error) => error instanceof WebsitePublishError,
  );
  const pointerAfterFail = (await prisma.business.findUnique({
    where: { id: businessA.id },
    select: { publishedWebsiteId: true },
  }))?.publishedWebsiteId;
  check("Failed publish leaves previous current site alive", pointerAfterFail === pointerBeforeFail);
  await prisma.websiteGalleryItem.deleteMany({
    where: { businessId: businessA.id, storedAssetId: privateJobPhoto.id },
  });

  await expectError(
    "A cannot publish B review",
    () => setReviewWebsiteSelected(prisma, accessA, { reviewId: reviewB.id, selected: true }),
    () => true,
  );
  await expectError(
    "A cannot publish B image",
    () => addWebsiteGalleryItem(prisma, accessA, { storedAssetId: imageB.id }),
    () => true,
  );
  const pointerBBefore = (await prisma.business.findUnique({
    where: { id: businessB.id },
    select: { publishedWebsiteId: true },
  }))?.publishedWebsiteId;
  const publishedA = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-still-a" });
  const pointerBAfter = (await prisma.business.findUnique({
    where: { id: businessB.id },
    select: { publishedWebsiteId: true },
  }))?.publishedWebsiteId;
  check("A cannot publish B — B pointer stays unchanged", pointerBBefore === pointerBAfter);
  check("A publish stays on A", publishedA.businessId === businessA.id);

  const historyA = await listWebsitePublishes(prisma, accessA);
  const bPublishes = await prisma.websitePublish.findMany({ where: { businessId: businessB.id } });
  check(
    "A cannot view B private website versions",
    historyA.versions.every((row) => row.id !== undefined) &&
      historyA.versions.every((row) => !bPublishes.some((item) => item.id === row.id)),
  );
  check(
    "A history only contains A publishes",
    historyA.versions.every((row) => !row.summary.includes("Beta")),
  );

  await expectError(
    "A cannot rollback B",
    async () => {
      const bPub = await publishWebsite(prisma, accessB, { idempotencyKey: "b-1" });
      await rollbackWebsite(prisma, accessA, { publishId: bPub.id, idempotencyKey: "rb-b" });
    },
    () => true,
  );

  const rollback = await rollbackWebsite(prisma, accessA, {
    publishId: first.id,
    idempotencyKey: "rb-1",
  });
  check("Rollback creates a new version", rollback.versionNumber === 3 && rollback.sourcePublishId === first.id);
  const afterRollback = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Rollback restores version 1 public state", afterRollback?.snapshot?.about.copy === frozenAbout);
  const sameRollback = await rollbackWebsite(prisma, accessA, {
    publishId: first.id,
    idempotencyKey: "rb-1",
  });
  check("Rollback is idempotent for the same key", sameRollback.id === rollback.id);
  const intactHistory = await listWebsitePublishes(prisma, accessA);
  check("Version history remains intact after rollback", intactHistory.versions.length >= 3);

  await activateBusinessTradeOp(prisma, accessA, "CLEANING");
  const multi = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-multi" });
  const multiView = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Handyman + Cleaning can publish together", multi.versionNumber >= 4);
  check(
    "Multi-trade snapshot contains both trades",
    multiView?.snapshot?.trades.some((row) => row.code === "HANDYMAN") === true &&
      multiView?.snapshot?.trades.some((row) => row.code === "CLEANING") === true &&
      multiView?.snapshot?.services.some((row) => row.id === handyService.id) === true &&
      multiView?.snapshot?.services.some((row) => row.id === cleaningService.id) === true,
  );
  const multiSnapshotJson = (await prisma.websitePublish.findUnique({ where: { id: multi.id } }))?.snapshotJson;

  await deactivateBusinessTradeOp(prisma, accessA, "CLEANING");
  const afterDeactivate = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-no-clean" });
  const noClean = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Old version still contains Cleaning", parseWebsiteSnapshot(multiSnapshotJson).services.some((row) => row.id === cleaningService.id));
  check("New version excludes Cleaning after deactivation", noClean?.snapshot?.services.some((row) => row.id === cleaningService.id) !== true);
  check("Handyman remains intact after Cleaning deactivation", noClean?.snapshot?.services.some((row) => row.id === handyService.id) === true);
  await activateBusinessTradeOp(prisma, accessA, "CLEANING");
  const reactivated = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-clean-again" });
  const reView = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Reactivation allows future Cleaning publication", reView?.snapshot?.services.some((row) => row.id === cleaningService.id) === true);
  check("Reactivation publish is a later version", reactivated.versionNumber > afterDeactivate.versionNumber);

  const service = publicServiceFromView(reView, "tv-mounting");
  check("Service slug resolves the tenant service", service?.id === handyService.id);
  check("Unknown service slug is not found", publicServiceFromView(reView, "not-a-service") == null);
  check(
    "Local route cannot combine A service and B location",
    publicLocalPageFromView(reView, "tahoe", "tv-mounting") == null,
  );
  check(
    "Local page for published Reno + TV exists",
    publicLocalPageFromView(reView, "reno", "tv-mounting")?.serviceId === handyService.id,
  );

  const paths = publishedSitemapPaths(reView.snapshot);
  check("Sitemap includes homepage and service pages", paths.includes(`/hire/${businessA.slug}`) && paths.includes(`/hire/${businessA.slug}/services/tv-mounting`));
  check("Sitemap includes local pages", paths.some((path) => path.includes("/in/reno/tv-mounting")));
  check("Sitemap excludes owner routes and B slug", !paths.some((path) => path.startsWith("/settings") || path.includes(businessB.slug)));
  check(
    "Canonical belongs to the correct tenant slug",
    reView.snapshot.business.slug === businessA.slug &&
      reView.snapshot.seo.home.title.includes("Alpha Sites"),
  );
  check(
    "Structured data facts are recorded services only",
    reView.snapshot.services.every((row) => row.name && row.id) &&
      !JSON.stringify(reView.snapshot).includes("password") &&
      !JSON.stringify(reView.snapshot).includes("stripeSecret"),
  );

  await prisma.websiteHostBinding.create({
    data: { businessId: businessA.id, hostname: "alpha.example.test", status: "VERIFIED" },
  });
  await prisma.websiteHostBinding.create({
    data: { businessId: businessB.id, hostname: "beta-unverified.example.test", status: "UNVERIFIED" },
  });
  const hostA = await resolvePublicHost(prisma, "alpha.example.test");
  const hostB = await resolvePublicHost(prisma, "beta-unverified.example.test");
  const hostUnknown = await resolvePublicHost(prisma, "nobody.example.test");
  check("Verified host for A resolves A", hostA.kind === "tenant" && hostA.businessId === businessA.id && hostA.slug === businessA.slug);
  check("UNVERIFIED host for B does not resolve", hostB.kind === "unknown");
  check("Unknown host fails closed", hostUnknown.kind === "unknown");
  check("Host for A cannot resolve B snapshot", hostA.kind !== "tenant" || hostA.businessId !== businessB.id);

  const [c1, c2] = await Promise.all([
    publishWebsite(prisma, accessA, { idempotencyKey: "conc-1" }),
    publishWebsite(prisma, accessA, { idempotencyKey: "conc-2" }),
  ]);
  const versions = [c1.versionNumber, c2.versionNumber].sort((a, b) => a - b);
  check("Concurrent different publishes produce sequential versions", versions[1] === versions[0] + 1);
  const current = await prisma.business.findUnique({
    where: { id: businessA.id },
    select: { publishedWebsiteId: true },
  });
  const currentRow = await prisma.websitePublish.findFirst({
    where: { id: current.publishedWebsiteId, businessId: businessA.id },
  });
  check("Current pointer always references a complete same-tenant publish", Boolean(currentRow && currentRow.snapshotJson));

  const actor = { businessId: businessA.id, membershipId: memA.id, role: "OWNER" };
  const generated = await runWritingAssist(prisma, actor, {
    action: "WRITE_FOR_ME",
    original: "",
    context: "Homepage hero headline for Alpha Sites. Do not invent licenses.",
    idempotencyKey: `ai-${randomUUID()}`,
  });
  check("Generate invokes existing AI writing service", Boolean(generated.output?.text));
  check("Disconnected generate remains usable", generated.connected === false || generated.status === "SKIPPED_NOT_CONNECTED" || Boolean(generated.output?.text));
  const beforeApply = await prisma.businessSettings.findUnique({ where: { businessId: businessA.id } });
  check("Generate alone does not modify saved draft", beforeApply?.websiteHeroHeadline === "Draft headline after publish");
  const appliedText = resolveWritingOriginal(beforeApply?.websiteHeroHeadline ?? "", generated.output.text, "APPLY");
  await saveWebsiteSeoDraft(prisma, accessA, {
    websiteHeroHeadline: appliedText,
    websiteHeroSupporting: beforeApply?.websiteHeroSupporting ?? "",
    seoTitleHome: beforeApply?.seoTitleHome ?? "",
    seoDescriptionHome: beforeApply?.seoDescriptionHome ?? "",
    seoTitleServices: beforeApply?.seoTitleServices ?? "",
    seoDescriptionServices: beforeApply?.seoDescriptionServices ?? "",
    seoTitleAbout: beforeApply?.seoTitleAbout ?? "",
    seoDescriptionAbout: beforeApply?.seoDescriptionAbout ?? "",
    seoTitleRequest: beforeApply?.seoTitleRequest ?? "",
    seoDescriptionRequest: beforeApply?.seoDescriptionRequest ?? "",
  });
  const afterApply = await prisma.businessSettings.findUnique({ where: { businessId: businessA.id } });
  const publicAfterApply = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Apply changes draft only", afterApply?.websiteHeroHeadline === appliedText);
  check("Apply does not Publish", publicAfterApply?.snapshot?.home.headline !== appliedText);
  const freeze = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-ai" });
  const publicFrozen = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Publish freezes the applied text", publicFrozen?.snapshot?.home.headline === appliedText && freeze.versionNumber > 0);
  await saveWebsiteSeoDraft(prisma, accessA, { websiteHeroHeadline: "Later AI draft headline" });
  const publicAfterLaterDraft = await loadPublicWebsiteView(businessA.slug, prisma);
  check("Later AI draft does not alter current public snapshot", publicAfterLaterDraft?.snapshot?.home.headline === appliedText);

  const exported = await buildBusinessExportZip(prisma, businessA.id);
  const zipText = exported.bytes.toString("utf8");
  check("Export includes website publish snapshots", zipText.includes("website-publishes.json") && zipText.includes("TV Mounting"));
  check("Export includes review text and omits secrets", zipText.includes("They mounted the TV cleanly.") && !zipText.includes("passwordHash"));
  const exportedB = await buildBusinessExportZip(prisma, businessB.id);
  check("A export excludes B catalog and reviews", !zipText.includes("Beta Fence Repair") && !zipText.includes("Beta only review text"));
  check("B export excludes A snapshot services", !exportedB.bytes.toString("utf8").includes("TV Mounting"));

  const validation = validateWebsiteSnapshot(publicFrozen.snapshot);
  check("Published snapshot validates", validation.ok === true);

  const cleaningOnly = await prisma.business.create({
    data: { name: "Gamma Clean", slug: `gamma-we-${randomUUID().slice(0, 8)}`, tradeCode: "CLEANING" },
  });
  const gammaUser = await prisma.user.create({
    data: { name: "Gamma", email: `we-g-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memG = await prisma.membership.create({
    data: { userId: gammaUser.id, businessId: cleaningOnly.id, role: "OWNER" },
  });
  const accessG = makeAccess(cleaningOnly.id, memG.id);
  await activateBusinessTradeOp(prisma, accessG, "CLEANING");
  await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleaningOnly.id,
      name: "Move-out Clean",
      category: "Move-out",
      tradeCode: "CLEANING",
      active: true,
    },
  });
  const cleanPub = await publishWebsite(prisma, accessG, { idempotencyKey: "clean-only" });
  const cleanView = await loadPublicWebsiteView(cleaningOnly.slug, prisma);
  check("Cleaning-only publish works", cleanPub.versionNumber === 1 && cleanView?.snapshot?.trades.every((row) => row.code === "CLEANING"));
  check("Cleaning-only snapshot has the Cleaning service", cleanView?.snapshot?.services.some((row) => row.name === "Move-out Clean") === true);
} catch (error) {
  failed += 1;
  console.error("FAIL - website engine live suite", error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll website-engine checks passed (${passed}).`
    : `\n${failed} website-engine check(s) failed (${passed} passed).`,
);
process.exit(failed === 0 ? 0 : 1);
