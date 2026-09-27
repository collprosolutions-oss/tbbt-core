/**
 * Typed allowlisted intake-condition drafts.
 *
 * Proves OWNER can draft/validate/preview extra questions, rules stay
 * allowlisted (no JS/eval), tenants cannot read each other, archived
 * Cleaning public V1/V2 and Handyman V1 stay frozen, historical
 * ServiceRequest snapshots stay frozen, and the live public intake
 * engine ignores unpublished drafts. Publishing is covered by
 * check-intake-snapshot-publish.mjs.
 *
 * Dedicated database: tbbt_intake_conditionals_test
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-intake-conditionals.mjs
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
  INTAKE_CONDITION_STATUS_DRAFT,
  IntakeConditionError,
  emptyIntakeConditionDocument,
  evaluateDraftedQuestion,
  parseIntakeConditionDocument,
  predicateMatches,
  previewIntakeConditionForm,
  validateIntakeConditionDocument,
  validatePreviewIntakeAnswers,
} = await import("@/lib/intake-conditionals");
const {
  loadIntakeConditionWorkspace,
  loadOwnedIntakeConditionDraft,
  publishIntakeConditionDraft,
  saveIntakeConditionDraft,
  validateOwnedIntakeConditionDraft,
} = await import("@/lib/intake-conditionals-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the intake-conditionals check.");
  process.exit(1);
}

const testDbName = "tbbt_intake_conditionals_test";
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
  "src/app/actions/intake-conditionals.ts",
  "src/app/(app)/intake-conditionals/page.tsx",
  "src/components/intake-conditionals/workspace.tsx",
];

console.log("\nSTATIC — Existing intake engine and archived schemas stay frozen");
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
    JSON.stringify(handyCurrent) === JSON.stringify(handyArchived) &&
    handyCurrent.fields.map((field) => field.key).join(",") ===
      "selectedWork,measurements,photos,notes,frequency",
);

const publicIntakeSrc = read("src/lib/public-intake.ts");
const intakeSchemaSrc = read("src/lib/intake-schema.ts");
const navSrc = read("src/lib/nav.ts");
const settingsSrc = read("src/lib/settings.ts");
const actionSrc = read("src/app/actions/intake-conditionals.ts");
const pageSrc = read("src/app/(app)/intake-conditionals/page.tsx");
const opsSrc = read("src/lib/intake-conditionals-ops.ts");
const migration = read("prisma/migrations/20260927153000_intake_condition_draft/migration.sql");
check(
  "Public intake engine does not import or apply condition drafts",
  !publicIntakeSrc.includes("intake-conditionals") &&
    !publicIntakeSrc.includes("intakeConditionDraft") &&
    publicIntakeSrc.includes("resolveReferencedTenantIntakeSnapshot"),
);
check(
  "intake-schema.ts does not depend on the draft system",
  !intakeSchemaSrc.includes("intake-conditionals") &&
    intakeSchemaSrc.includes("archivedIntakeSchema") &&
    intakeSchemaSrc.includes("fieldIsVisible"),
);
check(
  "Global navigation and Settings sections were not changed",
  !navSrc.includes("intake-conditionals") &&
    !settingsSrc.includes("intake-conditionals") &&
    !settingsSrc.includes("Intake condition"),
);
check(
  "No eval, Function, or raw SQL in the dedicated files",
  featureFiles.every((file) => !DANGEROUS.test(read(file))),
);
check(
  "OWNER-only page and actions never take client businessId",
  pageSrc.includes('requireBusinessRole(access, "OWNER")') &&
    actionSrc.includes("requireOperatingBusinessAccess") &&
    !actionSrc.includes('readString(formData, "businessId")') &&
    opsSrc.includes("requireBusinessRole(access, \"OWNER\")") &&
    opsSrc.includes("access.scope"),
);
check(
  "Migration is additive and idempotent",
  migration.includes("CREATE TABLE IF NOT EXISTS") &&
    migration.includes("IntakeConditionDraft") &&
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration),
);
check(
  "Draft parse still rejects a PUBLISHED status on the draft document",
  INTAKE_CONDITION_DRAFT_STATUS_REQUIRED.includes("must stay DRAFT") &&
    opsSrc.includes("publishIntakeConditionDraft") &&
    actionSrc.includes("publishIntakeConditionDraftAction"),
);

console.log("\nSTATIC — Allowlisted validation and preview evaluation");
const cleaningSchema = currentIntakeSchema("CLEANING");
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
    {
      key: "pet_access",
      type: "CHOICE",
      label: "Where should the team put pets?",
      options: [
        { value: "CRATE", label: "Crate" },
        { value: "YARD", label: "Yard" },
      ],
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
    {
      id: "show-pets",
      questionKey: "pet_access",
      when: { field: "pets", op: "IS_YES" },
      action: "SHOW",
    },
  ],
};
const valid = validateIntakeConditionDocument(validDraft, cleaningSchema);
check("Valid allowlisted Cleaning draft is accepted", valid.ok === true);

const jsRejected = validateIntakeConditionDocument(
  {
    ...validDraft,
    rules: [
      {
        id: "evil",
        questionKey: "fridge_notes",
        when: { field: "pets", op: "EVAL", value: "answers.pets === true" },
        action: "SHOW",
      },
    ],
  },
  cleaningSchema,
);
check(
  "Unknown / JS-shaped operators are rejected",
  jsRejected.ok === false &&
    jsRejected.errors.some((error) => error.includes("not allowlisted")),
);

const collision = validateIntakeConditionDocument(
  {
    ...validDraft,
    questions: [{ key: "bedrooms", type: "COUNTS", label: "Bedrooms again" }],
    rules: [],
  },
  cleaningSchema,
);
check(
  "Drafted keys cannot collide with platform fields",
  collision.ok === false && collision.errors.some((error) => error.includes("collides")),
);

const targetPlatform = validateIntakeConditionDocument(
  {
    ...validDraft,
    rules: [
      {
        id: "hide-bedrooms",
        questionKey: "bedrooms",
        when: { field: "pets", op: "IS_YES" },
        action: "HIDE",
      },
    ],
  },
  cleaningSchema,
);
check(
  "Rules cannot hide or require platform fields",
  targetPlatform.ok === false &&
    targetPlatform.errors.some((error) => error.includes("drafted question")),
);

const draftedPredicate = validateIntakeConditionDocument(
  {
    ...validDraft,
    rules: [
      ...validDraft.rules,
      {
        id: "nested",
        questionKey: "pet_access",
        when: { field: "fridge_notes", op: "IS_ANSWERED" },
        action: "SHOW",
      },
    ],
  },
  cleaningSchema,
);
check(
  "Predicates cannot read drafted questions",
  draftedPredicate.ok === false &&
    draftedPredicate.errors.some((error) => error.includes("platform fields")),
);

const publishedRejected = parseIntakeConditionDocument({
  ...validDraft,
  status: "PUBLISHED",
});
check(
  "PUBLISHED status is rejected on draft parse",
  publishedRejected.ok === false &&
    publishedRejected.errors.includes(INTAKE_CONDITION_DRAFT_STATUS_REQUIRED),
);

const v1Pin = validateIntakeConditionDocument(
  { ...validDraft, baseSchemaVersion: 1 },
  cleaningSchema,
);
check(
  "Drafts cannot pin to archived Cleaning V1 while current is V2",
  v1Pin.ok === false && v1Pin.errors.some((error) => error.includes("version 2")),
);

check(
  "INCLUDES matches multi-choice add-ons",
  predicateMatches(
    { field: "addons", op: "INCLUDES", value: "INSIDE_FRIDGE" },
    { addons: ["LAUNDRY", "INSIDE_FRIDGE"] },
  ) === true &&
    predicateMatches(
      { field: "addons", op: "INCLUDES", value: "INSIDE_FRIDGE" },
      { addons: ["LAUNDRY"] },
    ) === false,
);
check(
  "IS_YES / IS_BLANK stay typed",
  predicateMatches({ field: "pets", op: "IS_YES" }, { pets: "yes" }) === true &&
    predicateMatches({ field: "pets", op: "IS_YES" }, { pets: "no" }) === false &&
    predicateMatches({ field: "accessNotes", op: "IS_BLANK" }, { accessNotes: "" }) === true,
);

const hiddenFridge = evaluateDraftedQuestion(
  validDraft.questions[0],
  validDraft.rules,
  { addons: [] },
);
const shownFridge = evaluateDraftedQuestion(
  validDraft.questions[0],
  validDraft.rules,
  { addons: ["INSIDE_FRIDGE"] },
);
check(
  "SHOW+REQUIRE only apply when the allowlisted condition matches",
  hiddenFridge.visible === false &&
    hiddenFridge.required === false &&
    shownFridge.visible === true &&
    shownFridge.required === true,
);

const hideWins = evaluateDraftedQuestion(
  { key: "extra", type: "TEXT", label: "Extra" },
  [
    { id: "show", questionKey: "extra", when: { field: "pets", op: "IS_YES" }, action: "SHOW" },
    { id: "hide", questionKey: "extra", when: { field: "pets", op: "IS_YES" }, action: "HIDE" },
  ],
  { pets: "yes" },
);
check("HIDE wins when both SHOW and HIDE match", hideWins.visible === false);

const previewMissing = validatePreviewIntakeAnswers(
  cleaningSchema,
  valid.ok ? valid.document : emptyIntakeConditionDocument("CLEANING"),
  {
    bedrooms: 3,
    bathrooms: 2,
    homeSize: "1500_2000",
    frequency: "WEEKLY",
    addons: ["INSIDE_FRIDGE"],
  },
);
const previewOk = validatePreviewIntakeAnswers(
  cleaningSchema,
  valid.ok ? valid.document : emptyIntakeConditionDocument("CLEANING"),
  {
    bedrooms: 3,
    bathrooms: 2,
    homeSize: "1500_2000",
    frequency: "WEEKLY",
    addons: ["INSIDE_FRIDGE"],
    fridge_notes: "Please wipe shelves",
  },
);
check(
  "Preview validation requires drafted questions only when visible",
  previewMissing.ok === false &&
    previewOk.ok === true &&
    previewOk.ok &&
    previewOk.answers.fridge_notes === "Please wipe shelves" &&
    previewOk.answers.bedrooms === 3,
);

const preview = previewIntakeConditionForm(cleaningSchema, valid.ok ? valid.document : emptyIntakeConditionDocument("CLEANING"), {
  pets: "no",
  addons: [],
});
check(
  "Interactive preview keeps platform fields and hides unmatched drafted questions",
  preview.platform.fields.some((field) => field.key === "pets") &&
    preview.visibleQuestions.length === 0 &&
    preview.hiddenKeys.includes("fridge_notes"),
);

try {
  console.log("\nDB — History isolation and draft-only persistence");
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Cleaning Conditions",
      slug: `alpha-cond-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const handyB = await prisma.business.create({
    data: {
      name: "Beta Handyman Conditions",
      slug: `beta-cond-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const cleanC = await prisma.business.create({
    data: {
      name: "Gamma Cleaning Conditions",
      slug: `gamma-cond-${randomUUID().slice(0, 8)}`,
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
      description: "Frozen pre-condition Cleaning request",
      tradeCode: "CLEANING",
      intakeSchemaKey: "cleaning.public",
      intakeSchemaVersion: 1,
      intakeSchemaJson: freezeIntakeSchema(archivedV1),
      intakeAnswersJson: JSON.stringify(v1Answers),
    },
  });

  const saved = await saveIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: validDraft,
  });
  check(
    "OWNER can save a tenant-scoped Cleaning draft",
    saved.businessId === cleanA.id &&
      saved.tradeCode === "CLEANING" &&
      saved.status === INTAKE_CONDITION_STATUS_DRAFT &&
      saved.baseSchemaVersion === 2 &&
      !saved.documentJson.includes("bedrooms again"),
  );

  await expectRejects("ADMIN cannot save a draft", () =>
    saveIntakeConditionDraft(prisma, adminA, { tradeCode: "CLEANING", document: validDraft }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );
  await expectRejects("MEMBER cannot save a draft", () =>
    saveIntakeConditionDraft(prisma, memberA, { tradeCode: "CLEANING", document: validDraft }),
    (error) => error instanceof ForbiddenError || error?.name === "ForbiddenError",
  );
  await expectRejects("OWNER B cannot load OWNER A's draft by id", () =>
    loadOwnedIntakeConditionDraft(prisma, ownerB, { tradeCode: "HANDYMAN", draftId: saved.id }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("Same-trade OWNER C cannot read OWNER A's draft", () =>
    loadOwnedIntakeConditionDraft(prisma, ownerC, { tradeCode: "CLEANING", draftId: saved.id }),
    (error) =>
      error instanceof Error && error.message.startsWith("Record is not in the authorized"),
  );
  await expectRejects("OWNER B cannot save a Cleaning draft onto a Handyman-only business", () =>
    saveIntakeConditionDraft(prisma, ownerB, { tradeCode: "CLEANING", document: validDraft }),
    (error) => error instanceof IntakeConditionError,
  );

  const loadedA = await loadIntakeConditionWorkspace(prisma, ownerA, "CLEANING");
  const loadedB = await loadIntakeConditionWorkspace(prisma, ownerB, "HANDYMAN");
  const loadedC = await loadIntakeConditionWorkspace(prisma, ownerC, "CLEANING");
  check(
    "Workspace load is tenant-scoped and does not leak the other business draft",
    loadedA.document.questions.some((question) => question.key === "fridge_notes") &&
      loadedB.document.questions.length === 0 &&
      loadedB.selectedTrade === "HANDYMAN" &&
      loadedC.document.questions.length === 0 &&
      loadedC.selectedTrade === "CLEANING",
  );

  const otherDrafts = await prisma.intakeConditionDraft.findMany({
    where: { businessId: handyB.id },
  });
  check("Saving for A does not create a row on B", otherDrafts.length === 0);

  await expectRejects(
    "Unreviewed publishing is refused even for the owning OWNER",
    () => publishIntakeConditionDraft(prisma, ownerA, { tradeCode: "CLEANING" }),
    (error) =>
      error instanceof IntakeConditionError &&
      error.message.includes("reviewed"),
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
  const rereadHistorical = await prisma.serviceRequest.findUnique({ where: { id: historicalV1.id } });
  check(
    "Frozen Cleaning V1 request is unchanged after a draft is saved",
    rereadHistorical?.intakeSchemaVersion === 1 &&
      rereadHistorical?.intakeSchemaJson === freezeIntakeSchema(archivedV1) &&
      resolvedFrozenV1.version === 1 &&
      !resolvedFrozenV1.fields.some((field) => field.key === "fridge_notes") &&
      !resolvedFrozenV1.fields.some((field) => V2_ONLY_FIELDS.includes(field.key)) &&
      replayedV1.ok === true,
  );

  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanA.id,
      tradeCode: "CLEANING",
      name: "Standard Clean",
      pricingMode: "STARTING_AT",
      active: true,
    },
  });
  const created = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Pat Customer",
    email: `pat-${randomUUID().slice(0, 8)}@example.com`,
    phone: "5551112222",
    address: "1 Main St",
    streetAddress: "1 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Weekly clean",
    catalogItemIds: [catalog.id],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      frequency: "WEEKLY",
      pets: "yes",
      petNotes: "Friendly dog",
      fridge_notes: "Should never persist from a draft-only question",
    },
  });
  check("Public Cleaning intake still succeeds on the existing engine", created.ok === true);
  const liveRequest = created.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: created.requestId } })
    : null;
  const liveSchema = liveRequest
    ? JSON.parse(liveRequest.intakeSchemaJson ?? "{}")
    : { fields: [] };
  const liveAnswers = parseIntakeAnswers(liveRequest?.intakeAnswersJson);
  check(
    "New public request freezes current Cleaning V2 and ignores drafted questions",
    liveRequest?.intakeSchemaKey === "cleaning.public" &&
      liveRequest?.intakeSchemaVersion === 2 &&
      liveSchema.version === 2 &&
      !liveSchema.fields.some((field) => field.key === "fridge_notes") &&
      liveAnswers.fridge_notes == null &&
      liveAnswers.bedrooms === 3,
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
    "Handyman V1 public intake is unchanged by the other tenant's draft",
    handyCreated.ok === true &&
      handyRequest?.intakeSchemaKey === "handyman.public" &&
      handyRequest?.intakeSchemaVersion === 1 &&
      JSON.parse(handyRequest?.intakeSchemaJson ?? "{}").fields.map((field) => field.key).join(",") ===
        handyCurrent.fields.map((field) => field.key).join(","),
  );

  await validateOwnedIntakeConditionDraft(prisma, ownerA, {
    tradeCode: "CLEANING",
    document: validDraft,
  });
  check("OWNER validate helper accepts the saved allowlisted draft", true);
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
