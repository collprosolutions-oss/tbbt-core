/**
 * Pressure Washing Vertical Launch Pack proofs.
 *
 * Proves Pressure Washing installs through the existing trade / starter-catalog
 * path, Handyman and Cleaning stay unchanged, installs are tenant-scoped and
 * duplicate-safe, intake persists only on canonical fields, public pricing
 * stays Fixed / Starting At / Custom Quote with no hourly rates, two
 * businesses stay isolated, and a Pressure Washing request reaches the
 * existing estimate handoff. This is a reusable pack — not a second app.
 *
 * Run with:
 *   npm run test:pressure-washing-launch-pack
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
  archivedIntakeSchema,
  currentIntakeSchema,
  freezeIntakeSchema,
  parseIntakeAnswers,
  resolveRequestIntakeSchema,
  validateIntakeAnswers,
} = await import("@/lib/intake-schema");
const { getTradeConfig, preferredCatalogCategoryOrder } = await import(
  "@/lib/trade-config"
);
const { formatCatalogPriceLabel } = await import("@/lib/pricing-mode");
const {
  CANONICAL_PUBLIC_PRICING_MODES,
  getTradeLaunchPack,
  isCanonicalPublicPricingMode,
  listTradeLaunchPacks,
  planStarterCatalogInstallForTrade,
  pressureWashingLaunchPackCategories,
  pressureWashingLaunchPackStarterServices,
  pressureWashingStarterMode,
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
const {
  addRequestDraftLines,
  sourceItemsFromServiceRequest,
} = await import("@/lib/request-estimate-draft");
const {
  isPopulatedCustomerRequest,
  requestedWorkForHandoff,
} = await import("@/lib/request-estimate-handoff");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the Pressure Washing launch-pack check.");
  process.exit(1);
}

const testDbName = "tbbt_pressure_washing_launch_pack_test";
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
  "src/lib/pressure-washing-starter-catalog.ts",
  "src/lib/trade-launch-pack.ts",
  "src/lib/trade-config.ts",
  "src/lib/intake-schema.ts",
  "src/lib/trade-catalog.ts",
  "src/lib/website-engine/public.ts",
];

const washPack = getTradeLaunchPack("PRESSURE_WASHING");
const handyPack = getTradeLaunchPack("HANDYMAN");
const cleaningPack = getTradeLaunchPack("CLEANING");
const starterServices = pressureWashingLaunchPackStarterServices();
const starterCategories = pressureWashingLaunchPackCategories();
const emptyPlan = planStarterCatalogInstallForTrade("PRESSURE_WASHING", []);
const pricingBreakdown = starterServices.reduce(
  (acc, service) => {
    const mode = pressureWashingStarterMode(service);
    acc[mode] = (acc[mode] ?? 0) + 1;
    return acc;
  },
  /** @type {Record<string, number>} */ ({}),
);

