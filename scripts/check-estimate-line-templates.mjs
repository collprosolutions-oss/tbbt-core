/**
 * OWNER named estimate-line templates: save a bounded set of
 * labor/material/other draft lines and apply them to a DRAFT estimate.
 *
 * Proves isolation, authorization, duplicate names, draft-only apply,
 * no catalog-price writes, and no public hourly prices on a dedicated DB.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-line-templates.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for estimate-line-template checks.");
  process.exit(generateEarly.status ?? 1);
}

const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import(
  "@/lib/authorization"
);
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { isHourlyUnitLabel } = await import("@/lib/estimate-calculators/unit-registry");
const { formatCatalogPriceLabel, publicCatalogUnitAmount } = await import("@/lib/pricing-mode");
const {
  DRAFT_ONLY_APPLY_MESSAGE,
  DRAFT_ONLY_SAVE_MESSAGE,
  DUPLICATE_TEMPLATE_NAME_MESSAGE,
  EMPTY_TEMPLATE_LINES_MESSAGE,
  HOURLY_TEMPLATE_LINE_MESSAGE,
  MAX_TEMPLATE_LINES,
  MAX_TEMPLATE_NAME_LENGTH,
  NAME_REQUIRED_MESSAGE,
  NO_APPROVED_CHANGE_MESSAGE,
  NO_CATALOG_PRICE_WRITE_MESSAGE,
  NO_PUBLIC_HOURLY_PRICE_MESSAGE,
  REVIEW_BEFORE_SEND_MESSAGE,
  TEMPLATE_LINE_BOUND_MESSAGE,
  TEMPLATE_LIST_BOUND,
  TEMPLATE_NOT_FOUND_MESSAGE,
  assertCanManageEstimateLineTemplates,
  canAccessEstimateLineTemplates,
  collectTemplateLines,
  isolateSameBusinessTemplates,
  parseTemplateName,
  templateNameKey,
} = await import("@/lib/estimate-line-templates");
const {
  EstimateLineTemplateError,
  applyEstimateLineTemplateToDraft,
  createDraftEstimateWithOptionalTemplate,
  listEstimateLineTemplates,
  saveEstimateLineTemplateFromDraft,
} = await import("@/lib/estimate-line-template-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_line_templates_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-line-template test database.");
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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    console.error(`FAIL - ${label} (no error thrown)`);
    failures += 1;
  } catch (error) {
    if (predicate(error)) {
      console.log(`  ok  - ${label}`);
    } else {
      console.error(`FAIL - ${label}`, error);
      failures += 1;
    }
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

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function createDraftWithLines(businessId, lines) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.createMany({
    data: lines.map((line) => ({
      businessId,
      estimateId: estimate.id,
      description: line.description,
      quantity: new Prisma.Decimal(line.quantity),
      unitPrice: new Prisma.Decimal(line.unitPrice),
      total: new Prisma.Decimal(line.quantity).mul(line.unitPrice),
      type: line.type,
    })),
  });
  await persistDraftEstimateTotal(prisma, estimate.id, businessId);
  return estimate;
}

async function simulateSend(estimateId, businessId) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) return { ok: false };
    const version = await createEstimateVersionSnapshot(tx, {
      estimateId,
      businessId,
    });
    return { ok: true, version };
  });
}

try {
  console.log("\nSTATIC — Template helpers, UI, and honesty");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("ADMIN can manage estimates but templates stay OWNER-only", roleHasCapability("ADMIN", CAPABILITIES.MANAGE_ESTIMATES) && !canAccessEstimateLineTemplates("ADMIN"));
  check("MEMBER cannot manage templates", !canAccessEstimateLineTemplates("MEMBER") && !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));
  check("OWNER can access templates", canAccessEstimateLineTemplates("OWNER"));

  const schema = readRepo("prisma/schema.prisma");
  const migration = readRepo("prisma/migrations/20260928030000_estimate_line_template/migration.sql");
  const libSrc = readRepo("src/lib/estimate-line-templates.ts");
  const opsSrc = readRepo("src/lib/estimate-line-template-ops.ts");
  const actionSrc = readRepo("src/app/actions/estimate.ts");
  const pageSrc = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
  const newPageSrc = readRepo("src/app/(app)/estimates/new/page.tsx");
  const formSrc = readRepo("src/components/estimates/estimate-line-template-forms.tsx");
  const createFormSrc = readRepo("src/components/estimates/create-manual-estimate-form.tsx");
  const packageSrc = readRepo("package.json");
  const catalogWritePattern =
    /serviceCatalogItem\.(create|update|updateMany|upsert|delete|deleteMany)/;

  const templateModel = schema.slice(
    schema.indexOf("model EstimateLineTemplate {"),
    schema.indexOf("model EstimateLineTemplateLine {"),
  );
  check(
    "Schema keeps templates business-scoped with case-insensitive unique names",
    templateModel.includes("nameKey") &&
      templateModel.includes("@@unique([businessId, nameKey])") &&
      !templateModel.includes("@@unique([businessId, name])") &&
      schema.includes("model EstimateLineTemplateLine"),
  );
  check(
    "Migration is additive and does not rewrite catalog or approved estimates",
    migration.includes('CREATE TABLE IF NOT EXISTS "EstimateLineTemplate"') &&
      !/DROP TABLE|DELETE FROM|TRUNCATE|UPDATE\s+"ServiceCatalogItem"|UPDATE\s+"Estimate"/i.test(
        migration,
      ),
  );
  check("Dedicated test script is registered", packageSrc.includes("test:estimate-templates"));
  check("Save/apply actions re-authorize on the server", actionSrc.includes("saveEstimateLineTemplateFromDraft") && actionSrc.includes("applyEstimateLineTemplateToDraft"));
  check("Draft builder exposes OWNER save/apply", pageSrc.includes("Save as named template") && pageSrc.includes("Apply named template"));
  check("New estimate form can apply a template to a new DRAFT", createFormSrc.includes('name="templateId"') && newPageSrc.includes("loadEstimateLineTemplateOptions"));
  check("UI tells the owner to review before sending", formSrc.includes("REVIEW_BEFORE_SEND_MESSAGE") && createFormSrc.includes("REVIEW_BEFORE_SEND_MESSAGE"));
  check("Ops never write catalog prices", !catalogWritePattern.test(opsSrc) && opsSrc.includes("never writes ServiceCatalogItem"));
  check(
    "Apply stays on DRAFT and claims with the send updateMany lock",
    opsSrc.includes('status: "DRAFT"') &&
      opsSrc.includes("updateMany") &&
      opsSrc.includes("DRAFT_ONLY_APPLY_MESSAGE") &&
      opsSrc.includes("REVIEW_BEFORE_SEND_MESSAGE"),
  );
  check(
    "Create Estimate applies a template in the same transaction as the new draft",
    actionSrc.includes("createDraftEstimateWithOptionalTemplate") &&
      actionSrc.includes("applyEstimateLineTemplateInTx") &&
      opsSrc.includes("createDraftEstimateWithOptionalTemplate"),
  );
  check("Public hourly prices stay off templates", /do not publish hourly prices/i.test(NO_PUBLIC_HOURLY_PRICE_MESSAGE) && libSrc.includes("isHourlyUnitLabel"));
  check(
    "Public catalog labels drop hourly units",
    formatCatalogPriceLabel("VARIABLE", 75, "hour") === "From $75.00" &&
      isHourlyUnitLabel("hour"),
  );
  check("Blank name is rejected", parseTemplateName("").error === NAME_REQUIRED_MESSAGE);
  check("Too-long name is rejected", parseTemplateName("x".repeat(MAX_TEMPLATE_NAME_LENGTH + 1)).error.includes(String(MAX_TEMPLATE_NAME_LENGTH)));
  check("Name is trimmed", parseTemplateName("  Bath refresh  ").name === "Bath refresh");
  check("Name key folds letter casing", templateNameKey("Bath refresh") === "bath refresh");
  check("List bound is 40", TEMPLATE_LIST_BOUND === 40);
  check("Line bound is 20", MAX_TEMPLATE_LINES === 20);

  const hourly = collectTemplateLines([
    { type: "LABOR", description: "Hourly carpentry", quantity: "1", unitPrice: "75" },
  ]);
  check("Hourly title is rejected", hourly.error === HOURLY_TEMPLATE_LINE_MESSAGE);
  check(
    "Empty set is rejected",
    collectTemplateLines([]).error === EMPTY_TEMPLATE_LINES_MESSAGE,
  );
  const tooMany = collectTemplateLines(
    Array.from({ length: MAX_TEMPLATE_LINES + 1 }, (_, index) => ({
      type: "LABOR",
      description: `Line ${index + 1}`,
      quantity: "1",
      unitPrice: "10",
    })),
  );
  check("Over-bound line set is rejected", tooMany.error === TEMPLATE_LINE_BOUND_MESSAGE);
  const mixed = collectTemplateLines([
    { type: "LABOR", description: "Install vanity", quantity: "1", unitPrice: "180" },
    { type: "MATERIAL", description: "Vanity cabinet", quantity: "1", unitPrice: "90" },
    { type: "OTHER", description: "Permit", quantity: "1", unitPrice: "25" },
  ]);
  check(
    "Labor/material/other snapshots are collected",
    mixed.error == null &&
      mixed.lines.length === 3 &&
      mixed.lines.map((line) => line.type).join(",") === "LABOR,MATERIAL,OTHER",
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-tmpl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery Admin", email: `admin-tmpl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-tmpl-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-tmpl-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Templates", slug: `alpha-tmpl-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Templates", slug: `beta-tmpl-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
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

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const catalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Vanity install",
      pricingMode: "FIXED",
      price: new Prisma.Decimal("250"),
      active: true,
    },
  });
  const catalogPriceBefore = catalog.price.toString();

  const sourceDraft = await createDraftWithLines(businessA.id, [
    { type: "LABOR", description: "Install vanity\n\nScope / Included Work:\nRemove old vanity", quantity: "1", unitPrice: "180" },
    { type: "MATERIAL", description: "Vanity cabinet", quantity: "1", unitPrice: "90" },
    { type: "OTHER", description: "Permit", quantity: "1", unitPrice: "25" },
  ]);

  console.log("\nDEDICATED DB — Authorization");
  await expectError(
    "ADMIN cannot save a template",
    () =>
      saveEstimateLineTemplateFromDraft(prisma, adminA, {
        estimateId: sourceDraft.id,
        name: "Admin should fail",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot save a template",
    () =>
      saveEstimateLineTemplateFromDraft(prisma, memberA, {
        estimateId: sourceDraft.id,
        name: "Member should fail",
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot list templates",
    () => listEstimateLineTemplates(prisma, adminA),
    (error) => error instanceof ForbiddenError,
  );
  check(
    "assertCanManageEstimateLineTemplates allows OWNER",
    (() => {
      assertCanManageEstimateLineTemplates(ownerA);
      return true;
    })(),
  );

  console.log("\nDEDICATED DB — Save, duplicate names, isolation");
  const saved = await saveEstimateLineTemplateFromDraft(prisma, ownerA, {
    estimateId: sourceDraft.id,
    name: "  Bath refresh  ",
  });
  check("OWNER can save a named template", saved.template.name === "Bath refresh" && saved.template.lineCount === 3);
  check("Save reports that catalog prices are unchanged", saved.message === NO_CATALOG_PRICE_WRITE_MESSAGE);
  check("Saved template stays in the source business", saved.template.businessId === businessA.id);
  const savedRow = await prisma.estimateLineTemplate.findFirst({
    where: { id: saved.template.id, businessId: businessA.id },
  });
  check("Saved nameKey is the lowercase unique key", savedRow?.nameKey === "bath refresh");
  check(
    "Saved lines are labor/material/other snapshots",
    saved.template.lines.map((line) => line.type).join(",") === "LABOR,MATERIAL,OTHER" &&
      saved.template.lines[0].description.includes("Install vanity") &&
      saved.template.lines[0].description.includes("Remove old vanity"),
  );

  await expectError(
    "Duplicate names in the same business are rejected",
    () =>
      saveEstimateLineTemplateFromDraft(prisma, ownerA, {
        estimateId: sourceDraft.id,
        name: "bath refresh",
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === DUPLICATE_TEMPLATE_NAME_MESSAGE,
  );

  const sourceB = await createDraftWithLines(businessB.id, [
    { type: "LABOR", description: "Beta labor", quantity: "1", unitPrice: "50" },
  ]);
  const savedB = await saveEstimateLineTemplateFromDraft(prisma, ownerB, {
    estimateId: sourceB.id,
    name: "Bath refresh",
  });
  check("Another business can reuse the same name", savedB.template.businessId === businessB.id && savedB.template.name === "Bath refresh");

  const listedA = await listEstimateLineTemplates(prisma, ownerA);
  const listedB = await listEstimateLineTemplates(prisma, ownerB);
  check(
    "Owner A lists only same-business templates",
    listedA.templates.length === 1 &&
      listedA.templates[0].id === saved.template.id &&
      listedA.templates.every((row) => row.businessId === businessA.id),
  );
  check(
    "Owner B lists only same-business templates",
    listedB.templates.length === 1 &&
      listedB.templates[0].id === savedB.template.id &&
      listedB.templates.every((row) => row.businessId === businessB.id),
  );
  check(
    "Isolation helper drops foreign templates",
    isolateSameBusinessTemplates(
      [saved.template, savedB.template],
      businessA.id,
    ).every((row) => row.businessId === businessA.id),
  );

  await expectError(
    "Owner A cannot apply Owner B's template",
    () =>
      applyEstimateLineTemplateToDraft(prisma, ownerA, {
        templateId: savedB.template.id,
        estimateId: sourceDraft.id,
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === TEMPLATE_NOT_FOUND_MESSAGE,
  );

  console.log("\nDEDICATED DB — Draft-only apply and catalog isolation");
  const newDraft = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const applied = await applyEstimateLineTemplateToDraft(prisma, ownerA, {
    templateId: saved.template.id,
    estimateId: newDraft.id,
  });
  check("Apply targets a new DRAFT", applied.status === "DRAFT" && applied.estimateId === newDraft.id);
  check("Apply tells the owner to review before sending", applied.message === REVIEW_BEFORE_SEND_MESSAGE);
  check("Apply copies the bounded line set", applied.addedLineCount === 3);

  const appliedDraft = await prisma.estimate.findFirst({
    where: { id: newDraft.id, businessId: businessA.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check("Resulting estimate stays DRAFT", appliedDraft?.status === "DRAFT");
  check(
    "Applied lines are editable draft snapshots, not catalog writes",
    appliedDraft?.lineItems.length === 3 &&
      appliedDraft.lineItems.every((line) => line.serviceCatalogItemId == null) &&
      appliedDraft.lineItems.some((line) => line.type === "LABOR" && line.description.includes("Install vanity")) &&
      appliedDraft.lineItems.some((line) => line.type === "MATERIAL") &&
      appliedDraft.lineItems.some((line) => line.type === "OTHER"),
  );
  const catalogAfterApply = await prisma.serviceCatalogItem.findFirst({
    where: { id: catalog.id, businessId: businessA.id },
  });
  check(
    "Public catalog price is unchanged after save/apply",
    catalogAfterApply?.price.toString() === catalogPriceBefore,
  );

  const sentSource = await createDraftWithLines(businessA.id, [
    { type: "LABOR", description: "Sent labor", quantity: "1", unitPrice: "100" },
  ]);
  const sent = await simulateSend(sentSource.id, businessA.id);
  check("Sent fixture is SENT", sent.ok === true);
  await expectError(
    "Cannot save a template from a SENT estimate",
    () =>
      saveEstimateLineTemplateFromDraft(prisma, ownerA, {
        estimateId: sentSource.id,
        name: "From sent",
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === DRAFT_ONLY_SAVE_MESSAGE,
  );
  await expectError(
    "Cannot apply a template to a SENT estimate",
    () =>
      applyEstimateLineTemplateToDraft(prisma, ownerA, {
        templateId: saved.template.id,
        estimateId: sentSource.id,
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === DRAFT_ONLY_APPLY_MESSAGE,
  );
  const sentAfter = await prisma.estimate.findFirst({
    where: { id: sentSource.id, businessId: businessA.id },
    include: { lineItems: true },
  });
  check(
    "SENT estimate lines stay unchanged",
    sentAfter?.status === "SENT" && sentAfter.lineItems.length === 1,
  );

  const approvedSource = await createDraftWithLines(businessA.id, [
    { type: "LABOR", description: "Approved labor", quantity: "1", unitPrice: "220" },
  ]);
  const approvedSend = await simulateSend(approvedSource.id, businessA.id);
  await prisma.estimate.update({
    where: { id: approvedSource.id },
    data: { status: "APPROVED", approvedVersionId: approvedSend.version.id },
  });
  const approvedBefore = await prisma.estimate.findFirst({
    where: { id: approvedSource.id, businessId: businessA.id },
    include: { lineItems: true },
  });
  await expectError(
    "Cannot apply a template to an APPROVED estimate",
    () =>
      applyEstimateLineTemplateToDraft(prisma, ownerA, {
        templateId: saved.template.id,
        estimateId: approvedSource.id,
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === NO_APPROVED_CHANGE_MESSAGE,
  );
  const approvedAfter = await prisma.estimate.findFirst({
    where: { id: approvedSource.id, businessId: businessA.id },
    include: { lineItems: true },
  });
  check(
    "Approved estimate stays approved with original lines",
    approvedAfter?.status === "APPROVED" &&
      approvedAfter.lineItems.length === approvedBefore.lineItems.length &&
      approvedAfter.approvedVersionId === approvedSend.version.id,
  );

  await expectError(
    "ADMIN cannot apply a template to a draft",
    () =>
      applyEstimateLineTemplateToDraft(prisma, adminA, {
        templateId: saved.template.id,
        estimateId: newDraft.id,
      }),
    (error) => error instanceof ForbiddenError,
  );

  const catalogFinal = await prisma.serviceCatalogItem.findFirst({
    where: { id: catalog.id, businessId: businessA.id },
  });
  check(
    "Catalog price is still the original public amount",
    catalogFinal?.price.toString() === "250" &&
      publicCatalogUnitAmount("FIXED", 250) === 250,
  );
  check(
    "Hourly labels are not a public catalog unit",
    isHourlyUnitLabel("hourly") && publicCatalogUnitAmount("VARIABLE", 0) == null,
  );

  console.log("\nDEDICATED DB — Create Estimate does not leave an orphan draft");
  const createCustomer = await prisma.customer.create({
    data: {
      businessId: businessA.id,
      name: "Create Estimate Customer",
    },
  });
  const estimateCountBefore = await prisma.estimate.count({
    where: { businessId: businessA.id },
  });
  await expectError(
    "Invalid template on Create Estimate does not commit a draft",
    () =>
      createDraftEstimateWithOptionalTemplate(prisma, ownerA, {
        customerId: createCustomer.id,
        templateId: "missing-template-id",
        leadSource: "MANUAL",
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === TEMPLATE_NOT_FOUND_MESSAGE,
  );
  const estimateCountAfterInvalid = await prisma.estimate.count({
    where: { businessId: businessA.id },
  });
  check(
    "Estimate count is unchanged after an invalid template create",
    estimateCountAfterInvalid === estimateCountBefore,
  );
  await expectError(
    "Foreign-business template on Create Estimate does not commit a draft",
    () =>
      createDraftEstimateWithOptionalTemplate(prisma, ownerA, {
        customerId: createCustomer.id,
        templateId: savedB.template.id,
        leadSource: "MANUAL",
      }),
    (error) =>
      error instanceof EstimateLineTemplateError &&
      error.message === TEMPLATE_NOT_FOUND_MESSAGE,
  );
  const estimateCountAfterForeign = await prisma.estimate.count({
    where: { businessId: businessA.id },
  });
  check(
    "Estimate count is unchanged after an unavailable template create",
    estimateCountAfterForeign === estimateCountBefore,
  );
  const createdWithTemplate = await createDraftEstimateWithOptionalTemplate(prisma, ownerA, {
    customerId: createCustomer.id,
    templateId: saved.template.id,
    leadSource: "MANUAL",
  });
  const createdDraft = await prisma.estimate.findFirst({
    where: { id: createdWithTemplate.estimateId, businessId: businessA.id },
    include: { lineItems: true },
  });
  check(
    "Valid Create Estimate + template stays DRAFT with applied lines",
    createdWithTemplate.appliedTemplate &&
      createdDraft?.status === "DRAFT" &&
      createdDraft.lineItems.length === 3,
  );

  console.log("\nDEDICATED DB — Send versus apply race");
  const raceDraft = await createDraftWithLines(businessA.id, [
    { type: "LABOR", description: "Pre-send labor", quantity: "1", unitPrice: "40" },
  ]);
  const [applyRace, sendRace] = await Promise.allSettled([
    applyEstimateLineTemplateToDraft(prisma, ownerA, {
      templateId: saved.template.id,
      estimateId: raceDraft.id,
    }),
    simulateSend(raceDraft.id, businessA.id),
  ]);
  const raced = await prisma.estimate.findFirst({
    where: { id: raceDraft.id, businessId: businessA.id },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      versions: {
        include: { lineItems: { orderBy: { createdAt: "asc" } } },
        orderBy: { versionNumber: "asc" },
      },
    },
  });
  const lineSignature = (line) =>
    [line.description, String(line.quantity), String(line.unitPrice), line.type].join("|");
  const liveSignatures = (raced?.lineItems ?? []).map(lineSignature).sort().join("\n");
  const snapshotSignatures = (raced?.versions[0]?.lineItems ?? [])
    .map(lineSignature)
    .sort()
    .join("\n");
  const liveHasTemplateLine = (raced?.lineItems ?? []).some((line) =>
    line.description.includes("Install vanity"),
  );
  const sendWon = sendRace.status === "fulfilled" && sendRace.value.ok === true;
  const applyWon = applyRace.status === "fulfilled";
  if (sendWon) {
    check("Raced estimate is SENT", raced?.status === "SENT");
    check(
      "SENT live lines match the version snapshot after send-versus-apply",
      Boolean(raced?.versions[0]) && liveSignatures === snapshotSignatures,
    );
    if (!applyWon) {
      check(
        "Send-win leaves no template lines on the SENT estimate",
        !liveHasTemplateLine &&
          raced?.lineItems.length === 1 &&
          raced.lineItems[0].description === "Pre-send labor",
      );
    } else {
      check(
        "Apply-then-send snapshots the template lines with the SENT version",
        liveHasTemplateLine && snapshotSignatures.includes("Install vanity"),
      );
    }
  } else {
    check(
      "Apply-win without send leaves a DRAFT with template lines",
      raced?.status === "DRAFT" && liveHasTemplateLine && applyWon,
    );
  }
  check(
    "A SENT estimate never has template lines missing from its snapshot",
    raced?.status !== "SENT" ||
      !liveHasTemplateLine ||
      snapshotSignatures.includes("Install vanity"),
  );

  console.log("\nDEDICATED DB — Concurrent case-insensitive duplicate names");
  const [nameA, nameB] = await Promise.allSettled([
    saveEstimateLineTemplateFromDraft(prisma, ownerA, {
      estimateId: sourceDraft.id,
      name: "Deck stain",
    }),
    saveEstimateLineTemplateFromDraft(prisma, ownerA, {
      estimateId: sourceDraft.id,
      name: "deck STAIN",
    }),
  ]);
  const concurrentOk = [nameA, nameB].filter((result) => result.status === "fulfilled");
  const concurrentDup = [nameA, nameB].filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof EstimateLineTemplateError &&
      result.reason.message === DUPLICATE_TEMPLATE_NAME_MESSAGE,
  );
  check(
    "Exactly one concurrent same-business case-variant name succeeds",
    concurrentOk.length === 1 && concurrentDup.length === 1,
  );
  const deckRows = await prisma.estimateLineTemplate.findMany({
    where: { businessId: businessA.id, nameKey: "deck stain" },
  });
  check("Only one lowercase nameKey row exists for the concurrent creates", deckRows.length === 1);

  if (failures > 0) {
    console.error(`\n${failures} estimate-line-template check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll estimate-line-template checks passed.");
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
