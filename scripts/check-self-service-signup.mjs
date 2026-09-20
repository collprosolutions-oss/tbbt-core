/**
 * Task #78: public self-service signup → Founder trial → first-run.
 *
 * Proves the marketing CTA enters /sign-up, a brand-new user gets one
 * Business + OWNER membership, the existing 30-day Founder trial starts
 * once without Stripe Checkout, retries do not duplicate records,
 * established businesses skip new-business creation, and Handyman
 * continues through the existing setup stages.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-self-service-signup.mjs
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
  postAuthenticationPath,
  resetFirstRunSetupSchemaEnsure,
} = await import("@/lib/first-run-setup");
const { provisionNewOwnerWithFounderTrial } = await import(
  "@/lib/public-signup-handoff"
);
const { provisionOwnerWorkspace } = await import("@/lib/signup-provision");
const {
  startFounderTrialIfEligible,
  resolveSaasEntitlement,
  TBBT_FOUNDER_TRIAL_MS,
  resetSaasBillingSchemaEnsure,
  ensureSaasBillingSchema,
} = await import("@/lib/saas-billing");
const {
  ensureStarterServicesSetupSchema,
  installOnboardingStarterServicesOp,
  resetStarterServicesSetupSchemaEnsure,
} = await import("@/lib/starter-services-setup");
const {
  ensureWebsiteSetupSchema,
  resetWebsiteSetupSchemaEnsure,
  skipWebsiteSetupOp,
} = await import("@/lib/website-setup");
const { DEFAULT_TRADE } = await import("@/lib/trades");
const { TBBT_SIGN_UP_HREF, TBBT_TRIAL_NAV_LABEL, TBBT_TRIAL_CTA_LABEL } =
  await import("@/lib/tbbt-marketing");
const { ForbiddenError } = await import("@/lib/authorization");

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

const authSrc = readRepo("src/app/actions/auth.ts");
const handoffSrc = readRepo("src/lib/public-signup-handoff.ts");
const headerSrc = readRepo("src/components/tbbt-marketing/header.tsx");
const homeSrc = readRepo("src/components/tbbt-marketing/home.tsx");
const pricingSrc = readRepo("src/components/tbbt-marketing/pricing.tsx");
const websiteAction = readRepo("src/app/actions/website-setup.ts");
const firstRunSrc = readRepo("src/lib/first-run-setup.ts");
const paymentsServiceSrc = readRepo("src/lib/payments/service.ts");
const signupForm = readRepo("src/components/auth/sign-up-form.tsx");

console.log("\nSTATIC — Public CTA enters the real signup flow");
check(
  "Start Free Trial CTAs reuse /sign-up",
  TBBT_SIGN_UP_HREF === "/sign-up" &&
    TBBT_TRIAL_NAV_LABEL === "Start Free Trial" &&
    TBBT_TRIAL_CTA_LABEL.includes("30-Day") &&
    headerSrc.includes("TBBT_SIGN_UP_HREF") &&
    homeSrc.includes("TBBT_SIGN_UP_HREF") &&
    pricingSrc.includes("TBBT_SIGN_UP_HREF") &&
    signupForm.includes("signUpAction"),
);
check(
  "Signup handoff provisions a tenant and starts the local Founder trial",
  authSrc.includes("provisionNewOwnerWithFounderTrial") &&
    authSrc.includes("redirect(result.nextPath)") &&
    handoffSrc.includes("provisionOwnerWorkspace") &&
    handoffSrc.includes("startFounderTrialIfEligible") &&
    handoffSrc.includes("postAuthenticationPath") &&
    !handoffSrc.includes("startSaasSubscriptionCheckout") &&
    !authSrc.includes("startSaasSubscriptionCheckout"),
);
check(
  "Website setup still starts trial idempotently; first-run lib stays off SaaS billing",
  websiteAction.includes("startFounderTrialIfEligible") &&
    !firstRunSrc.includes("saas-billing") &&
    !firstRunSrc.includes("STRIPE_SAAS") &&
    !paymentsServiceSrc.includes("provisionNewOwnerWithFounderTrial") &&
    !paymentsServiceSrc.includes("BusinessSaasSubscription"),
);

process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
process.env.STRIPE_SAAS_PRICE_ID = process.env.STRIPE_SAAS_PRICE_ID || "price_saas_test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_self_service_signup";
process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://self-service-signup.test";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("\nDATABASE_URL must be set to run self-service signup checks.");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(1);
}

const testDbName = "tbbt_self_service_signup_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for self-service signup test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Brand-new user enters setup with one tenant and one trial");
  resetFirstRunSetupSchemaEnsure();
  resetStarterServicesSetupSchemaEnsure();
  resetWebsiteSetupSchemaEnsure();
  resetSaasBillingSchemaEnsure();
  await ensureFirstRunSetupSchema(prisma);
  await ensureStarterServicesSetupSchema(prisma);
  await ensureWebsiteSetupSchema(prisma);
  await ensureSaasBillingSchema(prisma);

  const passwordHash = await bcrypt.hash("password12", 10);
  const now = new Date("2026-09-20T12:00:00.000Z");
  const result = await provisionNewOwnerWithFounderTrial(prisma, {
    name: "New Owner",
    email: `owner-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Cedar Handyman",
    now,
  });

  check(
    "Brand-new user is routed into first-run setup",
    result.nextPath === "/setup" &&
      result.membership.role === "OWNER" &&
      result.business.tradeCode === DEFAULT_TRADE &&
      result.business.firstRunSetupCompletedAt === null,
  );

  const businesses = await prisma.business.findMany({
    where: { memberships: { some: { userId: result.user.id } } },
  });
  const memberships = await prisma.membership.findMany({
    where: { userId: result.user.id },
  });
  const trialRow = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: result.business.id },
  });
  const entitlement = resolveSaasEntitlement({
    slug: result.business.slug,
    row: trialRow,
    now,
  });
  check(
    "Signup creates exactly one Business and one OWNER membership",
    businesses.length === 1 &&
      memberships.length === 1 &&
      memberships[0].role === "OWNER" &&
      memberships[0].businessId === result.business.id,
  );
  check(
    "Founder trial is initialized once without Stripe Checkout or a card",
    result.trial.started === true &&
      trialRow?.trialStartedAt?.getTime() === now.getTime() &&
      trialRow?.trialEndsAt?.getTime() === now.getTime() + TBBT_FOUNDER_TRIAL_MS &&
      trialRow?.founderEligible === true &&
      trialRow?.legacyExempt === false &&
      trialRow?.stripeCustomerId == null &&
      trialRow?.stripeSubscriptionId == null &&
      trialRow?.status === "none" &&
      entitlement.state === "trial_active" &&
      entitlement.canOperate === true,
  );

  const replay = await startFounderTrialIfEligible(prisma, {
    businessId: result.business.id,
    slug: result.business.slug,
    changedByMembershipId: result.membership.id,
    now: new Date(now.getTime() + 60_000),
  });
  const trialAfterReplay = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: result.business.id },
  });
  check(
    "Retry does not start a second Founder trial",
    replay.started === false &&
      replay.reason === "trial_already_started" &&
      (await prisma.businessSaasSubscription.count({
        where: { businessId: result.business.id },
      })) === 1 &&
      trialAfterReplay?.trialStartedAt?.getTime() === now.getTime() &&
      trialAfterReplay?.stripeCustomerId == null &&
      trialAfterReplay?.stripeSubscriptionId == null,
  );

  const ownerAccess = makeAccess(
    result.business.id,
    "OWNER",
    result.membership.id,
    { slug: result.business.slug },
  );
  await completeFirstRunSetupOp(prisma, ownerAccess, {
    name: "Cedar Handyman",
    phone: "555-222-3333",
    email: "shop@cedar.example",
    website: "",
  });
  const replaySetup = await completeFirstRunSetupOp(prisma, ownerAccess, {
    name: "Duplicate Name",
    phone: "555-000-0000",
    email: "dup@cedar.example",
    website: "",
  });
  const afterIdentity = await prisma.business.findUnique({
    where: { id: result.business.id },
  });
  check(
    "First-run setup reuses the signup business and does not duplicate on retry",
    replaySetup.alreadyComplete === true &&
      afterIdentity?.name === "Cedar Handyman" &&
      (await prisma.business.count()) === 1 &&
      (await prisma.membership.count({ where: { userId: result.user.id } })) === 1 &&
      postAuthenticationPath({ role: "OWNER", business: afterIdentity }) ===
        "/setup/services",
  );

  console.log("\nDB — Handyman continues through existing setup stages");
  const installed = await installOnboardingStarterServicesOp(prisma, ownerAccess);
  const installedAgain = await installOnboardingStarterServicesOp(prisma, ownerAccess);
  const catalogCount = await prisma.serviceCatalogItem.count({
    where: { businessId: result.business.id },
  });
  const afterServices = await prisma.business.findUnique({
    where: { id: result.business.id },
  });
  check(
    "Handyman starter catalog installs once and retry does not duplicate services",
    installed.added > 0 &&
      installedAgain.added === 0 &&
      catalogCount === installed.added &&
      afterServices?.starterServicesSetupCompletedAt instanceof Date &&
      postAuthenticationPath({ role: "OWNER", business: afterServices }) ===
        "/setup/website",
  );

  const skippedSite = await skipWebsiteSetupOp(prisma, ownerAccess);
  const skippedSiteAgain = await skipWebsiteSetupOp(prisma, ownerAccess);
  const websiteTrial = await startFounderTrialIfEligible(prisma, {
    businessId: result.business.id,
    slug: result.business.slug,
    changedByMembershipId: result.membership.id,
  });
  const afterWebsite = await prisma.business.findUnique({
    where: { id: result.business.id },
  });
  const billingAfterWebsite = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: result.business.id },
  });
  check(
    "Website skip reaches the operating dashboard without a second trial or Stripe subscription",
    skippedSite.alreadyComplete === false &&
      skippedSiteAgain.alreadyComplete === true &&
      websiteTrial.reason === "trial_already_started" &&
      afterWebsite?.websiteSetupCompletedAt instanceof Date &&
      postAuthenticationPath({ role: "OWNER", business: afterWebsite }) ===
        "/dashboard" &&
      billingAfterWebsite?.stripeCustomerId == null &&
      billingAfterWebsite?.stripeSubscriptionId == null &&
      (await prisma.business.count()) === 1,
  );

  console.log("\nDB — Existing businesses bypass first-run creation");
  const established = await provisionOwnerWorkspace(prisma, {
    name: "Established Owner",
    email: `established-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash,
    businessName: "Established Co",
  });
  const completedAt = new Date("2026-01-15T00:00:00.000Z");
  await prisma.business.update({
    where: { id: established.business.id },
    data: {
      firstRunSetupCompletedAt: completedAt,
      starterServicesSetupCompletedAt: completedAt,
      websiteSetupCompletedAt: completedAt,
    },
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: established.business.id,
      status: "none",
      legacyExempt: true,
      founderEligible: false,
    },
  });
  const establishedPath = postAuthenticationPath({
    role: "OWNER",
    business: await prisma.business.findUnique({
      where: { id: established.business.id },
    }),
  });
  const establishedTrial = await startFounderTrialIfEligible(prisma, {
    businessId: established.business.id,
    slug: established.business.slug,
    changedByMembershipId: established.membership.id,
  });
  const establishedSetup = await completeFirstRunSetupOp(
    prisma,
    makeAccess(established.business.id, "OWNER", established.membership.id, {
      slug: established.business.slug,
    }),
    {
      name: "Should Not Rename",
      phone: "555-111-1111",
      email: "keep@established.example",
      website: "",
    },
  );
  const establishedAfter = await prisma.business.findUnique({
    where: { id: established.business.id },
  });
  check(
    "Existing completed business continues to the dashboard and skips new-business creation",
    establishedPath === "/dashboard" &&
      establishedTrial.reason === "legacy_exempt" &&
      establishedSetup.alreadyComplete === true &&
      establishedAfter?.name === "Established Co" &&
      (await prisma.business.count()) === 2,
  );

  let duplicateEmailThrew = false;
  try {
    await provisionNewOwnerWithFounderTrial(prisma, {
      name: "Clone",
      email: result.user.email,
      passwordHash,
      businessName: "Clone Co",
    });
  } catch (error) {
    duplicateEmailThrew = error?.code === "P2002";
  }
  check(
    "Repeating signup with the same email does not create another Business",
    duplicateEmailThrew &&
      (await prisma.user.count({ where: { email: result.user.email } })) === 1 &&
      (await prisma.business.count({ where: { name: "Cedar Handyman" } })) === 1 &&
      (await prisma.business.count({ where: { name: "Clone Co" } })) === 0,
  );

  await expectForbiddenMember(result, passwordHash);
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

async function expectForbiddenMember(result, passwordHash) {
  const memberUser = await prisma.user.create({
    data: {
      name: "Field Tech",
      email: `member-${randomUUID().slice(0, 8)}@example.com`,
      passwordHash,
    },
  });
  const member = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: result.business.id,
      role: "MEMBER",
    },
  });
  try {
    await completeFirstRunSetupOp(
      prisma,
      makeAccess(result.business.id, "MEMBER", member.id, {
        slug: result.business.slug,
      }),
      {
        name: "Hijack",
        phone: "555-9",
        email: "hijack@example.com",
        website: "",
      },
    );
    check("MEMBER cannot complete OWNER first-run setup", false);
  } catch (error) {
    check(
      "MEMBER cannot complete OWNER first-run setup",
      error instanceof ForbiddenError,
    );
  }
}

console.log(
  failed === 0
    ? `\nAll self-service signup checks passed (${passed}).`
    : `\n${failed} self-service signup check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
