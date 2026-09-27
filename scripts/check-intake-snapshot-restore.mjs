/**
 * OWNER restore of an older immutable tenant intake snapshot as the
 * current BusinessTrade pointer.
 *
 * Proves same-tenant ownership, wrong-trade refusal, pointer-only revert,
 * and an open public form submitted after a revert. Snapshot rows and
 * historical ServiceRequest records are never rewritten. Public submit
 * still freezes the exact snapshot the form displayed.
 *
 * Dedicated database: tbbt_intake_snapshot_restore_test
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-intake-snapshot-restore.mjs
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
} = await import("@/lib/intake-schema");
const {
  INTAKE_CONDITION_RESTORE_CONFIRM_REQUIRED,
  INTAKE_CONDITION_STATUS_DRAFT,
  IntakeConditionError,
} = await import("@/lib/intake-conditionals");
const {
  loadIntakeConditionWorkspace,
  publishIntakeConditionDraft,
  restoreIntakeConditionSnapshot,
  saveIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");
const {
  listOwnedTenantIntakeSnapshotHistory,
  loadOwnedTenantIntakeSnapshot,
  loadPublishedIntakeOverlay,
  restoreOwnedTenantIntakeSnapshot,
} = await import("@/lib/intake-snapshot-ops");
const {
  TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT,
  parseTenantIntakeSnapshotPayload,
} = await import("@/lib/intake-snapshot");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the intake-snapshot-restore check.");
  process.exit(1);
}

const testDbName = "tbbt_intake_snapshot_restore_test";
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
  "src/lib/intake-conditionals.ts",
  "src/lib/intake-conditionals-ops.ts",
  "src/lib/intake-snapshot.ts",
  "src/lib/intake-snapshot-ops.ts",
  "src/app/actions/intake-conditionals.ts",
  "src/app/(app)/intake-conditionals/page.tsx",
  "src/components/intake-conditionals/workspace.tsx",
  "src/lib/public-intake.ts",
];

const cleaningDraftV1 = {
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
  questions: [
    {
      key: "gate_code_notes",
      type: "NOTES",
      label: "Gate code notes",
    },
  ],
  rules: [
    {
      id: "show-gate",
      questionKey: "gate_code_notes",
      when: { field: "frequency", op: "EQUALS", value: "ONE_TIME" },
      action: "SHOW",
    },
  ],
};

console.log("\nSTATIC — Restore moves the current pointer and leaves snapshots immutable");
const snapshotOpsSrc = read("src/lib/intake-snapshot-ops.ts");
const actionSrc = read("src/app/actions/intake-conditionals.ts");
const pageSrc = read("src/app/(app)/intake-conditionals/page.tsx");
const workspaceSrc = read("src/components/intake-conditionals/workspace.tsx");
const opsSrc = read("src/lib/intake-conditionals-ops.ts");
const publicIntakeSrc = read("src/lib/public-intake.ts");
const navSrc = read("src/lib/nav.ts");
const settingsSrc = read("src/lib/settings.ts");
const restoreFn = snapshotOpsSrc.slice(
  snapshotOpsSrc.indexOf("export async function restoreOwnedTenantIntakeSnapshot"),
  snapshotOpsSrc.indexOf("export async function createTenantIntakeSnapshot"),
);

check(
  "History list is bounded and trade-scoped",
  TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT === 20 &&
    snapshotOpsSrc.includes("take: TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT") &&
    snapshotOpsSrc.includes("listOwnedTenantIntakeSnapshotHistory") &&
    snapshotOpsSrc.includes("...access.scope, tradeCode: code"),
);
check(
  "Restore updates only BusinessTrade.publishedIntakeSnapshotId",
  restoreFn.includes("publishedIntakeSnapshotId: row.id") &&
    restoreFn.includes("businessTrade.updateMany") &&
    !restoreFn.includes("tenantIntakeSnapshot.update") &&
    !restoreFn.includes("snapshotJson:") &&
    !restoreFn.includes("versionNumber:") &&
    !restoreFn.includes("schemaVersion:") &&
    !restoreFn.includes("publishedAt:") &&
    !restoreFn.includes("serviceRequest"),
);
check(
  "Restore requires OWNER confirmation and never takes client businessId",
  INTAKE_CONDITION_RESTORE_CONFIRM_REQUIRED.includes("current public pointer") &&
    snapshotOpsSrc.includes("input.confirmed !== true") &&
    actionSrc.includes("restoreIntakeConditionSnapshotAction") &&
    !actionSrc.includes('readString(formData, "businessId")') &&
    pageSrc.includes('requireBusinessRole(access, "OWNER")') &&
    opsSrc.includes('requireBusinessRole(access, "OWNER")') &&
    snapshotOpsSrc.includes('requireBusinessRole(access, "OWNER")'),
);
check(
  "Workspace history restore is explicit and trade-bound",
  workspaceSrc.includes("Restore this version as current") &&
    workspaceSrc.includes('name="snapshotId"') &&
    workspaceSrc.includes('name="confirmed"') &&
    workspaceSrc.includes("workspace.selectedTrade") &&
    pageSrc.includes("Restore an older published version"),
);
check(
  "Public intake still submits the displayed snapshot, not the current pointer",
  publicIntakeSrc.includes("resolveReferencedTenantIntakeSnapshot") &&
    publicIntakeSrc.includes("tenantIntakeSnapshotId") &&
    !publicIntakeSrc.includes("restoreOwnedTenantIntakeSnapshot") &&
    !publicIntakeSrc.includes("intakeConditionDraft"),
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

try {
  console.log("\nDB — Ownership, wrong-trade, revert, and open-form-after-revert");
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Restore Cleaning",
      slug: `alpha-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const handyB = await prisma.business.create({
    data: {
      name: "Beta Restore Handyman",
      slug: `beta-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const cleanC = await prisma.business.create({
    data: {
      name: "Gamma Restore Cleaning",
      slug: `gamma-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const boundD = await prisma.business.create({
    data: {
      name: "Delta Restore Bound",
      slug: `delta-restore-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, handyB.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, cleanC.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, boundD.id, "CLEANING");

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
  const ownerDUser = await prisma.user.create({
    data: { name: "Owner D", email: `ownerd-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x" },
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
  const ownerDMembership = await prisma.membership.create({
    data: { userId: ownerDUser.id, businessId: boundD.id, role: "OWNER" },
  });

  const ownerA = makeAccess(cleanA.id, "OWNER", ownerAMembership.id);
  const adminA = makeAccess(cleanA.id, "ADMIN", adminAMembership.id);
  const memberA = makeAccess(cleanA.id, "MEMBER", memberAMembership.id);
  const ownerB = makeAccess(handyB.id, "OWNER", ownerBMembership.id);
  const ownerC = makeAccess(cleanC.id, "OWNER", ownerCMembership.id);
  const ownerD = makeAccess(boundD.id, "OWNER", ownerDMembership.id);

  const archivedV1 = archivedIntakeSchema("cleaning.public", 1);
  const v1Customer = await prisma.customer.create({
    data: {
      businessId: cleanA.id,
      name: "Historical V1 Customer",
      email: `v1-${randomUUID().slice(0, 8)}@example.com`,
    },
  });
  const historicalV1 = await prisma.serviceRequest.create({
    data: {
      businessId: cleanA.id,
      customerId: v1Customer.id,
      description: "Frozen pre-restore Cleaning V1 request",
      tradeCode: "CLEANING",
      intakeSchemaKey: "cleaning.public",
      intakeSchemaVersion: 1,
      intakeSchemaJson: freezeIntakeSchema(archivedV1),
      intakeAnswersJson: JSON.stringify({
        bedrooms: 2,
        bathrooms: 1,
        homeSize: "1000_1500",
        frequency: "ONE_TIME",
        addons: ["INTERIOR_WINDOWS"],
        pets: "no",
        accessNotes: "Front door",
      }),
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
  const handyCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanA.id,
      tradeCode: "HANDYMAN",
      name: "Door repair",
      pricingMode: "STARTING_AT",
      active: true,
    },
  });

  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV1,
  });
  const first = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "restore-publish-v1",
  });
  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: cleaningDraftV2,
  });
  const second = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "restore-publish-v2",
  });
  await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "HANDYMAN",
    document: handyDraft,
  });
  const handySnap = await publishIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "HANDYMAN",
    reviewed: true,
    idempotencyKey: "restore-publish-handy-v1",
  });

  const firstJson = first.snapshotJson;
  const firstPublishedAt = first.publishedAt.toISOString();
  const secondJson = second.snapshotJson;
  const handyJson = handySnap.snapshotJson;

  const historyCleaning = await listOwnedTenantIntakeSnapshotHistory(prisma, ownerA, "CLEANING");
  const historyHandy = await listOwnedTenantIntakeSnapshotHistory(prisma, ownerA, "HANDYMAN");
  const historyB = await listOwnedTenantIntakeSnapshotHistory(prisma, ownerB, "HANDYMAN");
  const historyC = await listOwnedTenantIntakeSnapshotHistory(prisma, ownerC, "CLEANING");
  const workspaceA = await loadIntakeConditionWorkspace(prisma, ownerA, "CLEANING");
  check(
    "OWNER history is bounded to this business and trade",
    historyCleaning.historyLimit === TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT &&
      historyCleaning.currentSnapshotId === second.id &&
      historyCleaning.versions.map((row) => row.snapshotId).join(",") === `${second.id},${first.id}` &&
      historyCleaning.versions[0].isCurrent === true &&
      historyCleaning.versions[1].isCurrent === false &&
      !historyCleaning.versions.some((row) => row.snapshotId === handySnap.id) &&
      historyHandy.versions.map((row) => row.snapshotId).join(",") === handySnap.id &&
      historyHandy.currentSnapshotId === handySnap.id &&
      historyB.versions.length === 0 &&
      historyC.versions.length === 0 &&
      workspaceA.history.currentSnapshotId === second.id &&
      workspaceA.published?.snapshotId === second.id,
  );

  await expectRejects("ADMIN cannot restore", () =>
    restoreIntakeConditionSnapshot(prisma, adminA, {
      snapshotId: first.id,
      tradeCode: "CLEANING",
      confirmed: true,
    }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );
  await expectRejects("MEMBER cannot restore", () =>
    restoreIntakeConditionSnapshot(prisma, memberA, {
      snapshotId: first.id,
      tradeCode: "CLEANING",
      confirmed: true,
    }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );
  await expectRejects("Unconfirmed restore is rejected", () =>
    restoreIntakeConditionSnapshot(prisma, ownerA, {
      snapshotId: first.id,
      tradeCode: "CLEANING",
      confirmed: false,
    }),
    (error) =>
      error instanceof IntakeConditionError &&
      error.message === INTAKE_CONDITION_RESTORE_CONFIRM_REQUIRED,
  );
  await expectRejects("Same-trade OWNER C cannot restore OWNER A's snapshot", () =>
    restoreOwnedTenantIntakeSnapshot(prisma, ownerC, {
      snapshotId: first.id,
      tradeCode: "CLEANING",
      confirmed: true,
    }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("OWNER B cannot restore OWNER A's snapshot onto another tenant", () =>
    restoreOwnedTenantIntakeSnapshot(prisma, ownerB, {
      snapshotId: first.id,
      tradeCode: "HANDYMAN",
      confirmed: true,
    }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("OWNER B cannot load OWNER A's snapshot by id", () =>
    loadOwnedTenantIntakeSnapshot(prisma, ownerB, { snapshotId: first.id, tradeCode: "HANDYMAN" }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("Wrong-trade restore of a Cleaning snapshot onto Handyman is refused", () =>
    restoreOwnedTenantIntakeSnapshot(prisma, ownerA, {
      snapshotId: first.id,
      tradeCode: "HANDYMAN",
      confirmed: true,
    }),
    (error) =>
      error instanceof IntakeConditionError &&
      error.message === "That published version belongs to a different trade.",
  );
  await expectRejects("Wrong-trade restore of a Handyman snapshot onto Cleaning is refused", () =>
    restoreOwnedTenantIntakeSnapshot(prisma, ownerA, {
      snapshotId: handySnap.id,
      tradeCode: "CLEANING",
      confirmed: true,
    }),
    (error) =>
      error instanceof IntakeConditionError &&
      error.message === "That published version belongs to a different trade.",
  );

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
  await expectRejects("Corrupt snapshot cannot be restored as the current pointer", () =>
    restoreOwnedTenantIntakeSnapshot(prisma, ownerA, {
      snapshotId: corrupt.id,
      tradeCode: "CLEANING",
      confirmed: true,
    }),
    (error) =>
      error instanceof IntakeConditionError &&
      error.message === "That published version cannot be restored.",
  );

  const pointerBefore = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
  });
  check(
    "Current pointer is still version 2 before the explicit restore",
    pointerBefore?.publishedIntakeSnapshotId === second.id,
  );

  const restored = await restoreIntakeConditionSnapshot(prisma, ownerA, {
    snapshotId: first.id,
    tradeCode: "CLEANING",
    confirmed: true,
  });
  const rereadFirst = await prisma.tenantIntakeSnapshot.findUnique({ where: { id: first.id } });
  const rereadSecond = await prisma.tenantIntakeSnapshot.findUnique({ where: { id: second.id } });
  const rereadHandy = await prisma.tenantIntakeSnapshot.findUnique({ where: { id: handySnap.id } });
  const pointerAfter = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "CLEANING" },
  });
  const handyPointer = await prisma.businessTrade.findFirst({
    where: { businessId: cleanA.id, tradeCode: "HANDYMAN" },
  });
  const overlayAfter = await loadPublishedIntakeOverlay(prisma, cleanA.id, "CLEANING");
  const historyAfter = await listOwnedTenantIntakeSnapshotHistory(prisma, ownerA, "CLEANING");
  check(
    "Restore moves the current pointer to version 1 and does not edit snapshot rows",
    restored.id === first.id &&
      restored.versionNumber === 1 &&
      pointerAfter?.publishedIntakeSnapshotId === first.id &&
      overlayAfter?.snapshotId === first.id &&
      overlayAfter?.versionNumber === 1 &&
      rereadFirst?.snapshotJson === firstJson &&
      rereadFirst?.versionNumber === 1 &&
      rereadFirst?.publishedAt.toISOString() === firstPublishedAt &&
      rereadSecond?.snapshotJson === secondJson &&
      rereadSecond?.versionNumber === 2 &&
      rereadHandy?.snapshotJson === handyJson &&
      handyPointer?.publishedIntakeSnapshotId === handySnap.id &&
      historyAfter.currentSnapshotId === first.id &&
      historyAfter.versions.find((row) => row.snapshotId === first.id)?.isCurrent === true &&
      historyAfter.versions.find((row) => row.snapshotId === second.id)?.isCurrent === false,
  );

  const v2AfterRevert = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Open V2 Form After Revert",
    email: `v2after-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5552221111",
    address: "21 Main St",
    streetAddress: "21 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Opened on V2, submitted after restore to V1",
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
      oven_notes: "Still the V2 oven question",
      fridge_notes: "Must not be required from the restored V1 pointer",
    },
  });
  const v2AfterRevertRow = v2AfterRevert.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: v2AfterRevert.requestId } })
    : null;
  const v2AfterRevertSchema = v2AfterRevertRow
    ? JSON.parse(v2AfterRevertRow.intakeSchemaJson ?? "{}")
    : { fields: [] };
  const v2AfterRevertAnswers = parseIntakeAnswers(v2AfterRevertRow?.intakeAnswersJson);
  check(
    "Open V2 form submitted after restore still validates and freezes V2",
    v2AfterRevert.ok === true &&
      v2AfterRevertRow?.tenantIntakeSnapshotId === second.id &&
      v2AfterRevertRow?.tenantIntakeSnapshotVersion === 2 &&
      v2AfterRevertRow?.intakeSchemaVersion === 2 &&
      v2AfterRevertSchema.version === 2 &&
      v2AfterRevertSchema.fields.some((field) => field.key === "oven_notes") &&
      v2AfterRevertSchema.fields.some((field) => field.key === "fridge_notes") &&
      v2AfterRevertAnswers.oven_notes === "Still the V2 oven question" &&
      v2AfterRevertAnswers.fridge_notes == null,
  );

  const v1AfterRevert = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "New V1 Form After Revert",
    email: `v1after-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5552222222",
    address: "22 Main St",
    streetAddress: "22 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "New form after restore uses restored V1",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: first.id,
    intakeAnswers: {
      bedrooms: 2,
      bathrooms: 1,
      homeSize: "1000_1500",
      frequency: "ONE_TIME",
      addons: ["INSIDE_FRIDGE"],
      fridge_notes: "Restored V1 fridge question",
      oven_notes: "Must not persist on restored V1",
    },
  });
  const v1AfterRevertRow = v1AfterRevert.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: v1AfterRevert.requestId } })
    : null;
  const v1AfterRevertSchema = v1AfterRevertRow
    ? JSON.parse(v1AfterRevertRow.intakeSchemaJson ?? "{}")
    : { fields: [] };
  check(
    "New public request against the restored pointer freezes V1",
    v1AfterRevert.ok === true &&
      v1AfterRevertRow?.tenantIntakeSnapshotId === first.id &&
      v1AfterRevertRow?.tenantIntakeSnapshotVersion === 1 &&
      v1AfterRevertSchema.version === 1 &&
      v1AfterRevertSchema.fields.some((field) => field.key === "fridge_notes") &&
      !v1AfterRevertSchema.fields.some((field) => field.key === "oven_notes") &&
      parseIntakeAnswers(v1AfterRevertRow?.intakeAnswersJson).fridge_notes ===
        "Restored V1 fridge question" &&
      parseIntakeAnswers(v1AfterRevertRow?.intakeAnswersJson).oven_notes == null,
  );

  const rereadHistorical = await prisma.serviceRequest.findUnique({
    where: { id: historicalV1.id },
  });
  const resolvedFrozenV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: rereadHistorical?.intakeSchemaKey,
    intakeSchemaVersion: rereadHistorical?.intakeSchemaVersion,
    intakeSchemaJson: rereadHistorical?.intakeSchemaJson,
    tradeCode: rereadHistorical?.tradeCode,
  });
  check(
    "Historical Cleaning V1 request is not reinterpreted after restore",
    rereadHistorical?.intakeSchemaVersion === 1 &&
      rereadHistorical?.intakeSchemaJson === freezeIntakeSchema(archivedV1) &&
      rereadHistorical?.tenantIntakeSnapshotId == null &&
      resolvedFrozenV1.version === 1 &&
      !resolvedFrozenV1.fields.some((field) => field.key === "fridge_notes"),
  );

  const handyAfter = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Handy After Restore",
    email: `handy-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5552223333",
    address: "23 Oak St",
    streetAddress: "23 Oak St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Handyman pointer was not moved",
    catalogItemIds: [handyCatalog.id],
    includeOther: false,
    otherDescription: "",
    tenantIntakeSnapshotId: handySnap.id,
    intakeAnswers: {
      frequency: "ONE_TIME",
      gate_code_notes: "1234",
    },
  });
  const handyAfterRow = handyAfter.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: handyAfter.requestId } })
    : null;
  check(
    "Same-business Handyman pointer is unchanged by a Cleaning restore",
    handyAfter.ok === true &&
      handyAfterRow?.tenantIntakeSnapshotId === handySnap.id &&
      handyAfterRow?.tradeCode === "HANDYMAN" &&
      parseIntakeAnswers(handyAfterRow?.intakeAnswersJson).gate_code_notes === "1234",
  );

  await saveIntakeConditionDraft(prisma, ownerD, {
    tradeCode: "CLEANING",
    document: cleaningDraftV1,
  });
  const boundFirst = await publishIntakeConditionDraft(prisma, ownerD, {
    tradeCode: "CLEANING",
    reviewed: true,
    idempotencyKey: "bound-v1",
  });
  const extras = [];
  for (let versionNumber = 2; versionNumber <= TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT + 3; versionNumber += 1) {
    extras.push(
      prisma.tenantIntakeSnapshot.create({
        data: {
          businessId: boundD.id,
          tradeCode: "CLEANING",
          versionNumber,
          status: "PUBLISHED",
          schemaVersion: 1,
          snapshotJson: boundFirst.snapshotJson,
          summary: `Bound filler v${versionNumber}`,
        },
      }),
    );
  }
  await Promise.all(extras);
  const boundHistory = await listOwnedTenantIntakeSnapshotHistory(prisma, ownerD, "CLEANING");
  const boundNewest = Math.max(...boundHistory.versions.map((row) => row.versionNumber));
  const boundOldest = Math.min(...boundHistory.versions.map((row) => row.versionNumber));
  check(
    "OWNER history is newest-first and bounded",
    boundHistory.versions.length === TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT &&
      boundNewest === TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT + 3 &&
      boundOldest === boundNewest - TENANT_INTAKE_SNAPSHOT_HISTORY_LIMIT + 1 &&
      !boundHistory.versions.some((row) => row.snapshotId === boundFirst.id),
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
