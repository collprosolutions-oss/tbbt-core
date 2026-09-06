/**
 * Multi-line Scope / Included Work on estimate lines, plus explicit
 * Save Service & Scope to Catalog into the existing ServiceCatalogItem catalog.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-scope.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import(
  "@/lib/authorization"
);
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const {
  INCLUDED_WORK_MARKER,
  catalogScopeText,
  joinLineDescription,
  lineItemIncludedWork,
  normalizeIncludedWork,
  splitLineDescription,
} = await import("@/lib/estimate-line-scope");
const {
  CUSTOM_QUOTE_DRAFT_MARKER,
  STARTING_AT_DRAFT_MARKER,
  addRequestDraftLines,
  draftEstimateSendError,
} = await import("@/lib/request-estimate-draft");
const {
  EstimateLineError,
  addCatalogItemToDraftEstimate,
  saveDraftEstimateLineAsCatalog,
  updateDraftEstimateLineIncludedWork,
} = await import("@/lib/estimate-line-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_scope_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-scope test database.");
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
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
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

const WALL_SCOPE = [
  "Remove and dispose of existing siding/paneling",
  "Install new wall paneling",
  "Cut and fit material around windows, doors, outlets, fixtures, or other openings as applicable",
  "Install required finish trim",
  "Reinstall applicable existing fixture(s)",
  "Job-site cleanup and debris removal",
].join("\n");

function scopeOf(item) {
  return item ? lineItemIncludedWork(item.description) : null;
}

function titleOf(item) {
  return item ? splitLineDescription(item.description).title : "";
}

function lineItemModelFieldNames(modelName) {
  const model = Prisma.dmmf.datamodel.models.find((entry) => entry.name === modelName);
  return model ? model.fields.map((field) => field.name) : [];
}

async function simulateSend(estimateId, businessId) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) {
      return { ok: false };
    }
    const version = await createEstimateVersionSnapshot(tx, {
      estimateId,
      businessId,
    });
    return { ok: true, version };
  });
}

try {
  console.log("\nSTATIC — Scope field, customer display, and explicit reuse");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("OWNER can manage catalog", roleHasCapability("OWNER", CAPABILITIES.MANAGE_CATALOG));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    "LineItem has no includedWork column — Preview shares Production DB and cannot select a missing field",
    !schema.includes("includedWork         String?") &&
      !schema.includes("includedWork      String?"),
  );
  check(
    "Prisma LineItem client has no includedWork field (React #441 / missing-column crash)",
    !lineItemModelFieldNames("LineItem").includes("includedWork"),
  );
  check(
    "Prisma EstimateVersionLineItem client has no includedWork field",
    !lineItemModelFieldNames("EstimateVersionLineItem").includes("includedWork"),
  );
  check(
    "Scope is encoded in the existing description snapshot field",
    schema.includes("INCLUDED_WORK_MARKER") && INCLUDED_WORK_MARKER.includes("Scope / Included Work"),
  );

  const laborSource = readFileSync(new URL("../src/lib/labor-minimum.ts", import.meta.url), "utf8");
  check(
    "Labor-minimum totals still read only total and type",
    laborSource.includes("select: { total: true, type: true }") &&
      !laborSource.includes("includedWork"),
  );

  const snapshotSource = readFileSync(
    new URL("../src/lib/estimate-version.ts", import.meta.url),
    "utf8",
  );
  check(
    "Estimate version snapshot copies the description that carries scope",
    snapshotSource.includes("description: item.description") &&
      !snapshotSource.includes("includedWork"),
  );

  const customerPage = readFileSync(
    new URL("../src/app/e/[token]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Customer estimate renders scope from description, without selecting a missing column",
    customerPage.includes("IncludedWorkDisplay") &&
      customerPage.includes("description={item.description}") &&
      !customerPage.includes("includedWork: true"),
  );

  const ownerPageSource = readFileSync(
    new URL("../src/app/(app)/estimates/[estimateId]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Owner estimate detail does not query a Prisma includedWork field",
    !ownerPageSource.includes("includedWork: true") &&
      ownerPageSource.includes("lineItems: { orderBy: { createdAt: \"asc\" } }"),
  );

  const ownerPage = ownerPageSource;
  const reuseForm = readFileSync(
    new URL("../src/components/estimates/draft-line-scope-forms.tsx", import.meta.url),
    "utf8",
  );
  const customForm = readFileSync(
    new URL("../src/components/estimates/add-custom-line-form.tsx", import.meta.url),
    "utf8",
  );
  const customAction = readFileSync(
    new URL("../src/app/actions/estimate.ts", import.meta.url),
    "utf8",
  );
  check(
    "DRAFT owner page can edit scope and optionally save service and scope to the catalog",
    ownerPage.includes("EditLineIncludedWorkForm") &&
      ownerPage.includes("SaveLineForReuseForm") &&
      ownerPage.includes("currentPriceLabel") &&
      reuseForm.includes("Save Service & Scope to Catalog") &&
      reuseForm.includes("Also save the current price as the default starting price") &&
      reuseForm.includes("currentPriceLabel") &&
      !reuseForm.includes("defaultChecked") &&
      reuseForm.includes("useState(false)") &&
      reuseForm.includes("Scope / Included Work"),
  );
  const saveOps = readFileSync(
    new URL("../src/lib/estimate-line-ops.ts", import.meta.url),
    "utf8",
  );
  check(
    "Catalog price is saved only when savePrice is explicitly true",
    saveOps.includes("const savePrice = input.savePrice === true") &&
      !saveOps.includes("input.savePrice !== false"),
  );
  const addCustomSlice = customAction.slice(
    customAction.indexOf("export async function addCustomLineItem"),
    customAction.indexOf("export async function priceEstimateLineItem"),
  );
  check(
    "Add custom item can include scope without writing the catalog",
    customForm.includes('name="includedWork"') &&
      addCustomSlice.includes("includedWork") &&
      !addCustomSlice.includes("saveDraftEstimateLineAsCatalog") &&
      !addCustomSlice.includes("serviceCatalogItem.create"),
  );
  check(
    "Save for reuse is an explicit exported action, not addCustomLineItem",
    customAction.includes("export async function saveEstimateLineForReuse") &&
      customAction.includes("saveDraftEstimateLineAsCatalog"),
  );

  const invoiceCarry = readFileSync(
    new URL("../src/lib/invoice-carry-forward.ts", import.meta.url),
    "utf8",
  );
  check(
    "Invoice carry-forward copies description snapshots and does not select includedWork",
    invoiceCarry.includes("description: line.description") &&
      !invoiceCarry.includes("includedWork"),
  );

  check(
    "normalizeIncludedWork preserves line breaks and trims empty text",
    normalizeIncludedWork(`  ${WALL_SCOPE}  `) === WALL_SCOPE &&
      normalizeIncludedWork("   \n  ") === null,
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-scope-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-scope-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-scope-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Scope",
      slug: `alpha-scope-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      laborMinimumEnabled: true,
      laborMinimumAmount: new Prisma.Decimal("200"),
    },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Scope", slug: `beta-scope-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const fixedItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "TV Mounting",
      description: "Mount TV\nConceal cords",
      pricingMode: "FIXED",
      price: new Prisma.Decimal("150"),
      active: true,
    },
  });
  const startingItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Door Adjustment",
      description: "Adjust latch\nTighten hinges",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal("75"),
      active: true,
    },
  });
  const quoteItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Custom Carpentry",
      description: "Measure on site\nBuild to fit",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
    },
  });

  const catalogCountBefore = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id },
  });

  console.log("\nTEST — Multi-line scope persistence and pricing isolation");
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });

  await prisma.$transaction(async (tx) => {
    await addRequestDraftLines(tx, {
      businessId: businessA.id,
      estimateId: estimate.id,
      items: [
        { quantity: 1, serviceCatalogItem: fixedItem },
        { quantity: 1, serviceCatalogItem: startingItem },
        { quantity: 1, serviceCatalogItem: quoteItem },
        { quantity: 1, customDescription: "one-off custom trim" },
      ],
    });
    await persistDraftEstimateTotal(tx, estimate.id, businessA.id);
  });

  const draft = await prisma.estimate.findUnique({
    where: { id: estimate.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  check(
    "DRAFT estimate detail query (same include as /estimates/[id]) loads without a missing-column crash",
    draft != null && draft.lineItems.length === 4,
  );
  const tvLine = draft.lineItems.find((item) => item.description.includes("TV Mounting"));
  const doorLine = draft.lineItems.find((item) => item.description.includes("Door Adjustment"));
  const carpentryLine = draft.lineItems.find((item) => item.description.includes("Custom Carpentry"));
  const oneOffLine = draft.lineItems.find((item) => item.description.includes("one-off custom trim"));

  check("FIXED catalog description snapshots onto includedWork", scopeOf(tvLine) === "Mount TV\nConceal cords");
  check(
    "STARTING_AT catalog description snapshots onto includedWork",
    scopeOf(doorLine) === "Adjust latch\nTighten hinges",
  );
  check(
    "CUSTOM_QUOTE catalog description snapshots onto includedWork",
    scopeOf(carpentryLine) === "Measure on site\nBuild to fit",
  );
  check("One-off custom request has no scope until the owner adds it", scopeOf(oneOffLine) == null);
  check(
    "Prefill still keeps existing pricing-mode behavior",
    tvLine.unitPrice.toString() === "150" &&
      doorLine.unitPrice.toString() === "75" &&
      doorLine.description.includes(STARTING_AT_DRAFT_MARKER) &&
      carpentryLine.description.includes(CUSTOM_QUOTE_DRAFT_MARKER),
  );
  check(
    "Request prefill does not write extra catalog rows",
    (await prisma.serviceCatalogItem.count({ where: { businessId: businessA.id } })) ===
      catalogCountBefore,
  );

  const totalBeforeScope = draft.total.toString();
  const laborBeforeScope = draft.laborMinimumAdjustment.toString();
  const scoped = await updateDraftEstimateLineIncludedWork(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: oneOffLine.id,
    includedWork: WALL_SCOPE,
  });
  check("DRAFT scope editing persists every line break", scopeOf(scoped) === WALL_SCOPE);
  const afterScope = await prisma.estimate.findUnique({ where: { id: estimate.id } });
  check(
    "Editing scope does not change estimate total or labor minimum",
    afterScope.total.toString() === totalBeforeScope &&
      afterScope.laborMinimumAdjustment.toString() === laborBeforeScope,
  );

  const lineCountBefore = draft.lineItems.length;
  const afterScopeLines = await prisma.lineItem.count({
    where: { estimateId: estimate.id, businessId: businessA.id },
  });
  check("Scope does not create additional priced line items", afterScopeLines === lineCountBefore);

  await expectError(
    "SENT estimate cannot change scope",
    async () => {
      await prisma.estimate.update({
        where: { id: estimate.id },
        data: { status: "SENT" },
      });
      try {
        await updateDraftEstimateLineIncludedWork(prisma, ownerA, {
          estimateId: estimate.id,
          lineItemId: oneOffLine.id,
          includedWork: "should not save",
        });
      } finally {
        await prisma.estimate.update({
          where: { id: estimate.id },
          data: { status: "DRAFT" },
        });
      }
    },
    (error) => error instanceof EstimateLineError,
  );
  const stillDraftScope = await prisma.lineItem.findFirst({
    where: { id: oneOffLine.id, businessId: businessA.id },
  });
  check(
    "Failed SENT scope edit left the DRAFT scope unchanged",
    scopeOf(stillDraftScope) === WALL_SCOPE,
  );

  console.log("\nTEST — Snapshot / SENT / APPROVED lifecycle");
  const sent = await simulateSend(estimate.id, businessA.id);
  check("Send created a version snapshot", sent.ok === true);
  const versionLines = await prisma.estimateVersionLineItem.findMany({
    where: { estimateVersionId: sent.version.id },
    orderBy: { createdAt: "asc" },
  });
  const versionOneOff = versionLines.find((item) => item.description.includes("one-off custom trim"));
  check("SENT snapshot stores the multi-line scope", scopeOf(versionOneOff) === WALL_SCOPE);
  check(
    "SENT snapshot also stores catalog-copied scope",
    scopeOf(versionLines.find((item) => item.description.includes("TV Mounting"))) ===
      "Mount TV\nConceal cords",
  );
  const sentDetail = await prisma.estimate.findFirst({
    where: { id: estimate.id, status: "SENT" },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      versions: { orderBy: { versionNumber: "desc" } },
    },
  });
  check(
    "SENT estimate detail query (same include as /estimates/[id]) loads without a missing-column crash",
    sentDetail != null &&
      sentDetail.lineItems.length > 0 &&
      sentDetail.versions.length > 0 &&
      scopeOf(
        sentDetail.lineItems.find((item) => item.description.includes("one-off custom trim")),
      ) === WALL_SCOPE,
  );

  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { status: "DRAFT" },
  });
  await updateDraftEstimateLineIncludedWork(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: oneOffLine.id,
    includedWork: `${WALL_SCOPE}\nAdd shoe molding`,
  });
  const sent2 = await simulateSend(estimate.id, businessA.id);
  const version1Reread = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sent.version.id, description: { contains: "one-off custom trim" } },
  });
  const version2Line = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sent2.version.id, description: { contains: "one-off custom trim" } },
  });
  check("Version 1 scope is unchanged after a later send", scopeOf(version1Reread) === WALL_SCOPE);
  check(
    "Version 2 stores the edited scope",
    scopeOf(version2Line) === `${WALL_SCOPE}\nAdd shoe molding`,
  );

  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { status: "APPROVED", approvedVersionId: sent2.version.id },
    });
    await tx.estimateVersion.update({
      where: { id: sent2.version.id },
      data: { approvedAt: new Date() },
    });
  });
  const approvedVersionLine = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sent2.version.id, description: { contains: "one-off custom trim" } },
  });
  check(
    "APPROVED version still has the agreed scope",
    scopeOf(approvedVersionLine) === `${WALL_SCOPE}\nAdd shoe molding`,
  );

  const approvedDetail = await prisma.estimate.findFirst({
    where: { id: estimate.id, status: "APPROVED" },
    include: {
      lineItems: { orderBy: { createdAt: "asc" } },
      versions: { orderBy: { versionNumber: "desc" } },
    },
  });
  check(
    "APPROVED estimate detail query (same include as /estimates/[id]) loads without a missing-column crash",
    approvedDetail != null &&
      approvedDetail.lineItems.length > 0 &&
      approvedDetail.versions.length > 0 &&
      scopeOf(
        approvedDetail.lineItems.find((item) =>
          item.description.includes("one-off custom trim"),
        ),
      ) === `${WALL_SCOPE}\nAdd shoe molding`,
  );

  console.log("\nTEST — Save Service & Scope to Catalog and insert snapshot");
  const reuseEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const reuseLine = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: reuseEstimate.id,
      description: joinLineDescription(
        "Decorative Wall Paneling & Finish Carpentry",
        WALL_SCOPE,
      ),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1800),
      total: new Prisma.Decimal(1800),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, reuseEstimate.id, businessA.id);
  const catalogBeforeSave = await prisma.serviceCatalogItem.count({
    where: { businessId: businessA.id },
  });
  check(
    "Creating a one-off custom line does not add a catalog item",
    catalogBeforeSave === catalogCountBefore,
  );

  const savedUnchecked = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
    savePrice: false,
  });
  check(
    "Unchecked price box still saves the service title to the catalog",
    savedUnchecked.name === "Decorative Wall Paneling & Finish Carpentry",
  );
  check(
    "Unchecked price box still saves Scope / Included Work to the catalog",
    catalogScopeText(savedUnchecked.description) === WALL_SCOPE,
  );
  check("Unchecked save stays CUSTOM_QUOTE", savedUnchecked.pricingMode === "CUSTOM_QUOTE");
  check(
    "Unchecked price box does not save the $1,800 job price as the catalog default",
    savedUnchecked.price == null,
  );
  check(
    "Exactly one new catalog row was created after an unchecked save",
    (await prisma.serviceCatalogItem.count({ where: { businessId: businessA.id } })) ===
      catalogCountBefore + 1,
  );

  const savedOmitted = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
  });
  check(
    "Omitting savePrice is treated as unchecked and still does not write the price",
    savedOmitted.id === savedUnchecked.id && savedOmitted.price == null,
  );

  const saved = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
    savePrice: true,
  });
  check("Explicit save creates a reusable ServiceCatalogItem", saved.name === "Decorative Wall Paneling & Finish Carpentry");
  check("Saved reusable service keeps the multi-line scope", catalogScopeText(saved.description) === WALL_SCOPE);
  check("Saved reusable service keeps CUSTOM_QUOTE mode", saved.pricingMode === "CUSTOM_QUOTE");
  check(
    "Checked price box saves the $1,800 job price as the default starting price",
    saved.price?.toString() === "1800",
  );
  check(
    "Checked save updates the same catalog row instead of creating another",
    saved.id === savedUnchecked.id &&
      (await prisma.serviceCatalogItem.count({ where: { businessId: businessA.id } })) ===
        catalogCountBefore + 1,
  );

  const savedUncheckAfterPrice = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
    savePrice: false,
  });
  check(
    "Unchecking later still saves title and scope and leaves the existing catalog price alone",
    savedUncheckAfterPrice.id === saved.id &&
      catalogScopeText(savedUncheckAfterPrice.description) === WALL_SCOPE &&
      savedUncheckAfterPrice.price?.toString() === "1800",
  );

  const savedAgain = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
    savePrice: true,
  });
  check("Saving the same title again updates the existing reusable service", savedAgain.id === saved.id);
  check(
    "No duplicate reusable service was created",
    (await prisma.serviceCatalogItem.count({ where: { businessId: businessA.id } })) ===
      catalogCountBefore + 1,
  );

  const nextEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const inserted = await addCatalogItemToDraftEstimate(prisma, ownerA, {
    estimateId: nextEstimate.id,
    catalogItemId: saved.id,
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(1800),
  });
  check("Inserted estimate receives the saved title", titleOf(inserted) === saved.name);
  check("Inserted estimate receives its own scope snapshot", scopeOf(inserted) === WALL_SCOPE);
  check("Inserted estimate receives the default price as a starting point", inserted.unitPrice.toString() === "1800");
  check("Inserted line is a snapshot, not a live catalog pointer for content", inserted.id !== reuseLine.id);

  await updateDraftEstimateLineIncludedWork(prisma, ownerA, {
    estimateId: nextEstimate.id,
    lineItemId: inserted.id,
    includedWork: `${WALL_SCOPE}\nStain to match existing trim`,
  });
  await prisma.lineItem.update({
    where: { id: inserted.id },
    data: { unitPrice: new Prisma.Decimal(2400), total: new Prisma.Decimal(2400) },
  });
  await persistDraftEstimateTotal(prisma, nextEstimate.id, businessA.id);

  const masterAfterEdit = await prisma.serviceCatalogItem.findFirst({
    where: { id: saved.id, businessId: businessA.id },
  });
  check(
    "Editing the new estimate does not alter the reusable master",
    catalogScopeText(masterAfterEdit.description) === WALL_SCOPE && masterAfterEdit.price.toString() === "1800",
  );

  await prisma.serviceCatalogItem.update({
    where: { id: saved.id },
    data: {
      description: "Updated master scope only",
      price: new Prisma.Decimal(9999),
      name: "Renamed master paneling",
    },
  });
  const historical = await prisma.lineItem.findFirst({
    where: { id: reuseLine.id, businessId: businessA.id },
  });
  const nextLine = await prisma.lineItem.findFirst({
    where: { id: inserted.id, businessId: businessA.id },
  });
  const historicalSent = await simulateSend(reuseEstimate.id, businessA.id);
  const historicalVersion = await prisma.estimateVersionLineItem.findFirst({
    where: {
      estimateVersionId: historicalSent.version.id,
      description: { contains: "Decorative Wall Paneling" },
    },
  });
  check(
    "Later reusable-service edits do not alter previously created estimate lines",
    titleOf(historical) === "Decorative Wall Paneling & Finish Carpentry" &&
      scopeOf(historical) === WALL_SCOPE &&
      historical.unitPrice.toString() === "1800",
  );
  check(
    "The customized second estimate keeps its own title, scope, and price",
    titleOf(nextLine) === "Decorative Wall Paneling & Finish Carpentry" &&
      scopeOf(nextLine) === `${WALL_SCOPE}\nStain to match existing trim` &&
      nextLine.unitPrice.toString() === "2400",
  );
  check(
    "SENT historical snapshot still has the original agreed scope",
    scopeOf(historicalVersion) === WALL_SCOPE &&
      titleOf(historicalVersion) === "Decorative Wall Paneling & Finish Carpentry",
  );

  const insertedFixed = await addCatalogItemToDraftEstimate(prisma, ownerA, {
    estimateId: nextEstimate.id,
    catalogItemId: fixedItem.id,
    quantity: new Prisma.Decimal(1),
  });
  const insertedStarting = await addCatalogItemToDraftEstimate(prisma, ownerA, {
    estimateId: nextEstimate.id,
    catalogItemId: startingItem.id,
    quantity: new Prisma.Decimal(1),
  });
  check("FIXED insert still snapshots catalog price and scope", insertedFixed.unitPrice.toString() === "150" && scopeOf(insertedFixed) === "Mount TV\nConceal cords");
  check(
    "STARTING_AT insert still snapshots catalog price and scope",
    insertedStarting.unitPrice.toString() === "75" &&
      scopeOf(insertedStarting) === "Adjust latch\nTighten hinges",
  );

  const minEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: minEstimate.id,
      description: joinLineDescription("Small labor", "Prep\nInstall\nCleanup"),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(50),
      total: new Prisma.Decimal(50),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, minEstimate.id, businessA.id);
  const minAfter = await prisma.estimate.findUnique({ where: { id: minEstimate.id } });
  check(
    "Labor minimum still calculates when a line has scope",
    minAfter.laborMinimumAdjustment.toString() === "150" && minAfter.total.toString() === "200",
  );

  console.log("\nTEST — Tenant isolation");
  await expectError(
    "Business B cannot edit Business A scope",
    () =>
      updateDraftEstimateLineIncludedWork(prisma, ownerB, {
        estimateId: nextEstimate.id,
        lineItemId: inserted.id,
        includedWork: "stolen",
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "Business B cannot save Business A line into B's catalog",
    () =>
      saveDraftEstimateLineAsCatalog(prisma, ownerB, {
        estimateId: reuseEstimate.id,
        lineItemId: reuseLine.id,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "MEMBER cannot save a reusable service",
    () =>
      saveDraftEstimateLineAsCatalog(prisma, memberA, {
        estimateId: reuseEstimate.id,
        lineItemId: reuseLine.id,
      }),
    (error) => error instanceof ForbiddenError || error instanceof EstimateLineError,
  );
  const betaCatalog = await prisma.serviceCatalogItem.findMany({
    where: { businessId: businessB.id },
  });
  check("Business B still has no catalog rows from Business A saves", betaCatalog.length === 0);
  const aLineUnchanged = await prisma.lineItem.findFirst({
    where: { id: inserted.id, businessId: businessA.id },
  });
  check(
    "Cross-tenant scope edit did not mutate Business A",
    scopeOf(aLineUnchanged) === `${WALL_SCOPE}\nStain to match existing trim`,
  );

  console.log(
    failures === 0
      ? "\nAll estimate scope / reuse checks passed."
      : `\n${failures} estimate scope / reuse check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
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
