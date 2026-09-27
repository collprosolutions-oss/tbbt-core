/**
 * Cleaning Vertical Launch Pack proofs.
 *
 * Proves Cleaning installs through the existing trade / starter-catalog
 * path, Handyman stays unchanged, installs are tenant-scoped and
 * duplicate-safe, intake persists only on canonical fields, public
 * pricing stays Fixed / Starting At / Custom Quote, and this is a
 * reusable pack — not a second Cleaning application.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-cleaning-launch-pack.mjs
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

const { ensurePrimaryBusinessTrade } = await import("@/lib/business-trades");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { installStarterCatalogForTrade } = await import("@/lib/trade-catalog");
const {
  currentIntakeSchema,
  parseIntakeAnswers,
  validateIntakeAnswers,
} = await import("@/lib/intake-schema");
const { getTradeConfig, preferredCatalogCategoryOrder } = await import(
  "@/lib/trade-config"
);
const { formatCatalogPriceLabel } = await import("@/lib/pricing-mode");
const {
  CANONICAL_PUBLIC_PRICING_MODES,
  cleaningLaunchPackCategories,
  cleaningLaunchPackStarterServices,
  cleaningStarterMode,
  getTradeLaunchPack,
  isCanonicalPublicPricingMode,
  listTradeLaunchPacks,
  planStarterCatalogInstallForTrade,
} = await import("@/lib/trade-launch-pack");
const {
  CLEANING_STARTER_SERVICES,
  planCleaningStarterCatalogInstall,
} = await import("@/lib/cleaning-starter-catalog");
const {
  HANDYMAN_STARTER_SERVICES,
  importableStarterServices,
  planStarterCatalogInstall,
  starterPricingMode,
} = await import("@/lib/handyman-starter-catalog");
const { groupServiceCatalogItemsByCategory } = await import(
  "@/lib/service-catalog-category"
);
const { groupPublicCatalog, toPublicCatalogItem } = await import("@/lib/public-site");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Cleaning launch-pack check.");
  process.exit(1);
}

const testDbName = "tbbt_cleaning_launch_pack_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
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

const FAKE_CLAIM =
  /certified|certification|years in business|#1|best rated|testimonial|five-star|5-star|licensed and insured|serving fort myers|cape coral|lee county/i;
const HOURLY = /hourly|\bper hour\b|\/\s*hr\b|\$\/hour|hour rate/i;
const SCHEMA_DDL =
  /CREATE TABLE|ALTER TABLE|DROP TABLE|\$executeRaw|\$executeRawUnsafe|prisma\/schema|prisma\/migrations/i;

const packFiles = [
  "src/lib/cleaning-starter-catalog.ts",
  "src/lib/trade-launch-pack.ts",
  "src/lib/trade-config.ts",
  "src/lib/intake-schema.ts",
  "src/lib/trade-catalog.ts",
  "src/lib/website-engine/public.ts",
];

const cleaningPack = getTradeLaunchPack("CLEANING");
const handyPack = getTradeLaunchPack("HANDYMAN");
const starterServices = cleaningLaunchPackStarterServices();
const starterCategories = cleaningLaunchPackCategories();
const emptyPlan = planCleaningStarterCatalogInstall([]);
const pricingBreakdown = starterServices.reduce(
  (acc, service) => {
    const mode = cleaningStarterMode(service);
    acc[mode] = (acc[mode] ?? 0) + 1;
    return acc;
  },
  /** @type {Record<string, number>} */ ({}),
);