console.log("\nSTATIC — Reusable launch pack, not a second Pressure Washing app");
check(
  "Pressure Washing pack reuses TradeConfiguration + existing starter installer",
  washPack.tradeCode === "PRESSURE_WASHING" &&
    washPack.catalogStarterSource === "PRESSURE_WASHING_STARTER" &&
    washPack.config.catalogStarterSource === "PRESSURE_WASHING_STARTER" &&
    listTradeLaunchPacks().length === 3 &&
    handyPack.catalogStarterSource === "HANDYMAN_STARTER" &&
    cleaningPack.catalogStarterSource === "CLEANING_STARTER",
);
check(
  "Pack planner dispatches through the existing trade planner",
  emptyPlan.add.length === starterServices.length &&
    planStarterCatalogInstallForTrade("HANDYMAN", []).add.length ===
      planStarterCatalogInstall([]).add.length &&
    planStarterCatalogInstallForTrade("CLEANING", []).add.length ===
      planCleaningStarterCatalogInstall([]).add.length,
);
check(
  "No schema/raw DDL in the Pressure Washing launch pack",
  packFiles.every((file) => !SCHEMA_DDL.test(read(file))) &&
    !read("src/lib/trade-launch-pack.ts").includes("prisma/schema") &&
    !read("src/lib/pressure-washing-starter-catalog.ts").includes("$executeRaw"),
);
check(
  "No fake certification, service-area, or customer claims",
  packFiles.every((file) => !FAKE_CLAIM.test(read(file))),
);
check(
  "No separate Pressure Washing engine, catalog installer, or schema/DDL",
  !read("src/lib/trade-launch-pack.ts").includes("pressure-washing-engine") &&
    read("src/lib/trade-catalog.ts").includes("installPressureWashingStarterRows") &&
    read("src/lib/starter-catalog-install.ts").includes("installStarterCatalogForTrade") &&
    !read("src/lib/trade-launch-pack.ts").includes("if (trade === \"PRESSURE_WASHING\")") &&
    !read("src/lib/pressure-washing-starter-catalog.ts").includes(
      "if (trade === \"PRESSURE_WASHING\")",
    ),
);
check(
  "Generic workflow files stay Request → Estimate → Job → Invoice",
  read("src/lib/public-intake.ts").includes("createPublicServiceRequest") &&
    !read("src/lib/pressure-washing-starter-catalog.ts").includes("createInvoice") &&
    !read("src/lib/trade-launch-pack.ts").includes("createJob") &&
    !read("src/lib/trade-launch-pack.ts").includes("createInvoice"),
);
check(
  "No public hourly labor language in the Pressure Washing pack",
  !HOURLY.test(read("src/lib/pressure-washing-starter-catalog.ts")) &&
    starterServices.every((service) => !HOURLY.test(service.description)) &&
    starterServices.every((service) => {
      const label = formatCatalogPriceLabel(
        pressureWashingStarterMode(service),
        service.startingPrice,
        service.unitLabel,
      );
      return !HOURLY.test(label);
    }),
);
check(
  "Pack does not add CRM, payments, website engine, or global navigation",
  !read("src/lib/pressure-washing-starter-catalog.ts").includes("createCustomer") &&
    !read("src/lib/pressure-washing-starter-catalog.ts").includes("stripe") &&
    !read("src/lib/pressure-washing-starter-catalog.ts").includes("WebsitePublish") &&
    !read("src/app/(app)/layout.tsx").includes("PRESSURE_WASHING") &&
    read("src/components/settings/settings-workspace.tsx").includes(
      "listConfiguredTradeCodes",
    ),
);

console.log("\nSTATIC — Catalog size, categories, and pricing-mode truth");
check(
  "Starter set is a small commercially bounded pack (8–16 services)",
  starterServices.length >= 8 && starterServices.length <= 16,
);
check(
  "Pressure Washing categories are registered on the trade config",
  starterCategories.join("|") ===
    [
      "House Exterior",
      "Concrete & Hardscape",
      "Decks & Fences",
      "Roof & Gutters",
      "Commercial",
      "Custom Pressure Washing",
    ].join("|") &&
    getTradeConfig("PRESSURE_WASHING").catalogCategories.join("|") ===
      starterCategories.join("|") &&
    preferredCatalogCategoryOrder("PRESSURE_WASHING").join("|") ===
      starterCategories.join("|") &&
    ["House Wash", "Driveway Cleaning", "Custom Pressure Washing Quote"].every((name) =>
      starterServices.some((service) => service.name === name),
    ),
);
check(
  "Starter pricing modes stay Fixed / Starting At / Custom Quote",
  starterServices.every((service) =>
    isCanonicalPublicPricingMode(pressureWashingStarterMode(service)),
  ) &&
    CANONICAL_PUBLIC_PRICING_MODES.every((mode) =>
      Object.prototype.hasOwnProperty.call(pricingBreakdown, mode),
    ) &&
    !starterServices.some((service) => pressureWashingStarterMode(service) === "VARIABLE"),
);
check(
  "Prices are labeled as editable starter defaults, not market claims",
  starterServices
    .filter((service) => service.startingPrice != null)
    .every((service) => service.description.includes("Starter default you can edit")),
);

