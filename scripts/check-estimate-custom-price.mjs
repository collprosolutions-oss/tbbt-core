/**
 * Custom-quote / price-required estimate lines: owner can assign a job
 * price inline without creating a catalog item, Send stays blocked at $0,
 * and labor minimum still applies after the price is saved.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-custom-price.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const {
  CUSTOM_QUOTE_DRAFT_MARKER,
  STARTING_AT_DRAFT_MARKER,
  addRequestDraftLines,
  draftEstimateSendError,
  isUnpricedCustomQuoteDraftLine,
} = await import("@/lib/request-estimate-draft");
const { EstimateLineError, priceDraftEstimateLine } = await import("@/lib/estimate-line-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_custom_price_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate custom-price test database.");
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

try {
  console.log("\nSTATIC — Custom-price helpers and UI");
  check("OWNER can manage estimates", roleHasCapability("OWNER", CAPABILITIES.MANAGE_ESTIMATES));
  check("MEMBER cannot manage estimates", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_ESTIMATES));

  const pageSource = readFileSync(new URL("../src/app/(app)/estimates/[estimateId]/page.tsx", import.meta.url), "utf8");
  const formSource = readFileSync(
    new URL("../src/components/estimates/price-required-line-form.tsx", import.meta.url),
    "utf8",
  );
  check("Estimate page mounts an inline price field on price-required lines", pageSource.includes("PriceRequiredLineForm"));
  check("Add custom item remains available (reused architecture, not a second catalog path)", pageSource.includes("AddCustomLineForm"));
  check("Inline form saves unit price without a catalog write", formSource.includes("unitPrice") && formSource.includes("does not add the work to the service catalog"));

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-price-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-price-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-price-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Quotes",
      slug: `alpha-price-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      laborMinimumEnabled: true,
      laborMinimumAmount: new Prisma.Decimal("200"),
    },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Quotes", slug: `beta-price-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
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
      pricingMode: "FIXED",
      price: new Prisma.Decimal("150"),
      active: true,
    },
  });
  const startingItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Door Adjustment",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal("75"),
      active: true,
    },
  });
  const quoteItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Custom Carpentry",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
    },
  });

  const catalogCountBefore = await prisma.serviceCatalogItem.count({ where: { businessId: businessA.id } });

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
        { quantity: 2, customDescription: "custom wall paneling / wainscoting" },
      ],
    });
    await persistDraftEstimateTotal(tx, estimate.id, businessA.id);
  });

  const draft = await prisma.estimate.findUnique({
    where: { id: estimate.id },
    include: { lineItems: { orderBy: { createdAt: "asc" } } },
  });
  const tvLine = draft?.lineItems.find((item) => item.description.includes("TV Mounting"));
  const doorLine = draft?.lineItems.find((item) => item.description.includes("Door Adjustment"));
  const carpentryLine = draft?.lineItems.find((item) => item.description.includes("Custom Carpentry"));
  const panelLine = draft?.lineItems.find((item) => item.description.includes("custom wall paneling"));

  check("FIXED line stays at the catalog snapshot", tvLine?.unitPrice.toString() === "150");
  check(
    "STARTING_AT line keeps its starting price and marker",
    doorLine?.unitPrice.toString() === "75" && doorLine.description.includes(STARTING_AT_DRAFT_MARKER),
  );
  check(
    "Custom-quote catalog line is price required at $0",
    carpentryLine != null && isUnpricedCustomQuoteDraftLine(carpentryLine),
  );
  check(
    "Other / custom request wording is preserved on the $0 line",
    panelLine?.description.includes("custom wall paneling / wainscoting") === true &&
      panelLine.description.includes(CUSTOM_QUOTE_DRAFT_MARKER),
  );

  const sendBlocked = draftEstimateSendError(draft);
  check(
    "Send Estimate is blocked while a required-price line is still $0",
    sendBlocked === "Enter a price for each custom-quote line before sending.",
  );

  await expectError(
    "Zero / missing price is rejected",
    () =>
      priceDraftEstimateLine(prisma, ownerA, {
        estimateId: estimate.id,
        lineItemId: panelLine.id,
        unitPrice: "0",
      }),
    (error) => error instanceof EstimateLineError,
  );

  const pricedPanel = await priceDraftEstimateLine(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: panelLine.id,
    unitPrice: "120",
    quantity: "2",
  });
  check("Entered custom price is persisted", pricedPanel.unitPrice.toString() === "120");
  check("Quantity stays editable and is saved", pricedPanel.quantity.toString() === "2");
  check("Line total updates from existing line-item math (120 × 2)", pricedPanel.total.toString() === "240");
  check(
    "Original request wording stays after pricing",
    pricedPanel.description === "custom wall paneling / wainscoting",
  );
  check("Price-required marker is cleared once priced", !isUnpricedCustomQuoteDraftLine(pricedPanel));

  const stillBlocked = draftEstimateSendError({
    status: "DRAFT",
    lineItems: [tvLine, doorLine, carpentryLine, pricedPanel],
  });
  check("Send stays disabled until every required-price line is resolved", stillBlocked != null);

  const pricedCarpentry = await priceDraftEstimateLine(prisma, ownerA, {
    estimateId: estimate.id,
    lineItemId: carpentryLine.id,
    unitPrice: "85",
  });
  check("Catalog custom-quote line can be priced without creating a catalog item", pricedCarpentry.unitPrice.toString() === "85");

  const after = await prisma.estimate.findUnique({
    where: { id: estimate.id },
    include: { lineItems: true },
  });
  const tvAfter = after?.lineItems.find((item) => item.id === tvLine.id);
  const doorAfter = after?.lineItems.find((item) => item.id === doorLine.id);
  check("FIXED line is unchanged after custom prices are entered", tvAfter?.unitPrice.toString() === "150");
  check(
    "STARTING_AT line is unchanged after custom prices are entered",
    doorAfter?.unitPrice.toString() === "75" && doorAfter.description.includes(STARTING_AT_DRAFT_MARKER),
  );

  const catalogCountAfter = await prisma.serviceCatalogItem.count({ where: { businessId: businessA.id } });
  check("Pricing a custom line does not write the service catalog", catalogCountAfter === catalogCountBefore);

  check(
    "Send Estimate can proceed once every required price is saved",
    draftEstimateSendError(after) === null,
  );

  // Labor: 150 + 75 + 85 + 240 = 550, all LABOR, so minimum $200 does not add.
  check("Labor minimum does not invent an adjustment when labor already exceeds it", after?.laborMinimumAdjustment.toString() === "0");
  check("Estimate total is the priced line-item sum", after?.total.toString() === "550");

  const minEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  await prisma.$transaction(async (tx) => {
    await addRequestDraftLines(tx, {
      businessId: businessA.id,
      estimateId: minEstimate.id,
      items: [{ quantity: 1, customDescription: "unusual trim / oversized work" }],
    });
    await persistDraftEstimateTotal(tx, minEstimate.id, businessA.id);
  });
  const minDraft = await prisma.estimate.findUnique({
    where: { id: minEstimate.id },
    include: { lineItems: true },
  });
  const minLine = minDraft.lineItems[0];
  await priceDraftEstimateLine(prisma, ownerA, {
    estimateId: minEstimate.id,
    lineItemId: minLine.id,
    unitPrice: "50",
  });
  const minAfter = await prisma.estimate.findUnique({ where: { id: minEstimate.id } });
  check("Labor minimum still calculates after the custom price is entered", minAfter?.laborMinimumAdjustment.toString() === "150");
  check("Estimate total is custom labor + labor-minimum adjustment", minAfter?.total.toString() === "200");

  await expectError(
    "MEMBER cannot price a custom-quote line",
    () =>
      priceDraftEstimateLine(prisma, memberA, {
        estimateId: estimate.id,
        lineItemId: pricedPanel.id,
        unitPrice: "1",
      }),
    (error) => error instanceof ForbiddenError || error instanceof EstimateLineError,
  );
  await expectError(
    "Business B cannot price Business A line",
    () =>
      priceDraftEstimateLine(prisma, ownerB, {
        estimateId: estimate.id,
        lineItemId: pricedPanel.id,
        unitPrice: "1",
      }),
    (error) => error instanceof Error,
  );

  console.log(
    failures === 0 ? "\nAll estimate custom-price checks passed." : `\n${failures} estimate custom-price check(s) failed.`,
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
