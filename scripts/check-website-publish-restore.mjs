/**
 * OWNER bounded website publish history and explicit restore of a prior
 * published website snapshot. Restore moves Business.publishedWebsiteId
 * to the existing WebsitePublish row and restores each trade’s exact
 * captured TenantIntakeSnapshot pointer. WebsitePublish,
 * TenantIntakeSnapshot, and historical ServiceRequest rows are never
 * rewritten. Already-open hire forms still submit the version they
 * displayed.
 *
 * Dedicated database: tbbt_website_publish_restore_test
 *
 * Run with:
 *   npm run test:website-publish-restore
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

const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { ForbiddenError } = await import("@/lib/authorization");
const { ensurePrimaryBusinessTrade } = await import("@/lib/business-trades");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const {
  archivedIntakeSchema,
  freezeIntakeSchema,
  parseIntakeAnswers,
  resolveRequestIntakeSchema,
} = await import("@/lib/intake-schema");
const { INTAKE_CONDITION_STATUS_DRAFT } = await import("@/lib/intake-conditionals");
const {
  publishIntakeConditionDraft,
  saveIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");
const {
  WebsitePublishError,
  WEBSITE_PUBLISH_HISTORY_LIMIT,
  WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED,
  WEBSITE_PUBLISH_RESTORE_INTAKE_UNCHANGED,
  WEBSITE_PUBLISH_RESTORE_STALE,
  listOwnedWebsitePublishHistory,
  listWebsitePublishes,
  loadPublicWebsiteIntakeOverlays,
  loadPublicWebsiteView,
  parseWebsiteSnapshot,
  publishWebsite,
  restoreOwnedWebsitePublish,
  restoreWebsiteFromForm,
  rollbackWebsite,
  websiteRestoreResultMessage,
} = await import("@/lib/website-engine");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the website-publish-restore check.");
  process.exit(1);
}

const testDbName = "tbbt_website_publish_restore_test";
const parsedUrl = new URL(baseUrl);
const host = parsedUrl.hostname;
const allowRemoteTestDb = process.env.TBBT_ALLOW_REMOTE_TEST_DB === "1";
if (!allowRemoteTestDb && host !== "localhost" && host !== "127.0.0.1") {
  console.error(
    `Refusing prisma db push --accept-data-loss against host ${host}. Use localhost/127.0.0.1 or set TBBT_ALLOW_REMOTE_TEST_DB=1.`,
  );
  process.exit(1);
}
parsedUrl.pathname = `/${testDbName}`;
const testUrl = parsedUrl.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
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

async function expectRejects(label, fn, isExpected = () => true) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function runOrderedPointerWrites(first, second) {
  const firstAtHold = deferred();
  const secondAtHold = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const firstRun = first(async () => {
    firstAtHold.resolve();
    await releaseFirst.promise;
  });
  const secondRun = second(async () => {
    secondAtHold.resolve();
    await releaseSecond.promise;
  });
  await Promise.all([firstAtHold.promise, secondAtHold.promise]);
  releaseFirst.resolve();
  const firstResult = await firstRun.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  releaseSecond.resolve();
  const secondResult = await secondRun.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  return { firstResult, secondResult };
}

const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe|\$executeRaw\b/;
const featureFiles = [
  "src/lib/website-engine/publish.ts",
  "src/lib/website-engine/form.ts",
  "src/lib/website-engine/editor.ts",
  "src/lib/website-engine/snapshot.ts",
  "src/app/actions/website-engine.ts",
  "src/components/settings/website-publish-panel.tsx",
  "src/lib/public-intake.ts",
];

const cleaningDraftV1 = {
  version: 1,
  status: INTAKE_CONDITION_STATUS_DRAFT,
  tradeCode: "CLEANING",
  baseSchemaKey: "cleaning.public",
  baseSchemaVersion: 2,
  questions: [{ key: "fridge_notes", type: "NOTES", label: "Fridge notes" }],
  rules: [
    {
      id: "show-fridge",
      questionKey: "fridge_notes",
      when: { field: "addons", op: "INCLUDES", value: "INSIDE_FRIDGE" },
      action: "SHOW",
    },
    {
      id: "require-fridge",
      questionKey: "fridge_notes",
      when: { field: "addons", op: "INCLUDES", value: "INSIDE_FRIDGE" },
      action: "REQUIRE",
    },
  ],
};

const cleaningDraftV2 = {
  ...cleaningDraftV1,
  questions: [
    ...cleaningDraftV1.questions,
    { key: "oven_notes", type: "NOTES", label: "Oven notes" },
  ],
  rules: [
    ...cleaningDraftV1.rules,
    {
      id: "show-oven",
      questionKey: "oven_notes",
      when: { field: "addons", op: "INCLUDES", value: "INSIDE_OVEN" },
      action: "SHOW",
    },
  ],
};

const handyDraft = {
  version: 1,
  status: INTAKE_CONDITION_STATUS_DRAFT,
  tradeCode: "HANDYMAN",
  baseSchemaKey: "handyman.public",
  baseSchemaVersion: 1,
  questions: [{ key: "gate_code_notes", type: "NOTES", label: "Gate code notes" }],
  rules: [
    {
      id: "show-gate",
      questionKey: "gate_code_notes",
      when: { field: "frequency", op: "EQUALS", value: "ONE_TIME" },
      action: "SHOW",
    },
  ],
};

function cleaningAnswers(extra = {}) {
  return {
    bedrooms: 3,
    bathrooms: 2,
    homeSize: "1500_2000",
    frequency: "WEEKLY",
    ...extra,
  };
}

function contact(prefix) {
  return {
    name: `${prefix} Customer`,
    email: `${prefix}-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551110000",
    address: "1 Main St",
    streetAddress: "1 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: prefix,
    includeOther: false,
    otherDescription: "",
  };
}

console.log("\nSTATIC — OWNER bounded history and pointer-only website restore");
const publishSrc = read("src/lib/website-engine/publish.ts");
const formSrc = read("src/lib/website-engine/form.ts");
const actionSrc = read("src/app/actions/website-engine.ts");
const panelSrc = read("src/components/settings/website-publish-panel.tsx");
const editorSrc = read("src/lib/website-engine/editor.ts");
const publicIntakeSrc = read("src/lib/public-intake.ts");
const navSrc = read("src/lib/nav.ts");
const settingsSrc = read("src/lib/settings.ts");
const restoreFn = publishSrc.slice(
  publishSrc.indexOf("async function restoreCapturedIntakePointers"),
  publishSrc.indexOf("async function loadWebsitePublishHistoryRows"),
);
const restoreExport = publishSrc.slice(
  publishSrc.indexOf("export async function restoreOwnedWebsitePublish"),
);

check(
  "OWNER-only restore; ADMIN sees the same bounded read-only history",
  WEBSITE_PUBLISH_HISTORY_LIMIT === 20 &&
    publishSrc.includes("take: WEBSITE_PUBLISH_HISTORY_LIMIT") &&
    publishSrc.includes("listOwnedWebsitePublishHistory") &&
    publishSrc.includes("Bounded read-only history for OWNER and ADMIN") &&
    editorSrc.includes("listOwnedWebsitePublishHistory") &&
    editorSrc.includes("listWebsitePublishes") &&
    editorSrc.includes("cannot restore") &&
    actionSrc.includes("listOwnedWebsitePublishHistory") &&
    panelSrc.includes("Only the owner can restore"),
);
check(
  "Rollback and restore both require OWNER",
  publishSrc.includes("export async function rollbackWebsite") &&
    publishSrc.slice(
      publishSrc.indexOf("export async function rollbackWebsite"),
      publishSrc.indexOf("export async function websiteHasUnpublishedChanges"),
    ).includes("requireOwner(access)") &&
    actionSrc.includes('requireBusinessRole(operating.access, "OWNER")') &&
    !actionSrc.includes("Captured intake snapshots were restored."),
);
check(
  "Restore moves website and captured intake pointers only",
  restoreExport.includes("publishedWebsiteId: source.id") &&
    restoreFn.includes("publishedIntakeSnapshotId: row.id") &&
    restoreExport.includes("business.updateMany") &&
    restoreFn.includes("businessTrade.updateMany") &&
    !restoreFn.includes("websitePublish.update") &&
    !restoreFn.includes("tenantIntakeSnapshot.update") &&
    !restoreFn.includes("serviceRequest") &&
    !restoreExport.includes("snapshotJson:") &&
    !restoreExport.includes("create({") &&
    !restoreFn.includes("serviceRequest."),
);
check(
  "Restore requires OWNER confirmation, expected current id, and never takes client businessId",
  WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED.includes("current public site") &&
    publishSrc.includes("input.confirmed !== true") &&
    publishSrc.includes("expectedCurrentId") &&
    actionSrc.includes("restoreWebsiteAction") &&
    formSrc.includes("restoreWebsiteFromForm") &&
    !actionSrc.includes('readString(formData, "businessId")') &&
    panelSrc.includes("Restore this version as current") &&
    panelSrc.includes('name="expectedCurrentId"') &&
    panelSrc.includes('name="confirmed"') &&
    panelSrc.includes("Showing the newest {versions.length}") &&
    actionSrc.includes("websiteRestoreResultMessage") &&
    actionSrc.includes("result.restoredIntakeCount"),
);
check(
  "Public intake still submits the displayed snapshot after a website restore",
  publicIntakeSrc.includes("resolveReferencedTenantIntakeSnapshot") &&
    publicIntakeSrc.includes("tenantIntakeSnapshotId") &&
    !publicIntakeSrc.includes("restoreOwnedWebsitePublish"),
);
check(
  "Global navigation and Settings sections were not changed",
  !navSrc.includes("website-publish-restore") &&
    settingsSrc.includes('"website-publish"') &&
    !settingsSrc.includes("intake-conditionals"),
);
check(
  "No eval, Function, or raw SQL in the dedicated files",
  featureFiles.every((file) => !DANGEROUS.test(read(file))),
);
check(
  "Dedicated test DB push is host-guarded",
  read("scripts/check-website-publish-restore.mjs").includes("TBBT_ALLOW_REMOTE_TEST_DB") &&
    read("scripts/check-website-publish-restore.mjs").includes('host !== "127.0.0.1"') &&
    read("scripts/check-website-publish-restore.mjs").includes("--accept-data-loss"),
);
check(
  "Restore copy distinguishes captured intake from legacy publishes",
  read("src/lib/website-engine/snapshot.ts").includes("WEBSITE_PUBLISH_RESTORE_INTAKE_UNCHANGED") &&
    read("src/lib/website-engine/snapshot.ts").includes("predates captured intake") &&
    read("src/lib/website-engine/snapshot.ts").includes("websiteRestoreResultMessage") &&
    read("src/lib/website-engine/snapshot.ts").includes("leaves intake pointers unchanged"),
);

try {
  console.log("\nDB — OWNER auth, isolation, restore, stale/concurrent, old-form submit");
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Website Restore",
      slug: `alpha-web-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const handyB = await prisma.business.create({
    data: {
      name: "Beta Website Restore",
      slug: `beta-web-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const boundD = await prisma.business.create({
    data: {
      name: "Delta Website Restore Bound",
      slug: `delta-web-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, handyB.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, boundD.id, "CLEANING");

  const ownerAUser = await prisma.user.create({
    data: { name: "Owner A", email: `wpr-a-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Admin A", email: `wpr-admin-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Member A", email: `wpr-mem-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Owner B", email: `wpr-b-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const ownerDUser = await prisma.user.create({
    data: { name: "Owner D", email: `wpr-d-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const ownerAMembership = await prisma.membership.create({
    data: { userId: ownerAUser.id, businessId: cleanA.id, role: "OWNER" },
  });
  const adminAMembership = await prisma.membership.create({
    data: { userId: adminAUser.id, businessId: cleanA.id, role: "ADMIN" },
  });
  const memberAMembership = await prisma.membership.create({
    data: { userId: memberAUser.id, businessId: cleanA.id, role: "MEMBER" },
  });
  const ownerBMembership = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: handyB.id, role: "OWNER" },
  });
  const ownerDMembership = await prisma.membership.create({
    data: { userId: ownerDUser.id, businessId: boundD.id, role: "OWNER" },
  });
  const ownerA = makeAccess(cleanA.id, "OWNER", ownerAMembership.id);
  const adminA = makeAccess(cleanA.id, "ADMIN", adminAMembership.id);
  const memberA = makeAccess(cleanA.id, "MEMBER", memberAMembership.id);
  const ownerB = makeAccess(handyB.id, "OWNER", ownerBMembership.id);
  const ownerD = makeAccess(boundD.id, "OWNER", ownerDMembership.id);

  const catalogA = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanA.id,
      name: "Standard House Cleaning",
      category: "House Cleaning",
      tradeCode: "CLEANING",
      active: true,
      recurrenceEligible: true,
    },
  });
  const catalogB = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyB.id,
      name: "TV Mounting",
      category: "Mounting",
      tradeCode: "HANDYMAN",
      active: true,
    },
  });

  const archivedV1 = archivedIntakeSchema("cleaning.public", 1);
  const archivedV2 = archivedIntakeSchema("cleaning.public", 2);
  const archivedHandyV1 = archivedIntakeSchema("handyman.public", 1);
  const historicalCustomer = await prisma.customer.create({
    data: { businessId: cleanA.id, name: "Historical Cleaning Restore" },
  });
  const historicalHandyCustomer = await prisma.customer.create({
    data: { businessId: handyB.id, name: "Historical Handyman Restore" },
  });
  const historicalCleaningV1 = await prisma.serviceRequest.create({
    data: {
      businessId: cleanA.id,
      customerId: historicalCustomer.id,
      tradeCode: "CLEANING",
      summary: "Archived Cleaning V1",
      intakeSchemaKey: "cleaning.public",
      intakeSchemaVersion: 1,
      intakeSchemaJson: freezeIntakeSchema(archivedV1),
      intakeAnswersJson: JSON.stringify({
        bedrooms: 2,
        bathrooms: 1,
        homeSize: "1000_1500",
        frequency: "MONTHLY",
        pets: "no",
      }),
    },
  });
  const historicalCleaningV2 = await prisma.serviceRequest.create({
    data: {
      businessId: cleanA.id,
      customerId: historicalCustomer.id,
      tradeCode: "CLEANING",
      summary: "Archived Cleaning V2",
      intakeSchemaKey: "cleaning.public",
      intakeSchemaVersion: 2,
      intakeSchemaJson: freezeIntakeSchema(archivedV2),
      intakeAnswersJson: JSON.stringify(cleaningAnswers({ bedrooms: 2, bathrooms: 1 })),
    },
  });
  const historicalHandyV1 = await prisma.serviceRequest.create({
    data: {
      businessId: handyB.id,
      customerId: historicalHandyCustomer.id,
      tradeCode: "HANDYMAN",
      summary: "Archived Handyman V1",
      intakeSchemaKey: "handyman.public",
      intakeSchemaVersion: 1,
      intakeSchemaJson: freezeIntakeSchema(archivedHandyV1),
      intakeAnswersJson: JSON.stringify({ frequency: "ONE_TIME" }),
    },
  });

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV1,
  });
  const intakeV1 = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "restore-intake-v1",
  });
  const websiteV1 = await publishWebsite(prisma, ownerA, { idempotencyKey: "restore-web-v1" });
  const websiteV1Json = websiteV1.snapshotJson;
  const websiteV1PublishedAt = websiteV1.publishedAt.toISOString();
  const intakeV1Json = intakeV1.snapshotJson;

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV2,
  });
  const intakeV2 = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "restore-intake-v2",
  });
  const websiteV2 = await publishWebsite(prisma, ownerA, { idempotencyKey: "restore-web-v2" });
  const websiteV2Json = websiteV2.snapshotJson;
  const intakeV2Json = intakeV2.snapshotJson;

  const historyA = await listOwnedWebsitePublishHistory(prisma, ownerA);
  check(
    "OWNER history is newest-first, bounded, and tenant-scoped",
    historyA.historyLimit === WEBSITE_PUBLISH_HISTORY_LIMIT &&
      historyA.currentId === websiteV2.id &&
      historyA.versions.map((row) => row.id).join(",") === `${websiteV2.id},${websiteV1.id}` &&
      historyA.versions[0].isCurrent === true &&
      historyA.versions[1].isCurrent === false,
  );

  await expectRejects(
    "ADMIN cannot list OWNER website publish history",
    () => listOwnedWebsitePublishHistory(prisma, adminA),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectRejects(
    "MEMBER cannot list OWNER website publish history",
    () => listOwnedWebsitePublishHistory(prisma, memberA),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  const historyB = await listOwnedWebsitePublishHistory(prisma, ownerB);
  const adminHistory = await listWebsitePublishes(prisma, adminA);
  check("OWNER B history does not include OWNER A publishes", historyB.versions.length === 0);
  check(
    "ADMIN can read the same bounded history but cannot restore",
    adminHistory.historyLimit === WEBSITE_PUBLISH_HISTORY_LIMIT &&
      adminHistory.currentId === websiteV2.id &&
      adminHistory.versions.map((row) => row.id).join(",") === `${websiteV2.id},${websiteV1.id}`,
  );

  await expectRejects(
    "ADMIN cannot restore a website publish",
    () =>
      restoreOwnedWebsitePublish(prisma, adminA, {
        publishId: websiteV1.id,
        confirmed: true,
        expectedCurrentId: websiteV2.id,
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectRejects(
    "ADMIN cannot roll back or copy a prior website version",
    () =>
      rollbackWebsite(prisma, adminA, {
        publishId: websiteV1.id,
        idempotencyKey: "admin-rollback",
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectRejects(
    "MEMBER cannot restore a website publish",
    () =>
      restoreOwnedWebsitePublish(prisma, memberA, {
        publishId: websiteV1.id,
        confirmed: true,
        expectedCurrentId: websiteV2.id,
      }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectRejects(
    "Unconfirmed restore is rejected",
    () =>
      restoreOwnedWebsitePublish(prisma, ownerA, {
        publishId: websiteV1.id,
        confirmed: false,
        expectedCurrentId: websiteV2.id,
      }),
    (error) =>
      error instanceof WebsitePublishError &&
      error.message === WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED,
  );
  await expectRejects(
    "OWNER B cannot restore OWNER A website publish",
    () =>
      restoreOwnedWebsitePublish(prisma, ownerB, {
        publishId: websiteV1.id,
        confirmed: true,
        expectedCurrentId: websiteV2.id,
      }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );

  const pointerBefore = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const intakeBefore = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  await expectRejects(
    "Stale expected current id is rejected before any pointer move",
    () =>
      restoreOwnedWebsitePublish(prisma, ownerA, {
        publishId: websiteV1.id,
        confirmed: true,
        expectedCurrentId: websiteV1.id,
      }),
    (error) =>
      error instanceof WebsitePublishError && error.message === WEBSITE_PUBLISH_RESTORE_STALE,
  );
  const pointerAfterStale = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const intakeAfterStale = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  check(
    "Stale restore leaves website and intake pointers on version 2",
    pointerBefore?.publishedWebsiteId === websiteV2.id &&
      pointerAfterStale?.publishedWebsiteId === websiteV2.id &&
      intakeBefore?.publishedIntakeSnapshotId === intakeV2.id &&
      intakeAfterStale?.publishedIntakeSnapshotId === intakeV2.id,
  );

  const openedV2 = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("opened-v2"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: intakeV2.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_OVEN"],
      oven_notes: "Opened on website v2",
    }),
  });
  check("Opened V2 form can be prepared before restore", openedV2.ok === true);

  async function restoreV1Held(beforePointerWrite) {
    return restoreOwnedWebsitePublish(prisma, ownerA, {
      publishId: websiteV1.id,
      confirmed: true,
      expectedCurrentId: websiteV2.id,
      beforePointerWrite,
    });
  }
  const firstOrder = await runOrderedPointerWrites(restoreV1Held, restoreV1Held);
  check(
    "Restore-vs-restore order A-then-B: first wins and second is stale",
    firstOrder.firstResult.status === "fulfilled" &&
      firstOrder.firstResult.value.restoredIntakeCount === 1 &&
      firstOrder.secondResult.status === "rejected" &&
      firstOrder.secondResult.reason instanceof WebsitePublishError &&
      firstOrder.secondResult.reason.message === WEBSITE_PUBLISH_RESTORE_STALE,
  );
  const afterFirstOrder = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  check("First ordering leaves the website on v1", afterFirstOrder?.publishedWebsiteId === websiteV1.id);

  const resetToV2 = await restoreOwnedWebsitePublish(prisma, ownerA, {
    publishId: websiteV2.id,
    confirmed: true,
    expectedCurrentId: websiteV1.id,
  });
  check(
    "Reset to v2 restores captured intake v2",
    resetToV2.restoredIntakeCount === 1 &&
      websiteRestoreResultMessage(resetToV2.versionNumber, resetToV2.restoredIntakeCount).includes(
        "Restored captured intake for 1 trade",
      ),
  );
  const secondOrder = await runOrderedPointerWrites(restoreV1Held, restoreV1Held);
  check(
    "Restore-vs-restore order B-then-A: first wins and second is stale",
    secondOrder.firstResult.status === "fulfilled" &&
      secondOrder.secondResult.status === "rejected" &&
      secondOrder.secondResult.reason instanceof WebsitePublishError &&
      secondOrder.secondResult.reason.message === WEBSITE_PUBLISH_RESTORE_STALE,
  );
  const afterConcurrent = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const intakeAfterConcurrent = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  const publishCountAfterConcurrent = await prisma.websitePublish.count({
    where: { businessId: cleanA.id },
  });
  check(
    "Both restore orderings leave website v1, captured intake v1, and no copied row",
    afterConcurrent?.publishedWebsiteId === websiteV1.id &&
      intakeAfterConcurrent?.publishedIntakeSnapshotId === intakeV1.id &&
      publishCountAfterConcurrent === 2 &&
      websiteRestoreResultMessage(websiteV1.versionNumber, 1).includes("Restored captured intake"),
  );

  const rereadWebsiteV1 = await prisma.websitePublish.findUnique({ where: { id: websiteV1.id } });
  const rereadWebsiteV2 = await prisma.websitePublish.findUnique({ where: { id: websiteV2.id } });
  const rereadIntakeV1 = await prisma.tenantIntakeSnapshot.findUnique({ where: { id: intakeV1.id } });
  const rereadIntakeV2 = await prisma.tenantIntakeSnapshot.findUnique({ where: { id: intakeV2.id } });
  const viewRestored = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysRestored = await loadPublicWebsiteIntakeOverlays(
    prisma,
    viewRestored,
    cleanA.id,
    ["CLEANING"],
  );
  const historyAfter = await listOwnedWebsitePublishHistory(prisma, ownerA);
  check(
    "Restore moves the current website pointer to v1 and does not edit snapshot rows",
    rereadWebsiteV1?.snapshotJson === websiteV1Json &&
      rereadWebsiteV1?.publishedAt.toISOString() === websiteV1PublishedAt &&
      rereadWebsiteV1?.versionNumber === 1 &&
      rereadWebsiteV2?.snapshotJson === websiteV2Json &&
      rereadWebsiteV2?.versionNumber === 2 &&
      rereadIntakeV1?.snapshotJson === intakeV1Json &&
      rereadIntakeV2?.snapshotJson === intakeV2Json &&
      viewRestored?.source === "snapshot" &&
      viewRestored?.snapshot?.trades.find((row) => row.code === "CLEANING")?.tenantIntake
        ?.snapshotId === intakeV1.id &&
      overlaysRestored.ok === true &&
      overlaysRestored.overlays.CLEANING?.snapshotId === intakeV1.id &&
      historyAfter.currentId === websiteV1.id &&
      historyAfter.versions.find((row) => row.id === websiteV1.id)?.isCurrent === true &&
      historyAfter.versions.find((row) => row.id === websiteV2.id)?.isCurrent === false,
  );

  const openedV2After = openedV2.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: openedV2.requestId } })
    : null;
  const openedV2Submit = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("old-form-after-restore"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: intakeV2.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_OVEN"],
      oven_notes: "Still V2 after website restore",
    }),
  });
  const openedV2SubmitRow = openedV2Submit.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: openedV2Submit.requestId } })
    : null;
  const openedV2Schema = openedV2SubmitRow
    ? JSON.parse(openedV2SubmitRow.intakeSchemaJson ?? "{}")
    : { fields: [] };
  check(
    "Already-opened V2 form still submits V2 after website restore to captured V1",
    openedV2After?.tenantIntakeSnapshotId === intakeV2.id &&
      openedV2Submit.ok === true &&
      openedV2SubmitRow?.tenantIntakeSnapshotId === intakeV2.id &&
      openedV2SubmitRow?.tenantIntakeSnapshotVersion === intakeV2.versionNumber &&
      openedV2Schema.fields.some((field) => field.key === "oven_notes") &&
      parseIntakeAnswers(openedV2SubmitRow?.intakeAnswersJson).oven_notes ===
        "Still V2 after website restore",
  );

  const newV1After = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("new-v1-after-restore"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: intakeV1.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Restored captured V1",
      oven_notes: "Must not persist on restored V1",
    }),
  });
  const newV1AfterRow = newV1After.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: newV1After.requestId } })
    : null;
  const newV1Schema = newV1AfterRow ? JSON.parse(newV1AfterRow.intakeSchemaJson ?? "{}") : { fields: [] };
  check(
    "New public request against the restored captured intake freezes V1",
    newV1After.ok === true &&
      newV1AfterRow?.tenantIntakeSnapshotId === intakeV1.id &&
      newV1AfterRow?.tenantIntakeSnapshotVersion === intakeV1.versionNumber &&
      newV1Schema.fields.some((field) => field.key === "fridge_notes") &&
      !newV1Schema.fields.some((field) => field.key === "oven_notes") &&
      parseIntakeAnswers(newV1AfterRow?.intakeAnswersJson).fridge_notes === "Restored captured V1" &&
      parseIntakeAnswers(newV1AfterRow?.intakeAnswersJson).oven_notes == null,
  );

  const resetBeforePublishRace = await restoreOwnedWebsitePublish(prisma, ownerA, {
    publishId: websiteV2.id,
    confirmed: true,
    expectedCurrentId: websiteV1.id,
  });
  const intakeBeforePublishRace = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  const publishRace = await runOrderedPointerWrites(
    (beforePointerWrite) =>
      publishWebsite(prisma, ownerA, {
        idempotencyKey: `race-pub-${randomUUID().slice(0, 8)}`,
        beforePointerWrite,
      }),
    (beforePointerWrite) =>
      restoreOwnedWebsitePublish(prisma, ownerA, {
        publishId: websiteV1.id,
        confirmed: true,
        expectedCurrentId: websiteV2.id,
        beforePointerWrite,
      }),
  );
  const afterPublishRace = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const intakeAfterPublishRace = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  check(
    "Publish-first race makes restore stale and leaves intake pointers unchanged",
    resetBeforePublishRace.restoredIntakeCount === 1 &&
      intakeBeforePublishRace?.publishedIntakeSnapshotId === intakeV2.id &&
      publishRace.firstResult.status === "fulfilled" &&
      publishRace.firstResult.value.versionNumber === 3 &&
      publishRace.secondResult.status === "rejected" &&
      publishRace.secondResult.reason instanceof WebsitePublishError &&
      publishRace.secondResult.reason.message === WEBSITE_PUBLISH_RESTORE_STALE &&
      afterPublishRace?.publishedWebsiteId === publishRace.firstResult.value.id &&
      afterPublishRace?.publishedWebsiteId !== websiteV2.id &&
      intakeAfterPublishRace?.publishedIntakeSnapshotId === intakeV2.id,
  );

  const parsedLegacySource = parseWebsiteSnapshot(websiteV1Json);
  const legacySnapshot = {
    ...parsedLegacySource,
    trades: parsedLegacySource.trades.map((trade) => {
      const { tenantIntake: _tenantIntake, tenantIntakeCaptured: _captured, ...rest } = trade;
      return rest;
    }),
  };
  const legacy = await prisma.websitePublish.create({
    data: {
      businessId: cleanA.id,
      versionNumber: 80,
      schemaVersion: 1,
      snapshotJson: JSON.stringify(legacySnapshot),
      summary: "legacy uncaptured",
    },
  });
  const parsedLegacy = parseWebsiteSnapshot(legacy.snapshotJson);
  const legacyRestore = await restoreOwnedWebsitePublish(prisma, ownerA, {
    publishId: legacy.id,
    confirmed: true,
    expectedCurrentId: afterPublishRace.publishedWebsiteId,
  });
  const intakeAfterLegacy = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  const websiteAfterLegacy = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const legacyMessage = websiteRestoreResultMessage(
    legacyRestore.versionNumber,
    legacyRestore.restoredIntakeCount,
  );
  check(
    "Legacy uncaptured restore reports unchanged intake and leaves the pointer",
    parsedLegacy.trades.every((trade) => trade.tenantIntakeCaptured !== true) &&
      legacyRestore.restoredIntakeCount === 0 &&
      legacyMessage.includes(WEBSITE_PUBLISH_RESTORE_INTAKE_UNCHANGED) &&
      !legacyMessage.includes("Captured intake snapshots were restored.") &&
      intakeAfterLegacy?.publishedIntakeSnapshotId === intakeV2.id &&
      websiteAfterLegacy?.publishedWebsiteId === legacy.id,
  );

  const missingForm = new FormData();
  missingForm.set("publishId", websiteV2.id);
  missingForm.set("expectedCurrentId", websiteV1.id);
  await expectRejects(
    "Form restore without confirmation is rejected",
    () => restoreWebsiteFromForm(prisma, ownerA, missingForm),
    (error) =>
      error instanceof WebsitePublishError &&
      error.message === WEBSITE_PUBLISH_RESTORE_CONFIRM_REQUIRED,
  );

  await saveIntakeConditionDraft(prisma, ownerB, {
    tradeCode: "HANDYMAN",
    document: handyDraft,
  });
  const handySnap = await publishIntakeConditionDraft(prisma, ownerB, {
    tradeCode: "HANDYMAN",
    reviewed: true,
    idempotencyKey: "restore-handy-v1",
  });
  const websiteB = await publishWebsite(prisma, ownerB, { idempotencyKey: "restore-web-b" });
  const historyAAfterB = await listOwnedWebsitePublishHistory(prisma, ownerA);
  const settingsHistoryA = await listWebsitePublishes(prisma, ownerA);
  check(
    "OWNER A history still excludes business B publishes",
    !historyAAfterB.versions.some((row) => row.id === websiteB.id) &&
      !settingsHistoryA.versions.some((row) => row.id === websiteB.id) &&
      catalogB.businessId === handyB.id &&
      handySnap.businessId === handyB.id,
  );
  await expectRejects(
    "OWNER A cannot restore OWNER B website publish",
    () =>
      restoreOwnedWebsitePublish(prisma, ownerA, {
        publishId: websiteB.id,
        confirmed: true,
        expectedCurrentId: websiteV1.id,
      }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );

  const parsedV1 = parseWebsiteSnapshot(websiteV1Json);
  const brokenSnapshot = {
    ...parsedV1,
    trades: parsedV1.trades.map((trade) =>
      trade.code === "CLEANING"
        ? {
            ...trade,
            tenantIntakeCaptured: true,
            tenantIntake: {
              snapshotId: `missing_${randomUUID().replaceAll("-", "")}`,
              versionNumber: 1,
            },
          }
        : trade,
    ),
  };
  const broken = await prisma.websitePublish.create({
    data: {
      businessId: cleanA.id,
      versionNumber: 90,
      schemaVersion: 1,
      snapshotJson: JSON.stringify(brokenSnapshot),
      summary: "broken captured intake",
    },
  });
  const pointerBeforeBroken = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const intakeBeforeBroken = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  await expectRejects(
    "Restore fails closed when the target captured intake is missing",
    () =>
      restoreOwnedWebsitePublish(prisma, ownerA, {
        publishId: broken.id,
        confirmed: true,
        expectedCurrentId: websiteV1.id,
      }),
    (error) =>
      error instanceof WebsitePublishError &&
      String(error.message).includes("captured intake snapshot"),
  );
  const pointerAfterBroken = await prisma.business.findFirst({
    where: { id: cleanA.id },
    select: { publishedWebsiteId: true },
  });
  const intakeAfterBroken = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  check(
    "Failed restore leaves website and intake pointers unchanged",
    pointerAfterBroken?.publishedWebsiteId === pointerBeforeBroken?.publishedWebsiteId &&
      intakeAfterBroken?.publishedIntakeSnapshotId === intakeBeforeBroken?.publishedIntakeSnapshotId,
  );

  const rereadHistoricalCleaningV1 = await prisma.serviceRequest.findUnique({
    where: { id: historicalCleaningV1.id },
  });
  const rereadHistoricalCleaningV2 = await prisma.serviceRequest.findUnique({
    where: { id: historicalCleaningV2.id },
  });
  const rereadHistoricalHandyV1 = await prisma.serviceRequest.findUnique({
    where: { id: historicalHandyV1.id },
  });
  const resolvedCleaningV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: rereadHistoricalCleaningV1?.intakeSchemaKey,
    intakeSchemaVersion: rereadHistoricalCleaningV1?.intakeSchemaVersion,
    intakeSchemaJson: rereadHistoricalCleaningV1?.intakeSchemaJson,
    tradeCode: rereadHistoricalCleaningV1?.tradeCode,
  });
  check(
    "Historical ServiceRequests are not rewritten or reinterpreted",
    rereadHistoricalCleaningV1?.tenantIntakeSnapshotId == null &&
      rereadHistoricalCleaningV1?.intakeSchemaJson === freezeIntakeSchema(archivedV1) &&
      resolvedCleaningV1.version === 1 &&
      !resolvedCleaningV1.fields.some((field) => field.key === "fridge_notes") &&
      rereadHistoricalCleaningV2?.intakeSchemaJson === freezeIntakeSchema(archivedV2) &&
      rereadHistoricalHandyV1?.intakeSchemaJson === freezeIntakeSchema(archivedHandyV1) &&
      openedV2After?.intakeSchemaJson ===
        (await prisma.serviceRequest.findUnique({ where: { id: openedV2.requestId } }))
          ?.intakeSchemaJson,
  );
  check(
    "Business B catalog and requests never leak into business A restore",
    openedV2SubmitRow?.businessId === cleanA.id &&
      newV1AfterRow?.businessId === cleanA.id &&
      rereadHistoricalHandyV1?.businessId === handyB.id,
  );

  const boundCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: boundD.id,
      name: "Bound Clean",
      category: "House Cleaning",
      tradeCode: "CLEANING",
      active: true,
    },
  });
  await saveIntakeConditionDraft(prisma, ownerD, {
    tradeCode: "CLEANING",
    document: cleaningDraftV1,
  });
  await publishIntakeConditionDraft(prisma, ownerD, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "bound-intake-v1",
  });
  const boundFirst = await publishWebsite(prisma, ownerD, { idempotencyKey: "bound-web-v1" });
  const extras = [];
  for (let versionNumber = 2; versionNumber <= WEBSITE_PUBLISH_HISTORY_LIMIT + 3; versionNumber += 1) {
    extras.push(
      prisma.websitePublish.create({
        data: {
          businessId: boundD.id,
          versionNumber,
          schemaVersion: boundFirst.schemaVersion,
          snapshotJson: boundFirst.snapshotJson,
          summary: `Bound filler v${versionNumber}`,
        },
      }),
    );
  }
  await Promise.all(extras);
  const boundHistory = await listOwnedWebsitePublishHistory(prisma, ownerD);
  const boundNewest = Math.max(...boundHistory.versions.map((row) => row.versionNumber));
  const boundOldest = Math.min(...boundHistory.versions.map((row) => row.versionNumber));
  check(
    "OWNER website history is newest-first and bounded",
    boundHistory.versions.length === WEBSITE_PUBLISH_HISTORY_LIMIT &&
      boundNewest === WEBSITE_PUBLISH_HISTORY_LIMIT + 3 &&
      boundOldest === boundNewest - WEBSITE_PUBLISH_HISTORY_LIMIT + 1 &&
      !boundHistory.versions.some((row) => row.id === boundFirst.id) &&
      Boolean(boundCatalog.id),
  );
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}

if (failed > 0) {
  console.error(`\n${failed} website-publish-restore check(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`\nAll ${passed} website-publish-restore checks passed.`);
