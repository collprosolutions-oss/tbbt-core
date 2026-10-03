/**
 * OWNER Facebook Page and Instagram publish for one connected social
 * destination.
 *
 * Uses the official Graph API v26.0 clients in production and a fake
 * provider in these tests. Proves OWNER authorization, tenant isolation,
 * claim-before-provider, DRAFT/planned-day refusal, retry after FAILED,
 * and that failures are never labeled PUBLISHED. Instagram uses only an
 * approved public marketing image. Google stays disconnected. No live
 * Graph API post.
 *
 * Run with:
 *   npm run test:marketing-social-publish
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for social publish checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  FACEBOOK_CONNECTED_OTHERS_DISCONNECTED_MESSAGE,
  OWNER_SOCIAL_PUBLISH_MESSAGE,
  PHOTO_PERMISSION_REVOKED_MESSAGE,
  SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE,
  SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
  SOCIAL_PUBLISH_ATTEMPT_FAILED,
  SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
  SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE,
  SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  SOCIAL_PUBLISH_DESTINATION_NOT_IMPLEMENTED_MESSAGE,
  SOCIAL_PUBLISH_EMPTY_MESSAGE,
  SOCIAL_PUBLISH_FAILED_MESSAGE,
  SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
  INSTAGRAM_SOCIAL_PUBLISH_FAILED_MESSAGE,
  INSTAGRAM_SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
  INSTAGRAM_SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
  INSTAGRAM_SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE,
  INSTAGRAM_SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE,
  SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE,
  SOCIAL_PUBLISH_PUBLIC_ASSET_REQUIRED_MESSAGE,
  SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_FOUND_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_POSTED,
  SOCIAL_PUBLISH_RESOLVE_POSTED_MESSAGE,
  SOCIAL_PUBLISH_STALE_MESSAGE,
  SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
  SOCIAL_PUBLISH_UNCONFIRMED_MS,
  canPublishMarketingToSocial,
  canResolveSocialPublishAttempt,
  composeSocialPublishMessage,
  isPublicMarketingAssetUrl,
  sanitizeSocialPublishProviderError,
  selectPublicMarketingAssetUrl,
  socialPublishAttemptLiveKey,
  socialPublishDisplay,
} = await import("@/lib/marketing");
const { MarketingError } = await import("@/lib/marketing-ops");
const {
  advanceMarketingContentStatus,
  createMarketingContent,
  grantJobPhotoMarketingPermission,
  planStudioPublicationDay,
} = await import("@/lib/marketing-ops");
const {
  missingMarketingSocialPublishSchema,
  publishMarketingContentToSocial,
  resolveMarketingSocialPublishAttempt,
} = await import("@/lib/marketing-social-publish");
const { loadMarketingSource } = await import("@/lib/marketing-data");
const { createFakeSocialPublishingProvider } = await import("@/lib/social-publishing/fake");
const { createFacebookSocialPublishingProvider } = await import("@/lib/social-publishing/facebook");
const {
  createInstagramSocialPublishingProvider,
  instagramMediaContainerUrl,
  instagramMediaPublishUrl,
} = await import("@/lib/social-publishing/instagram");
const {
  FACEBOOK_GRAPH_API_HOST,
  FACEBOOK_GRAPH_API_VERSION,
  facebookPageFeedUrl,
  isFakeSocialPublishingAdapterEnabled,
} = await import("@/lib/social-publishing");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const previousFake = process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER;
delete process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER;

const opsSrc = readSrc("src/lib/marketing-social-publish.ts");
const facebookSrc = readSrc("src/lib/social-publishing/facebook.ts");
const instagramSrc = readSrc("src/lib/social-publishing/instagram.ts");
const fakeSrc = readSrc("src/lib/social-publishing/fake.ts");
const actionSrc = readSrc("src/app/actions/marketing.ts");
const buttonSrc = readSrc("src/components/marketing/publish-social-button.tsx");
const workspaceSrc = readSrc("src/components/marketing/marketing-workspace.tsx");
const dataSrc = readSrc("src/lib/marketing-data.ts");
const migrationSql = readSrc(
  "prisma/migrations/20261002182000_marketing_social_publish/migration.sql",
);
const leakNeedle = (value) =>
  typeof value === "string" && (/EAA[A-Za-z0-9]+/.test(value) || value.includes("fake-page-token"));

function createReleaseBarrier(count) {
  let released;
  const gate = new Promise((resolve) => {
    released = resolve;
  });
  let arrived = 0;
  return {
    wait() {
      arrived += 1;
      if (arrived >= count) released();
      return gate;
    },
  };
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_social_publish_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for social publish test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const raceClientA = new PrismaClient({ datasourceUrl: testUrl });
const raceClientB = new PrismaClient({ datasourceUrl: testUrl });
const raceClientC = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, user: { id: userId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

async function approvePackage(db, owner, admin, input) {
  const draft = await createMarketingContent(db, admin, input);
  await advanceMarketingContentStatus(db, owner, { contentId: draft.id });
  const approved = await advanceMarketingContentStatus(db, owner, { contentId: draft.id });
  return approved;
}

try {
  console.log("\nSTATIC — Reserved migration and official Facebook Graph API");
  check(
    "Reserved migration folder is exactly 20261002182000_marketing_social_publish",
    existsSync(join(root, "prisma/migrations/20261002182000_marketing_social_publish/migration.sql")) &&
      !existsSync(join(root, "prisma/migrations/20261002180000_marketing_social_publish/migration.sql")),
  );
  check(
    "Social publish migration is additive IF NOT EXISTS",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSql) &&
      migrationSql.includes('CREATE TABLE IF NOT EXISTS "MarketingSocialDestination"') &&
      migrationSql.includes('CREATE TABLE IF NOT EXISTS "MarketingSocialPublishAttempt"') &&
      migrationSql.includes("20261002182000") &&
      migrationSql.includes("20261002050000_job_project_link"),
  );
  check(
    "Official provider uses current Graph API v26.0 Page feed",
    FACEBOOK_GRAPH_API_VERSION === "v26.0" &&
      FACEBOOK_GRAPH_API_HOST === "https://graph.facebook.com" &&
      facebookPageFeedUrl("123") === "https://graph.facebook.com/v26.0/123/feed" &&
      facebookSrc.includes("pages_manage_posts") &&
      facebookSrc.includes("/{page-id}/feed"),
  );
  check(
    "Official Instagram provider uses current Graph API v26.0 media publish",
    instagramMediaContainerUrl("178414") === "https://graph.facebook.com/v26.0/178414/media" &&
      instagramMediaPublishUrl("178414") === "https://graph.facebook.com/v26.0/178414/media_publish" &&
      instagramSrc.includes("image_url") &&
      instagramSrc.includes("media_publish") &&
      instagramSrc.includes("instagram-api/guides/content-publishing") &&
      !instagramSrc.includes("graph.instagram.com"),
  );
  check(
    "Public marketing asset helper refuses private job and signed URLs",
    isPublicMarketingAssetUrl("https://example.test/after.jpg") === true &&
      isPublicMarketingAssetUrl("/api/storage/public/asset1") === true &&
      isPublicMarketingAssetUrl("/api/storage/private/secret") === false &&
      isPublicMarketingAssetUrl("https://bucket.test/photo.jpg?X-Amz-Signature=abc") === false &&
      isPublicMarketingAssetUrl("https://example.test/api/storage/private/secret") === false &&
      selectPublicMarketingAssetUrl([
        { approved: true, url: "https://example.test/api/storage/private/secret", visibility: "PRIVATE", category: "JOB_PHOTO" },
        { approved: true, url: "https://example.test/public.jpg" },
      ]) === "https://example.test/public.jpg" &&
      selectPublicMarketingAssetUrl([
        { approved: true, url: "https://example.test/customer.jpg", category: "CUSTOMER_PHOTO", visibility: "PRIVATE" },
      ]) === null,
  );
  check(
    "Fake adapter cannot enable in Vercel production",
    isFakeSocialPublishingAdapterEnabled() === false,
  );
  const previousVercel = process.env.VERCEL_ENV;
  process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER = "fake";
  process.env.VERCEL_ENV = "production";
  check(
    "Vercel production ignores the fake social adapter",
    isFakeSocialPublishingAdapterEnabled() === false,
  );
  delete process.env.VERCEL_ENV;
  if (previousVercel != null) process.env.VERCEL_ENV = previousVercel;
  delete process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER;
  check(
    "Ops fail closed without request-time DDL",
    opsSrc.includes("missingMarketingSocialPublishSchema") &&
      !opsSrc.includes("$executeRawUnsafe") &&
      !opsSrc.includes("ALTER TABLE") &&
      !opsSrc.includes("CREATE TABLE") &&
      !opsSrc.includes("ADD COLUMN"),
  );
  check(
    "OWNER may publish; ADMIN and MEMBER cannot",
    canPublishMarketingToSocial({
      role: "OWNER",
      status: "APPROVED",
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      destinationConnected: true,
      photos: [{ approved: true }],
    }) === true &&
      canPublishMarketingToSocial({
        role: "ADMIN",
        status: "APPROVED",
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        destinationConnected: true,
        photos: [{ approved: true }],
      }) === false &&
      canPublishMarketingToSocial({
        role: "MEMBER",
        status: "APPROVED",
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        destinationConnected: true,
        photos: [{ approved: true }],
      }) === false &&
      canPublishMarketingToSocial({
        role: "OWNER",
        status: "APPROVED",
        destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
        destinationConnected: true,
        photos: [{ approved: true, url: "https://example.test/after.jpg" }],
      }) === true &&
      canPublishMarketingToSocial({
        role: "OWNER",
        status: "APPROVED",
        destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
        destinationConnected: true,
        photos: [{ approved: true, url: "/api/storage/private/secret", visibility: "PRIVATE" }],
      }) === false,
  );
  check(
    "DRAFT and planned-only packages cannot publish",
    canPublishMarketingToSocial({
      role: "OWNER",
      status: "DRAFT",
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      destinationConnected: true,
      photos: [{ approved: true }],
    }) === false &&
      canPublishMarketingToSocial({
        role: "OWNER",
        status: "READY_FOR_REVIEW",
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        destinationConnected: true,
        photos: [{ approved: true }],
      }) === false,
  );
  check(
    "Failed and in-flight attempts are not displayed as PUBLISHED",
    socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_FAILED).published === false &&
      socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_FAILED).label === SOCIAL_PUBLISH_FAILED_MESSAGE &&
      socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_CLAIMED).published === false &&
      socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_CLAIMED).inFlight === true &&
      socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_CLAIMED).label === SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE &&
      socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_PUBLISHED).published === true &&
      socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_PUBLISHED).label === SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
  );
  const agedClaimedAt = new Date(Date.now() - SOCIAL_PUBLISH_UNCONFIRMED_MS - 1000);
  const agedDisplay = socialPublishDisplay({
    status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
    claimedAt: agedClaimedAt,
  });
  check(
    "Aged CLAIMED is Unconfirmed, not in-flight PUBLISHED",
    agedDisplay.published === false &&
      agedDisplay.unconfirmed === true &&
      agedDisplay.inFlight === false &&
      agedDisplay.label === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE &&
      canResolveSocialPublishAttempt({
        role: "OWNER",
        status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
        claimedAt: agedClaimedAt,
      }) === true &&
      canResolveSocialPublishAttempt({
        role: "ADMIN",
        status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
        claimedAt: agedClaimedAt,
      }) === false,
  );
  const specialToken = "EAAGPage+Token/xyz";
  const encodedToken = encodeURIComponent(specialToken);
  const sanitizedEncoded = sanitizeSocialPublishProviderError(
    `url?access_token=${encodedToken}&other=1 token ${specialToken}`,
    specialToken,
  );
  check(
    "Sanitizer redacts the Page token and EAA tokens and caps length",
    sanitizeSocialPublishProviderError(
      `invalid token fake-page-token and EAAGCopiedTokenXYZ ${"x".repeat(300)}`,
      "fake-page-token",
    ) ===
      sanitizeSocialPublishProviderError(
        `invalid token [redacted] and [redacted] ${"x".repeat(300)}`,
      ) &&
      !sanitizeSocialPublishProviderError(
        `invalid token fake-page-token and EAAGCopiedTokenXYZ`,
        "fake-page-token",
      ).includes("fake-page-token") &&
      !/EAA[A-Za-z0-9]+/.test(
        sanitizeSocialPublishProviderError("Graph error EAAGCopiedTokenXYZ", "unused"),
      ) &&
      sanitizeSocialPublishProviderError(`token EAAGCopiedTokenXYZ ${"n".repeat(400)}`).length === 200 &&
      !sanitizedEncoded.includes(specialToken) &&
      !sanitizedEncoded.includes(encodedToken) &&
      sanitizedEncoded.includes("access_token=[redacted]"),
  );
  check(
    "Missing schema detector stays scoped to social publish tables",
    missingMarketingSocialPublishSchema({
      code: "P2021",
      message: "The table `MarketingSocialPublishAttempt` does not exist in the current database.",
    }) &&
      missingMarketingSocialPublishSchema({
        code: "P2022",
        message: "The column `MarketingSocialDestination.accessToken` does not exist in the current database.",
      }) &&
      !missingMarketingSocialPublishSchema({
        code: "P2002",
        message: "Unique constraint failed on the fields: (`MarketingSocialPublishAttempt`)",
      }) &&
      !missingMarketingSocialPublishSchema({
        code: "P2021",
        message: "The table `WebsitePublish` does not exist in the current database.",
      }),
  );
  check(
    "Workspace exposes explicit OWNER Publish to Facebook and Instagram actions",
    workspaceSrc.includes("PublishSocialButton") &&
      workspaceSrc.includes("canPublishMarketingToSocial") &&
      workspaceSrc.includes("SOCIAL_PUBLISH_DESTINATION_INSTAGRAM") &&
      workspaceSrc.includes("studioPhotosHavePublicMarketingAsset") &&
      buttonSrc.includes("Publish to Facebook") &&
      buttonSrc.includes("Retry Facebook publish") &&
      buttonSrc.includes("Publish to Instagram") &&
      buttonSrc.includes("Retry Instagram publish") &&
      buttonSrc.includes("SOCIAL_PUBLISH_DESTINATION_FACEBOOK") &&
      buttonSrc.includes("SOCIAL_PUBLISH_DESTINATION_INSTAGRAM") &&
      actionSrc.includes("publishMarketingContentToSocial") &&
      buttonSrc.includes("Not posted, allow retry") &&
      buttonSrc.includes("It posted") &&
      actionSrc.includes("resolveMarketingSocialPublishAttempt"),
  );
  check(
    "Page loader never selects an access token",
    dataSrc.includes("loadMarketingSocialDestinations") &&
      !dataSrc.includes("accessToken") &&
      opsSrc.includes("select: { destination: true, pageId: true }"),
  );
  check(
    "Dedicated tests use a fake provider and do not post to Graph API",
    fakeSrc.includes("createFakeSocialPublishingProvider") &&
      !fakeSrc.includes("graph.facebook.com") &&
      facebookSrc.includes("FACEBOOK_SOCIAL_PUBLISHING_PROVIDER") &&
      facebookSrc.includes("graph.facebook.com") &&
      instagramSrc.includes("INSTAGRAM_SOCIAL_PUBLISHING_PROVIDER") &&
      instagramSrc.includes("graph.facebook.com"),
  );
  check(
    "Caption plus hashtags compose the Facebook message",
    composeSocialPublishMessage({ caption: "Work completed.", hashtags: "Reno" }) ===
      "Work completed.\n\n#Reno",
  );

  const graphToken = "EAAGPageTokenLeakXYZ999";
  const graphRejected = await createFacebookSocialPublishingProvider(async () => ({
    ok: false,
    status: 400,
    async json() {
      return { error: { message: `Invalid OAuth access token ${graphToken}` } };
    },
  })).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    pageId: "111",
    accessToken: graphToken,
    message: "hello",
  });
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  const graphTimeout = await createFacebookSocialPublishingProvider(async () => {
    throw abortError;
  }).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    pageId: "111",
    accessToken: graphToken,
    message: "hello",
  });
  const graphNetwork = await createFacebookSocialPublishingProvider(async () => {
    throw new Error(`fetch failed ${graphToken}`);
  }).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    pageId: "111",
    accessToken: graphToken,
    message: "hello",
  });
  check(
    "Graph HTTP rejection is FAILED/rejected and redacts the Page token",
    graphRejected.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      graphRejected.outcome === "rejected" &&
      graphRejected.ok === false &&
      !graphRejected.error.includes(graphToken) &&
      graphRejected.error.includes("[redacted]"),
  );
  check(
    "Graph timeout or network error is UNKNOWN and keeps the token out",
    graphTimeout.status === "UNKNOWN" &&
      graphTimeout.outcome === "unknown" &&
      graphNetwork.status === "UNKNOWN" &&
      graphNetwork.outcome === "unknown" &&
      !graphTimeout.error.includes(graphToken) &&
      !graphNetwork.error.includes(graphToken),
  );

  const igGraphCalls = [];
  const igGraphPublished = await createInstagramSocialPublishingProvider(async (url, init) => {
    igGraphCalls.push({ url: String(url), body: String(init.body) });
    if (String(url).includes("/media_publish")) {
      return { ok: true, status: 200, async json() { return { id: "ig_media_ok" }; } };
    }
    return { ok: true, status: 200, async json() { return { id: "ig_container_ok" }; } };
  }).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
    pageId: "178414000",
    accessToken: graphToken,
    message: "Public work completed.",
    imageUrl: "https://example.test/public.jpg",
  });
  const igGraphRejected = await createInstagramSocialPublishingProvider(async () => ({
    ok: false,
    status: 400,
    async json() {
      return { error: { message: `Invalid OAuth access token ${graphToken}` } };
    },
  })).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
    pageId: "178414000",
    accessToken: graphToken,
    message: "hello",
    imageUrl: "https://example.test/public.jpg",
  });
  const igGraphTimeout = await createInstagramSocialPublishingProvider(async () => {
    throw abortError;
  }).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
    pageId: "178414000",
    accessToken: graphToken,
    message: "hello",
    imageUrl: "https://example.test/public.jpg",
  });
  const igGraphPrivate = await createInstagramSocialPublishingProvider(async () => {
    throw new Error("live Graph must not be called");
  }).publish({
    destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
    pageId: "178414000",
    accessToken: graphToken,
    message: "hello",
    imageUrl: "https://example.test/api/storage/private/secret",
  });
  check(
    "Instagram Graph success uses fake Meta container then publish",
    igGraphPublished.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      igGraphPublished.providerPostId === "ig_media_ok" &&
      igGraphCalls.length === 2 &&
      igGraphCalls[0].url === instagramMediaContainerUrl("178414000") &&
      igGraphCalls[1].url === instagramMediaPublishUrl("178414000") &&
      igGraphCalls[0].body.includes("image_url=https%3A%2F%2Fexample.test%2Fpublic.jpg") &&
      igGraphCalls[0].body.includes("access_token"),
  );
  check(
    "Instagram Graph HTTP rejection is FAILED and redacts the token",
    igGraphRejected.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      igGraphRejected.outcome === "rejected" &&
      !igGraphRejected.error.includes(graphToken) &&
      igGraphRejected.error.includes("[redacted]"),
  );
  check(
    "Instagram timeout is UNKNOWN and a private URL never reaches Graph",
    igGraphTimeout.status === "UNKNOWN" &&
      !igGraphTimeout.error.includes(graphToken) &&
      igGraphPrivate.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      igGraphPrivate.outcome === "rejected",
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Social", slug: `alpha-soc-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Social", slug: `beta-soc-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-soc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-soc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-soc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-soc-${randomUUID()}@example.com`, passwordHash: "x" },
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
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id, betaOwner.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const photo = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "AFTER",
      url: "https://example.test/after.jpg",
      caption: "Ada cell 555-0100",
    },
  });
  await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: photo.id });
  await prisma.marketingSocialDestination.create({
    data: {
      businessId: businessA.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      pageId: "111222333",
      accessToken: "fake-page-token",
    },
  });

  const packageInput = {
    contentType: "COMPLETED_JOB",
    title: "Reno faucet post",
    body: "Faucet repair completed in Reno.",
    channelIntent: "FACEBOOK",
    jobId: job.id,
    photoIds: [photo.id],
    hashtags: "Reno faucetrepair",
  };

  console.log("\nTEST — DRAFT or merely planned day never publishes");
  const draft = await createMarketingContent(prisma, adminA, packageInput);
  const plannedDraft = await planStudioPublicationDay(prisma, ownerA, {
    contentId: draft.id,
    plannedFor: "2026-10-08",
    expectedUpdatedAt: draft.updatedAt,
  });
  const plannedDraftCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Planned DRAFT never reaches the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: draft.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: plannedDraft.updatedAt,
        },
        { provider: plannedDraftCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE &&
      plannedDraftCalls.published.length === 0,
  );
  await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  const readyRow = await prisma.marketingContent.findFirst({
    where: { id: draft.id, businessId: businessA.id },
  });
  const plannedReady = await planStudioPublicationDay(prisma, ownerA, {
    contentId: draft.id,
    plannedFor: "2026-10-09",
    expectedUpdatedAt: readyRow.updatedAt,
  });
  await expectError(
    "Planned READY_FOR_REVIEW never reaches the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: draft.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: plannedReady.updatedAt,
        },
        { provider: plannedDraftCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE &&
      plannedDraftCalls.published.length === 0,
  );
  const draftStatus = await prisma.marketingContent.findFirst({
    where: { id: draft.id, businessId: businessA.id },
    select: { status: true },
  });
  check("Planned draft/review rows stay off PUBLISHED content status", draftStatus.status !== "PUBLISHED");

  console.log("\nTEST — Permission, tenant, disconnected destinations");
  const approved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Approved Facebook post",
  });
  await expectError(
    "ADMIN cannot publish",
    () =>
      publishMarketingContentToSocial(
        prisma,
        adminA,
        {
          contentId: approved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: approved.updatedAt,
        },
        { provider: createFakeSocialPublishingProvider() },
      ),
    (error) => error instanceof MarketingError && error.message === OWNER_SOCIAL_PUBLISH_MESSAGE,
  );
  await expectError(
    "MEMBER cannot publish",
    () =>
      publishMarketingContentToSocial(
        prisma,
        memberA,
        {
          contentId: approved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: approved.updatedAt,
        },
        { provider: createFakeSocialPublishingProvider() },
      ),
    (error) =>
      (error instanceof MarketingError && error.message === OWNER_SOCIAL_PUBLISH_MESSAGE) ||
      error instanceof ForbiddenError,
  );
  const tenantCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Business B cannot publish A's package",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerB,
        {
          contentId: approved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: approved.updatedAt,
        },
        { provider: tenantCalls },
      ),
    (error) => error instanceof Error && tenantCalls.published.length === 0,
  );
  const instagramCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Instagram without a connected destination never calls the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: approved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
          expectedUpdatedAt: approved.updatedAt,
        },
        { provider: instagramCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === INSTAGRAM_SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE &&
      instagramCalls.published.length === 0,
  );
  await expectError(
    "Google stays disconnected and never calls the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: approved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_GOOGLE,
          expectedUpdatedAt: approved.updatedAt,
        },
        { provider: instagramCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_DESTINATION_NOT_IMPLEMENTED_MESSAGE,
  );

  const disconnectedBusiness = await prisma.business.create({
    data: {
      name: "No Destination",
      slug: `none-soc-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const disconnectedUser = await prisma.user.create({
    data: { name: "No Dest Owner", email: `none-soc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const disconnectedMem = await prisma.membership.create({
    data: { userId: disconnectedUser.id, businessId: disconnectedBusiness.id, role: "OWNER" },
  });
  const disconnectedAccess = makeAccess(
    disconnectedBusiness.id,
    "OWNER",
    disconnectedMem.id,
    disconnectedUser.id,
  );
  const disconnectedCustomer = await prisma.customer.create({
    data: { businessId: disconnectedBusiness.id, name: "Ned" },
  });
  const disconnectedJob = await prisma.job.create({
    data: {
      businessId: disconnectedBusiness.id,
      customerId: disconnectedCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const disconnectedPhoto = await prisma.jobPhoto.create({
    data: {
      businessId: disconnectedBusiness.id,
      jobId: disconnectedJob.id,
      stage: "AFTER",
      url: "https://example.test/none.jpg",
      marketingPermissionStatus: "APPROVED",
    },
  });
  const disconnectedApproved = await approvePackage(prisma, disconnectedAccess, disconnectedAccess, {
    contentType: "GENERAL_POST",
    title: "No destination",
    body: "Should not post.",
    photoIds: [disconnectedPhoto.id],
  });
  const disconnectedCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Missing Facebook destination never calls the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        disconnectedAccess,
        {
          contentId: disconnectedApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: disconnectedApproved.updatedAt,
        },
        { provider: disconnectedCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE &&
      disconnectedCalls.published.length === 0,
  );

  console.log("\nTEST — Stale snapshot is refused before the provider");
  const staleApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Stale snapshot post",
  });
  const staleBefore = staleApproved.updatedAt;
  await planStudioPublicationDay(prisma, ownerA, {
    contentId: staleApproved.id,
    plannedFor: "2026-10-12",
    expectedUpdatedAt: staleBefore,
  });
  const staleCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Stale content snapshot never calls the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: staleApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: staleBefore,
        },
        { provider: staleCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_STALE_MESSAGE &&
      staleCalls.published.length === 0,
  );

  console.log("\nTEST — Fake provider records failures without PUBLISHED");
  const failApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Fail then retry",
  });
  const failing = createFakeSocialPublishingProvider();
  failing.setFailNext(true);
  const failed = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: failApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: failApproved.updatedAt,
    },
    { provider: failing },
  );
  const failedRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: failed.attemptId, businessId: businessA.id },
  });
  const failedContent = await prisma.marketingContent.findFirst({
    where: { id: failApproved.id, businessId: businessA.id },
  });
  check(
    "Provider rejection is FAILED and not PUBLISHED",
    failed.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      failed.published === false &&
      failed.posted === false &&
      failed.message.includes(SOCIAL_PUBLISH_FAILED_MESSAGE) &&
      failedRow?.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      failedRow.liveKey == null &&
      failedContent?.status === "APPROVED" &&
      failing.published.length === 0,
  );

  const retried = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: failApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: failApproved.updatedAt,
    },
    { provider: failing },
  );
  check(
    "Retry after FAILED calls the provider once and can publish",
    retried.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      retried.published === true &&
      retried.message === SOCIAL_PUBLISH_PUBLISHED_MESSAGE &&
      failing.published.length === 1 &&
      failing.published[0].pageId === "111222333" &&
      failing.published[0].message.includes("Faucet repair completed in Reno."),
  );
  const afterRetry = await prisma.marketingContent.findFirst({
    where: { id: failApproved.id, businessId: businessA.id },
  });
  check("Successful publish does not rewrite MarketingContent.status to PUBLISHED", afterRetry.status === "APPROVED");

  console.log("\nTEST — Duplicate click claims once");
  const dupApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Duplicate click post",
  });
  const dupProvider = createFakeSocialPublishingProvider();
  let releaseSecond;
  const hold = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const firstClaim = publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: dupApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: dupApproved.updatedAt,
    },
    { provider: dupProvider, beforeProvider: () => hold },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  let duplicateError = null;
  try {
    await publishMarketingContentToSocial(
      prisma,
      ownerA,
      {
        contentId: dupApproved.id,
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        expectedUpdatedAt: dupApproved.updatedAt,
      },
      { provider: dupProvider },
    );
  } catch (error) {
    duplicateError = error;
  }
  releaseSecond();
  const firstResult = await firstClaim;
  check(
    "Second click is refused as in-flight or already published",
    duplicateError instanceof MarketingError &&
      (duplicateError.message === SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE ||
        duplicateError.message === SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE),
  );
  check(
    "Provider is called once for the claimed attempt",
    firstResult.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      firstResult.published === true &&
      dupProvider.published.length === 1,
  );
  await expectError(
    "A later click after PUBLISHED does not post again",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: dupApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: dupApproved.updatedAt,
        },
        { provider: dupProvider },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE &&
      dupProvider.published.length === 1,
  );

  console.log("\nTEST — Empty text and revoked photos fail closed");
  const emptyApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Empty caption",
    body: "   ",
    hashtags: "",
  });
  const emptyCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Empty approved text never calls the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: emptyApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: emptyApproved.updatedAt,
        },
        { provider: emptyCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_EMPTY_MESSAGE &&
      emptyCalls.published.length === 0,
  );

  const revokeApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Revoked photo post",
  });
  await prisma.jobPhoto.update({
    where: { id: photo.id },
    data: { marketingPermissionStatus: "PRIVATE" },
  });
  const revokeCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Revoked photo blocks publish before the provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: revokeApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: revokeApproved.updatedAt,
        },
        { provider: revokeCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === PHOTO_PERMISSION_REVOKED_MESSAGE &&
      revokeCalls.published.length === 0,
  );
  await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: photo.id });

  console.log("\nTEST — Loader presents connected Facebook and keeps others disconnected");
  const sourceA = await loadMarketingSource(prisma, businessA.id, new Date(), "OWNER");
  const sourceB = await loadMarketingSource(prisma, businessB.id, new Date(), "OWNER");
  const publishedRow = sourceA.contents.find((row) => row.id === failApproved.id);
  const failedDisplay = socialPublishDisplay(SOCIAL_PUBLISH_ATTEMPT_FAILED);
  check(
    "Tenant A shows Facebook connected and Instagram/Google disconnected",
    sourceA.channels.connected === true &&
      sourceA.channels.message === FACEBOOK_CONNECTED_OTHERS_DISCONNECTED_MESSAGE &&
      sourceA.channels.destinations.FACEBOOK.connected === true &&
      sourceA.channels.destinations.INSTAGRAM.connected === false &&
      sourceA.channels.destinations.GOOGLE.connected === false &&
      sourceA.channels.destinations.INSTAGRAM.implemented === true &&
      sourceA.channels.destinations.GOOGLE.implemented === false,
  );
  check(
    "Published attempt is labeled PUBLISHED only after a provider success",
    publishedRow?.socialPublish.published === true &&
      publishedRow.socialPublish.attemptStatus === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      publishedRow.socialPublish.label === SOCIAL_PUBLISH_PUBLISHED_MESSAGE &&
      publishedRow.status === "APPROVED",
  );
  check("Tenant B does not see A's packages or destination", sourceB.contents.length === 0 && sourceB.channels.connected === false);
  check(
    "Display helper never calls a failure PUBLISHED",
    failedDisplay.published === false && failedDisplay.label !== SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
  );

  const throwing = createFakeSocialPublishingProvider();
  throwing.setThrowNext(true);
  const throwApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Provider throw",
  });
  const thrown = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: throwApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: throwApproved.updatedAt,
    },
    { provider: throwing },
  );
  const thrownRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: thrown.attemptId, businessId: businessA.id },
  });
  check(
    "Provider throw is unconfirmed and keeps liveKey",
    thrown.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
      thrown.published === false &&
      thrown.unconfirmed === true &&
      thrown.message === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE &&
      thrownRow?.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
      thrownRow.liveKey === socialPublishAttemptLiveKey(throwApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK) &&
      thrownRow.failureLabel === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE &&
      throwing.published.length === 0,
  );

  console.log("\nTEST — Claim is written before the provider is called");
  const claimApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Claim before provider",
  });
  const claimProvider = createFakeSocialPublishingProvider();
  let claimedBeforeProvider = false;
  const claimed = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: claimApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: claimApproved.updatedAt,
    },
    {
      provider: claimProvider,
      beforeProvider: async () => {
        const row = await prisma.marketingSocialPublishAttempt.findFirst({
          where: { contentId: claimApproved.id, businessId: businessA.id },
        });
        claimedBeforeProvider =
          row?.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
          row.liveKey === socialPublishAttemptLiveKey(claimApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK);
      },
    },
  );
  check(
    "Claim writes CLAIMED before the provider is called",
    claimedBeforeProvider === true &&
      claimed.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      claimProvider.callCount === 1,
  );

  console.log("\nTEST — Token-bearing provider errors are redacted");
  const leakApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Token leak post",
  });
  const leakToken = "EAAGFakePageTokenLeak999xyz";
  await prisma.marketingSocialDestination.update({
    where: {
      businessId_destination: {
        businessId: businessA.id,
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      },
    },
    data: { accessToken: leakToken },
  });
  const leaking = createFakeSocialPublishingProvider();
  leaking.setLeakNext(true);
  const leaked = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: leakApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: leakApproved.updatedAt,
    },
    { provider: leaking },
  );
  const leakedRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: leaked.attemptId, businessId: businessA.id },
  });
  const leakSource = await loadMarketingSource(prisma, businessA.id, new Date(), "OWNER");
  const leakLoaded = leakSource.contents.find((row) => row.id === leakApproved.id);
  const leakHaystack = [
    leaked.message,
    leaked.failureLabel,
    leakedRow?.providerError,
    leakedRow?.failureLabel,
    leakLoaded?.socialPublish.label,
    JSON.stringify(leakSource),
  ];
  check(
    "Token-bearing provider error never appears in DB rows, return value, or loadMarketingSource",
    leaked.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      leaked.published === false &&
      leakedRow?.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      leakHaystack.every((value) => value == null || !leakNeedle(String(value))) &&
      String(leakedRow?.providerError ?? "").includes("[redacted]") &&
      String(leaked.failureLabel ?? "").includes("[redacted]"),
  );
  const throwTokenApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Throw token post",
  });
  const thrownToken = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: throwTokenApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: throwTokenApproved.updatedAt,
    },
    {
      provider: {
        id: "fake-throw-token",
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        connected: true,
        async publish(input) {
          throw new Error(`Graph exploded ${input.accessToken} access_token=${input.accessToken}`);
        },
      },
    },
  );
  const thrownTokenRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: thrownToken.attemptId, businessId: businessA.id },
  });
  check(
    "Thrown provider error containing the token is redacted in DB and return value",
    thrownToken.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
      thrownToken.unconfirmed === true &&
      !leakNeedle(thrownToken.message) &&
      !leakNeedle(thrownToken.failureLabel) &&
      !leakNeedle(thrownTokenRow?.providerError) &&
      !leakNeedle(thrownTokenRow?.failureLabel) &&
      String(thrownTokenRow?.providerError ?? "").includes("[redacted]"),
  );
  await prisma.marketingSocialDestination.update({
    where: {
      businessId_destination: {
        businessId: businessA.id,
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      },
    },
    data: { accessToken: "fake-page-token" },
  });

  console.log("\nTEST — Graph response shapes persist only definite rejections as FAILED");
  function makeFacebookFetch(spec) {
    return async () => {
      if (spec.kind === "abort") {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      }
      if (spec.kind === "network") {
        throw new Error("fetch failed");
      }
      return {
        ok: spec.ok,
        status: spec.status,
        async json() {
          if (spec.badJson) throw new SyntaxError("Unexpected end of JSON input");
          return spec.json ?? null;
        },
      };
    };
  }
  const graphPersistCases = [
    {
      name: "400+error",
      ok: false,
      status: 400,
      json: { error: { message: "Invalid OAuth access token" } },
      providerStatus: SOCIAL_PUBLISH_ATTEMPT_FAILED,
      outcome: "rejected",
      stored: SOCIAL_PUBLISH_ATTEMPT_FAILED,
      keepLiveKey: false,
      refuseRetry: false,
    },
    {
      name: "500",
      ok: false,
      status: 500,
      json: { error: { message: "internal error" } },
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
    {
      name: "502",
      ok: false,
      status: 502,
      json: {},
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
    {
      name: "504",
      ok: false,
      status: 504,
      json: { error: { message: "gateway timeout" } },
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
    {
      name: "200 no id",
      ok: true,
      status: 200,
      json: {},
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
    {
      name: "200 bad JSON",
      ok: true,
      status: 200,
      badJson: true,
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
    {
      name: "abort",
      kind: "abort",
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
    {
      name: "network error",
      kind: "network",
      providerStatus: "UNKNOWN",
      outcome: "unknown",
      stored: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      keepLiveKey: true,
      refuseRetry: true,
    },
  ];
  for (const spec of graphPersistCases) {
    const fetchImpl = makeFacebookFetch(spec);
    const raw = await createFacebookSocialPublishingProvider(fetchImpl).publish({
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      pageId: "111222333",
      accessToken: "fake-page-token",
      message: "hello",
    });
    check(
      `Graph ${spec.name} provider result is ${spec.providerStatus}/${spec.outcome}`,
      raw.status === spec.providerStatus && raw.outcome === spec.outcome && raw.ok === false,
    );
    const shapeApproved = await approvePackage(prisma, ownerA, adminA, {
      ...packageInput,
      title: `Graph shape ${spec.name}`,
    });
    const persisted = await publishMarketingContentToSocial(
      prisma,
      ownerA,
      {
        contentId: shapeApproved.id,
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        expectedUpdatedAt: shapeApproved.updatedAt,
      },
      { provider: createFacebookSocialPublishingProvider(fetchImpl) },
    );
    const persistedRow = await prisma.marketingSocialPublishAttempt.findFirst({
      where: { id: persisted.attemptId, businessId: businessA.id },
    });
    const expectedLiveKey = spec.keepLiveKey
      ? socialPublishAttemptLiveKey(shapeApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK)
      : null;
    check(
      `Graph ${spec.name} stores ${spec.stored} with liveKey ${spec.keepLiveKey ? "kept" : "cleared"}`,
      persisted.status === spec.stored &&
        persistedRow?.status === spec.stored &&
        persistedRow.liveKey === expectedLiveKey &&
        persisted.published === false,
    );
    const retryShape = createFakeSocialPublishingProvider();
    if (spec.refuseRetry) {
      await expectError(
        `Graph ${spec.name} refuses Retry while unconfirmed`,
        () =>
          publishMarketingContentToSocial(
            prisma,
            ownerA,
            {
              contentId: shapeApproved.id,
              destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
              expectedUpdatedAt: shapeApproved.updatedAt,
            },
            { provider: retryShape },
          ),
        (error) =>
          error instanceof MarketingError &&
          error.message === SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE &&
          retryShape.callCount === 0,
      );
    } else {
      const retriedShape = await publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: shapeApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: shapeApproved.updatedAt,
        },
        { provider: retryShape },
      );
      check(
        `Graph ${spec.name} allows Retry after a definite rejection`,
        retriedShape.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
          retriedShape.published === true &&
          retryShape.callCount === 1,
      );
    }
  }

  console.log("\nTEST — Unknown outcome and aged CLAIMED recovery");
  const unknownApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Unknown outcome post",
  });
  const unknowning = createFakeSocialPublishingProvider();
  unknowning.setUnknownNext(true);
  const unknownResult = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: unknownApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: unknownApproved.updatedAt,
    },
    { provider: unknowning },
  );
  const unknownRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: unknownResult.attemptId, businessId: businessA.id },
  });
  check(
    "Timeout/unknown outcome stays CLAIMED with liveKey",
    unknownResult.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
      unknownResult.unconfirmed === true &&
      unknownResult.message === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE &&
      unknownRow?.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
      unknownRow.liveKey ===
        socialPublishAttemptLiveKey(unknownApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK) &&
      unknownRow.failureLabel === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE &&
      unknowning.published.length === 0,
  );
  const unknownRetry = createFakeSocialPublishingProvider();
  await expectError(
    "CLAIMED unknown outcome refuses retry until resolved",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: unknownApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: unknownApproved.updatedAt,
        },
        { provider: unknownRetry },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE &&
      unknownRetry.callCount === 0,
  );
  const resolvedUnknown = await resolveMarketingSocialPublishAttempt(prisma, ownerA, {
    attemptId: unknownResult.attemptId,
    resolution: SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
  });
  const resolvedUnknownRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: unknownResult.attemptId, businessId: businessA.id },
  });
  check(
    "OWNER Not posted, allow retry clears liveKey and marks FAILED",
    resolvedUnknown.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      resolvedUnknown.published === false &&
      resolvedUnknown.message === SOCIAL_PUBLISH_RESOLVE_NOT_POSTED_MESSAGE &&
      resolvedUnknownRow?.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      resolvedUnknownRow.liveKey == null,
  );

  const agedApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Aged claimed post",
  });
  const agedClaimedAtRow = new Date(Date.now() - SOCIAL_PUBLISH_UNCONFIRMED_MS - 1500);
  const agedAttempt = await prisma.marketingSocialPublishAttempt.create({
    data: {
      businessId: businessA.id,
      contentId: agedApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      claimedAt: agedClaimedAtRow,
      expectedContentUpdatedAt: agedApproved.updatedAt,
      destinationPageId: "111222333",
      liveKey: socialPublishAttemptLiveKey(agedApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK),
      createdByMembershipId: ownerMem.id,
    },
  });
  const agedSource = await loadMarketingSource(prisma, businessA.id, new Date(), "OWNER");
  const agedLoaded = agedSource.contents.find((row) => row.id === agedApproved.id);
  const adminAgedSource = await loadMarketingSource(prisma, businessA.id, new Date(), "ADMIN");
  const adminAgedLoaded = adminAgedSource.contents.find((row) => row.id === agedApproved.id);
  check(
    "Aged CLAIMED is Unconfirmed in loadMarketingSource for OWNER resolve",
    agedLoaded?.socialPublish.attemptStatus === SOCIAL_PUBLISH_ATTEMPT_CLAIMED &&
      agedLoaded.socialPublish.unconfirmed === true &&
      agedLoaded.socialPublish.inFlight === false &&
      agedLoaded.socialPublish.canResolve === true &&
      agedLoaded.socialPublish.label === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE &&
      adminAgedLoaded?.socialPublish.unconfirmed === true &&
      adminAgedLoaded.socialPublish.canResolve === false,
  );
  const agedRetry = createFakeSocialPublishingProvider();
  await expectError(
    "Aged CLAIMED refuses another publish until confirmed",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: agedApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: agedApproved.updatedAt,
        },
        { provider: agedRetry },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE &&
      agedRetry.callCount === 0,
  );
  await expectError(
    "ADMIN cannot resolve an unconfirmed attempt",
    () =>
      resolveMarketingSocialPublishAttempt(prisma, adminA, {
        attemptId: agedAttempt.id,
        resolution: SOCIAL_PUBLISH_RESOLVE_POSTED,
      }),
    (error) => error instanceof MarketingError && error.message === OWNER_SOCIAL_PUBLISH_MESSAGE,
  );
  await expectError(
    "Business B cannot resolve A's unconfirmed attempt",
    () =>
      resolveMarketingSocialPublishAttempt(prisma, ownerB, {
        attemptId: agedAttempt.id,
        resolution: SOCIAL_PUBLISH_RESOLVE_POSTED,
      }),
    (error) => error instanceof Error,
  );
  const freshClaimed = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Fresh claimed not ready",
  });
  const freshAttempt = await prisma.marketingSocialPublishAttempt.create({
    data: {
      businessId: businessA.id,
      contentId: freshClaimed.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      claimedAt: new Date(),
      expectedContentUpdatedAt: freshClaimed.updatedAt,
      destinationPageId: "111222333",
      liveKey: socialPublishAttemptLiveKey(freshClaimed.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK),
      createdByMembershipId: ownerMem.id,
    },
  });
  await expectError(
    "Fresh CLAIMED cannot be resolved yet",
    () =>
      resolveMarketingSocialPublishAttempt(prisma, ownerA, {
        attemptId: freshAttempt.id,
        resolution: SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
      }),
    (error) =>
      error instanceof MarketingError && error.message === SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE,
  );
  const agedPostedApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Aged claimed posted",
  });
  const agedPostedAttempt = await prisma.marketingSocialPublishAttempt.create({
    data: {
      businessId: businessA.id,
      contentId: agedPostedApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      claimedAt: new Date(Date.now() - SOCIAL_PUBLISH_UNCONFIRMED_MS - 2000),
      expectedContentUpdatedAt: agedPostedApproved.updatedAt,
      destinationPageId: "111222333",
      liveKey: socialPublishAttemptLiveKey(agedPostedApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK),
      createdByMembershipId: ownerMem.id,
    },
  });
  const markedPosted = await resolveMarketingSocialPublishAttempt(prisma, ownerA, {
    attemptId: agedPostedAttempt.id,
    resolution: SOCIAL_PUBLISH_RESOLVE_POSTED,
  });
  const markedPostedRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: agedPostedAttempt.id, businessId: businessA.id },
  });
  check(
    "OWNER It posted marks aged CLAIMED as PUBLISHED and keeps liveKey",
    markedPosted.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      markedPosted.published === true &&
      markedPosted.message === SOCIAL_PUBLISH_RESOLVE_POSTED_MESSAGE &&
      markedPostedRow?.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      markedPostedRow.liveKey ===
        socialPublishAttemptLiveKey(agedPostedApproved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK),
  );
  const agedRetryAfterNotPosted = await resolveMarketingSocialPublishAttempt(prisma, ownerA, {
    attemptId: agedAttempt.id,
    resolution: SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
  });
  const retriedAfterResolve = createFakeSocialPublishingProvider();
  const retriedAged = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: agedApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: agedApproved.updatedAt,
    },
    { provider: retriedAfterResolve },
  );
  check(
    "Retry works after Not posted, allow retry",
    agedRetryAfterNotPosted.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      retriedAged.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      retriedAged.published === true &&
      retriedAfterResolve.callCount === 1,
  );
  await expectError(
    "Missing attempt cannot be resolved",
    () =>
      resolveMarketingSocialPublishAttempt(prisma, ownerA, {
        attemptId: "missing-attempt",
        resolution: SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
      }),
    (error) =>
      error instanceof MarketingError && error.message === SOCIAL_PUBLISH_RESOLVE_NOT_FOUND_MESSAGE,
  );

  console.log("\nTEST — OWNER Instagram publish uses a public marketing asset");
  await prisma.marketingSocialDestination.create({
    data: {
      businessId: businessA.id,
      destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
      pageId: "17841400000000",
      accessToken: "fake-ig-token",
    },
  });
  const igApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Instagram public asset post",
    channelIntent: "INSTAGRAM",
  });
  const igProvider = createFakeSocialPublishingProvider();
  const igPublished = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: igApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
      expectedUpdatedAt: igApproved.updatedAt,
    },
    { provider: igProvider },
  );
  const igPublishedRow = await prisma.marketingSocialPublishAttempt.findFirst({
    where: { id: igPublished.attemptId, businessId: businessA.id },
  });
  const igContent = await prisma.marketingContent.findFirst({
    where: { id: igApproved.id, businessId: businessA.id },
  });
  check(
    "Instagram publish uses the public approved image and fake Meta id",
    igPublished.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      igPublished.published === true &&
      igPublished.message === INSTAGRAM_SOCIAL_PUBLISH_PUBLISHED_MESSAGE &&
      igPublished.providerPostId.startsWith("fake_ig_") &&
      igProvider.published.length === 1 &&
      igProvider.published[0].destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM &&
      igProvider.published[0].imageUrl === "https://example.test/after.jpg" &&
      igProvider.published[0].message.includes("Faucet repair completed in Reno.") &&
      !igProvider.published[0].message.includes("555-0100") &&
      !igProvider.published[0].imageUrl.includes("private") &&
      igPublishedRow?.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      igContent?.status === "APPROVED",
  );
  await expectError(
    "Duplicate Instagram click after PUBLISHED does not post again",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: igApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
          expectedUpdatedAt: igApproved.updatedAt,
        },
        { provider: igProvider },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === INSTAGRAM_SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE &&
      igProvider.published.length === 1,
  );

  const igFailApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Instagram fail then retry",
  });
  const igFailing = createFakeSocialPublishingProvider();
  igFailing.setFailNext(true);
  const igFailed = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: igFailApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
      expectedUpdatedAt: igFailApproved.updatedAt,
    },
    { provider: igFailing },
  );
  check(
    "Instagram provider rejection is FAILED and not PUBLISHED",
    igFailed.status === SOCIAL_PUBLISH_ATTEMPT_FAILED &&
      igFailed.published === false &&
      igFailed.message.includes(INSTAGRAM_SOCIAL_PUBLISH_FAILED_MESSAGE) &&
      igFailing.published.length === 0,
  );
  const igRetried = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: igFailApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
      expectedUpdatedAt: igFailApproved.updatedAt,
    },
    { provider: igFailing },
  );
  check(
    "Instagram retry after FAILED can publish once",
    igRetried.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      igRetried.published === true &&
      igFailing.published.length === 1,
  );

  const igDupApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Instagram duplicate click",
  });
  const igDupProvider = createFakeSocialPublishingProvider();
  let releaseIgSecond;
  const holdIg = new Promise((resolve) => {
    releaseIgSecond = resolve;
  });
  const igFirstClaim = publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: igDupApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
      expectedUpdatedAt: igDupApproved.updatedAt,
    },
    { provider: igDupProvider, beforeProvider: () => holdIg },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  let igDuplicateError = null;
  try {
    await publishMarketingContentToSocial(
      prisma,
      ownerA,
      {
        contentId: igDupApproved.id,
        destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
        expectedUpdatedAt: igDupApproved.updatedAt,
      },
      { provider: igDupProvider },
    );
  } catch (error) {
    igDuplicateError = error;
  }
  releaseIgSecond();
  const igFirstResult = await igFirstClaim;
  check(
    "Instagram second click is refused as in-flight or already published",
    igDuplicateError instanceof MarketingError &&
      (igDuplicateError.message === INSTAGRAM_SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE ||
        igDuplicateError.message === INSTAGRAM_SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE),
  );
  check(
    "Instagram provider is called once for the claimed attempt",
    igFirstResult.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      igFirstResult.published === true &&
      igDupProvider.published.length === 1,
  );

  const privatePhoto = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "BEFORE",
      url: "https://example.test/api/storage/private/customer-secret",
      caption: "Ada cell 555-0100",
      marketingPermissionStatus: "APPROVED",
    },
  });
  const privateApproved = await approvePackage(prisma, ownerA, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Private job photo blocked",
    body: "Should not post private photo.",
    channelIntent: "INSTAGRAM",
    jobId: job.id,
    photoIds: [privatePhoto.id],
    hashtags: "Reno",
  });
  const privateCalls = createFakeSocialPublishingProvider();
  await expectError(
    "Private job photo is refused before Instagram provider",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: privateApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
          expectedUpdatedAt: privateApproved.updatedAt,
        },
        { provider: privateCalls },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_PUBLIC_ASSET_REQUIRED_MESSAGE &&
      privateCalls.published.length === 0 &&
      privateCalls.callCount === 0,
  );

  const mixedApproved = await approvePackage(prisma, ownerA, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Mixed private and public",
    body: "Only the public image is sent.",
    channelIntent: "INSTAGRAM",
    jobId: job.id,
    photoIds: [privatePhoto.id, photo.id],
    hashtags: "Reno",
  });
  const mixedCalls = createFakeSocialPublishingProvider();
  const mixedPublished = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: mixedApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
      expectedUpdatedAt: mixedApproved.updatedAt,
    },
    { provider: mixedCalls },
  );
  check(
    "Mixed package sends only the public marketing image",
    mixedPublished.published === true &&
      mixedCalls.published.length === 1 &&
      mixedCalls.published[0].imageUrl === "https://example.test/after.jpg" &&
      !JSON.stringify(mixedCalls.published[0]).includes("customer-secret") &&
      !JSON.stringify(mixedCalls.published[0]).includes("555-0100"),
  );

  const igSource = await loadMarketingSource(prisma, businessA.id, new Date(), "OWNER");
  const igRow = igSource.contents.find((row) => row.id === igApproved.id);
  check(
    "Loader presents Instagram as connected and published without rewriting content status",
    igSource.channels.destinations.INSTAGRAM.connected === true &&
      igSource.channels.destinations.INSTAGRAM.implemented === true &&
      igRow?.instagramPublish.published === true &&
      igRow.instagramPublish.label === INSTAGRAM_SOCIAL_PUBLISH_PUBLISHED_MESSAGE &&
      igRow.status === "APPROVED" &&
      igRow.socialPublish.published === false,
  );

  console.log("\nTEST — Two-connection liveKey race");
  async function runConnectionRace(clients, content, extraDeps = {}) {
    const provider = createFakeSocialPublishingProvider();
    provider.setDelayMs(80);
    const barrier = createReleaseBarrier(clients.length);
    const results = await Promise.allSettled(
      clients.map((client) =>
        publishMarketingContentToSocial(
          client,
          ownerA,
          {
            contentId: content.id,
            destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
            expectedUpdatedAt: content.updatedAt,
          },
          { provider, beforeClaimCreate: () => barrier.wait(), ...extraDeps },
        ),
      ),
    );
    const attempts = await prisma.marketingSocialPublishAttempt.findMany({
      where: { contentId: content.id, businessId: businessA.id },
    });
    return { provider, results, attempts };
  }

  let twoWayFailures = 0;
  for (let round = 0; round < 50; round += 1) {
    const raceApproved = await approvePackage(prisma, ownerA, adminA, {
      ...packageInput,
      title: `Two-way race ${round}`,
    });
    const raced = await runConnectionRace([raceClientA, raceClientB], raceApproved);
    const fulfilled = raced.results.filter((row) => row.status === "fulfilled");
    const publishedAttempts = raced.attempts.filter((row) => row.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED);
    if (
      raced.provider.callCount !== 1 ||
      fulfilled.length !== 1 ||
      raced.attempts.length !== 1 ||
      publishedAttempts.length !== 1
    ) {
      twoWayFailures += 1;
    }
  }
  check(
    "50-round two-connection race: one provider call, one fulfilled result, one attempt",
    twoWayFailures === 0,
  );

  const threeApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Three-way race",
  });
  const threeWay = await runConnectionRace([raceClientA, raceClientB, raceClientC], threeApproved);
  const threeFulfilled = threeWay.results.filter((row) => row.status === "fulfilled");
  check(
    "3-way race: one provider call, one fulfilled result, one attempt",
    threeWay.provider.callCount === 1 &&
      threeFulfilled.length === 1 &&
      threeWay.attempts.length === 1 &&
      threeWay.attempts[0].status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
  );

  const claimedRetryApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "CLAIMED retry refusal",
  });
  const claimedRetryProvider = createFakeSocialPublishingProvider();
  claimedRetryProvider.setDelayMs(60);
  let releaseClaimedRetry;
  const holdClaimedRetry = new Promise((resolve) => {
    releaseClaimedRetry = resolve;
  });
  const claimedRetryFirst = publishMarketingContentToSocial(
    prisma,
    ownerA,
    {
      contentId: claimedRetryApproved.id,
      destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
      expectedUpdatedAt: claimedRetryApproved.updatedAt,
    },
    { provider: claimedRetryProvider, beforeProvider: () => holdClaimedRetry },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  const claimedRetrySecond = createFakeSocialPublishingProvider();
  await expectError(
    "CLAIMED in-flight retry is refused before another provider call",
    () =>
      publishMarketingContentToSocial(
        prisma,
        ownerA,
        {
          contentId: claimedRetryApproved.id,
          destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
          expectedUpdatedAt: claimedRetryApproved.updatedAt,
        },
        { provider: claimedRetrySecond },
      ),
    (error) =>
      error instanceof MarketingError &&
      error.message === SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE &&
      claimedRetrySecond.callCount === 0,
  );
  releaseClaimedRetry();
  const claimedRetryResult = await claimedRetryFirst;
  check(
    "In-flight claim still publishes once after retry refusal",
    claimedRetryResult.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      claimedRetryProvider.callCount === 1,
  );

  const omitApproved = await approvePackage(prisma, ownerA, adminA, {
    ...packageInput,
    title: "Omit liveKey race",
  });
  const omitRace = await runConnectionRace([raceClientA, raceClientB], omitApproved, { omitLiveKey: true });
  const omitFulfilled = omitRace.results.filter((row) => row.status === "fulfilled");
  check(
    "Race test fails when liveKey is omitted (two provider calls and two attempt rows)",
    omitRace.provider.callCount >= 2 && omitFulfilled.length >= 2 && omitRace.attempts.length >= 2,
  );

  console.log("\nTEST — Resolve compare-and-set race");
  async function createUnconfirmedAttempt(title) {
    const approved = await approvePackage(prisma, ownerA, adminA, {
      ...packageInput,
      title,
    });
    const attempt = await prisma.marketingSocialPublishAttempt.create({
      data: {
        businessId: businessA.id,
        contentId: approved.id,
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
        claimedAt: new Date(Date.now() - SOCIAL_PUBLISH_UNCONFIRMED_MS - 1000),
        expectedContentUpdatedAt: approved.updatedAt,
        destinationPageId: "111222333",
        liveKey: socialPublishAttemptLiveKey(approved.id, SOCIAL_PUBLISH_DESTINATION_FACEBOOK),
        failureLabel: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
        createdByMembershipId: ownerMem.id,
      },
    });
    return { approved, attempt };
  }

  async function runResolveRace(title, resolutions, extraDeps = {}) {
    const { approved, attempt } = await createUnconfirmedAttempt(title);
    const barrier = createReleaseBarrier(2);
    const results = await Promise.allSettled(
      resolutions.map((resolution, index) =>
        resolveMarketingSocialPublishAttempt(
          index === 0 ? raceClientA : raceClientB,
          ownerA,
          { attemptId: attempt.id, resolution },
          { beforeResolveUpdate: () => barrier.wait(), ...extraDeps },
        ),
      ),
    );
    return { approved, attempt, results };
  }

  async function assertResolveRetry(approved, winnerStatus) {
    const retry = createFakeSocialPublishingProvider();
    if (winnerStatus === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED) {
      try {
        await publishMarketingContentToSocial(
          prisma,
          ownerA,
          {
            contentId: approved.id,
            destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
            expectedUpdatedAt: approved.updatedAt,
          },
          { provider: retry },
        );
        return false;
      } catch (error) {
        return (
          error instanceof MarketingError &&
          error.message === SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE &&
          retry.callCount === 0
        );
      }
    }
    const retried = await publishMarketingContentToSocial(
      prisma,
      ownerA,
      {
        contentId: approved.id,
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        expectedUpdatedAt: approved.updatedAt,
      },
      { provider: retry },
    );
    return (
      retried.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED &&
      retried.published === true &&
      retry.callCount === 1
    );
  }

  let resolveRaceFailures = 0;
  for (let round = 0; round < 30; round += 1) {
    const postedVsPosted = round < 15;
    const resolutions = postedVsPosted
      ? [SOCIAL_PUBLISH_RESOLVE_POSTED, SOCIAL_PUBLISH_RESOLVE_POSTED]
      : [SOCIAL_PUBLISH_RESOLVE_POSTED, SOCIAL_PUBLISH_RESOLVE_NOT_POSTED];
    const raced = await runResolveRace(
      postedVsPosted ? `Resolve POSTED/POSTED ${round}` : `Resolve POSTED/NOT_POSTED ${round}`,
      resolutions,
    );
    const fulfilled = raced.results.filter((row) => row.status === "fulfilled");
    const winner = fulfilled[0]?.value;
    if (
      fulfilled.length !== 1 ||
      !winner ||
      !(await assertResolveRetry(raced.approved, winner.status))
    ) {
      resolveRaceFailures += 1;
    }
  }
  check(
    "30-round two-connection resolve race: exactly one success; retry matches outcome",
    resolveRaceFailures === 0,
  );

  const omitResolve = await runResolveRace(
    "Omit resolve CLAIMED guard",
    [SOCIAL_PUBLISH_RESOLVE_POSTED, SOCIAL_PUBLISH_RESOLVE_NOT_POSTED],
    { omitResolveClaimedGuard: true },
  );
  const omitResolveFulfilled = omitResolve.results.filter((row) => row.status === "fulfilled");
  check(
    "Resolve race fails when status: CLAIMED guard is omitted (both resolves succeed)",
    omitResolveFulfilled.length >= 2,
  );

  console.log(
    failures === 0
      ? "\nAll marketing social publish checks passed."
      : `\n${failures} marketing social publish check(s) failed.`,
  );
} finally {
  if (previousFake == null) delete process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER;
  else process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER = previousFake;
  await Promise.all([
    prisma.$disconnect(),
    raceClientA.$disconnect(),
    raceClientB.$disconnect(),
    raceClientC.$disconnect(),
  ]);
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
