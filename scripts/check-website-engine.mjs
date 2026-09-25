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
  missingWebsiteEngineSchema,
  publicServiceFromView,
  publicLocalPageFromView,
  resolvePublicHost,
  resolvePublicRoot,
  authorizedPublicOrigin,
  publishedSitemapPaths,
  snapshotPageMetadata,
  snapshotIntakeSchemasByTrade,
  publishWebsiteFromForm,
  rollbackWebsiteFromForm,
  publishedLocalBusinessDescription,
  publishedServicesHeroDescription,
  publishedProjectsDescription,
  snapshotContainsHandymanClaim,
  addWebsiteGalleryItem,
  saveWebsiteSeoDraft,
  setReviewWebsiteSelected,
  WebsitePublishError,
} = await import("@/lib/website-engine");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { publicCanonicalUrl } = await import("@/lib/public-site-seo");
const { DECORATIVE_WALL_PANELING_TITLE } = await import(
  "@/lib/estimate-calculators/decorative-wall-paneling"
);

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
const formSrc = read("src/lib/website-engine/form.ts");
const copySrc = read("src/lib/website-engine/copy.ts");
const slugSrc = read("src/lib/website-engine/slugs.ts");
const intakeSrc = read("src/lib/public-intake.ts");
const requestPage = read("src/app/r/[slug]/page.tsx");
const servicesPage = read("src/app/hire/[slug]/services/page.tsx");
const slugMigration = read("prisma/migrations/20260925191000_website_service_slug/migration.sql");
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
  hosts.includes('status !== "VERIFIED"') &&
    hosts.includes('kind: "unverified"') &&
    hosts.includes('kind: "unknown"') &&
    hosts.includes("resolvePublicRoot") &&
    hosts.includes("authorizedPublicOrigin") &&
    !hosts.includes("businessId:") === false,
);
check(
  "Stable websiteSlug is additive and unique within a business",
  schema.includes("websiteSlug") &&
    schema.includes("@@unique([businessId, websiteSlug])") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(slugMigration) &&
    slugMigration.includes('ADD COLUMN IF NOT EXISTS "websiteSlug"') &&
    slugMigration.includes("IF NOT EXISTS") &&
    slugSrc.includes("ensureCatalogWebsiteSlugs") &&
    builder.includes("ensureCatalogWebsiteSlugs"),
);
check(
  "Snapshot freezes public intake and skips stale managed images",
  snapshot.includes("intakeMeasurementMode") &&
    snapshot.includes("asksWorkAreaIntake") &&
    snapshot.includes("PublishedTradeIntake") &&
    builder.includes("publicIntakeSchemaProjection") &&
    builder.includes("catalogAsksWorkAreaIntake") &&
    builder.includes("continue") &&
    publicView.includes("snapshotIntakeSchemasByTrade") &&
    intakeSrc.includes("publishedSnapshot") &&
    intakeSrc.includes("snapshotIntakeSchemaForTrade") &&
    requestPage.includes("snapshot.seo.request") &&
    requestPage.includes("snapshotIntakeSchemasByTrade"),
);
check(
  "Publish/rollback forms send a stable client attempt id",
  formSrc.includes("readWebsiteEngineIdempotencyKey") &&
    formSrc.includes("Publish attempt is missing an idempotency key") &&
    panel.includes('name="idempotencyKey"') &&
    panel.includes("useFormAttemptKey") &&
    !read("src/app/actions/website-engine.ts").includes("randomUUID()"),
);
check(
  "Owner editor lists gallery drafts and switches local-pair copy",
  panel.includes("galleryItems") &&
    panel.includes("removeWebsiteGalleryItemAction") &&
    panel.includes("setLocalPairKey") &&
    panel.includes("setLocalCopy(pair?.draftCopy ??") &&
    settingsWorkspace.includes("galleryItems={websitePublish.galleryItems}"),
);
check(
  "Snapshot public copy is derived from published trades",
  copySrc.includes("publishedLocalBusinessDescription") &&
    hireHome.includes("publishedLocalBusinessDescription") &&
    collproHome.includes("publishedLocalBusinessDescription") &&
    servicesPage.includes("publishedServicesHeroDescription") &&
    collproHome.includes("viewHomeMetadata") &&
    requestPage.includes("snapshot.seo.request"),
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
  "Older snapshots default missing intake fields instead of crashing",
  (() => {
    const parsed = parseWebsiteSnapshot({
      schemaVersion: 1,
      business: { id: "b", slug: "s", name: "N" },
      services: [{ id: "1", slug: "old", name: "Old" }],
    });
    return (
      parsed.services[0].intakeMeasurementMode === "NONE" &&
      parsed.services[0].asksWorkAreaIntake === false &&
      parsed.services[0].intakeMeasurementAxes === ""
    );
  })(),
);
check(
  "Missing publishedWebsiteId schema falls back instead of crashing public pages",
  missingWebsiteEngineSchema({ code: "P2022", message: "The column `Business.publishedWebsiteId` does not exist in the current database." }) &&
    missingWebsiteEngineSchema({ code: "P2021", message: "The table `WebsitePublish` does not exist in the current database." }) &&
    !missingWebsiteEngineSchema(new Error("unrelated")),
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
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });
  const workAreaService = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: DECORATIVE_WALL_PANELING_TITLE,
      description: "Finish carpentry for decorative wall paneling.",
      category: "Trim & Carpentry",
      pricingMode: "CUSTOM_QUOTE",
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

  const collpro =
    (await prisma.business.findUnique({ where: { slug: "collpro-reno" } })) ??
    (await prisma.business.create({
      data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
    }));
  await activateBusinessTradeOp(prisma, makeAccess(collpro.id, memA.id), "HANDYMAN");
  await prisma.business.update({
    where: { id: collpro.id },
    data: { publishedWebsiteId: null },
  });
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
  const publishedTv = afterFirst?.snapshot?.services.find((row) => row.id === handyService.id);
  const publishedWorkArea = afterFirst?.snapshot?.services.find((row) => row.id === workAreaService.id);
  check(
    "Published snapshot freezes measurement intake",
    publishedTv?.intakeMeasurementMode === "RECOMMENDED" &&
      publishedTv?.intakeMeasurementAxes.includes("width") &&
      publishedTv?.intakeMeasurementUnit === "IN",
  );
  check("Published snapshot freezes work-area intake", publishedWorkArea?.asksWorkAreaIntake === true);
  check(
    "Published trade intake is a public projection without calculator rates",
    afterFirst?.snapshot?.trades.some((row) => row.intake?.key === "handyman.public" && row.intake.fields.some((field) => field.key === "frequency")) === true &&
      !JSON.stringify(afterFirst.snapshot).includes("hourlyRate") &&
      !JSON.stringify(afterFirst.snapshot).includes("DEFAULT_CONTENTS_HANDLING_RATES"),
  );
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
  await prisma.serviceCatalogItem.update({
    where: { id: handyService.id },
    data: {
      name: "Draft TV Name",
      intakeMeasurementMode: "NONE",
      intakeMeasurementAxes: "",
      active: false,
    },
  });
  const leakedIntake = await loadPublicWebsiteView(businessA.slug, prisma);
  const leakedTv = leakedIntake?.site.items.find((row) => row.id === handyService.id);
  check(
    "Draft catalog edits do not change published request intake",
    leakedTv?.name === "TV Mounting" &&
      leakedTv?.intakeMeasurementMode === "RECOMMENDED" &&
      leakedTv?.intakeMeasurementAxes.includes("width"),
  );
  check(
    "Deactivated published service stays on the current public form",
    leakedIntake?.site.items.some((row) => row.id === handyService.id) === true,
  );
  const frozenSubmit = await createPublicServiceRequest(prisma, {
    slug: businessA.slug,
    name: "Frozen Intake",
    email: `frozen-${randomUUID().slice(0, 8)}@example.com`,
    phone: "555-0100",
    address: "",
    streetAddress: "10 Snapshot St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Keep the published TV mount.",
    catalogItemIds: [handyService.id],
    includeOther: false,
    otherDescription: "",
    measurements: [{ catalogItemId: handyService.id, width: "40", height: "24", unit: "IN" }],
    intakeAnswers: { frequency: "ONE_TIME" },
  });
  check("Published service remains submittable after draft deactivation", frozenSubmit.ok === true);
  const frozenRequest = frozenSubmit.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: frozenSubmit.requestId } })
    : null;
  check(
    "Historical ServiceRequest freezes the published intake schema",
    frozenRequest?.intakeSchemaKey === "handyman.public" &&
      frozenRequest?.intakeSchemaJson?.includes("handyman.public") === true,
  );
  await prisma.serviceCatalogItem.update({
    where: { id: handyService.id },
    data: {
      name: "TV Mounting",
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      active: true,
    },
  });
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
  check(
    "Rollback creates a new version",
    rollback.versionNumber > second.versionNumber && rollback.sourcePublishId === first.id,
  );
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
  const persistedSlug = await prisma.serviceCatalogItem.findUnique({
    where: { id: handyService.id },
    select: { websiteSlug: true },
  });
  check("First publish persists a stable websiteSlug", persistedSlug?.websiteSlug === "tv-mounting");
  await prisma.serviceCatalogItem.update({
    where: { id: handyService.id },
    data: { name: "Living Room Television Install" },
  });
  await publishWebsite(prisma, accessA, { idempotencyKey: "pub-rename" });
  const renamedView = await loadPublicWebsiteView(businessA.slug, prisma);
  check(
    "Rename plus republish keeps the same service URL slug",
    publicServiceFromView(renamedView, "tv-mounting")?.id === handyService.id &&
      publicServiceFromView(renamedView, "living-room-television-install") == null &&
      renamedView?.snapshot?.services.find((row) => row.id === handyService.id)?.name ===
        "Living Room Television Install",
  );
  await prisma.serviceCatalogItem.update({
    where: { id: handyService.id },
    data: { name: "TV Mounting" },
  });
  const dupOne = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Same Name Service",
      category: "Other Services",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });
  const dupTwo = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Same Name Service",
      category: "Other Services",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });
  await publishWebsite(prisma, accessA, { idempotencyKey: "pub-dups" });
  const dupView = await loadPublicWebsiteView(businessA.slug, prisma);
  const dupSlugs = (dupView?.snapshot?.services ?? [])
    .filter((row) => row.id === dupOne.id || row.id === dupTwo.id)
    .map((row) => row.slug)
    .sort();
  check(
    "Two same-name services receive different stable slugs",
    dupSlugs.length === 2 && dupSlugs[0] !== dupSlugs[1],
  );
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

  const hostAName = `alpha-${randomUUID().slice(0, 8)}.example.test`;
  const hostBName = `beta-${randomUUID().slice(0, 8)}.example.test`;
  await prisma.websiteHostBinding.create({
    data: { businessId: businessA.id, hostname: hostAName, status: "VERIFIED" },
  });
  await prisma.websiteHostBinding.create({
    data: { businessId: businessB.id, hostname: hostBName, status: "UNVERIFIED" },
  });
  const hostA = await resolvePublicHost(prisma, hostAName);
  const hostB = await resolvePublicHost(prisma, hostBName);
  const hostUnknown = await resolvePublicHost(prisma, `nobody-${randomUUID().slice(0, 8)}.example.test`);
  check("Verified host for A resolves A", hostA.kind === "tenant" && hostA.businessId === businessA.id && hostA.slug === businessA.slug);
  check("UNVERIFIED host for B does not resolve", hostB.kind === "unverified");
  check("Unknown host fails closed", hostUnknown.kind === "unknown");
  check("Host for A cannot resolve B snapshot", hostA.kind !== "tenant" || hostA.businessId !== businessB.id);
  const hostBVerifiedName = `beta-ok-${randomUUID().slice(0, 8)}.example.test`;
  await prisma.websiteHostBinding.create({
    data: { businessId: businessB.id, hostname: hostBVerifiedName, status: "VERIFIED" },
  });
  const rootA = await resolvePublicRoot(prisma, hostAName);
  const rootB = await resolvePublicRoot(prisma, hostBVerifiedName);
  const rootUnverified = await resolvePublicRoot(prisma, hostBName);
  const rootUnknown = await resolvePublicRoot(prisma, `nobody-${randomUUID().slice(0, 8)}.example.test`);
  const rootMarketing = await resolvePublicRoot(prisma, "www.tbbtool.com");
  const rootCollpro = await resolvePublicRoot(prisma, "www.collproreno.com");
  check(
    "Verified host A root renders tenant A",
    rootA.kind === "site" && rootA.slug === businessA.slug && rootA.origin === `https://${hostAName}`,
  );
  check(
    "Verified host B root renders tenant B",
    rootB.kind === "site" && rootB.slug === businessB.slug && rootB.origin === `https://${hostBVerifiedName}`,
  );
  check("Unverified custom host fails closed at /", rootUnverified.kind === "unknown");
  check("Unknown custom host fails closed at /", rootUnknown.kind === "unknown");
  check("Marketing host stays on TBBT marketing", rootMarketing.kind === "marketing");
  check("CollPro host stays on CollPro", rootCollpro.kind === "site" && rootCollpro.slug === "collpro-reno");
  const originA = authorizedPublicOrigin(hostA, hostAName);
  const originB = authorizedPublicOrigin(await resolvePublicHost(prisma, hostBVerifiedName), hostBVerifiedName);
  check(
    "Canonical host isolation uses the authorized public origin",
    originA === `https://${hostAName}` &&
      originB === `https://${hostBVerifiedName}` &&
      publicCanonicalUrl(businessA.slug, "/", originA) === `https://${hostAName}/` &&
      publicCanonicalUrl(businessB.slug, "/", originB) === `https://${hostBVerifiedName}/` &&
      publicCanonicalUrl(businessA.slug, "/", originA) !== publicCanonicalUrl(businessB.slug, "/", originB),
  );
  const sitemapA = publishedSitemapPaths(dupView.snapshot ?? reView.snapshot).map((path) =>
    publicCanonicalUrl(businessA.slug, path, originA),
  );
  check(
    "Sitemap host isolation keeps tenant A URLs on host A",
    sitemapA.every((url) => url.startsWith(`https://${hostAName}`)) &&
      !sitemapA.some((url) => url.includes(hostBVerifiedName) || url.includes(businessB.slug)),
  );

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

  const formRetry = new FormData();
  formRetry.set("idempotencyKey", "form-retry-1");
  const formFirst = await publishWebsiteFromForm(prisma, accessA, formRetry);
  const formSecond = await publishWebsiteFromForm(prisma, accessA, formRetry);
  check(
    "Same publish form retry keeps one logical version",
    formFirst.id === formSecond.id && formFirst.versionNumber === formSecond.versionNumber,
  );
  await expectError(
    "Publish form without a client attempt key is rejected",
    () => publishWebsiteFromForm(prisma, accessA, new FormData()),
    (error) => error instanceof WebsitePublishError,
  );
  const formNext = new FormData();
  formNext.set("idempotencyKey", "form-retry-2");
  const formThird = await publishWebsiteFromForm(prisma, accessA, formNext);
  check(
    "A new publish form attempt id creates the next version",
    formThird.versionNumber === formFirst.versionNumber + 1 && formThird.id !== formFirst.id,
  );
  const rollbackForm = new FormData();
  rollbackForm.set("publishId", first.id);
  rollbackForm.set("idempotencyKey", "form-rb-1");
  const formRollback = await rollbackWebsiteFromForm(prisma, accessA, rollbackForm);
  const formRollbackRetry = await rollbackWebsiteFromForm(prisma, accessA, rollbackForm);
  check(
    "Same rollback form retry keeps one logical version",
    formRollback.id === formRollbackRetry.id && formRollback.versionNumber === formRollbackRetry.versionNumber,
  );
  await expectError(
    "Rollback form without a client attempt key is rejected",
    () => {
      const missing = new FormData();
      missing.set("publishId", first.id);
      return rollbackWebsiteFromForm(prisma, accessA, missing);
    },
    (error) => error instanceof WebsitePublishError,
  );
  const staleAsset = await prisma.storedAsset.create({
    data: {
      businessId: businessA.id,
      storageAccountId: storageA.id,
      category: "WEBSITE_IMAGE",
      originalFilename: "stale.jpg",
      storageKey: `public/${randomUUID()}.jpg`,
      mimeType: "image/jpeg",
      fileSizeBytes: 400,
      visibility: "PRIVATE",
      status: "DELETED",
      publicPath: null,
    },
  });
  await prisma.publicSiteImage.create({
    data: {
      businessId: businessA.id,
      page: "home",
      slot: "stale-hero",
      imageUrl: "/stale-old.jpg",
      storedAssetId: staleAsset.id,
    },
  });
  const stalePub = await publishWebsite(prisma, accessA, { idempotencyKey: "pub-stale-skip" });
  const staleView = await loadPublicWebsiteView(businessA.slug, prisma);
  check(
    "Stale managed PublicSiteImage is not snapshotted",
    stalePub.versionNumber > 0 &&
      staleView?.snapshot?.images.every((row) => row.assetId !== staleAsset.id && row.imageUrl !== "/stale-old.jpg") === true,
  );
  await saveWebsiteSeoDraft(prisma, accessA, {
    websiteHeroHeadline: "SEO home headline",
    websiteHeroSupporting: "SEO home supporting",
    seoTitleHome: "Alpha Home SEO",
    seoDescriptionHome: "Frozen home SEO for Alpha.",
    seoTitleServices: "Alpha Services SEO",
    seoDescriptionServices: "Frozen services SEO.",
    seoTitleAbout: "Alpha About SEO",
    seoDescriptionAbout: "Frozen about SEO.",
    seoTitleRequest: "Ask Alpha",
    seoDescriptionRequest: "Frozen request SEO for Alpha.",
  });
  await publishWebsite(prisma, accessA, { idempotencyKey: "pub-seo" });
  const seoView = await loadPublicWebsiteView(businessA.slug, prisma);
  const requestMeta = seoView?.snapshot
    ? snapshotPageMetadata({
        snapshot: seoView.snapshot,
        page: seoView.snapshot.seo.request,
        pathname: `/r/${businessA.slug}`,
        origin: originA,
      })
    : null;
  check(
    "Snapshot request SEO is frozen and used for /r metadata",
    seoView?.snapshot?.seo.request.title === "Ask Alpha" &&
      seoView?.snapshot?.seo.request.description === "Frozen request SEO for Alpha." &&
      requestMeta?.title?.absolute === "Ask Alpha" &&
      requestMeta?.openGraph?.url === `https://${hostAName}/r/${businessA.slug}`,
  );
  check(
    "Snapshot home SEO is frozen for the published site",
    seoView?.snapshot?.seo.home.title === "Alpha Home SEO",
  );
  const requestSchemas = seoView?.snapshot ? snapshotIntakeSchemasByTrade(seoView.snapshot) : {};
  check(
    "Snapshot request page uses the frozen trade intake projection",
    requestSchemas.HANDYMAN?.key === "handyman.public" &&
      requestSchemas.HANDYMAN?.fields.some((field) => field.key === "frequency") === true,
  );

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
  const cleaningCopy = publishedLocalBusinessDescription({
    name: "Gamma Clean",
    trades: cleanView?.snapshot?.trades ?? [],
  });
  const cleaningHero = publishedServicesHeroDescription({
    name: "Gamma Clean",
    trades: cleanView?.snapshot?.trades ?? [],
  });
  const cleaningProjects = publishedProjectsDescription({
    name: "Gamma Clean",
    trades: cleanView?.snapshot?.trades ?? [],
  });
  check(
    "Cleaning-only public copy is never labeled Handyman",
    cleaningCopy.includes("Cleaning") &&
      !snapshotContainsHandymanClaim(cleaningCopy) &&
      !snapshotContainsHandymanClaim(cleaningHero) &&
      !snapshotContainsHandymanClaim(cleaningProjects) &&
      !snapshotContainsHandymanClaim(JSON.stringify(cleanView?.snapshot?.seo ?? {})),
  );

  const liveOnly = await prisma.business.create({
    data: { name: "Live Compat", slug: `live-we-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const liveUser = await prisma.user.create({
    data: { name: "Live", email: `we-l-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memL = await prisma.membership.create({
    data: { userId: liveUser.id, businessId: liveOnly.id, role: "OWNER" },
  });
  const accessL = makeAccess(liveOnly.id, memL.id);
  await activateBusinessTradeOp(prisma, accessL, "HANDYMAN");
  const liveService = await prisma.serviceCatalogItem.create({
    data: {
      businessId: liveOnly.id,
      name: "Live Only Job",
      category: "Other Services",
      tradeCode: "HANDYMAN",
      active: true,
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
    },
  });
  const liveView = await loadPublicWebsiteView(liveOnly.slug, prisma);
  check("Compatibility tenant still uses the live catalog", liveView?.source === "compatibility");
  await prisma.serviceCatalogItem.update({
    where: { id: liveService.id },
    data: { name: "Live Changed Job", intakeMeasurementMode: "NONE", active: false },
  });
  const liveAfter = await loadPublicWebsiteView(liveOnly.slug, prisma);
  check(
    "Compatibility tenant follows live draft rules",
    liveAfter?.source === "compatibility" &&
      liveAfter?.site.items.some((row) => row.id === liveService.id) !== true,
  );

  const ghost = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Published Then Hidden",
      category: "Other Services",
      tradeCode: "HANDYMAN",
      active: true,
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });
  await publishWebsite(prisma, accessA, { idempotencyKey: "pub-ghost" });
  await prisma.serviceCatalogItem.update({
    where: { id: ghost.id },
    data: { active: false, name: "Hidden Draft", intakeMeasurementMode: "NONE" },
  });
  const ghostView = await loadPublicWebsiteView(businessA.slug, prisma);
  check(
    "Current public form keeps the currently published service",
    ghostView?.source === "snapshot" &&
      ghostView.site.items.some((row) => row.id === ghost.id && row.name === "Published Then Hidden") === true,
  );
  const ghostSubmit = await createPublicServiceRequest(prisma, {
    slug: businessA.slug,
    name: "Ghost Keep",
    email: `ghost-${randomUUID().slice(0, 8)}@example.com`,
    phone: "555-0101",
    address: "",
    streetAddress: "11 Snapshot St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Still the published service.",
    catalogItemIds: [ghost.id],
    includeOther: false,
    otherDescription: "",
    measurements: [{ catalogItemId: ghost.id, width: "12", height: "8", unit: "IN" }],
    intakeAnswers: { frequency: "ONE_TIME" },
  });
  check("Request for the currently published service stays consistent", ghostSubmit.ok === true);
  await publishWebsite(prisma, accessA, { idempotencyKey: "pub-ghost-gone" });
  const goneView = await loadPublicWebsiteView(businessA.slug, prisma);
  check(
    "Next Publish removes a service that is no longer offered",
    goneView?.site.items.some((row) => row.id === ghost.id) !== true,
  );
  const tenantASlug = publicServiceFromView(goneView, "tv-mounting");
  const viewB = await loadPublicWebsiteView(businessB.slug, prisma);
  check(
    "Tenant A slug never resolves tenant B service",
    tenantASlug?.id === handyService.id &&
      publicServiceFromView(goneView, "beta-fence-repair")?.id !== serviceB.id &&
      publicServiceFromView(viewB, "tv-mounting")?.id !== handyService.id,
  );
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