console.log("\nSTATIC — Reusable launch pack, not a second Cleaning app");
check(
  "Cleaning pack reuses TradeConfiguration + existing starter installer",
  cleaningPack.tradeCode === "CLEANING" &&
    cleaningPack.catalogStarterSource === "CLEANING_STARTER" &&
    cleaningPack.config.catalogStarterSource === "CLEANING_STARTER" &&
    listTradeLaunchPacks().length === 2 &&
    handyPack.catalogStarterSource === "HANDYMAN_STARTER",
);
check(
  "Pack planner dispatches through existing Handyman / Cleaning planners",
  planStarterCatalogInstallForTrade("CLEANING", []).add.length === emptyPlan.add.length &&
    planStarterCatalogInstallForTrade("HANDYMAN", []).add.length ===
      planStarterCatalogInstall([]).add.length,
);
check(
  "10. No schema/raw DDL in the Cleaning launch pack",
  packFiles.every((file) => !SCHEMA_DDL.test(read(file))) &&
    !read("src/lib/trade-launch-pack.ts").includes("prisma/schema") &&
    !read("src/lib/cleaning-starter-catalog.ts").includes("$executeRaw"),
);
check(
  "11. No fake certification, service-area, or customer claims",
  packFiles.every((file) => !FAKE_CLAIM.test(read(file))),
);
check(
  "No separate Cleaning engine, catalog installer, or schema/DDL",
  !read("src/lib/trade-launch-pack.ts").includes("cleaning-engine") &&
    read("src/lib/trade-catalog.ts").includes("installCleaningStarterRows") &&
    read("src/lib/starter-catalog-install.ts").includes("installStarterCatalogForTrade") &&
    packFiles.every((file) => !SCHEMA_DDL.test(read(file))) &&
    !read("src/lib/trade-launch-pack.ts").includes("if (trade === \"CLEANING\")") &&
    !read("src/lib/cleaning-starter-catalog.ts").includes("if (trade === \"CLEANING\")"),
);
check(
  "Generic workflow files stay Request → Estimate → Job → Invoice",
  read("src/lib/public-intake.ts").includes("createPublicServiceRequest") &&
    !read("src/lib/cleaning-starter-catalog.ts").includes("createInvoice") &&
    !read("src/lib/trade-launch-pack.ts").includes("createJob") &&
    !read("src/lib/trade-launch-pack.ts").includes("createInvoice"),
);
check(
  "No fake certification, service-area, or customer claims",
  packFiles.every((file) => !FAKE_CLAIM.test(read(file))),
);
check(
  "No public hourly labor language in the Cleaning pack",
  !HOURLY.test(read("src/lib/cleaning-starter-catalog.ts")) &&
    starterServices.every((service) => !HOURLY.test(service.description)) &&
    starterServices.every((service) => {
      const label = formatCatalogPriceLabel(
        cleaningStarterMode(service),
        service.startingPrice,
        service.unitLabel,
      );
      return !HOURLY.test(label);
    }),
);

console.log("\nSTATIC — Catalog size, categories, and pricing-mode truth");
check(
  "Starter set is commercially bounded (20–35 services)",
  starterServices.length >= 20 && starterServices.length <= 35,
);
check(
  "Existing Cleaning names remain and new categories are registered",
  ["Standard Clean", "Deep Clean", "Move-In / Move-Out Clean", "Custom Cleaning Quote"].every(
    (name) => starterServices.some((service) => service.name === name),
  ) &&
    starterCategories.join("|") ===
      [
        "Recurring Cleaning",
        "One-Time Cleaning",
        "Deep Cleaning",
        "Move-In / Move-Out",
        "Vacation Rental / Turnover",
        "Kitchen Add-Ons",
        "Bathroom Add-Ons",
        "Interior Add-Ons",
        "Office / Small Commercial",
        "Custom Cleaning",
      ].join("|") &&
    getTradeConfig("CLEANING").catalogCategories.join("|") === starterCategories.join("|") &&
    preferredCatalogCategoryOrder("CLEANING").join("|") === starterCategories.join("|"),
);
check(
  "Starter pricing modes stay Fixed / Starting At / Custom Quote",
  starterServices.every((service) =>
    isCanonicalPublicPricingMode(cleaningStarterMode(service)),
  ) &&
    CANONICAL_PUBLIC_PRICING_MODES.every((mode) =>
      Object.prototype.hasOwnProperty.call(pricingBreakdown, mode),
    ) &&
    !starterServices.some((service) => cleaningStarterMode(service) === "VARIABLE"),
);
check(
  "Prices are labeled as editable starter defaults, not market claims",
  starterServices
    .filter((service) => service.startingPrice != null)
    .every((service) => service.description.includes("Starter default you can edit")),
);

