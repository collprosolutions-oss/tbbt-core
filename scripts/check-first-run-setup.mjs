/**
 * Task 1: first-run OWNER business setup.
 *
 * Proves signup still provisions User + Business + OWNER membership,
 * incomplete OWNERs are routed to /setup, completion is an explicit
 * timestamp (not inferred from phone/email), tenant writes stay scoped,
 * MEMBER/ADMIN and existing CollPro are not trapped, and a new
 * non-CollPro tenant does not inherit CollPro public identity defaults.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-first-run-setup.mjs
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
  FIRST_RUN_SETUP_ENSURE_SQL,
  FIRST_RUN_SETUP_PATH,
  hasCompletedFirstRunSetup,
  ownerNeedsFirstRunSetup,
  postAuthenticationPath,
  resetFirstRunSetupSchemaEnsure,
} = await import("@/lib/first-run-setup");
const { provisionOwnerWorkspace } = await import("@/lib/signup-provision");
const { ForbiddenError } = await import("@/lib/authorization");
const { SettingsError } = await import("@/lib/settings-ops");
const {
  DEFAULT_PUBLIC_ABOUT_STORY,
  HOW_IT_WORKS_STEPS,
  publicPhone,
  resolveHowItWorksSteps,
  resolvePublicServiceAreaCopy,
} = await import("@/lib/public-site");
const { resolvePublishedAboutCopy } = await import("@/lib/website-story");
const { resolveBusinessServiceArea } = await import("@/lib/business-service-area");

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

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

console.log("\nSTATIC — Signup still provisions User + Business + OWNER");
const authSrc = readRepo("src/app/actions/auth.ts");
const provisionSrc = readRepo("src/lib/signup-provision.ts");
check(
  "Signup uses the extracted atomic provision helper",
  authSrc.includes("provisionOwnerWorkspace") &&
    provisionSrc.includes("tx.user.create") &&
    provisionSrc.includes("tx.business.create") &&
    provisionSrc.includes('role: "OWNER"') &&
    provisionSrc.includes("allocateBusinessSlug"),
);
check(
  "Signup does not set first-run completion during provision",
  (() => {
    const createBlock = provisionSrc.slice(
      provisionSrc.indexOf("tx.business.create"),
      provisionSrc.indexOf("tx.membership.create"),
    );
    return createBlock.includes("tradeCode: DEFAULT_TRADE") && !createBlock.includes("firstRunSetupCompletedAt");
  })(),
);
check(
  "Successful signup redirects into first-run setup, not Dashboard",
  authSrc.includes("redirect(FIRST_RUN_SETUP_PATH)") &&
    FIRST_RUN_SETUP_PATH === "/setup",
);
check(
  "Sign-in uses postAuthenticationPath for OWNER/ADMIN/MEMBER",
  authSrc.includes("postAuthenticationPath") &&
    authSrc.includes("include: { business: true }"),
);

console.log("\nSTATIC — Routing gates");
const appLayout = readRepo("src/app/(app)/layout.tsx");
const fieldLayout = readRepo("src/app/field/layout.tsx");
const setupPage = readRepo("src/app/setup/page.tsx");
const setupAction = readRepo("src/app/actions/first-run-setup.ts");
check(
  "Management console sends incomplete OWNER to /setup",
  appLayout.includes("ownerNeedsFirstRunSetup") &&
    appLayout.includes("FIRST_RUN_SETUP_PATH"),
);
check(
  "Field layout does not trap MEMBER/ADMIN; only incomplete OWNER",
  fieldLayout.includes("ownerNeedsFirstRunSetup") &&
    !fieldLayout.includes('role === "MEMBER"') &&
    fieldLayout.includes("FIRST_RUN_SETUP_PATH"),
);
check(
  "Completed OWNER leaves setup for Dashboard",
  setupPage.includes("hasCompletedFirstRunSetup") &&
    setupPage.includes('redirect("/dashboard")') &&
    setupPage.includes('workspace.role !== "OWNER"') &&
    setupPage.includes('"/field"'),
);
check(
  "Setup save reuses Settings profile and public-contact fields",
  setupAction.includes("completeFirstRunSetupOp") &&
    readRepo("src/lib/first-run-setup.ts").includes("updateBusinessProfileOp") &&
    readRepo("src/lib/first-run-setup.ts").includes("updateBusinessPublicContactOp") &&
    readRepo("src/components/auth/first-run-setup-form.tsx").includes('name="publicPhone"') &&
    readRepo("src/components/auth/first-run-setup-form.tsx").includes('name="publicEmail"') &&
    readRepo("src/components/auth/first-run-setup-form.tsx").includes('name="publicWebsite"'),
);
check(
  "Task 1 does not add later onboarding products",
  !setupAction.includes("Stripe") &&
    !provisionSrc.includes("installStarterCatalog") &&
    !setupPage.includes("trade picker") &&
    !readRepo("src/lib/first-run-setup.ts").includes("custom domain"),
);

console.log("\nSTATIC — CollPro public identity stays tenant-gated");
const aboutSrc = readRepo("src/components/public/public-about.tsx");
const homeSrc = readRepo("src/components/public/public-home.tsx");
const areaPage = readRepo("src/app/hire/[slug]/service-area/page.tsx");
const apexHome = readRepo("src/app/page.tsx");
check(
  "CollPro About heading remains in source and is slug-gated",
  aboutSrc.includes("Why Homeowners Choose CollPro Reno") &&
    aboutSrc.includes("isCollProRenoSlug") &&
    aboutSrc.includes("Fort Myers and Cape Coral"),
);
check(
  "CollPro project band remains in source and is slug-gated",
  homeSrc.includes("Recent Projects / Real CollPro Work") &&
    homeSrc.includes("isCollProRenoSlug"),
);
check(
  "Hire service-area keeps Lee County copy behind the CollPro slug",
  areaPage.includes("Lee County") &&
    areaPage.includes("Fort Myers") &&
    areaPage.includes("isCollProRenoSlug") &&
    areaPage.includes("resolveBusinessServiceArea"),
);
check(
  "Live CollPro apex / homepage is unchanged",
  apexHome.includes("COLLPRO_RENO_DISPLAY_NAME") &&
    apexHome.includes("loadDefaultPublicBusiness") &&
    !apexHome.includes("first-run") &&
    !apexHome.includes("FIRST_RUN_SETUP"),
);
check(
  "How It Works keeps the CollPro-branded step for CollPro only",
  HOW_IT_WORKS_STEPS[1].body.includes("CollPro Reno reviews") &&
    resolveHowItWorksSteps("collpro-reno")[1].body.includes("CollPro Reno reviews") &&
    !resolveHowItWorksSteps("other-handyman")[1].body.includes("CollPro Reno"),
);

console.log("\nUNIT — Completion is explicit, not inferred from contact fields");
check(
  "New non-CollPro business with empty completion is incomplete",
  hasCompletedFirstRunSetup({ slug: "new-handyman", firstRunSetupCompletedAt: null }) === false,
);
check(
  "Phone and email alone do not mark setup complete",
  ownerNeedsFirstRunSetup({
    role: "OWNER",
    business: { slug: "new-handyman", firstRunSetupCompletedAt: null },
  }) === true,
);
check(
  "A stored completion timestamp marks setup complete",
  hasCompletedFirstRunSetup({
    slug: "new-handyman",
    firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
  }) === true,
);
check(
  "Existing CollPro is not forced through owner onboarding",
  hasCompletedFirstRunSetup({ slug: "collpro-reno", firstRunSetupCompletedAt: null }) === true &&
    ownerNeedsFirstRunSetup({
      role: "OWNER",
      business: { slug: "collpro-reno", firstRunSetupCompletedAt: null },
    }) === false &&
    ownerNeedsFirstRunSetup({
      role: "OWNER",
      business: { slug: "collpro-reno-handyman-services", firstRunSetupCompletedAt: null },
    }) === false,
);
check(
  "MEMBER is not forced into OWNER onboarding",
  ownerNeedsFirstRunSetup({
    role: "MEMBER",
    business: { slug: "new-handyman", firstRunSetupCompletedAt: null },
  }) === false &&
    postAuthenticationPath({
      role: "MEMBER",
      business: { slug: "new-handyman", firstRunSetupCompletedAt: null },
    }) === "/field",
);
check(
  "ADMIN is not forced into OWNER onboarding",
  ownerNeedsFirstRunSetup({
    role: "ADMIN",
    business: { slug: "new-handyman", firstRunSetupCompletedAt: null },
  }) === false &&
    postAuthenticationPath({
      role: "ADMIN",
      business: { slug: "new-handyman", firstRunSetupCompletedAt: null },
    }) === "/dashboard",
);
check(
  "Incomplete OWNER is routed to setup; completed OWNER reaches Dashboard",
  postAuthenticationPath({
    role: "OWNER",
    business: { slug: "new-handyman", firstRunSetupCompletedAt: null },
  }) === "/setup" &&
    postAuthenticationPath({
      role: "OWNER",
      business: {
        slug: "new-handyman",
        firstRunSetupCompletedAt: new Date("2026-01-01T00:00:00Z"),
      },
    }) === "/dashboard",
);

console.log("\nUNIT — New non-CollPro tenants do not inherit CollPro public identity");
check(
  "CollPro phone fallback does not leak to another tenant",
  publicPhone("collpro-reno") === "(239) 357-8199" && publicPhone("other-handyman") === null,
);
check(
  "CollPro About story is not the empty-copy fallback for another tenant",
  resolvePublishedAboutCopy(null, "collpro-reno") === DEFAULT_PUBLIC_ABOUT_STORY &&
    resolvePublishedAboutCopy(null, "other-handyman") === "" &&
    resolvePublishedAboutCopy("  ", "other-handyman") === "",
);
check(
  "Approved About copy still publishes for any tenant",
  resolvePublishedAboutCopy("Our shop has served this town since last spring.", "other-handyman") ===
    "Our shop has served this town since last spring.",
);
check(
  "Non-CollPro service-area copy has no Fort Myers assumption",
  /Fort Myers/.test(resolvePublicServiceAreaCopy("collpro-reno")) &&
    !/Fort Myers|Cape Coral|Lee County/.test(resolvePublicServiceAreaCopy("other-handyman")),
);
check(
  "Non-CollPro intake service area stays empty",
  resolveBusinessServiceArea({ slug: "collpro-reno" }).cities.includes("Fort Myers") &&
    resolveBusinessServiceArea({ slug: "other-handyman" }).cities.length === 0 &&
    resolveBusinessServiceArea({ slug: "other-handyman" }).region === null,
);

const migrationSql = readRepo("prisma/migrations/20260915120000_add_first_run_setup/migration.sql");
check(
  "Migration and preview ensure share the one-shot backfill, not a repeating UPDATE",
  migrationSql.includes("information_schema.columns") &&
    FIRST_RUN_SETUP_ENSURE_SQL.includes("information_schema.columns") &&
    FIRST_RUN_SETUP_ENSURE_SQL.includes('ADD COLUMN "firstRunSetupCompletedAt"') &&
    (migrationSql.match(/UPDATE "Business"/g) || []).length === 1,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("\nDATABASE_URL must be set to run first-run setup persistence checks.");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(1);
}

const testDbName = "tbbt_first_run_setup_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for first-run setup test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Atomic signup provision and first-run completion");
  resetFirstRunSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);

  const passwordHash = await bcrypt.hash("password12", 10);
  const provisioned = await provisionOwnerWorkspace(prisma, {
    name: "New Owner",
    email: `owner-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Cedar Handyman",
  });

  check(
    "Provision creates User + Business + OWNER membership together",
    Boolean(provisioned.user.id) &&
      provisioned.business.name === "Cedar Handyman" &&
      provisioned.membership.userId === provisioned.user.id &&
      provisioned.membership.businessId === provisioned.business.id &&
      provisioned.membership.role === "OWNER",
  );
  check(
    "New signup business is not marked first-run complete",
    provisioned.business.firstRunSetupCompletedAt === null,
  );
  check(
    "New OWNER is routed into first-run setup",
    postAuthenticationPath({
      role: provisioned.membership.role,
      business: provisioned.business,
    }) === "/setup",
  );

  const other = await provisionOwnerWorkspace(prisma, {
    name: "Other Owner",
    email: `other-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Maple Handyman",
  });

  const ownerAccess = makeAccess(
    provisioned.business.id,
    "OWNER",
    provisioned.membership.id,
  );
  const otherAccess = makeAccess(other.business.id, "OWNER", other.membership.id);
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
    "First-run setup requires public phone",
    () =>
      completeFirstRunSetupOp(prisma, ownerAccess, {
        name: "Cedar Handyman",
        phone: "",
        email: "shop@cedar.example",
        website: "",
      }),
    (error) => error instanceof SettingsError && /phone/i.test(error.message),
  );
  await expectError(
    "MEMBER cannot complete OWNER first-run setup",
    () =>
      completeFirstRunSetupOp(
        prisma,
        makeAccess(provisioned.business.id, "MEMBER", memberMembership.id),
        {
          name: "Cedar Handyman",
          phone: "555-222-3333",
          email: "shop@cedar.example",
          website: "",
        },
      ),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot complete OWNER first-run setup",
    () =>
      completeFirstRunSetupOp(
        prisma,
        makeAccess(provisioned.business.id, "ADMIN", adminMembership.id),
        {
          name: "Cedar Handyman",
          phone: "555-222-3333",
          email: "shop@cedar.example",
          website: "",
        },
      ),
    (error) => error instanceof ForbiddenError,
  );

  await completeFirstRunSetupOp(prisma, ownerAccess, {
    name: "Cedar Handyman Co",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "https://cedar.example",
  });

  const saved = await prisma.business.findUnique({
    where: { id: provisioned.business.id },
  });
  const otherAfter = await prisma.business.findUnique({
    where: { id: other.business.id },
  });
  check(
    "Setup saves name and public contact only on that OWNER's business",
    saved?.name === "Cedar Handyman Co" &&
      saved?.publicPhone === "555-222-3333" &&
      saved?.publicEmail === "shop@cedar.example" &&
      saved?.publicWebsite === "https://cedar.example" &&
      otherAfter?.name === "Maple Handyman" &&
      otherAfter?.publicPhone === null &&
      otherAfter?.publicEmail === null &&
      otherAfter?.firstRunSetupCompletedAt === null,
  );
  check(
    "Completion timestamp persists and is not inferred from contact fields",
    saved?.firstRunSetupCompletedAt instanceof Date,
  );
  check(
    "Completed OWNER reaches Dashboard normally",
    postAuthenticationPath({ role: "OWNER", business: saved }) === "/dashboard" &&
      ownerNeedsFirstRunSetup({ role: "OWNER", business: saved }) === false,
  );

  await completeFirstRunSetupOp(prisma, otherAccess, {
    name: "Hijacked",
    phone: "555-999-0000",
    email: "hijack@example.com",
    website: "",
  });
  const afterOtherSave = await prisma.business.findUnique({
    where: { id: provisioned.business.id },
  });
  const maple = await prisma.business.findUnique({
    where: { id: other.business.id },
  });
  check(
    "Other OWNER setup writes stay on the other business",
    afterOtherSave?.name === "Cedar Handyman Co" &&
      afterOtherSave?.publicPhone === "555-222-3333" &&
      maple?.name === "Hijacked" &&
      maple?.publicPhone === "555-999-0000" &&
      maple?.firstRunSetupCompletedAt instanceof Date,
  );

  const collpro = await prisma.business.create({
    data: {
      name: "CollPro Reno Handyman Services",
      slug: "collpro-reno",
      tradeCode: "HANDYMAN",
    },
  });
  check(
    "Existing CollPro row is not treated as needing owner onboarding",
    ownerNeedsFirstRunSetup({ role: "OWNER", business: collpro }) === false &&
      postAuthenticationPath({ role: "OWNER", business: collpro }) === "/dashboard",
  );

  console.log("\nDB — Preview one-shot backfill does not mark later signups complete");
  const preexisting = await prisma.business.create({
    data: {
      name: "Already Live Co",
      slug: `already-live-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Business" DROP COLUMN IF EXISTS "firstRunSetupCompletedAt"`,
  );
  resetFirstRunSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  const backfilled = await prisma.business.findUnique({
    where: { id: preexisting.id },
  });
  check(
    "First ensure backfills businesses that already existed",
    backfilled?.firstRunSetupCompletedAt instanceof Date,
  );

  const later = await provisionOwnerWorkspace(prisma, {
    name: "Later Owner",
    email: `later-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Later Handyman",
  });
  resetFirstRunSetupSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  const laterAfterEnsure = await prisma.business.findUnique({
    where: { id: later.business.id },
  });
  check(
    "Later signup stays incomplete after a second ensure",
    laterAfterEnsure?.firstRunSetupCompletedAt === null &&
      ownerNeedsFirstRunSetup({
        role: "OWNER",
        business: laterAfterEnsure,
      }) === true,
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
    ? `\nAll first-run setup checks passed (${passed}).`
    : `\n${passed} passed, ${failed} failed.`,
);
process.exit(failed > 0 ? 1 : 0);
