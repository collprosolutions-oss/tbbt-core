/**
 * Task 2: Handyman starter services onboarding.
 *
 * Proves identity-complete OWNERs continue to starter-services setup, the
 * current Handyman installer is reused, install/skip persist explicitly
 * (not from service count), repeats cannot duplicate, ADMIN/MEMBER cannot
 * install during onboarding, existing/CollPro tenants are not trapped,
 * and another business's catalog is untouched.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-starter-services-setup.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  completeFirstRunSetupOp,
  ensureFirstRunSetupSchema,
  ownerNeedsFirstRunSetup,
  postAuthenticationPath,
  resetFirstRunSetupSchemaEnsure,
} = await import("@/lib/first-run-setup");
const { provisionOwnerWorkspace } = await import("@/lib/signup-provision");
const { ForbiddenError } = await import("@/lib/authorization");
const {
  HANDYMAN_STARTER_SERVICES,
  importableStarterServices,
  planStarterCatalogInstall,
  starterIntakeFields,
  starterPricingMode,
} = await import("@/lib/handyman-starter-catalog");
const { installHandymanStarterCatalogForBusiness } = await import(
  "@/lib/starter-catalog-install"
);
const {
  ensureStarterServicesSetupSchema,
  hasCompletedStarterServicesSetup,
  installOnboardingStarterServicesOp,
  ownerNeedsStarterServicesSetup,
  resetStarterServicesSetupSchemaEnsure,
  skipOnboardingStarterServicesOp,
  STARTER_SERVICES_SETUP_INSTALLED,
  STARTER_SERVICES_SETUP_PATH,
  STARTER_SERVICES_SETUP_SKIPPED,
  tradeOffersOnboardingStarterCatalog,
} = await import("@/lib/starter-services-setup");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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

function makeAccess(businessId, role, membershipId, business = {}) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, tradeCode: "HANDYMAN", slug: "unused", ...business },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

console.log("\nSTATIC — Onboarding continues to starter services after Task 1");
const firstRunAction = readRepo("src/app/actions/first-run-setup.ts");
const catalogAction = readRepo("src/app/actions/catalog.ts");
const servicesPage = readRepo("src/app/(app)/services/page.tsx");
const addServiceSheet = readRepo("src/components/services/add-service-sheet.tsx");
const appLayout = readRepo("src/app/(app)/layout.tsx");
const fieldLayout = readRepo("src/app/field/layout.tsx");
const starterPage = readRepo("src/app/setup/services/page.tsx");
const starterForm = readRepo("src/components/auth/starter-services-setup-form.tsx");
const installer = readRepo("src/lib/starter-catalog-install.ts");
check(
  "First-run completion uses postAuthenticationPath so Handyman owners continue to starter services",
  firstRunAction.includes("postAuthenticationPath") &&
    STARTER_SERVICES_SETUP_PATH === "/setup/services",
);
check(
  "Management console and Field send incomplete starter-services OWNERs to /setup/services",
  appLayout.includes("ownerNeedsStarterServicesSetup") &&
    appLayout.includes("STARTER_SERVICES_SETUP_PATH") &&
    fieldLayout.includes("ownerNeedsStarterServicesSetup"),
);
check(
  "Starter-services screen offers Add and Skip, then Continue after install",
  starterForm.includes("Add Handyman Starter Services") &&
    starterForm.includes("Skip for now") &&
    starterForm.includes("Continue") &&
    starterPage.includes("continueHref") &&
    starterPage.includes("Handyman starter services"),
);
check(
  "Services page still uses the existing Handyman starter catalog installer",
  catalogAction.includes("installHandymanStarterCatalogForBusiness") &&
    catalogAction.includes("export async function installHandymanStarterCatalog") &&
    addServiceSheet.includes("InstallStarterCatalogForm") &&
    servicesPage.includes("planStarterCatalogInstall") &&
    installer.includes("planStarterCatalogInstall") &&
    installer.includes("starterIntakeFields"),
);
check(
  "Task 2 does not add a trade picker, Cleaning catalog, or later onboarding products",
  !starterPage.includes("Cleaning") &&
    !starterForm.includes("trade picker") &&
    !readRepo("src/lib/starter-services-setup.ts").includes("Stripe") &&
    tradeOffersOnboardingStarterCatalog("HANDYMAN") === true &&
    tradeOffersOnboardingStarterCatalog("CLEANING") === false,
);

console.log("\nUNIT — Explicit starter-services completion, not service count");
const importable = importableStarterServices();
check(
  "Installer plans against the current Handyman starter catalog",
  importable.length > 0 &&
    importable.length === planStarterCatalogInstall([]).add.length &&
    importable.every((service) =>
      HANDYMAN_STARTER_SERVICES.some((row) => row.templateKey === service.templateKey),
    ),
);
check(
  "Identity-complete Handyman OWNER is routed to starter-services setup",
  postAuthenticationPath({
    role: "OWNER",
    business: {
      slug: "new-handyman",
      tradeCode: "HANDYMAN",
      firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
      starterServicesSetupCompletedAt: null,
    },
  }) === "/setup/services" &&
    ownerNeedsStarterServicesSetup({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        starterServicesSetupCompletedAt: null,
      },
    }) === true,
);
check(
  "Catalog item count does not complete starter-services onboarding",
  ownerNeedsStarterServicesSetup({
    role: "OWNER",
    business: {
      slug: "new-handyman",
      tradeCode: "HANDYMAN",
      starterServicesSetupCompletedAt: null,
    },
  }) === true,
);
check(
  "Installed or skipped timestamp completes the step",
  hasCompletedStarterServicesSetup({
    slug: "new-handyman",
    starterServicesSetupCompletedAt: new Date("2026-01-02T00:00:00Z"),
    starterServicesSetupChoice: STARTER_SERVICES_SETUP_INSTALLED,
  }) === true &&
    ownerNeedsStarterServicesSetup({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        starterServicesSetupCompletedAt: new Date("2026-01-02T00:00:00Z"),
        starterServicesSetupChoice: STARTER_SERVICES_SETUP_SKIPPED,
      },
    }) === false &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
        starterServicesSetupCompletedAt: new Date("2026-01-02T00:00:00Z"),
        starterServicesSetupChoice: STARTER_SERVICES_SETUP_INSTALLED,
      },
    }) === "/setup/website",
);
check(
  "Existing CollPro is not forced through starter-services onboarding",
  hasCompletedStarterServicesSetup({
    slug: "collpro-reno",
    starterServicesSetupCompletedAt: null,
  }) === true &&
    ownerNeedsStarterServicesSetup({
      role: "OWNER",
      business: {
        slug: "collpro-reno",
        tradeCode: "HANDYMAN",
        starterServicesSetupCompletedAt: null,
      },
    }) === false &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "collpro-reno",
        tradeCode: "HANDYMAN",
        firstRunSetupCompletedAt: null,
        starterServicesSetupCompletedAt: null,
      },
    }) === "/dashboard",
);
check(
  "MEMBER and ADMIN cannot be forced into OWNER starter-services onboarding",
  ownerNeedsStarterServicesSetup({
    role: "MEMBER",
    business: {
      slug: "new-handyman",
      tradeCode: "HANDYMAN",
      starterServicesSetupCompletedAt: null,
    },
  }) === false &&
    ownerNeedsStarterServicesSetup({
      role: "ADMIN",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        starterServicesSetupCompletedAt: null,
      },
    }) === false &&
    postAuthenticationPath({
      role: "MEMBER",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        starterServicesSetupCompletedAt: null,
      },
    }) === "/field" &&
    postAuthenticationPath({
      role: "ADMIN",
      business: {
        slug: "new-handyman",
        tradeCode: "HANDYMAN",
        starterServicesSetupCompletedAt: null,
      },
    }) === "/dashboard",
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("\nDATABASE_URL must be set to run starter-services persistence checks.");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(1);
}

const testDbName = "tbbt_starter_services_setup_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for starter-services setup test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Install, skip, isolation, and existing tenants");
  resetFirstRunSetupSchemaEnsure();
  resetStarterServicesSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);

  const passwordHash = await bcrypt.hash("password12", 10);
  const provisioned = await provisionOwnerWorkspace(prisma, {
    name: "New Owner",
    email: `owner-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Cedar Handyman",
  });
  const ownerAccess = makeAccess(
    provisioned.business.id,
    "OWNER",
    provisioned.membership.id,
    { slug: provisioned.business.slug },
  );

  await completeFirstRunSetupOp(prisma, ownerAccess, {
    name: "Cedar Handyman",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "",
  });
  const afterIdentity = await prisma.business.findUnique({
    where: { id: provisioned.business.id },
  });
  check(
    "New OWNER completing Task 1 proceeds to starter-services setup",
    afterIdentity?.firstRunSetupCompletedAt instanceof Date &&
      afterIdentity?.starterServicesSetupCompletedAt === null &&
      postAuthenticationPath({ role: "OWNER", business: afterIdentity }) ===
        "/setup/services",
  );

  const memberUser = await prisma.user.create({
    data: {
      name: "Field Tech",
      email: `member-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash,
    },
  });
  const memberMembership = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: provisioned.business.id,
      role: "MEMBER",
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      name: "Office Admin",
      email: `admin-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash,
    },
  });
  const adminMembership = await prisma.membership.create({
    data: {
      userId: adminUser.id,
      businessId: provisioned.business.id,
      role: "ADMIN",
    },
  });

  await expectError(
    "MEMBER cannot perform OWNER onboarding installation",
    () =>
      installOnboardingStarterServicesOp(
        prisma,
        makeAccess(provisioned.business.id, "MEMBER", memberMembership.id, {
          slug: provisioned.business.slug,
        }),
      ),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot perform OWNER onboarding installation",
    () =>
      installOnboardingStarterServicesOp(
        prisma,
        makeAccess(provisioned.business.id, "ADMIN", adminMembership.id, {
          slug: provisioned.business.slug,
        }),
      ),
    (error) => error instanceof ForbiddenError,
  );

  const collpro = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });
  const collproItem = await prisma.serviceCatalogItem.create({
    data: {
      businessId: collpro.id,
      name: "CollPro Custom Service",
      pricingMode: "STARTING_AT",
      price: 199,
      category: "Doors & Locks",
    },
  });
  const collproBefore = await prisma.serviceCatalogItem.findMany({
    where: { businessId: collpro.id },
    orderBy: { id: "asc" },
  });

  const firstInstall = await installOnboardingStarterServicesOp(prisma, ownerAccess);
  const installed = await prisma.serviceCatalogItem.findMany({
    where: { businessId: provisioned.business.id },
    orderBy: { name: "asc" },
  });
  const cedarAfterInstall = await prisma.business.findUnique({
    where: { id: provisioned.business.id },
  });
  check(
    "Onboarding install uses the current Handyman starter catalog",
    firstInstall.added === importable.length &&
      installed.length === importable.length &&
      installed.every((item) => {
        const template = importable.find((service) => service.name === item.name);
        if (!template) return false;
        const priceMatches =
          template.startingPrice == null
            ? item.price == null
            : Number(item.price) === template.startingPrice;
        const intake = starterIntakeFields(template);
        return (
          item.category === template.category &&
          item.pricingMode === starterPricingMode(template) &&
          priceMatches &&
          item.intakeMeasurementMode === intake.intakeMeasurementMode &&
          item.description === template.description
        );
      }),
  );
  check(
    "Installed state persists and is not inferred from service count",
    cedarAfterInstall?.starterServicesSetupCompletedAt instanceof Date &&
      cedarAfterInstall?.starterServicesSetupChoice === STARTER_SERVICES_SETUP_INSTALLED &&
      postAuthenticationPath({ role: "OWNER", business: cedarAfterInstall }) ===
        "/setup/website",
  );

  const secondInstall = await installOnboardingStarterServicesOp(prisma, ownerAccess);
  const installedAgain = await prisma.serviceCatalogItem.findMany({
    where: { businessId: provisioned.business.id },
  });
  check(
    "Repeated installation cannot duplicate services",
    secondInstall.added === 0 &&
      secondInstall.skipped === importable.length &&
      installedAgain.length === installed.length,
  );

  const skipOwner = await provisionOwnerWorkspace(prisma, {
    name: "Skip Owner",
    email: `skip-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Maple Handyman",
  });
  const skipAccess = makeAccess(
    skipOwner.business.id,
    "OWNER",
    skipOwner.membership.id,
    { slug: skipOwner.business.slug },
  );
  await completeFirstRunSetupOp(prisma, skipAccess, {
    name: "Maple Handyman",
    phone: "555-444-5555",
    email: "shop@maple.example",
    website: "",
  });
  await skipOnboardingStarterServicesOp(prisma, skipAccess);
  const skippedBiz = await prisma.business.findUnique({
    where: { id: skipOwner.business.id },
  });
  const skippedItems = await prisma.serviceCatalogItem.findMany({
    where: { businessId: skipOwner.business.id },
  });
  check(
    "Skip persists and does not install services",
    skippedBiz?.starterServicesSetupCompletedAt instanceof Date &&
      skippedBiz?.starterServicesSetupChoice === STARTER_SERVICES_SETUP_SKIPPED &&
      skippedItems.length === 0 &&
      postAuthenticationPath({ role: "OWNER", business: skippedBiz }) === "/setup/website",
  );

  const skippedInstall = await installOnboardingStarterServicesOp(prisma, skipAccess);
  const skippedItemsAfter = await prisma.serviceCatalogItem.findMany({
    where: { businessId: skipOwner.business.id },
  });
  check(
    "A skipped owner cannot silently install by retrying the onboarding installer",
    skippedInstall.alreadyComplete === true &&
      skippedInstall.choice === STARTER_SERVICES_SETUP_SKIPPED &&
      skippedItemsAfter.length === 0,
  );

  const otherItems = await prisma.serviceCatalogItem.findMany({
    where: { businessId: skipOwner.business.id },
  });
  const cedarItems = await prisma.serviceCatalogItem.findMany({
    where: { businessId: provisioned.business.id },
  });
  check(
    "Install is tenant-scoped and does not modify another business's catalog",
    cedarItems.length === importable.length && otherItems.length === 0,
  );

  const collproAfter = await prisma.serviceCatalogItem.findMany({
    where: { businessId: collpro.id },
    orderBy: { id: "asc" },
  });
  check(
    "CollPro catalog is unchanged",
    collproAfter.length === collproBefore.length &&
      collproAfter[0]?.id === collproItem.id &&
      collproAfter[0]?.name === "CollPro Custom Service" &&
      Number(collproAfter[0]?.price) === 199 &&
      ownerNeedsStarterServicesSetup({ role: "OWNER", business: collpro }) === false,
  );

  const preexisting = await prisma.business.create({
    data: {
      name: "Already Live Co",
      slug: `already-live-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Business" DROP COLUMN IF EXISTS "starterServicesSetupChoice"`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Business" DROP COLUMN IF EXISTS "starterServicesSetupCompletedAt"`,
  );
  resetStarterServicesSetupSchemaEnsure();
  await ensureStarterServicesSetupSchema(prisma);
  const backfilled = await prisma.business.findUnique({
    where: { id: preexisting.id },
  });
  check(
    "Existing businesses are backfilled and not forced through Task 2",
    backfilled?.starterServicesSetupCompletedAt instanceof Date &&
      ownerNeedsStarterServicesSetup({ role: "OWNER", business: backfilled }) === false,
  );

  const later = await provisionOwnerWorkspace(prisma, {
    name: "Later Owner",
    email: `later-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Later Handyman",
  });
  resetStarterServicesSetupSchemaEnsure();
  await ensureStarterServicesSetupSchema(prisma);
  const laterAfterEnsure = await prisma.business.findUnique({
    where: { id: later.business.id },
  });
  check(
    "Later signup stays incomplete after a second ensure",
    laterAfterEnsure?.starterServicesSetupCompletedAt === null &&
      ownerNeedsStarterServicesSetup({
        role: "OWNER",
        business: laterAfterEnsure,
      }) === true,
  );

  const servicesInstall = await installHandymanStarterCatalogForBusiness(
    prisma,
    later.business.id,
  );
  const servicesAgain = await installHandymanStarterCatalogForBusiness(
    prisma,
    later.business.id,
  );
  const laterItems = await prisma.serviceCatalogItem.findMany({
    where: { businessId: later.business.id },
  });
  check(
    "Existing Services installer remains operational and idempotent",
    servicesInstall.added === importable.length &&
      servicesAgain.added === 0 &&
      laterItems.length === importable.length,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failed === 0
    ? `\nAll starter-services setup checks passed (${passed}).`
    : `\n${passed} passed, ${failed} failed.`,
);
process.exit(failed > 0 ? 1 : 0);