console.log("\nSTATIC — Handyman starter catalog is unchanged");
const handyImportable = importableStarterServices();
check(
  "Handyman starter count, names, and prices stay on the Handyman pack",
  handyImportable.length === planStarterCatalogInstall([]).add.length &&
    HANDYMAN_STARTER_SERVICES.some((row) => row.name === "Standard Door Knob Replacement") &&
    HANDYMAN_STARTER_SERVICES.find((row) => row.templateKey === "standard-door-knob-replacement")
      ?.startingPrice === 75 &&
    HANDYMAN_STARTER_SERVICES.find((row) => row.templateKey === "tv-mounting-up-to-55")
      ?.startingPrice === 125 &&
    starterPricingMode(
      HANDYMAN_STARTER_SERVICES.find((row) => row.templateKey === "interior-trim-finish-carpentry"),
    ) === "CUSTOM_QUOTE" &&
    !read("src/lib/handyman-starter-catalog.ts").includes("CLEANING_STARTER"),
);

console.log("\nSTATIC — Intake stays on the existing schema");
const cleaningIntake = currentIntakeSchema("CLEANING");
const intakeKeys = cleaningIntake.fields.map((field) => field.key);
const requiredKeys = cleaningIntake.fields
  .filter((field) => field.required && field.render === "trade")
  .map((field) => field.key);
check(
  "Cleaning intake reuses versioned cleaning.public fields",
  cleaningIntake.key === "cleaning.public" &&
    cleaningIntake.version === 1 &&
    cleaningPack.intakeSchema.key === "cleaning.public" &&
    requiredKeys.join(",") === "bedrooms,bathrooms,homeSize,frequency",
);
check(
  "Supported Cleaning intake facts are canonical field keys",
  [
    "propertyType",
    "homeSize",
    "bedrooms",
    "bathrooms",
    "occupancy",
    "condition",
    "frequency",
    "visitContext",
    "pets",
    "addons",
    "photos",
    "accessNotes",
  ].every((key) => intakeKeys.includes(key)),
);
const missingRequired = validateIntakeAnswers(cleaningIntake, {});
const validRequired = validateIntakeAnswers(cleaningIntake, {
  bedrooms: 3,
  bathrooms: 2,
  homeSize: "1500_2000",
  frequency: "WEEKLY",
  propertyType: "HOUSE",
  occupancy: "OCCUPIED",
  condition: "STANDARD",
  visitContext: "STANDARD",
  pets: "yes",
  petNotes: "Friendly dog",
  addons: ["LAUNDRY", "LINENS"],
  accessNotes: "Side gate",
});
check(
  "Required fields still fail closed; optional facts persist when present",
  missingRequired.ok === false &&
    validRequired.ok === true &&
    validRequired.ok &&
    validRequired.answers.propertyType === "HOUSE" &&
    validRequired.answers.occupancy === "OCCUPIED" &&
    validRequired.answers.condition === "STANDARD" &&
    validRequired.answers.visitContext === "STANDARD" &&
    Array.isArray(validRequired.answers.addons) &&
    validRequired.answers.addons.includes("LINENS"),
);

