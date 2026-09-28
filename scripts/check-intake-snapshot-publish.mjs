/**
 * OWNER-reviewed publishing of intake-condition drafts as immutable,
 * versioned tenant intake snapshots.
 *
 * Proves validation, tenant isolation, authorization, publishing,
 * historical replay, and the public-form version race: submit freezes
 * the exact snapshot the form loaded, even after a newer publish.
 * Cleaning public V1/V2, Handyman V1, and existing ServiceRequest rows
 * keep resolving exactly as recorded.
 *
 * Dedicated database: tbbt_intake_snapshot_publish_test
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-intake-snapshot-publish.mjs
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
  currentIntakeSchema,
  freezeIntakeSchema,
  parseIntakeAnswers,
  resolveRequestIntakeSchema,
  validateIntakeAnswers,
} = await import("@/lib/intake-schema");
const {
  INTAKE_CONDITION_DRAFT_STATUS_REQUIRED,
  INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED,
  INTAKE_CONDITION_STATUS_DRAFT,
  IntakeConditionError,
  parseIntakeConditionDocument,
  validateIntakeConditionDocument,
} = await import("@/lib/intake-conditionals");
const {
  loadIntakeConditionWorkspace,
  loadOwnedIntakeConditionDraft,
  publishIntakeConditionDraft,
  saveIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");
const {
  loadOwnedTenantIntakeSnapshot,
  loadPublishedIntakeOverlay,
  loadPublishedIntakeOverlaysByTrade,
  resolveReferencedTenantIntakeSnapshot,
} = await import("@/lib/intake-snapshot-ops");
const {
  PUBLIC_INTAKE_REFRESH_FORM,
  parseTenantIntakeSnapshotPayload,
  tenantIntakeSchemaKey,
} = await import("@/lib/intake-snapshot");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the intake-snapshot-publish check.");
  process.exit(1);
}

const testDbName = "tbbt_intake_snapshot_publish_test";
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

const PRE_162_V1_FIELD_KEYS = [
  "selectedWork",
  "bedrooms",
  "bathrooms",
  "homeSize",
  "frequency",
  "addons",
  "pets",
  "petNotes",
  "accessNotes",
  "photos",
  "notes",
];
const V2_ONLY_FIELDS = ["propertyType", "occupancy", "condition", "visitContext"];
const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe|\$executeRaw\b/;
const featureFiles = [
  "src/lib/intake-conditionals.ts",
  "src/lib/intake-conditionals-ops.ts",
  "src/lib/intake-snapshot.ts",
  "src/lib/intake-snapshot-ops.ts",
  "src/app/actions/intake-conditionals.ts",
  "src/app/(app)/intake-conditionals/page.tsx",
  "src/components/intake-conditionals/workspace.tsx",
  "src/lib/public-intake.ts",
];

const validDraft = {
  version: 1,
  status: INTAKE_CONDITION_STATUS_DRAFT,
  tradeCode: "CLEANING",
  baseSchemaKey: "cleaning.public",
  baseSchemaVersion: 2,
  questions: [
    {
      key: "fridge_notes",
      type: "NOTES",
      label: "Fridge notes",
      required: false,
    },
  ],
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

console.log("\nSTATIC — Archived schemas, drafts, and snapshot publish stay separated");
const archivedV1 = archivedIntakeSchema("cleaning.public", 1);
const archivedV2 = archivedIntakeSchema("cleaning.public", 2);
const cleaningCurrent = currentIntakeSchema("CLEANING");
const handyCurrent = currentIntakeSchema("HANDYMAN");
const handyArchived = archivedIntakeSchema("handyman.public", 1);
check(
  "Archived Cleaning public V1 field set is unchanged",
  archivedV1?.key === "cleaning.public" &&
    archivedV1?.version === 1 &&
    archivedV1?.fields.map((field) => field.key).join(",") === PRE_162_V1_FIELD_KEYS.join(",") &&
    V2_ONLY_FIELDS.every((key) => !archivedV1.fields.some((field) => field.key === key)),
);
check(
  "Current Cleaning public intake remains V2",
  cleaningCurrent.key === "cleaning.public" &&
    cleaningCurrent.version === 2 &&
    archivedV2?.version === 2 &&
    V2_ONLY_FIELDS.every((key) => cleaningCurrent.fields.some((field) => field.key === key)),
);
check(
  "Handyman V1 remains the current and archived schema",
  handyCurrent.key === "handyman.public" &&
    handyCurrent.version === 1 &&
    handyArchived?.version === 1 &&
    JSON.stringify(handyCurrent) === JSON.stringify(handyArchived),
);

const publicIntakeSrc = read("src/lib/public-intake.ts");
const intakeSchemaSrc = read("src/lib/intake-schema.ts");
const navSrc = read("src/lib/nav.ts");
const settingsSrc = read("src/lib/settings.ts");
const actionSrc = read("src/app/actions/intake-conditionals.ts");
const pageSrc = read("src/app/(app)/intake-conditionals/page.tsx");
const opsSrc = read("src/lib/intake-conditionals-ops.ts");
const snapshotOpsSrc = read("src/lib/intake-snapshot-ops.ts");
const migration = read("prisma/migrations/20260927230000_tenant_intake_snapshot/migration.sql");
check(
  "Public intake applies published snapshots and never reads draft rows",
  publicIntakeSrc.includes("resolveReferencedTenantIntakeSnapshot") &&
    publicIntakeSrc.includes("tenantIntakeSnapshotId") &&
    publicIntakeSrc.includes("publishedIntake.baseSchema") &&
    publicIntakeSrc.includes("PUBLIC_INTAKE_REFRESH_FORM") &&
    !publicIntakeSrc.includes("loadPublishedIntakeOverlay") &&
    !publicIntakeSrc.includes("intakeConditionDraft") &&
    !publicIntakeSrc.includes("from \"@/lib/intake-conditionals\""),
);
check(
  "intake-schema.ts still has no draft/snapshot publish dependency",
  !intakeSchemaSrc.includes("intake-conditionals") &&
    !intakeSchemaSrc.includes("TenantIntakeSnapshot") &&
    intakeSchemaSrc.includes("archivedIntakeSchema") &&
    intakeSchemaSrc.includes("resolveRequestIntakeSchema"),
);
check(
  "Global navigation and Settings sections were not changed",
  !navSrc.includes("intake-conditionals") &&
    !navSrc.includes("intake-snapshot") &&
    !settingsSrc.includes("intake-conditionals") &&
    !settingsSrc.includes("Intake condition"),
);
check(
  "No eval, Function, or raw SQL in the dedicated files",
  featureFiles.every((file) => !DANGEROUS.test(read(file))),
);
check(
  "Public submit forwards the displayed snapshot id from the loaded form",
  read("src/app/actions/intake.ts").includes("tenantIntakeSnapshotId") &&
    read("src/components/public/request-flow.tsx").includes(
      'formData.set("tenantIntakeSnapshotId"',
    ),
);
check(
  "Public page fails closed when the current snapshot pointer is unusable",
  read("src/app/r/[slug]/page.tsx").includes("publishedIntake.ok") &&
    read("src/app/r/[slug]/page.tsx").includes("PUBLIC_INTAKE_REFRESH_FORM") &&
    read("src/app/r/[slug]/page.tsx").includes("loadPublicWebsiteIntakeOverlays") &&
    read("src/lib/intake-snapshot-ops.ts").includes("return { ok: false }"),
);
check(
  "OWNER-only publish never takes client businessId",
  pageSrc.includes('requireBusinessRole(access, "OWNER")') &&
    actionSrc.includes("requireOperatingBusinessAccess") &&
    !actionSrc.includes('readString(formData, "businessId")') &&
    opsSrc.includes('requireBusinessRole(access, "OWNER")') &&
    snapshotOpsSrc.includes('requireBusinessRole(access, "OWNER")') &&
    snapshotOpsSrc.includes("access.scope"),
);
check(
  "Migration is additive and idempotent",
  migration.includes("CREATE TABLE IF NOT EXISTS") &&
    migration.includes("TenantIntakeSnapshot") &&
    migration.includes("publishedIntakeSnapshotId") &&
    migration.includes("tenantIntakeSnapshotId") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration),
);
check(
  "Publish requires an OWNER review confirmation",
  INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED.includes("reviewed") &&
    actionSrc.includes("publishIntakeConditionDraftAction") &&
    snapshotOpsSrc.includes("input.reviewed !== true"),
);
check(
  "Draft parse still rejects a PUBLISHED document status",
  parseIntakeConditionDocument({ ...validDraft, status: "PUBLISHED" }).ok === false &&
    parseIntakeConditionDocument({ ...validDraft, status: "PUBLISHED" }).errors.includes(
      INTAKE_CONDITION_DRAFT_STATUS_REQUIRED,
    ),
);
check(
  "Tenant snapshot keys stay off the archived platform catalog",
  tenantIntakeSchemaKey("cleaning.public") === "tenant.cleaning.public" &&
    archivedIntakeSchema("tenant.cleaning.public", 1) == null,
);

const cleaningSchema = currentIntakeSchema("CLEANING");
const valid = validateIntakeConditionDocument(validDraft, cleaningSchema);
check("Valid allowlisted Cleaning draft is accepted", valid.ok === true);

try {
  console.log("\nDB — Validation, isolation, authorization, publish, and historical replay");
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Cleaning Snapshots",
      slug: `alpha-snap-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const handyB = await prisma.business.create({
    data: {
      name: "Beta Handyman Snapshots",
      slug: `beta-snap-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const cleanC = await prisma.business.create({
    data: {
      name: "Gamma Cleaning Snapshots",
      slug: `gamma-snap-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, handyB.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, cleanC.id, "CLEANING");

  const ownerAUser = await prisma.user.create({
    data: { name: "Owner A", email: `ownera-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "Admin A", email: `admina-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "Member A", email: `membera-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Owner B", email: `ownerb-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
  });
  const ownerCUser = await prisma.user.create({
    data: { name: "Owner C", email: `ownerc-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
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
  const ownerCMembership = await prisma.membership.create({
    data: { userId: ownerCUser.id, businessId: cleanC.id, role: "OWNER" },
  });

  const ownerA = makeAccess(cleanA.id, "OWNER", ownerAMembership.id);
  const adminA = makeAccess(cleanA.id, "ADMIN", adminAMembership.id);
  const memberA = makeAccess(cleanA.id, "MEMBER", memberAMembership.id);
  const ownerB = makeAccess(handyB.id, "OWNER", ownerBMembership.id);
  const ownerC = makeAccess(cleanC.id, "OWNER", ownerCMembership.id);

  const v1Customer = await prisma.customer.create({
    data: {
      businessId: cleanA.id,
      name: "Historical V1 Customer",
      email: `v1-${randomUUID().slice(0, 8)}@example.com`,
    },
  });
  const v1Answers = {
    bedrooms: 2,
    bathrooms: 1,
    homeSize: "1000_1500",
    frequency: "ONE_TIME",
    addons: ["INTERIOR_WINDOWS"],
    pets: "no",
    accessNotes: "Front door",
  };
  const historicalV1 = await prisma.serviceRequest.create({
    data: {
      businessId: cleanA.id,
      customerId: v1Customer.id,
      description: "Frozen pre-publish Cleaning V1 request",
      tradeCode: "CLEANING",
      intakeSchemaKey: "cleaning.public",
      intakeSchemaVersion: 1,
      intakeSchemaJson: freezeIntakeSchema(archivedV1),
      intakeAnswersJson: JSON.stringify(v1Answers),
    },
  });

  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanA.id,
      tradeCode: "CLEANING",
      name: "Standard Clean",
      pricingMode: "STARTING_AT",
      active: true,
    },
  });
  const existingV2 = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Existing V2 Customer",
    email: `v2-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551110000",
    address: "9 Pine St",
    streetAddress: "9 Pine St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Existing V2 before publish",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "MONTHLY",
      pets: "no",
    },
  });
  const existingV2Row = existingV2.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: existingV2.requestId } })
    : null;
  check(
    "Existing public request before publish still freezes platform Cleaning V2",
    existingV2.ok === true &&
      existingV2Row?.intakeSchemaKey === "cleaning.public" &&
      existingV2Row?.intakeSchemaVersion === 2 &&
      existingV2Row?.tenantIntakeSnapshotId == null,
  );

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: validDraft,
  });

  const unpublishedPublic = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Draft Only Customer",
    email: `draft-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551112222",
    address: "1 Main St",
    streetAddress: "1 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Still platform only",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Should not persist before publish",
    },
  });
  const unpublishedRow = unpublishedPublic.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: unpublishedPublic.requestId } })
    : null;
  const unpublishedAnswers = parseIntakeAnswers(unpublishedRow?.intakeAnswersJson);
  check(
    "Unpublished drafts are ignored by new public requests",
    unpublishedPublic.ok === true &&
      unpublishedRow?.intakeSchemaKey === "cleaning.public" &&
      unpublishedRow?.intakeSchemaVersion === 2 &&
      unpublishedRow?.tenantIntakeSnapshotId == null &&
      unpublishedAnswers.fridge_notes == null,
  );

  await expectRejects(
    "Unreviewed publish is rejected",
    () => publishIntakeConditionDraft(prisma, ownerA, { tradeCode: "CLEANING", reviewed: false }),
    (error) =>
      error instanceof IntakeConditionError &&
      error.message === INTAKE_CONDITION_PUBLISH_REVIEW_REQUIRED,
  );
  await expectRejects("ADMIN cannot publish", () =>
    publishIntakeConditionDraft(prisma, adminA, { tradeCode: "CLEANING", reviewed: true }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );
  await expectRejects("MEMBER cannot publish", () =>
    publishIntakeConditionDraft(prisma, memberA, { tradeCode: "CLEANING", reviewed: true }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );

  const first = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "publish-v1",
  });
  const firstAgain = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "publish-v1",
  });
  const firstPayload = parseTenantIntakeSnapshotPayload(first.snapshotJson);
  check(
    "OWNER review publishes immutable snapshot version 1 once per idempotency key",
    first.businessId === cleanA.id &&
      first.tradeCode === "CLEANING" &&
      first.versionNumber === 1 &&
      first.status === "PUBLISHED" &&
      firstAgain.id === first.id &&
      firstPayload?.composedSchema.key === "tenant.cleaning.public" &&
      firstPayload?.composedSchema.fields.some((field) => field.key === "fridge_notes") &&
      firstPayload?.baseSchema.version === 2,
  );

  const pointerA = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
  });
  check(
    "BusinessTrade current pointer moves to the published snapshot",
    pointerA?.publishedIntakeSnapshotId === first.id,
  );

  const overlayA = await loadPublishedIntakeOverlay(prisma, cleanA.id, "CLEANING");
  const overlayB = await loadPublishedIntakeOverlay(prisma, handyB.id, "HANDYMAN");
  const overlayC = await loadPublishedIntakeOverlay(prisma, cleanC.id, "CLEANING");
  check(
    "Published overlay is tenant-scoped and does not leak to other businesses",
    overlayA?.snapshotId === first.id &&
      overlayA?.document.questions.some((question) => question.key === "fridge_notes") &&
      overlayB == null &&
      overlayC == null,
  );

  await expectRejects("OWNER B cannot load OWNER A's snapshot by id", () =>
    loadOwnedTenantIntakeSnapshot(prisma, ownerB, { snapshotId: first.id, tradeCode: "HANDYMAN" }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("Same-trade OWNER C cannot read OWNER A's snapshot", () =>
    loadOwnedTenantIntakeSnapshot(prisma, ownerC, { snapshotId: first.id, tradeCode: "CLEANING" }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("OWNER B cannot publish a Cleaning snapshot onto a Handyman-only business", () =>
    publishIntakeConditionDraft(prisma, ownerB, { tradeCode: "CLEANING", reviewed: true }),
    (error) => error instanceof IntakeConditionError,
  );

  const missingRequired = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Needs Fridge Notes",
    email: `need-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5552223333",
    address: "3 Main St",
    streetAddress: "3 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Fridge add-on",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      addons: ["INSIDE_FRIDGE"],
    },
  });
  check(
    "Published required extra question is enforced on new public requests",
    missingRequired.ok === false &&
      "error" in missingRequired &&
      String(missingRequired.error).includes("Fridge notes"),
  );

  const createdLive = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Pat Published",
    email: `pat-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551113333",
    address: "4 Main St",
    streetAddress: "4 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Weekly clean with fridge",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Please wipe shelves",
    },
  });
  const liveRequest = createdLive.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: createdLive.requestId } })
    : null;
  const liveSchema = liveRequest ? JSON.parse(liveRequest.intakeSchemaJson ?? "{}") : { fields: [] };
  const liveAnswers = parseIntakeAnswers(liveRequest?.intakeAnswersJson);
  check(
    "New public request freezes published tenant version 1",
    createdLive.ok === true &&
      liveRequest?.intakeSchemaKey === "tenant.cleaning.public" &&
      liveRequest?.intakeSchemaVersion === 1 &&
      liveRequest?.tenantIntakeSnapshotId === first.id &&
      liveRequest?.tenantIntakeSnapshotVersion === 1 &&
      liveSchema.fields.some((field) => field.key === "fridge_notes") &&
      liveAnswers.fridge_notes === "Please wipe shelves" &&
      liveAnswers.bedrooms === 3,
  );

  const hiddenExtra = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "No Fridge",
    email: `nof-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551114444",
    address: "5 Main St",
    streetAddress: "5 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "No fridge add-on",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
      addons: ["LAUNDRY"],
      fridge_notes: "Should not persist when hidden",
    },
  });
  const hiddenRow = hiddenExtra.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: hiddenExtra.requestId } })
    : null;
  check(
    "Hidden extra answers are not persisted when the published rule does not match",
    hiddenExtra.ok === true &&
      hiddenRow?.tenantIntakeSnapshotVersion === 1 &&
      parseIntakeAnswers(hiddenRow?.intakeAnswersJson).fridge_notes == null,
  );

  const handyCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyB.id,
      tradeCode: "HANDYMAN",
      name: "Door repair",
      pricingMode: "STARTING_AT",
      active: true,
    },
  });
  const handyCreated = await createPublicServiceRequest(prisma, {
    slug: handyB.slug,
    name: "Handy Customer",
    email: `handy-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5553334444",
    address: "2 Oak St",
    streetAddress: "2 Oak St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Handle is loose",
    catalogItemIds: [handyCatalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: { frequency: "ONE_TIME" },
  });
  const handyRequest = handyCreated.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: handyCreated.requestId } })
    : null;
  check(
    "Handyman V1 public intake is unchanged by the other tenant's published snapshot",
    handyCreated.ok === true &&
      handyRequest?.intakeSchemaKey === "handyman.public" &&
      handyRequest?.intakeSchemaVersion === 1 &&
      handyRequest?.tenantIntakeSnapshotId == null &&
      JSON.parse(handyRequest?.intakeSchemaJson ?? "{}")
        .fields.map((field) => field.key)
        .join(",") === handyCurrent.fields.map((field) => field.key).join(","),
  );

  const editedDraft = {
    ...validDraft,
    questions: [
      ...validDraft.questions,
      { key: "oven_notes", type: "NOTES", label: "Oven notes" },
    ],
    rules: [
      ...validDraft.rules,
      {
        id: "show-oven",
        questionKey: "oven_notes",
        when: { field: "addons", op: "INCLUDES", value: "INSIDE_OVEN" },
        action: "SHOW",
      },
    ],
  };
  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: editedDraft,
  });
  const second = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "publish-v2",
  });
  const rereadFirst = await prisma.tenantIntakeSnapshot.findUnique({ where: { id: first.id } });
  check(
    "Second publish creates version 2 and leaves version 1 immutable",
    second.versionNumber === 2 &&
      second.id !== first.id &&
      rereadFirst?.snapshotJson === first.snapshotJson &&
      rereadFirst?.versionNumber === 1 &&
      parseTenantIntakeSnapshotPayload(second.snapshotJson)?.document.questions.some(
        (question) => question.key === "oven_notes",
      ) === true &&
      parseTenantIntakeSnapshotPayload(rereadFirst.snapshotJson)?.document.questions.some(
        (question) => question.key === "oven_notes",
      ) === false,
  );

  const v2Live = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Version Two Customer",
    email: `v2p-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551115555",
    address: "6 Main St",
    streetAddress: "6 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Oven add-on",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: second.id,
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      addons: ["INSIDE_OVEN"],
      oven_notes: "Heavy soil",
    },
  });
  const v2Row = v2Live.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: v2Live.requestId } })
    : null;
  check(
    "Requests after the second publish freeze version 2, not version 1",
    v2Live.ok === true &&
      v2Row?.tenantIntakeSnapshotId === second.id &&
      v2Row?.tenantIntakeSnapshotVersion === 2 &&
      v2Row?.intakeSchemaVersion === 2 &&
      parseIntakeAnswers(v2Row?.intakeAnswersJson).oven_notes === "Heavy soil",
  );

  const v1AfterV2 = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Stale V1 Form",
    email: `v1after-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551116666",
    address: "7 Main St",
    streetAddress: "7 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Opened on V1, submitted after V2",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Still the V1 fridge question",
      oven_notes: "Must not be required or frozen from V2",
    },
  });
  const v1AfterV2Row = v1AfterV2.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: v1AfterV2.requestId } })
    : null;
  const v1AfterV2Schema = v1AfterV2Row
    ? JSON.parse(v1AfterV2Row.intakeSchemaJson ?? "{}")
    : { fields: [] };
  const v1AfterV2Answers = parseIntakeAnswers(v1AfterV2Row?.intakeAnswersJson);
  check(
    "V1 form submitted after V2 is published still validates and freezes V1",
    v1AfterV2.ok === true &&
      v1AfterV2Row?.tenantIntakeSnapshotId === first.id &&
      v1AfterV2Row?.tenantIntakeSnapshotVersion === 1 &&
      v1AfterV2Row?.intakeSchemaVersion === 1 &&
      v1AfterV2Schema.version === 1 &&
      v1AfterV2Schema.fields.some((field) => field.key === "fridge_notes") &&
      !v1AfterV2Schema.fields.some((field) => field.key === "oven_notes") &&
      v1AfterV2Answers.fridge_notes === "Still the V1 fridge question" &&
      v1AfterV2Answers.oven_notes == null &&
      v1AfterV2Schema.fields
        .filter((field) => V2_ONLY_FIELDS.includes(field.key))
        .map((field) => field.key).length ===
        firstPayload?.baseSchema.fields.filter((field) => V2_ONLY_FIELDS.includes(field.key)).length,
  );

  const countBeforeOmit = await prisma.serviceRequest.count({ where: { businessId: cleanA.id } });
  const omittedAfterPublish = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "No Snapshot On Form",
    email: `nosnap-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551117777",
    address: "8 Main St",
    streetAddress: "8 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Form loaded before extras existed",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
      addons: ["INSIDE_FRIDGE"],
    },
  });
  const countAfterOmit = await prisma.serviceRequest.count({ where: { businessId: cleanA.id } });
  check(
    "Omitting a snapshot id after a publish fails with a refresh-form response",
    omittedAfterPublish.ok === false &&
      "error" in omittedAfterPublish &&
      omittedAfterPublish.error === PUBLIC_INTAKE_REFRESH_FORM &&
      countAfterOmit === countBeforeOmit,
  );

  const missingSnapshot = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Missing Snapshot",
    email: `miss-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551118888",
    address: "10 Main St",
    streetAddress: "10 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Referenced snapshot is gone",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: `missing_${randomUUID().replaceAll("-", "")}`,
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
    },
  });
  const crossTenant = await createPublicServiceRequest(prisma, {
    slug: handyB.slug,
    name: "Cross Tenant Snapshot",
    email: `cross-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5553335555",
    address: "11 Oak St",
    streetAddress: "11 Oak St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Other tenant snapshot",
    catalogItemIds: [handyCatalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: { frequency: "ONE_TIME" },
  });
  const corrupt = await prisma.tenantIntakeSnapshot.create({
    data: {
      businessId: cleanA.id,
      tradeCode: "CLEANING",
      versionNumber: 99,
      status: "PUBLISHED",
      schemaVersion: 1,
      snapshotJson: "{not-valid",
    },
  });
  const invalidSnapshot = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Invalid Snapshot",
    email: `inv-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551119999",
    address: "12 Main St",
    streetAddress: "12 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Corrupt snapshot payload",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: corrupt.id,
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
    },
  });
  const resolvedMissing = await resolveReferencedTenantIntakeSnapshot(prisma, {
    businessId: cleanA.id,
    tradeCode: "CLEANING",
    snapshotId: `missing_${randomUUID().replaceAll("-", "")}`,
  });
  const resolvedCorrupt = await resolveReferencedTenantIntakeSnapshot(prisma, {
    businessId: cleanA.id,
    tradeCode: "CLEANING",
    snapshotId: corrupt.id,
  });
  const resolvedCross = await resolveReferencedTenantIntakeSnapshot(prisma, {
    businessId: handyB.id,
    tradeCode: "HANDYMAN",
    snapshotId: first.id,
  });
  check(
    "Unavailable or invalid referenced snapshots fail closed",
    missingSnapshot.ok === false &&
      crossTenant.ok === false &&
      invalidSnapshot.ok === false &&
      resolvedMissing.ok === false &&
      resolvedCorrupt.ok === false &&
      resolvedCross.ok === false &&
      (await prisma.serviceRequest.count({
        where: {
          businessId: { in: [cleanA.id, handyB.id] },
          tenantIntakeSnapshotId: { in: [corrupt.id, first.id] },
          description: { contains: "Other tenant snapshot" },
        },
      })) === 0,
  );

  const broken = await prisma.business.create({
    data: {
      name: "Broken Pointer Cleaning",
      slug: `broken-snap-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, broken.id, "CLEANING");
  const brokenCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: broken.id,
      tradeCode: "CLEANING",
      name: "Broken Clean",
      pricingMode: "STARTING_AT",
      active: true,
    },
  });
  const brokenSnapshot = await prisma.tenantIntakeSnapshot.create({
    data: {
      businessId: broken.id,
      tradeCode: "CLEANING",
      versionNumber: 1,
      status: "PUBLISHED",
      schemaVersion: 1,
      snapshotJson: "{not-valid",
    },
  });
  await prisma.businessTrade.updateMany({
    where: { businessId: broken.id, tradeCode: "CLEANING" },
    data: { publishedIntakeSnapshotId: brokenSnapshot.id },
  });
  const pageLoadBroken = await loadPublishedIntakeOverlaysByTrade(prisma, broken.id, ["CLEANING"]);
  const submitBrokenNoId = await createPublicServiceRequest(prisma, {
    slug: broken.slug,
    name: "Broken Pointer Customer",
    email: `brk-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5550001111",
    address: "13 Main St",
    streetAddress: "13 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Current pointer cannot be parsed",
    catalogItemIds: [brokenCatalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
    },
  });
  const pageLoadHealthy = await loadPublishedIntakeOverlaysByTrade(prisma, cleanA.id, ["CLEANING"]);
  const pageLoadPlainPointer = await loadPublishedIntakeOverlaysByTrade(prisma, handyB.id, [
    "HANDYMAN",
  ]);
  check(
    "Public page fails closed when the current snapshot pointer cannot be loaded or parsed",
    pageLoadBroken.ok === false &&
      submitBrokenNoId.ok === false &&
      "error" in submitBrokenNoId &&
      submitBrokenNoId.error === PUBLIC_INTAKE_REFRESH_FORM &&
      pageLoadHealthy.ok === true &&
      pageLoadHealthy.ok &&
      pageLoadHealthy.overlays.CLEANING?.snapshotId === second.id &&
      pageLoadPlainPointer.ok === true &&
      pageLoadPlainPointer.ok &&
      pageLoadPlainPointer.overlays.HANDYMAN == null &&
      (await prisma.serviceRequest.count({ where: { businessId: broken.id } })) === 0,
  );

  const plain = await prisma.business.create({
    data: {
      name: "Plain Platform Cleaning",
      slug: `plain-snap-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, plain.id, "CLEANING");
  const plainCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: plain.id,
      tradeCode: "CLEANING",
      name: "Plain Clean",
      pricingMode: "STARTING_AT",
      active: true,
    },
  });
  const plainCreated = await createPublicServiceRequest(prisma, {
    slug: plain.slug,
    name: "Plain Platform Customer",
    email: `plain-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5550002222",
    address: "14 Main St",
    streetAddress: "14 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Never published extras",
    catalogItemIds: [plainCatalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
    },
  });
  const plainRow = plainCreated.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: plainCreated.requestId } })
    : null;
  check(
    "Platform-only business with no published snapshot still submits without a snapshot id",
    plainCreated.ok === true &&
      plainRow?.intakeSchemaKey === "cleaning.public" &&
      plainRow?.intakeSchemaVersion === 2 &&
      plainRow?.tenantIntakeSnapshotId == null &&
      !JSON.parse(plainRow?.intakeSchemaJson ?? "{}").fields.some(
        (field) => field.key === "fridge_notes",
      ),
  );

  const replayLiveV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: liveRequest?.intakeSchemaKey,
    intakeSchemaVersion: liveRequest?.intakeSchemaVersion,
    intakeSchemaJson: liveRequest?.intakeSchemaJson,
    tradeCode: liveRequest?.tradeCode,
  });
  const replayedPublishedV1 = validateIntakeAnswers(
    replayLiveV1,
    parseIntakeAnswers(liveRequest?.intakeAnswersJson),
  );
  check(
    "Historical published v1 request still resolves its frozen extra question",
    replayLiveV1.key === "tenant.cleaning.public" &&
      replayLiveV1.version === 1 &&
      replayLiveV1.fields.some((field) => field.key === "fridge_notes") &&
      !replayLiveV1.fields.some((field) => field.key === "oven_notes") &&
      replayedPublishedV1.ok === true,
  );

  const resolvedFrozenV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: historicalV1.intakeSchemaKey,
    intakeSchemaVersion: historicalV1.intakeSchemaVersion,
    intakeSchemaJson: historicalV1.intakeSchemaJson,
    tradeCode: historicalV1.tradeCode,
  });
  const replayedV1 = validateIntakeAnswers(
    resolvedFrozenV1,
    parseIntakeAnswers(historicalV1.intakeAnswersJson),
  );
  const rereadHistorical = await prisma.serviceRequest.findUnique({
    where: { id: historicalV1.id },
  });
  const rereadExistingV2 = await prisma.serviceRequest.findUnique({
    where: { id: existingV2Row?.id ?? "" },
  });
  check(
    "Frozen Cleaning V1 request is unchanged after publish",
    rereadHistorical?.intakeSchemaVersion === 1 &&
      rereadHistorical?.intakeSchemaJson === freezeIntakeSchema(archivedV1) &&
      rereadHistorical?.tenantIntakeSnapshotId == null &&
      resolvedFrozenV1.version === 1 &&
      !resolvedFrozenV1.fields.some((field) => field.key === "fridge_notes") &&
      !resolvedFrozenV1.fields.some((field) => V2_ONLY_FIELDS.includes(field.key)) &&
      replayedV1.ok === true,
  );
  check(
    "Existing Cleaning V2 request stays on platform V2 after later publishes",
    rereadExistingV2?.intakeSchemaKey === "cleaning.public" &&
      rereadExistingV2?.intakeSchemaVersion === 2 &&
      rereadExistingV2?.tenantIntakeSnapshotId == null &&
      resolveRequestIntakeSchema({
        intakeSchemaKey: rereadExistingV2?.intakeSchemaKey,
        intakeSchemaVersion: rereadExistingV2?.intakeSchemaVersion,
        intakeSchemaJson: rereadExistingV2?.intakeSchemaJson,
        tradeCode: rereadExistingV2?.tradeCode,
      }).version === 2,
  );

  const loadedA = await loadIntakeConditionWorkspace(prisma, ownerA, "CLEANING");
  const loadedB = await loadIntakeConditionWorkspace(prisma, ownerB, "HANDYMAN");
  check(
    "Workspace publish view is tenant-scoped",
    loadedA.published?.snapshotId === second.id &&
      loadedA.published?.versionNumber === 2 &&
      loadedB.published == null &&
      loadedA.document.status === INTAKE_CONDITION_STATUS_DRAFT,
  );

  const draftAfterPublish = await loadOwnedIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
  });
  check(
    "Draft row remains DRAFT after publish and is not rewritten as PUBLISHED",
    draftAfterPublish.status === INTAKE_CONDITION_STATUS_DRAFT &&
      !draftAfterPublish.documentJson.includes('"status":"PUBLISHED"'),
  );

  const otherSnapshots = await prisma.tenantIntakeSnapshot.findMany({
    where: { businessId: { in: [handyB.id, cleanC.id] } },
  });
  check("Publishing for A does not create snapshot rows on B or C", otherSnapshots.length === 0);
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
