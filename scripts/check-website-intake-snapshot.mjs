/**
 * Published websites use the exact TenantIntakeSnapshot captured at
 * OWNER website publish. Later intake publish/restore moves only the
 * live pointer. Already-opened forms, archived Cleaning V1/V2,
 * Handyman V1, and historical ServiceRequests stay exactly as recorded.
 * Missing or cross-tenant/cross-trade snapshot refs fail closed.
 *
 * Dedicated database: tbbt_website_intake_snapshot_test
 *
 * Run with:
 *   npm run test:website-intake-snapshot
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
const {
  INTAKE_CONDITION_STATUS_DRAFT,
  IntakeConditionError,
} = await import("@/lib/intake-conditionals");
const {
  publishIntakeConditionDraft,
  restoreIntakeConditionSnapshot,
  saveIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");
const {
  loadPublishedIntakeOverlaysByTrade,
  loadPublishedIntakeOverlaysForWebsiteSnapshot,
  resolveReferencedTenantIntakeSnapshot,
} = await import("@/lib/intake-snapshot-ops");
const { PUBLIC_INTAKE_REFRESH_FORM } = await import("@/lib/intake-snapshot");
const {
  WebsitePublishError,
  loadPublicWebsiteIntakeOverlays,
  loadPublicWebsiteView,
  parseWebsiteSnapshot,
  publishWebsite,
  rollbackWebsite,
  websiteHasUnpublishedChanges,
} = await import("@/lib/website-engine");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the website-intake-snapshot check.");
  process.exit(1);
}

const testDbName = "tbbt_website_intake_snapshot_test";
const parsedUrl = new URL(baseUrl);
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

const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe|\$executeRaw\b/;
const featureFiles = [
  "src/lib/website-engine/snapshot.ts",
  "src/lib/website-engine/builder.ts",
  "src/lib/website-engine/public.ts",
  "src/lib/website-engine/publish.ts",
  "src/lib/intake-snapshot-ops.ts",
  "src/lib/public-intake.ts",
  "src/app/r/[slug]/page.tsx",
  "src/components/settings/website-publish-panel.tsx",
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

console.log("\nSTATIC — Published website pins captured intake snapshots");
const navSrc = read("src/lib/nav.ts");
const settingsSrc = read("src/lib/settings.ts");
const builderSrc = read("src/lib/website-engine/builder.ts");
const snapshotSrc = read("src/lib/website-engine/snapshot.ts");
const publicSrc = read("src/lib/website-engine/public.ts");
const requestPage = read("src/app/r/[slug]/page.tsx");
const publicIntakeSrc = read("src/lib/public-intake.ts");
const snapshotOpsSrc = read("src/lib/intake-snapshot-ops.ts");
const panelSrc = read("src/components/settings/website-publish-panel.tsx");
const publishSrc = read("src/lib/website-engine/publish.ts");

check(
  "Website publish captures current tenant intake ids without changing global navigation",
  builderSrc.includes("readCurrentPublishedIntake") &&
    builderSrc.includes("tenantIntakeCaptured: true") &&
    snapshotSrc.includes("tenantIntakeCaptured") &&
    publishSrc.includes("publishWebsite") &&
    panelSrc.includes("Publish website") &&
    panelSrc.includes("Publishing captures the current intake snapshot") &&
    !navSrc.includes("intake-conditionals") &&
    !navSrc.includes("intake-snapshot") &&
    !settingsSrc.includes("intake-conditionals") &&
    settingsSrc.includes('"website-publish"'),
);
check(
  "Public hire form loads overlays from the published website, not the live pointer",
  requestPage.includes("loadPublicWebsiteIntakeOverlays") &&
    publicSrc.includes("loadWebsiteSnapshotIntakeOverlays") &&
    snapshotOpsSrc.includes("loadPublishedIntakeOverlaysForWebsiteSnapshot") &&
    publicIntakeSrc.includes("snapshotTenantIntakeStateForTrade") &&
    publicIntakeSrc.includes("websiteIntake"),
);
check(
  "Missing or foreign snapshot refs fail closed; opened forms still send their displayed id",
  snapshotOpsSrc.includes("loadExactPublishedIntakeOverlay") &&
    snapshotOpsSrc.includes("return { ok: false }") &&
    publicIntakeSrc.includes("tenantIntakeSnapshotId") &&
    read("src/components/public/request-flow.tsx").includes(
      'formData.set("tenantIntakeSnapshotId"',
    ) &&
    requestPage.includes("PUBLIC_INTAKE_REFRESH_FORM"),
);
check(
  "No eval, Function, or raw SQL in the dedicated files",
  featureFiles.every((file) => !DANGEROUS.test(read(file))),
);
check(
  "OWNER website publish never takes client businessId",
  !read("src/app/actions/website-engine.ts").includes('readString(formData, "businessId")') &&
    publishSrc.includes("requireBusinessCapability") &&
    publishSrc.includes("access.businessId"),
);

try {
  console.log("\nDB — Publish, restore, old-form submit, authorization, isolation");
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Website Intake",
      slug: `alpha-web-intake-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const handyB = await prisma.business.create({
    data: {
      name: "Beta Website Intake",
      slug: `beta-web-intake-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, handyB.id, "HANDYMAN");

  const ownerAUser = await prisma.user.create({
    data: { name: "Owner A", email: `wia-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Admin A", email: `wia-admin-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Member A", email: `wia-mem-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Owner B", email: `wib-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
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
  const ownerA = makeAccess(cleanA.id, "OWNER", ownerAMembership.id);
  const adminA = makeAccess(cleanA.id, "ADMIN", adminAMembership.id);
  const memberA = makeAccess(cleanA.id, "MEMBER", memberAMembership.id);
  const ownerB = makeAccess(handyB.id, "OWNER", ownerBMembership.id);

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
    data: { businessId: cleanA.id, name: "Historical Cleaning" },
  });
  const historicalHandyCustomer = await prisma.customer.create({
    data: { businessId: handyB.id, name: "Historical Handyman" },
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
  await expectRejects(
    "ADMIN cannot publish a tenant intake snapshot",
    () => publishIntakeConditionDraft(prisma, adminA, { tradeCode: "CLEANING", reviewed: true }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  await expectRejects(
    "MEMBER cannot publish a tenant intake snapshot",
    () => publishIntakeConditionDraft(prisma, memberA, { tradeCode: "CLEANING", reviewed: true }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );
  const first = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "intake-v1",
  });

  await expectRejects(
    "MEMBER cannot publish the website",
    () => publishWebsite(prisma, memberA, { idempotencyKey: "member-web" }),
    (error) => error instanceof ForbiddenError || error.name === "ForbiddenError",
  );

  const websiteV1 = await publishWebsite(prisma, ownerA, { idempotencyKey: "web-v1" });
  const viewV1 = await loadPublicWebsiteView(cleanA.slug, prisma);
  const parsedV1 = viewV1?.snapshot ? parseWebsiteSnapshot(viewV1.snapshot) : null;
  const cleaningTradeV1 = parsedV1?.trades.find((row) => row.code === "CLEANING");
  check(
    "OWNER website publish captures the exact current intake snapshot id and version",
    websiteV1.versionNumber === 1 &&
      viewV1?.source === "snapshot" &&
      cleaningTradeV1?.tenantIntakeCaptured === true &&
      cleaningTradeV1?.tenantIntake?.snapshotId === first.id &&
      cleaningTradeV1?.tenantIntake?.versionNumber === first.versionNumber,
  );

  const overlaysV1 = await loadPublicWebsiteIntakeOverlays(
    prisma,
    viewV1,
    cleanA.id,
    ["CLEANING"],
  );
  check(
    "Published website hire form loads the captured intake overlay",
    overlaysV1.ok === true &&
      overlaysV1.overlays.CLEANING?.snapshotId === first.id &&
      overlaysV1.overlays.CLEANING?.versionNumber === first.versionNumber,
  );

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV2,
  });
  const second = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "intake-v2",
  });
  const livePointer = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  const unpublishedAfterIntake = await websiteHasUnpublishedChanges(prisma, ownerA);
  const viewAfterIntake = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysAfterIntake = await loadPublicWebsiteIntakeOverlays(
    prisma,
    viewAfterIntake,
    cleanA.id,
    ["CLEANING"],
  );
  const currentPointerOverlays = await loadPublishedIntakeOverlaysByTrade(prisma, cleanA.id, [
    "CLEANING",
  ]);
  check(
    "Later intake publish moves the pointer but the live website keeps captured v1",
    second.id !== first.id &&
      livePointer?.publishedIntakeSnapshotId === second.id &&
      unpublishedAfterIntake === true &&
      overlaysAfterIntake.ok === true &&
      overlaysAfterIntake.overlays.CLEANING?.snapshotId === first.id &&
      currentPointerOverlays.ok === true &&
      currentPointerOverlays.overlays.CLEANING?.snapshotId === second.id,
  );

  const omitAfterCapture = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("omit-id"),
    catalogItemIds: [catalogA.id],
    intakeAnswers: cleaningAnswers(),
  });
  check(
    "Omitting the snapshot id on a published website with a captured overlay refreshes",
    omitAfterCapture.ok === false && omitAfterCapture.error === PUBLIC_INTAKE_REFRESH_FORM,
  );

  const openedV1 = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("opened-v1"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Still V1 after later intake publish",
    }),
  });
  const openedV1Row = openedV1.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: openedV1.requestId } })
    : null;
  check(
    "Already-opened V1 form still submits V1 after a newer intake publish",
    openedV1.ok === true &&
      openedV1Row?.tenantIntakeSnapshotId === first.id &&
      openedV1Row?.tenantIntakeSnapshotVersion === first.versionNumber &&
      parseIntakeAnswers(openedV1Row?.intakeAnswersJson).fridge_notes ===
        "Still V1 after later intake publish" &&
      !JSON.parse(openedV1Row?.intakeSchemaJson ?? "{}").fields.some(
        (field) => field.key === "oven_notes",
      ),
  );

  await restoreIntakeConditionSnapshot(prisma, ownerA, {
    snapshotId: first.id,
    tradeCode: "CLEANING",
    confirmed: true,
  });
  const viewAfterRestore = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysAfterRestore = await loadPublicWebsiteIntakeOverlays(
    prisma,
    viewAfterRestore,
    cleanA.id,
    ["CLEANING"],
  );
  const pointerAfterRestore = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  check(
    "Restore moves only the live pointer; published website still uses captured v1",
    pointerAfterRestore?.publishedIntakeSnapshotId === first.id &&
      overlaysAfterRestore.ok === true &&
      overlaysAfterRestore.overlays.CLEANING?.snapshotId === first.id,
  );

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV2,
  });
  const third = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "intake-v3",
  });
  const websiteV2 = await publishWebsite(prisma, ownerA, { idempotencyKey: "web-v2" });
  const viewV2 = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysV2 = await loadPublicWebsiteIntakeOverlays(prisma, viewV2, cleanA.id, ["CLEANING"]);
  check(
    "Explicit OWNER republish captures the newer intake snapshot",
    websiteV2.versionNumber === 2 &&
      viewV2?.snapshot?.trades.find((row) => row.code === "CLEANING")?.tenantIntake?.snapshotId ===
        third.id &&
      overlaysV2.ok === true &&
      overlaysV2.overlays.CLEANING?.snapshotId === third.id,
  );

  const openedV1AfterWeb = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("old-form-after-web"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Opened before website republish",
    }),
  });
  const openedV1AfterWebRow = openedV1AfterWeb.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: openedV1AfterWeb.requestId } })
    : null;
  check(
    "Already-opened V1 form still submits after the website is republished to a later intake",
    openedV1AfterWeb.ok === true &&
      openedV1AfterWebRow?.tenantIntakeSnapshotId === first.id &&
      openedV1AfterWebRow?.tenantIntakeSnapshotVersion === first.versionNumber,
  );

  const rollback = await rollbackWebsite(prisma, ownerA, {
    publishId: websiteV1.id,
    idempotencyKey: "web-rollback",
  });
  const viewRollback = await loadPublicWebsiteView(cleanA.slug, prisma);
  const overlaysRollback = await loadPublicWebsiteIntakeOverlays(
    prisma,
    viewRollback,
    cleanA.id,
    ["CLEANING"],
  );
  check(
    "Website rollback restores the previously captured intake snapshot",
    rollback.versionNumber === 3 &&
      viewRollback?.snapshot?.trades.find((row) => row.code === "CLEANING")?.tenantIntake
        ?.snapshotId === first.id &&
      overlaysRollback.ok === true &&
      overlaysRollback.overlays.CLEANING?.snapshotId === first.id,
  );

  await saveIntakeConditionDraft(prisma, ownerB, {
    tradeCode: "HANDYMAN",
    document: handyDraft,
  });
  const handySnap = await publishIntakeConditionDraft(prisma, ownerB, {
    tradeCode: "HANDYMAN",
    reviewed: true,
    idempotencyKey: "handy-v1",
  });
  await publishWebsite(prisma, ownerB, { idempotencyKey: "web-b" });

  const missing = await resolveReferencedTenantIntakeSnapshot(prisma, {
    businessId: cleanA.id,
    tradeCode: "CLEANING",
    snapshotId: `missing_${randomUUID().replaceAll("-", "")}`,
  });
  const otherBusiness = await resolveReferencedTenantIntakeSnapshot(prisma, {
    businessId: cleanA.id,
    tradeCode: "CLEANING",
    snapshotId: handySnap.id,
  });
  const wrongTrade = await resolveReferencedTenantIntakeSnapshot(prisma, {
    businessId: cleanA.id,
    tradeCode: "HANDYMAN",
    snapshotId: first.id,
  });
  const foreignSubmit = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("foreign-snap"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: handySnap.id,
    intakeAnswers: cleaningAnswers(),
  });
  const missingSubmit = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    ...contact("missing-snap"),
    catalogItemIds: [catalogA.id],
    tenantIntakeSnapshotId: `missing_${randomUUID().replaceAll("-", "")}`,
    intakeAnswers: cleaningAnswers(),
  });
  check(
    "Referenced snapshot missing, other-business, or wrong-trade fails closed",
    missing.ok === false &&
      otherBusiness.ok === false &&
      wrongTrade.ok === false &&
      foreignSubmit.ok === false &&
      missingSubmit.ok === false,
  );

  const isolatedOverlays = await loadPublishedIntakeOverlaysForWebsiteSnapshot(prisma, cleanA.id, [
    {
      code: "CLEANING",
      tenantIntakeCaptured: true,
      tenantIntake: { snapshotId: handySnap.id, versionNumber: handySnap.versionNumber },
    },
  ]);
  const missingOverlays = await loadPublishedIntakeOverlaysForWebsiteSnapshot(prisma, cleanA.id, [
    {
      code: "CLEANING",
      tenantIntakeCaptured: true,
      tenantIntake: { snapshotId: `missing_${randomUUID().replaceAll("-", "")}`, versionNumber: 1 },
    },
  ]);
  const versionMismatch = await loadPublishedIntakeOverlaysForWebsiteSnapshot(prisma, cleanA.id, [
    {
      code: "CLEANING",
      tenantIntakeCaptured: true,
      tenantIntake: { snapshotId: first.id, versionNumber: 99 },
    },
  ]);
  check(
    "Website overlay load fails closed for foreign, missing, or version-mismatched snapshots",
    isolatedOverlays.ok === false && missingOverlays.ok === false && versionMismatch.ok === false,
  );

  const broken = await prisma.tenantIntakeSnapshot.create({
    data: {
      businessId: cleanA.id,
      tradeCode: "CLEANING",
      versionNumber: 90,
      snapshotJson: "{}",
      summary: "corrupt",
    },
  });
  const pointerBeforeBroken = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    select: { publishedIntakeSnapshotId: true },
  });
  await prisma.businessTrade.updateMany({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    data: { publishedIntakeSnapshotId: broken.id },
  });
  await expectRejects(
    "Website publish fails closed when the current intake pointer is unusable",
    () => publishWebsite(prisma, ownerA, { idempotencyKey: "web-broken" }),
    (error) =>
      error instanceof WebsitePublishError &&
      String(error.message).includes("published intake snapshot"),
  );
  await prisma.businessTrade.updateMany({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
    data: { publishedIntakeSnapshotId: pointerBeforeBroken?.publishedIntakeSnapshotId ?? first.id },
  });

  const compatBusiness = await prisma.business.create({
    data: {
      name: "Compat Website Intake",
      slug: `compat-web-intake-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, compatBusiness.id, "CLEANING");
  const compatUser = await prisma.user.create({
    data: { name: "Compat Owner", email: `wic-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const compatMembership = await prisma.membership.create({
    data: { userId: compatUser.id, businessId: compatBusiness.id, role: "OWNER" },
  });
  const compatOwner = makeAccess(compatBusiness.id, "OWNER", compatMembership.id);
  const compatCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: compatBusiness.id,
      name: "Compat Cleaning",
      category: "House Cleaning",
      tradeCode: "CLEANING",
      active: true,
    },
  });
  await saveIntakeConditionDraft(prisma, compatOwner, {
    tradeCode: "CLEANING",
    document: { ...cleaningDraftV1, tradeCode: "CLEANING" },
  });
  const compatSnap = await publishIntakeConditionDraft(prisma, compatOwner, {
    tradeCode: "CLEANING",
    reviewed: true,
  });
  const compatView = await loadPublicWebsiteView(compatBusiness.slug, prisma);
  const compatOverlays = await loadPublicWebsiteIntakeOverlays(
    prisma,
    compatView,
    compatBusiness.id,
    ["CLEANING"],
  );
  const compatSubmit = await createPublicServiceRequest(prisma, {
    slug: compatBusiness.slug,
    ...contact("compat"),
    catalogItemIds: [catalogA.id].filter(() => false).concat([compatCatalog.id]),
    tenantIntakeSnapshotId: compatSnap.id,
    intakeAnswers: cleaningAnswers({
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Compatibility path",
    }),
  });
  const compatRow = compatSubmit.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: compatSubmit.requestId } })
    : null;
  check(
    "Compatibility sites without a website publish still use the current intake pointer",
    compatView?.source === "compatibility" &&
      compatOverlays.ok === true &&
      compatOverlays.overlays.CLEANING?.snapshotId === compatSnap.id &&
      compatSubmit.ok === true &&
      compatRow?.tenantIntakeSnapshotId === compatSnap.id,
  );

  const rereadCleaningV1 = await prisma.serviceRequest.findUnique({
    where: { id: historicalCleaningV1.id },
  });
  const rereadCleaningV2 = await prisma.serviceRequest.findUnique({
    where: { id: historicalCleaningV2.id },
  });
  const rereadHandyV1 = await prisma.serviceRequest.findUnique({
    where: { id: historicalHandyV1.id },
  });
  const resolvedCleaningV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: rereadCleaningV1?.intakeSchemaKey,
    intakeSchemaVersion: rereadCleaningV1?.intakeSchemaVersion,
    intakeSchemaJson: rereadCleaningV1?.intakeSchemaJson,
    tradeCode: rereadCleaningV1?.tradeCode,
  });
  const resolvedCleaningV2 = resolveRequestIntakeSchema({
    intakeSchemaKey: rereadCleaningV2?.intakeSchemaKey,
    intakeSchemaVersion: rereadCleaningV2?.intakeSchemaVersion,
    intakeSchemaJson: rereadCleaningV2?.intakeSchemaJson,
    tradeCode: rereadCleaningV2?.tradeCode,
  });
  const resolvedHandyV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: rereadHandyV1?.intakeSchemaKey,
    intakeSchemaVersion: rereadHandyV1?.intakeSchemaVersion,
    intakeSchemaJson: rereadHandyV1?.intakeSchemaJson,
    tradeCode: rereadHandyV1?.tradeCode,
  });
  check(
    "Archived Cleaning V1/V2 and Handyman V1 historical requests stay exactly as recorded",
    rereadCleaningV1?.tenantIntakeSnapshotId == null &&
      rereadCleaningV1?.intakeSchemaJson === freezeIntakeSchema(archivedV1) &&
      resolvedCleaningV1.version === 1 &&
      !resolvedCleaningV1.fields.some((field) => field.key === "fridge_notes") &&
      rereadCleaningV2?.tenantIntakeSnapshotId == null &&
      rereadCleaningV2?.intakeSchemaJson === freezeIntakeSchema(archivedV2) &&
      resolvedCleaningV2.version === 2 &&
      rereadHandyV1?.tenantIntakeSnapshotId == null &&
      rereadHandyV1?.intakeSchemaJson === freezeIntakeSchema(archivedHandyV1) &&
      resolvedHandyV1.key === "handyman.public" &&
      resolvedHandyV1.version === 1,
  );
  check(
    "Business B catalog and intake never leak into business A requests",
    openedV1Row?.businessId === cleanA.id &&
      openedV1AfterWebRow?.businessId === cleanA.id &&
      compatRow?.businessId === compatBusiness.id &&
      rereadHandyV1?.businessId === handyB.id &&
      catalogB.businessId === handyB.id,
  );

  if (failed > 0) {
    console.error(`\n${failed} website-intake-snapshot check(s) failed, ${passed} passed.`);
    process.exit(1);
  }
  console.log(`\nAll ${passed} website-intake-snapshot checks passed.`);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