try {
  console.log("\nLIVE — Cleaning pack install, isolation, and Handyman regression");
  const cleanA = await prisma.business.create({
    data: {
      name: "Alpha Cleaning",
      slug: `alpha-clean-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  const handyB = await prisma.business.create({
    data: {
      name: "Beta Handyman",
      slug: `beta-handy-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const cleanC = await prisma.business.create({
    data: {
      name: "Gamma Cleaning",
      slug: `gamma-clean-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, cleanA.id, "CLEANING");
  await ensurePrimaryBusinessTrade(prisma, handyB.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, cleanC.id, "CLEANING");

  const customA = await prisma.serviceCatalogItem.create({
    data: {
      businessId: cleanA.id,
      tradeCode: "CLEANING",
      name: "Owner Custom Polish",
      description: "Tenant-owned custom service that must survive starter install.",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      category: "Custom Cleaning",
      active: true,
    },
  });
  const customB = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyB.id,
      tradeCode: "HANDYMAN",
      name: "Owner Custom Gate Latch",
      description: "Handyman custom row that Cleaning install must never touch.",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(90),
      category: "Doors & Locks",
      active: true,
    },
  });

  const first = await installStarterCatalogForTrade(prisma, cleanA.id, "CLEANING");
  const second = await installStarterCatalogForTrade(prisma, cleanA.id, "CLEANING");
  const handyInstall = await installStarterCatalogForTrade(prisma, handyB.id, "HANDYMAN");

  const aRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: cleanA.id },
    orderBy: { name: "asc" },
  });
  const aCleaning = aRows.filter((row) => row.tradeCode === "CLEANING");
  const aNames = aCleaning.map((row) => row.name);
  const uniqueANames = new Set(aNames);
  const bRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: handyB.id },
  });
  const cRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: cleanC.id },
  });
  const preservedCustom = await prisma.serviceCatalogItem.findUnique({
    where: { id: customA.id },
  });
  const preservedHandyCustom = await prisma.serviceCatalogItem.findUnique({
    where: { id: customB.id },
  });

  check(
    "1. Cleaning starter pack installs for a Cleaning business",
    first.added === starterServices.length &&
      first.tradeCode === "CLEANING" &&
      aCleaning.length === starterServices.length + 1 &&
      aCleaning.every((row) => row.businessId === cleanA.id),
  );
  check(
    "2. Handyman starter catalog remains unchanged after Cleaning install",
    handyInstall.added === handyImportable.length &&
      bRows.filter((row) => row.tradeCode === "HANDYMAN").length ===
        handyImportable.length + 1 &&
      bRows.every((row) => row.tradeCode === "HANDYMAN") &&
      bRows.every((row) => row.name !== "Standard Clean") &&
      preservedHandyCustom?.name === "Owner Custom Gate Latch" &&
      preservedHandyCustom?.price?.toString() === "90",
  );
  check(
    "3. Installing the Cleaning pack twice creates no duplicates",
    second.added === 0 &&
      second.skipped === starterServices.length &&
      uniqueANames.size === aNames.length &&
      aCleaning.length === starterServices.length + 1,
  );
  check(
    "4. Tenant A install does not change Tenant B or Tenant C",
    cRows.length === 0 &&
      bRows.every((row) => row.businessId === handyB.id) &&
      !bRows.some((row) => starterServices.some((service) => service.name === row.name)) &&
      (await prisma.serviceCatalogItem.count({
        where: { businessId: cleanC.id, tradeCode: "CLEANING" },
      })) === 0,
  );
  check(
    "5. Existing custom ServiceCatalogItems remain intact",
    preservedCustom?.id === customA.id &&
      preservedCustom?.name === "Owner Custom Polish" &&
      preservedCustom?.pricingMode === "CUSTOM_QUOTE" &&
      aRows.some((row) => row.id === customA.id),
  );

  const publicItems = aCleaning.map((row) => toPublicCatalogItem(row));
  const publicGroups = groupPublicCatalog(publicItems, "CLEANING");
  const grouped = groupServiceCatalogItemsByCategory(
    aCleaning,
    preferredCatalogCategoryOrder("CLEANING"),
  );
  check(
    "6. No public hourly pricing appears on installed Cleaning rows",
    publicItems.every((item) => !HOURLY.test(item.priceLabel)) &&
      aCleaning.every((row) => !HOURLY.test(row.description ?? "")),
  );
  check(
    "7. Installed pricing modes stay Fixed / Starting At / Custom Quote",
    aCleaning
      .filter((row) => row.id !== customA.id)
      .every((row) => isCanonicalPublicPricingMode(row.pricingMode)) &&
      publicItems
        .filter((item) => item.id !== customA.id)
        .every(
          (item) =>
            item.priceLabel.startsWith("Fixed ") ||
            item.priceLabel.startsWith("Starting at ") ||
            item.priceLabel === "Custom Quote",
        ),
  );
  check(
    "8. Cleaning categories render through existing service architecture",
    grouped.map((group) => group.category).join("|") ===
      publicGroups.map((group) => group.category).join("|") &&
      starterCategories.every((category) =>
        grouped.some((group) => group.category === category),
      ) &&
      grouped.every((group) => group.items.length > 0),
  );

  const standard = aCleaning.find((row) => row.name === "Standard Clean");
  check("Standard Clean installed for intake proof", Boolean(standard));
  const created = await createPublicServiceRequest(prisma, {
    slug: cleanA.slug,
    name: "Pat Customer",
    email: "pat-clean@example.com",
    phone: "5551112222",
    address: "1 Main St",
    streetAddress: "1 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Weekly clean",
    catalogItemIds: standard ? [standard.id] : [],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      bedrooms: 3,
      bathrooms: 2,
      homeSize: "1500_2000",
      propertyType: "HOUSE",
      occupancy: "OCCUPIED",
      condition: "STANDARD",
      visitContext: "STANDARD",
      frequency: "WEEKLY",
      pets: "yes",
      petNotes: "Friendly dog",
      addons: ["LAUNDRY"],
      accessNotes: "Side gate",
      inventedColumn: "should-not-persist",
    },
  });
  const request = created.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: created.requestId } })
    : null;
  const persisted = parseIntakeAnswers(request?.intakeAnswersJson);
  const persistedKeys = Object.keys(persisted).sort();
  check(
    "9. Request intake persists only through existing canonical fields",
    created.ok === true &&
      request?.tradeCode === "CLEANING" &&
      request?.intakeSchemaKey === "cleaning.public" &&
      Boolean(request?.intakeSchemaJson) &&
      persisted.propertyType === "HOUSE" &&
      persisted.occupancy === "OCCUPIED" &&
      persisted.condition === "STANDARD" &&
      persisted.visitContext === "STANDARD" &&
      persisted.frequency === "WEEKLY" &&
      persisted.inventedColumn == null &&
      persistedKeys.every((key) => intakeKeys.includes(key)),
  );

  const customer = await prisma.customer.create({
    data: {
      businessId: cleanA.id,
      name: "Workflow Customer",
      email: "workflow-clean@example.com",
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: cleanA.id,
      customerId: customer.id,
      serviceRequestId: request?.id,
      status: "APPROVED",
      total: new Prisma.Decimal(180),
      publicToken: randomUUID(),
    },
  });
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: cleanA.id,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(180),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      approvedAt: new Date(),
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });
  const job = await prisma.job.create({
    data: {
      businessId: cleanA.id,
      customerId: customer.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: cleanA.id,
      customerId: customer.id,
      jobId: job.id,
      status: "SENT",
      total: new Prisma.Decimal(180),
    },
  });
  check(
    "12. Generic workflow remains Request → Estimate → Job → Invoice",
    request?.id &&
      estimate.serviceRequestId === request.id &&
      job.estimateId === estimate.id &&
      invoice.jobId === job.id &&
      invoice.businessId === cleanA.id,
  );
  check(
    "13. Pack is reusable without a separate Cleaning engine",
    first.tradeCode === "CLEANING" &&
      read("src/lib/trade-catalog.ts").includes('source === "CLEANING_STARTER"') &&
      getTradeLaunchPack("CLEANING").catalogStarterSource === "CLEANING_STARTER",
  );

  console.log("\nCOUNTS — Cleaning launch pack");
  console.log(`  starter services: ${starterServices.length}`);
  console.log(`  categories: ${starterCategories.join(", ")}`);
  console.log(
    `  pricing: FIXED ${pricingBreakdown.FIXED ?? 0}, STARTING_AT ${pricingBreakdown.STARTING_AT ?? 0}, CUSTOM_QUOTE ${pricingBreakdown.CUSTOM_QUOTE ?? 0}`,
  );
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