console.log("\nSTATIC — Historical Handyman and Cleaning intake stay unchanged");
const handyCurrent = currentIntakeSchema("HANDYMAN");
const handyArchived = archivedIntakeSchema("handyman.public", 1);
const cleaningCurrent = currentIntakeSchema("CLEANING");
const cleaningV1 = archivedIntakeSchema("cleaning.public", 1);
const cleaningV2 = archivedIntakeSchema("cleaning.public", 2);
check(
  "Handyman public intake remains V1 with the original field set",
  handyCurrent.key === "handyman.public" &&
    handyCurrent.version === 1 &&
    handyArchived?.version === 1 &&
    JSON.stringify(handyCurrent) === JSON.stringify(handyArchived) &&
    handyCurrent.fields.map((field) => field.key).join(",") ===
      "selectedWork,measurements,photos,notes,frequency",
);
check(
  "Cleaning public intake remains archived V1 plus current V2",
  cleaningCurrent.key === "cleaning.public" &&
    cleaningCurrent.version === 2 &&
    cleaningV1?.version === 1 &&
    cleaningV2?.version === 2 &&
    cleaningV1.fields.map((field) => field.key).join(",") ===
      "selectedWork,bedrooms,bathrooms,homeSize,frequency,addons,pets,petNotes,accessNotes,photos,notes" &&
    !cleaningV1.fields.some((field) => field.key === "propertyType") &&
    cleaningCurrent.fields.some((field) => field.key === "propertyType"),
);
check(
  "Handyman and Cleaning starter catalogs are not rewritten by this pack",
  HANDYMAN_STARTER_SERVICES.some((row) => row.name === "Standard Door Knob Replacement") &&
    HANDYMAN_STARTER_SERVICES.find((row) => row.templateKey === "standard-door-knob-replacement")
      ?.startingPrice === 75 &&
    starterPricingMode(
      HANDYMAN_STARTER_SERVICES.find((row) => row.templateKey === "interior-trim-finish-carpentry"),
    ) === "CUSTOM_QUOTE" &&
    CLEANING_STARTER_SERVICES.some((row) => row.name === "Standard Clean") &&
    !read("src/lib/handyman-starter-catalog.ts").includes("PRESSURE_WASHING") &&
    !read("src/lib/cleaning-starter-catalog.ts").includes("PRESSURE_WASHING"),
);

console.log("\nSTATIC — Versioned Pressure Washing intake V1");
const washIntake = currentIntakeSchema("PRESSURE_WASHING");
const archivedV1 = archivedIntakeSchema("pressure-washing.public", 1);
const intakeKeys = washIntake.fields.map((field) => field.key);
const requiredKeys = washIntake.fields
  .filter((field) => field.required && field.render === "trade")
  .map((field) => field.key);
check(
  "currentIntakeSchema(PRESSURE_WASHING) returns pressure-washing.public V1",
  washIntake.key === "pressure-washing.public" &&
    washIntake.version === 1 &&
    washPack.intakeSchema.version === 1 &&
    archivedV1?.version === 1 &&
    JSON.stringify(washIntake) === JSON.stringify(archivedV1) &&
    requiredKeys.join(",") === "propertyType,frequency",
);
check(
  "Supported Pressure Washing intake facts are canonical field keys",
  [
    "propertyType",
    "stories",
    "surfaces",
    "waterAccess",
    "stains",
    "stainNotes",
    "frequency",
    "accessNotes",
  ].every((key) => intakeKeys.includes(key)),
);
const missingRequired = validateIntakeAnswers(washIntake, {});
const validRequired = validateIntakeAnswers(washIntake, {
  propertyType: "HOUSE",
  stories: "TWO",
  surfaces: ["SIDING", "CONCRETE"],
  waterAccess: "yes",
  stains: "yes",
  stainNotes: "Driveway oil",
  frequency: "ONE_TIME",
  accessNotes: "Side hose bib",
});
check(
  "Required fields fail closed; optional facts persist when present",
  missingRequired.ok === false &&
    validRequired.ok === true &&
    validRequired.ok &&
    validRequired.answers.propertyType === "HOUSE" &&
    validRequired.answers.frequency === "ONE_TIME" &&
    validRequired.answers.waterAccess === "yes" &&
    Array.isArray(validRequired.answers.surfaces) &&
    validRequired.answers.surfaces.includes("SIDING"),
);

