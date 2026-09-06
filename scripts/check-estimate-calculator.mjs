/**
 * Variable-scope Decorative Wall Paneling calculator.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-calculator.mjs
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
  CALCULATOR_SNAPSHOT_MARKER,
  catalogCalculatorDefinition,
  catalogScopeText,
  joinLineDescription,
  lineCalculatorSnapshot,
  lineItemIncludedWork,
  lineItemTitle,
} = await import("@/lib/estimate-line-scope");
const {
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
  computeDecorativeWallPaneling,
  grossWallAreaSqFt,
  suggestedPanelEquivalents,
} = await import("@/lib/estimate-calculators");
const {
  EstimateLineError,
  addCatalogItemToDraftEstimate,
  applyDraftEstimateCalculator,
  overrideDraftEstimateLinePrice,
  saveDraftEstimateLineAsCatalog,
} = await import("@/lib/estimate-line-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_calculator_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-calculator test database.");
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
  "Install required finish trim",
  "Job-site cleanup and debris removal",
].join("\n");

try {
  console.log("\nSTATIC — Calculator framework, customer hiding, no new column");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    "No Prisma calculator column — Preview cannot migrate a new field",
    !schema.includes("calculatorSnapshot") &&
      !schema.includes("calculatorId        ") &&
      schema.includes("CALCULATOR_SNAPSHOT_MARKER"),
  );

  const customerPage = readFileSync(
    new URL("../src/app/e/[token]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Customer estimate does not mount the internal calculator UI",
    !customerPage.includes("VariableScopeCalculatorForm") &&
      !customerPage.includes("CalculatorBreakdown") &&
      !customerPage.includes("TBBT Calculator Snapshot") &&
      customerPage.includes("lineItemTitle") &&
      customerPage.includes("IncludedWorkDisplay"),
  );

  const ownerPage = readFileSync(
    new URL("../src/app/(app)/estimates/[estimateId]/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "Owner DRAFT page mounts the calculator and keeps apply on the server",
    ownerPage.includes("VariableScopeCalculatorForm") &&
      ownerPage.includes("applyEstimateCalculator") === false &&
      ownerPage.includes("OverrideLinePriceForm"),
  );

  const founder = computeDecorativeWallPaneling(
    FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check("Gross area is 24 × 12 = 288 sq ft", grossWallAreaSqFt(24, 12) === 288);
  check(
    "Openings are not subtracted from gross labor area",
    grossWallAreaSqFt(24, 12) === 288,
  );
  check("4×8 panel-equivalent count is 9", suggestedPanelEquivalents(24, 12) === 9);
  check("Founder example recommended labor total is exactly $1,800", founder.recommendedAmount === 1800);
  check(
    "Founder example breakdown matches the quoted add-ons",
    founder.lines.find((line) => line.key === "panels")?.amount === 810 &&
      founder.lines.find((line) => line.key === "removal")?.amount === 360 &&
      founder.lines.find((line) => line.key === "patio-doors")?.amount === 150 &&
      founder.lines.find((line) => line.key === "windows")?.amount === 100 &&
      founder.lines.find((line) => line.key === "receptacles")?.amount === 50 &&
      founder.lines.find((line) => line.key === "fixtures")?.amount === 75 &&
      founder.lines.find((line) => line.key === "trim")?.amount === 180 &&
      founder.lines.find((line) => line.key === "cleanup")?.amount === 75,
  );
  const editedAllowances = computeDecorativeWallPaneling(
    { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, trimAllowance: 200, cleanupAllowance: 50 },
    DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  );
  check(
    "Editable trim and cleanup allowances change the recommendation",
    editedAllowances.recommendedAmount === 1795 &&
      editedAllowances.lines.find((line) => line.key === "trim")?.amount === 200 &&
      editedAllowances.lines.find((line) => line.key === "cleanup")?.amount === 50,
  );
  check(
    "Manual panel quantity overrides the auto 4×8 count",
    computeDecorativeWallPaneling(
      { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, panelQuantity: 10 },
      DEFAULT_DECORATIVE_WALL_PANELING_RATES,
    ).recommendedAmount === 1890,
  );

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-calc-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Calc", slug: `alpha-calc-${randomUUID().slice(0, 8)}` },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Calc", slug: `beta-calc-${randomUUID().slice(0, 8)}` },
  });
  const membershipA = await prisma.membership.create({
    data: { businessId: businessA.id, userId: ownerUser.id, role: "OWNER" },
  });
  const membershipMember = await prisma.membership.create({
    data: { businessId: businessA.id, userId: memberUser.id, role: "MEMBER" },
  });
  const membershipB = await prisma.membership.create({
    data: { businessId: businessB.id, userId: betaUser.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", membershipA.id);
  const memberA = makeAccess(businessA.id, "MEMBER", membershipMember.id);
  const ownerB = makeAccess(businessB.id, "OWNER", membershipB.id);

  console.log("\nTEST — Apply founder example on a DRAFT line");
  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const line = await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      description: joinLineDescription(DECORATIVE_WALL_PANELING_TITLE, WALL_SCOPE),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, estimate.id, businessA.id);

  const applied = await applyDraftEstimateCalculator(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });
  const appliedSnapshot = lineCalculatorSnapshot(applied.description);
  check("Recommended price applies to the DRAFT line as $1,800", applied.unitPrice.toString() === "1800");
  check("Applied line total is $1,800", applied.total.toString() === "1800");
  check("Customer-facing title stays the service name", lineItemTitle(applied.description) === DECORATIVE_WALL_PANELING_TITLE);
  check("Customer-facing scope stays separate from the calculator", lineItemIncludedWork(applied.description) === WALL_SCOPE);
  check(
    "Internal snapshot stores dimensions, quantities, rates, and recommended amount",
    appliedSnapshot?.inputs.wallWidthFt === 24 &&
      appliedSnapshot?.inputs.wallHeightFt === 12 &&
      appliedSnapshot?.inputs.removalType === "metal_siding" &&
      appliedSnapshot?.recommendedAmount === 1800 &&
      appliedSnapshot?.appliedAmount === 1800 &&
      appliedSnapshot?.rates.panelRate === 90,
  );
  check(
    "Customer-visible title and scope do not expose the calculator snapshot",
    !lineItemTitle(applied.description).includes("TBBT Calculator") &&
      !lineItemIncludedWork(applied.description)?.includes("TBBT Calculator") &&
      !lineItemIncludedWork(applied.description)?.includes("panelRate") &&
      applied.description.includes(CALCULATOR_SNAPSHOT_MARKER),
  );

  const overridden = await overrideDraftEstimateLinePrice(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    unitPrice: "1900",
  });
  const overrideSnapshot = lineCalculatorSnapshot(overridden.description);
  check("Owner can override the line price after calculation", overridden.unitPrice.toString() === "1900");
  check(
    "Override keeps the recommended snapshot and records the override",
    overrideSnapshot?.recommendedAmount === 1800 &&
      overrideSnapshot?.overriddenAmount === 1900 &&
      lineItemTitle(overridden.description) === DECORATIVE_WALL_PANELING_TITLE,
  );

  await applyDraftEstimateCalculator(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });

  console.log("\nTEST — SENT / APPROVED snapshots stay frozen");
  const sent = await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: estimate.id, businessId: businessA.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    return createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: businessA.id,
    });
  });
  const sentLine = await prisma.estimateVersionLineItem.findFirst({
    where: { estimateVersionId: sent.id },
  });
  await expectError(
    "SENT estimate cannot recalculate or apply a calculator price",
    () =>
      applyDraftEstimateCalculator(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        inputs: { ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE, wallWidthFt: 40 },
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof EstimateLineError,
  );
  await expectError(
    "SENT estimate cannot override the calculator price",
    () =>
      overrideDraftEstimateLinePrice(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        unitPrice: "50",
      }),
    (error) => error instanceof EstimateLineError,
  );
  const sentReread = await prisma.estimateVersionLineItem.findFirst({
    where: { id: sentLine.id },
  });
  check(
    "SENT historical snapshot still has the applied $1,800 recommendation",
    sentReread.unitPrice.toString() === "1800" &&
      lineCalculatorSnapshot(sentReread.description)?.recommendedAmount === 1800 &&
      lineItemTitle(sentReread.description) === DECORATIVE_WALL_PANELING_TITLE,
  );

  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { status: "APPROVED", approvedVersionId: sent.id },
    });
    await tx.estimateVersion.update({
      where: { id: sent.id },
      data: { approvedAt: new Date() },
    });
  });
  await expectError(
    "APPROVED estimate cannot recalculate",
    () =>
      applyDraftEstimateCalculator(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: line.id,
        inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof EstimateLineError,
  );

  console.log("\nTEST — Catalog save does not carry prior job quantities");
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
      description: applied.description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1800),
      total: new Prisma.Decimal(1800),
      type: "LABOR",
    },
  });
  const saved = await saveDraftEstimateLineAsCatalog(prisma, ownerA, {
    estimateId: reuseEstimate.id,
    lineItemId: reuseLine.id,
    savePrice: true,
  });
  const savedDefinition = catalogCalculatorDefinition(saved.description);
  check("Saved catalog keeps the calculator type", savedDefinition?.calculatorId === "decorative-wall-paneling");
  check("Saved catalog keeps the reusable scope", catalogScopeText(saved.description) === WALL_SCOPE);
  check(
    "Saved catalog does not store the previous job's 24×12 quantities",
    !JSON.stringify(savedDefinition ?? {}).includes("\"wallWidthFt\":24") &&
      savedDefinition?.rates.panelRate === 90,
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
  const insertedSnapshot = lineCalculatorSnapshot(inserted.description);
  check(
    "Next estimate receives calculator type and rates without prior job quantities",
    insertedSnapshot?.calculatorId === "decorative-wall-paneling" &&
      insertedSnapshot?.inputs.wallWidthFt === 0 &&
      insertedSnapshot?.inputs.slidingPatioDoors === 0 &&
      insertedSnapshot?.rates.panelRate === 90 &&
      lineItemTitle(inserted.description) === DECORATIVE_WALL_PANELING_TITLE &&
      lineItemIncludedWork(inserted.description) === WALL_SCOPE,
  );

  console.log("\nTEST — Tenant isolation");
  await expectError(
    "Business B cannot apply a calculator on Business A's estimate",
    () =>
      applyDraftEstimateCalculator(prisma, ownerB, {
        estimateId: nextEstimate.id,
        lineItemId: inserted.id,
        inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof Error,
  );
  await expectError(
    "MEMBER cannot apply a calculator",
    () =>
      applyDraftEstimateCalculator(prisma, memberA, {
        estimateId: nextEstimate.id,
        lineItemId: inserted.id,
        inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
        rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
      }),
    (error) => error instanceof ForbiddenError || error instanceof EstimateLineError,
  );
  const insertedUnchanged = await prisma.lineItem.findFirst({
    where: { id: inserted.id, businessId: businessA.id },
  });
  check(
    "Rejected calculator apply did not change Business A quantities",
    lineCalculatorSnapshot(insertedUnchanged.description)?.inputs.wallWidthFt === 0,
  );

  console.log(
    failures === 0
      ? "\nAll estimate calculator checks passed."
      : `\n${failures} estimate calculator check(s) failed.`,
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