try {
  console.log("\nLIVE — Pressure Washing install, isolation, and estimate handoff");
  const washA = await prisma.business.create({
    data: {
      name: "Alpha Pressure Washing",
      slug: `alpha-pw-${randomUUID().slice(0, 8)}`,
      tradeCode: "PRESSURE_WASHING",
    },
  });
  const washB = await prisma.business.create({
    data: {
      name: "Beta Pressure Washing",
      slug: `beta-pw-${randomUUID().slice(0, 8)}`,
      tradeCode: "PRESSURE_WASHING",
    },
  });
  const handyC = await prisma.business.create({
    data: {
      name: "Gamma Handyman",
      slug: `gamma-handy-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const cleanD = await prisma.business.create({
    data: {
      name: "Delta Cleaning",
      slug: `delta-clean-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, washA.id, "PRESSURE_WASHING");
  await ensurePrimaryBusinessTrade(prisma, washB.id, "PRESSURE_WASHING");
  await ensurePrimaryBusinessTrade(prisma, handyC.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, cleanD.id, "CLEANING");

  const customA = await prisma.serviceCatalogItem.create({
    data: {
      businessId: washA.id,
      tradeCode: "PRESSURE_WASHING",
      name: "Owner Custom Fleet Wash",
      description: "Tenant-owned custom service that must survive starter install.",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      category: "Custom Pressure Washing",
      active: true,
    },
  });
  const customHandy = await prisma.serviceCatalogItem.create({
    data: {
      businessId: handyC.id,
      tradeCode: "HANDYMAN",
      name: "Owner Custom Gate Latch",
      description: "Handyman custom row that Pressure Washing install must never touch.",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(90),
      category: "Doors & Locks",
      active: true,
    },
  });

  const first = await installStarterCatalogForTrade(prisma, washA.id, "PRESSURE_WASHING");
  const second = await installStarterCatalogForTrade(prisma, washA.id, "PRESSURE_WASHING");
  const handyInstall = await installStarterCatalogForTrade(prisma, handyC.id, "HANDYMAN");
  const cleanInstall = await installStarterCatalogForTrade(prisma, cleanD.id, "CLEANING");

  const aRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: washA.id },
    orderBy: { name: "asc" },
  });
  const aWash = aRows.filter((row) => row.tradeCode === "PRESSURE_WASHING");
  const aNames = aWash.map((row) => row.name);
  const uniqueANames = new Set(aNames);
  const bRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: washB.id },
  });
  const cRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: handyC.id },
  });
  const dRows = await prisma.serviceCatalogItem.findMany({
    where: { businessId: cleanD.id },
  });
  const preservedCustom = await prisma.serviceCatalogItem.findUnique({
    where: { id: customA.id },
  });
  const preservedHandyCustom = await prisma.serviceCatalogItem.findUnique({
    where: { id: customHandy.id },
  });

  check(
    "Pressure Washing starter pack installs for a Pressure Washing business",
    first.added === starterServices.length &&
      first.tradeCode === "PRESSURE_WASHING" &&
      aWash.length === starterServices.length + 1 &&
      aWash.every((row) => row.businessId === washA.id),
  );
  check(
    "Installing the Pressure Washing pack twice creates no duplicates",
    second.added === 0 &&
      second.skipped === starterServices.length &&
      uniqueANames.size === aNames.length &&
      aWash.length === starterServices.length + 1,
  );
  check(
    "Tenant A install does not change Tenant B, Handyman, or Cleaning catalogs",
    bRows.length === 0 &&
      cRows.every((row) => row.businessId === handyC.id) &&
      dRows.every((row) => row.businessId === cleanD.id) &&
      !cRows.some((row) => starterServices.some((service) => service.name === row.name)) &&
      !dRows.some((row) => starterServices.some((service) => service.name === row.name)) &&
      (await prisma.serviceCatalogItem.count({
        where: { businessId: washB.id, tradeCode: "PRESSURE_WASHING" },
      })) === 0,
  );
  check(
    "Handyman and Cleaning starter catalogs remain unchanged after Pressure Washing install",
    handyInstall.added === importableStarterServices().length &&
      cleanInstall.added === CLEANING_STARTER_SERVICES.length &&
      preservedHandyCustom?.name === "Owner Custom Gate Latch" &&
      preservedHandyCustom?.price?.toString() === "90" &&
      cRows.every((row) => row.tradeCode === "HANDYMAN") &&
      dRows.every((row) => row.tradeCode === "CLEANING"),
  );
  check(
    "Existing custom ServiceCatalogItems remain intact",
    preservedCustom?.id === customA.id &&
      preservedCustom?.name === "Owner Custom Fleet Wash" &&
      preservedCustom?.pricingMode === "CUSTOM_QUOTE" &&
      aRows.some((row) => row.id === customA.id),
  );

  const publicItems = aWash.map((row) => toPublicCatalogItem(row));
  const publicGroups = groupPublicCatalog(publicItems, "PRESSURE_WASHING");
  const grouped = groupServiceCatalogItemsByCategory(
    aWash,
    preferredCatalogCategoryOrder("PRESSURE_WASHING"),
  );
  check(
    "No public hourly pricing appears on installed Pressure Washing rows",
    publicItems.every((item) => !HOURLY.test(item.priceLabel)) &&
      aWash.every((row) => !HOURLY.test(row.description ?? "")),
  );
  check(
    "Installed pricing modes stay Fixed / Starting At / Custom Quote",
    aWash
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
    "Pressure Washing categories render through existing service architecture",
    grouped.map((group) => group.category).join("|") ===
      publicGroups.map((group) => group.category).join("|") &&
      starterCategories.every((category) =>
        grouped.some((group) => group.category === category),
      ) &&
      grouped.every((group) => group.items.length > 0),
  );

  const houseWash = aWash.find((row) => row.name === "House Wash");
  check("House Wash installed for intake proof", Boolean(houseWash));
  const created = await createPublicServiceRequest(prisma, {
    slug: washA.slug,
    name: "Pat Customer",
    email: "pat-pw@example.com",
    phone: "5551112222",
    address: "1 Main St",
    streetAddress: "1 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "House and driveway",
    catalogItemIds: houseWash ? [houseWash.id] : [],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      propertyType: "HOUSE",
      stories: "TWO",
      surfaces: ["SIDING", "CONCRETE"],
      waterAccess: "yes",
      stains: "yes",
      stainNotes: "Driveway oil",
      frequency: "ONE_TIME",
      accessNotes: "Side hose bib",
      inventedColumn: "should-not-persist",
    },
  });
  const request = created.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: created.requestId },
        include: {
          items: { include: { serviceCatalogItem: true } },
          serviceCatalogItem: true,
        },
      })
    : null;
  const persisted = parseIntakeAnswers(request?.intakeAnswersJson);
  const persistedKeys = Object.keys(persisted).sort();
  check(
    "Public Pressure Washing request persists only through existing canonical fields",
    created.ok === true &&
      request?.tradeCode === "PRESSURE_WASHING" &&
      request?.intakeSchemaKey === "pressure-washing.public" &&
      request?.intakeSchemaVersion === 1 &&
      Boolean(request?.intakeSchemaJson) &&
      persisted.propertyType === "HOUSE" &&
      persisted.frequency === "ONE_TIME" &&
      persisted.inventedColumn == null &&
      persistedKeys.every((key) => intakeKeys.includes(key)),
  );
  check(
    "New Pressure Washing requests freeze/store V1",
    request?.intakeSchemaVersion === 1 &&
      JSON.parse(request?.intakeSchemaJson ?? "{}").version === 1 &&
      JSON.parse(request?.intakeSchemaJson ?? "{}").fields.some(
        (field) => field.key === "propertyType",
      ),
  );

  const bRequestAttempt = await createPublicServiceRequest(prisma, {
    slug: washB.slug,
    name: "Steal Customer",
    email: "steal-pw@example.com",
    phone: "5559990000",
    address: "9 Other St",
    streetAddress: "9 Other St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Should not use Alpha catalog",
    catalogItemIds: houseWash ? [houseWash.id] : [],
    includeOther: false,
    otherDescription: "",
    intakeAnswers: {
      propertyType: "HOUSE",
      frequency: "ONE_TIME",
    },
  });
  check(
    "Business B cannot submit a public request using Business A catalog ids",
    bRequestAttempt.ok === false,
  );
  check(
    "Business B cannot read Business A catalog or request rows",
    (await prisma.serviceCatalogItem.findFirst({
      where: { id: houseWash?.id, businessId: washB.id },
    })) === null &&
      (await prisma.serviceRequest.findFirst({
        where: { id: request?.id, businessId: washB.id },
      })) === null &&
      (await prisma.serviceRequest.count({ where: { businessId: washB.id } })) === 0,
  );

  const customer = await prisma.customer.create({
    data: {
      businessId: washA.id,
      name: "Handoff Customer",
      email: "handoff-pw@example.com",
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: washA.id,
      customerId: customer.id,
      serviceRequestId: request?.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const convertedCount = request
    ? await prisma.$transaction((tx) =>
        addRequestDraftLines(tx, {
          businessId: washA.id,
          estimateId: estimate.id,
          items: sourceItemsFromServiceRequest(request),
        }),
      )
    : 0;
  const convertedLines = await prisma.lineItem.findMany({
    where: { estimateId: estimate.id, businessId: washA.id },
  });
  const handoffWork = requestedWorkForHandoff(request);
  check(
    "Pressure Washing request reaches the existing estimate handoff",
    convertedCount > 0 &&
      convertedLines.some((line) => line.serviceCatalogItemId === houseWash?.id) &&
      isPopulatedCustomerRequest(request) === true &&
      handoffWork.some((row) => row.name === "House Wash") &&
      estimate.serviceRequestId === request?.id,
  );

  const bEstimate = await prisma.estimate.findFirst({
    where: { id: estimate.id, businessId: washB.id },
  });
  check("Business B cannot load Business A estimate by id", bEstimate === null);

  const handyService =
    cRows.find(
      (row) =>
        row.name === "Standard Door Knob Replacement" &&
        row.intakeMeasurementMode === "NONE",
    ) ??
    cRows.find((row) => row.tradeCode === "HANDYMAN" && row.intakeMeasurementMode === "NONE");
  const handyCreated = await createPublicServiceRequest(prisma, {
    slug: handyC.slug,
    name: "Sam Customer",
    email: "sam-handy@example.com",
    phone: "5553334444",
    address: "2 Main St",
    streetAddress: "2 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Door knob",
    catalogItemIds: handyService ? [handyService.id] : [],
    includeOther: Boolean(!handyService),
    otherDescription: handyService ? "" : "Custom handyman work",
  });
  const handyRequest = handyCreated.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: handyCreated.requestId } })
    : null;
  check(
    "Existing Handyman public intake still works after Pressure Washing install",
    handyCreated.ok === true &&
      handyRequest?.tradeCode === "HANDYMAN" &&
      handyRequest?.intakeSchemaKey === "handyman.public" &&
      handyRequest?.intakeSchemaVersion === 1,
  );

  const standardClean = dRows.find((row) => row.name === "Standard Clean");
  const cleanCreated = await createPublicServiceRequest(prisma, {
    slug: cleanD.slug,
    name: "Lee Customer",
    email: "lee-clean@example.com",
    phone: "5554445555",
    address: "3 Main St",
    streetAddress: "3 Main St",
    city: "Reno",
    region: "NV",
    postalCode: "89501",
    notes: "Weekly clean",
    catalogItemIds: standardClean ? [standardClean.id] : [],
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
    },
  });
  const cleanRequest = cleanCreated.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: cleanCreated.requestId } })
    : null;
  check(
    "Existing Cleaning public intake still freezes cleaning.public V2",
    cleanCreated.ok === true &&
      cleanRequest?.tradeCode === "CLEANING" &&
      cleanRequest?.intakeSchemaKey === "cleaning.public" &&
      cleanRequest?.intakeSchemaVersion === 2,
  );

  const historicalV1Request = await prisma.serviceRequest.create({
    data: {
      businessId: cleanD.id,
      customerId: (
        await prisma.customer.create({
          data: {
            businessId: cleanD.id,
            name: "Historical V1 Customer",
            email: "v1-clean-pw@example.com",
          },
        })
      ).id,
      description: "Frozen pre-#162 Cleaning request",
      tradeCode: "CLEANING",
      intakeSchemaKey: "cleaning.public",
      intakeSchemaVersion: 1,
      intakeSchemaJson: freezeIntakeSchema(cleaningV1),
      intakeAnswersJson: JSON.stringify({
        bedrooms: 2,
        bathrooms: 1,
        homeSize: "1000_1500",
        frequency: "ONE_TIME",
      }),
    },
  });
  const resolvedFrozenV1 = resolveRequestIntakeSchema({
    intakeSchemaKey: historicalV1Request.intakeSchemaKey,
    intakeSchemaVersion: historicalV1Request.intakeSchemaVersion,
    intakeSchemaJson: historicalV1Request.intakeSchemaJson,
    tradeCode: historicalV1Request.tradeCode,
  });
  check(
    "Historical Cleaning V1 request remains interpretable exactly as recorded",
    historicalV1Request.intakeSchemaVersion === 1 &&
      resolvedFrozenV1.version === 1 &&
      !resolvedFrozenV1.fields.some((field) => field.key === "propertyType") &&
      historicalV1Request.intakeSchemaJson === freezeIntakeSchema(cleaningV1),
  );

  console.log("\nCOUNTS — Pressure Washing launch pack");
  console.log(`  starter services: ${starterServices.length}`);
  console.log(`  categories: ${starterCategories.join(", ")}`);
  console.log(
    `  pricing: FIXED ${pricingBreakdown.FIXED ?? 0}, STARTING_AT ${pricingBreakdown.STARTING_AT ?? 0}, CUSTOM_QUOTE ${pricingBreakdown.CUSTOM_QUOTE ?? 0}`,
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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
