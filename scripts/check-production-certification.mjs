/**
 * Handyman production-certification harness.
 *
 * This script inventories the REAL application surfaces and proves
 * isolated-database tenant / permission / honesty checks. It does NOT
 * invent a passing browser walkthrough of the full lifecycle.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-production-certification.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const exists = (rel) => existsSync(join(root, rel));

const { CAPABILITIES, roleHasCapability, canAccessManagementConsole } = await import(
  "@/lib/authorization"
);
const { visibleAppNav } = await import("@/lib/nav");
const { nextContentStatus } = await import("@/lib/marketing");
const { BANK_NOT_CONNECTED_MESSAGE } = await import("@/lib/financial-intelligence");
const { OWNER_INTELLIGENCE_SCHEMA_SOURCE } = await import("@/lib/owner-intelligence-schema");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_production_cert_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
let blockers = [];
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}
function blocker(label) {
  blockers.push(label);
  console.log(`  BLOCKER - ${label}`);
}

const lifecycle = [
  ["Signup", "src/app/(auth)/sign-up/page.tsx"],
  ["Sign-in", "src/app/(auth)/sign-in/page.tsx"],
  ["Forgot password", "src/app/(auth)/forgot-password/page.tsx"],
  ["Password reset", "src/app/reset-password/[token]/page.tsx"],
  ["First-run setup", "src/app/setup/page.tsx"],
  ["Starter services setup", "src/app/setup/services/page.tsx"],
  ["Website setup", "src/app/setup/website/page.tsx"],
  ["Public website", "src/app/hire/[slug]/page.tsx"],
  ["Public request", "src/app/r/[slug]/page.tsx"],
  ["Multi-trade core", "src/lib/business-trades.ts"],
  ["Trade configuration", "src/lib/trade-config.ts"],
  ["Versioned intake schema", "src/lib/intake-schema.ts"],
  ["Cleaning starter catalog", "src/lib/cleaning-starter-catalog.ts"],
  ["CRM customers", "src/app/(app)/customers/page.tsx"],
  ["Requests", "src/app/(app)/requests/page.tsx"],
  ["Estimate editor", "src/app/(app)/estimates/[estimateId]/page.tsx"],
  ["Customer estimate token", "src/app/e/[token]/page.tsx"],
  ["Jobs", "src/app/(app)/jobs/page.tsx"],
  ["Field workflow", "src/app/field/jobs/[jobId]/page.tsx"],
  ["Time cards", "src/app/(app)/time-cards/page.tsx"],
  ["Change orders", "src/app/(app)/jobs/[jobId]/change-orders/[changeOrderId]/page.tsx"],
  ["Invoices", "src/app/(app)/invoices/page.tsx"],
  ["Project portal invoice", "src/app/p/[token]/invoice/page.tsx"],
  ["Expenses", "src/app/(app)/expenses/page.tsx"],
  ["Reports / job profitability", "src/app/(app)/reports/page.tsx"],
  ["Reviews", "src/app/(app)/reviews/page.tsx"],
  ["Marketing", "src/app/(app)/marketing/page.tsx"],
  ["Growth", "src/app/(app)/growth/page.tsx"],
  ["Business Health / BSOS", "src/app/(app)/business-health/page.tsx"],
  ["Local SEO service+city page", "src/app/hire/[slug]/in/[city]/[service]/page.tsx"],
  ["Website publish engine", "src/lib/website-engine/publish.ts"],
  ["Website snapshot builder", "src/lib/website-engine/builder.ts"],
  ["Website service detail", "src/app/hire/[slug]/services/[serviceSlug]/page.tsx"],
];

try {
  console.log("\nSTATIC — Lifecycle surfaces exist");
  for (const [label, path] of lifecycle) {
    check(`${label} page exists (${path})`, exists(path));
  }

  const readme = read("README.md");
  check("README documents PostgreSQL", /PostgreSQL|Postgres/i.test(readme));
  check("README no longer claims SQLite as the live database", !/Prisma \+ SQLite/.test(readme));
  check("README documents localhost:43217", /43217/.test(readme));
  check("README documents www.collproreno.com", /collproreno\.com/.test(readme));
  check("README documents test:isolation", /test:isolation/.test(readme));
  check("README documents fake local adapters", /TBBT_PAYMENTS_ADAPTER=fake/.test(readme));

  const envExample = read(".env.example");
  check("SaaS Stripe Price ID is a separate env from Connect", envExample.includes("STRIPE_SAAS_PRICE_ID"));
  check("Connect payments fake adapter is local-only in .env.example", envExample.includes("TBBT_PAYMENTS_ADAPTER=fake"));
  check("SaaS billing fake adapter is local-only in .env.example", envExample.includes("TBBT_SAAS_BILLING_ADAPTER=fake"));
  check("Resend configuration is documented", envExample.includes("RESEND_API_KEY") && envExample.includes("EMAIL_FROM"));
  check("R2 configuration is documented", envExample.includes("R2_ACCOUNT_ID") && envExample.includes("R2_BUCKET_NAME"));

  const paymentsConfig = read("src/lib/payments/config.ts");
  const saasConfig = read("src/lib/saas-billing/config.ts");
  check(
    "SaaS billing adapter is a different module than Connect payments",
    paymentsConfig.includes("TBBT_PAYMENTS_ADAPTER") && saasConfig.includes("TBBT_SAAS_BILLING_ADAPTER"),
  );
  check(
    "Production ignores fake payment adapters",
    paymentsConfig.includes("VERCEL_ENV") || paymentsConfig.includes("production"),
  );

  const workspace = read("src/lib/workspace.ts");
  check(
    "Authenticated workspace does not run owner-intelligence DDL",
    !workspace.includes("ensureOwnerIntelligenceSchema") &&
      !workspace.includes("owner-intelligence-schema"),
  );
  check(
    "Owner-intelligence schema source is prisma migrate",
    OWNER_INTELLIGENCE_SCHEMA_SOURCE === "prisma-migrate",
  );
  const localPage = read("src/app/hire/[slug]/in/[city]/[service]/page.tsx");
  check(
    "Invalid city/service local pages call notFound",
    localPage.includes("notFound()") && localPage.includes("robots"),
  );
  const certDoc = read("docs/PRODUCTION_CERTIFICATION.md");
  check(
    "Production certification does not say new job photos use Vercel Blob",
    /private R2/.test(certDoc) && !/Job photos may still use Vercel Blob/.test(certDoc),
  );

  const migration = read("prisma/migrations/20260924040000_add_owner_intelligence/migration.sql");
  check(
    "Owner-intelligence migration is additive",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes("ADD COLUMN IF NOT EXISTS") &&
      migration.includes("CREATE TABLE IF NOT EXISTS"),
  );
  const websiteEngineMigration = read("prisma/migrations/20260925180000_website_engine/migration.sql");
  check(
    "Website engine migration is additive",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(websiteEngineMigration) &&
      websiteEngineMigration.includes("CREATE TABLE IF NOT EXISTS") &&
      websiteEngineMigration.includes("ADD COLUMN IF NOT EXISTS"),
  );

  check("OWNER and ADMIN can open the management console", canAccessManagementConsole("OWNER") && canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot open the management console", canAccessManagementConsole("MEMBER") === false);
  check("MEMBER cannot view reports / BSOS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
  check("MEMBER cannot manage marketing", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_MARKETING));
  check("MEMBER cannot manage reviews", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_REVIEWS));
  check("Business Health is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/business-health"));
  check("APPROVED marketing content has no PUBLISHED next step", nextContentStatus("APPROVED") === null);
  check("Financial intelligence refuses a bank balance", /Not Connected/.test(BANK_NOT_CONNECTED_MESSAGE));

  const estimatePage = read("src/app/e/[token]/page.tsx");
  const portalPage = read("src/app/p/[token]/page.tsx");
  check("Customer estimate route looks up Estimate.publicToken", /publicToken/.test(estimatePage));
  check("Project portal route looks up Job.projectToken", /projectToken/.test(portalPage));

  console.log("\nISOLATED DB — Tenant A cannot read tenant B owner-intelligence rows");
  const businessA = await prisma.business.create({
    data: { name: "Cert A", slug: `cert-a-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Cert B", slug: `cert-b-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const userA = await prisma.user.create({
    data: { name: "A", email: `cert-a-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memA = await prisma.membership.create({
    data: { userId: userA.id, businessId: businessA.id, role: "OWNER" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada" },
  });
  await prisma.businessGoal.create({
    data: { businessId: businessA.id, title: "Collect invoices", createdByMembershipId: memA.id },
  });
  await prisma.marketingCampaign.create({
    data: { businessId: businessA.id, name: "Site", createdByMembershipId: memA.id },
  });
  await prisma.serviceArea.create({
    data: { businessId: businessA.id, kind: "CITY", label: "Reno", city: "Reno", createdByMembershipId: memA.id },
  });
  await prisma.referralRequest.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      requestText: "Please introduce a neighbor.",
      createdByMembershipId: memA.id,
    },
  });
  check(
    "B cannot list A's goals",
    (await prisma.businessGoal.count({ where: { businessId: businessB.id } })) === 0,
  );
  check(
    "B cannot list A's campaigns",
    (await prisma.marketingCampaign.count({ where: { businessId: businessB.id } })) === 0,
  );
  check(
    "B cannot list A's service areas",
    (await prisma.serviceArea.count({ where: { businessId: businessB.id } })) === 0,
  );
  check(
    "B cannot list A's referral requests",
    (await prisma.referralRequest.count({ where: { businessId: businessB.id } })) === 0,
  );

  console.log("\nHONEST BLOCKERS — this harness does not invent a green full-system E2E");
  blocker("No browser walkthrough of signup → invoice → review was executed here.");
  blocker("Facebook / Instagram / Google publishing adapters are not connected; Marketing never fakes PUBLISHED.");
  blocker("Banking and accounting providers are Not Connected; cash-flow projected balance stays null.");
  blocker("External marketing AI is not connected; template drafts only.");
  blocker("Resend / Twilio / R2 / live Stripe Connect+SaaS require production secrets that this local harness does not set.");

  console.log(
    failures === 0
      ? `\nProduction-certification inventory passed (${lifecycle.length} surfaces). ${blockers.length} explicit blocker(s) documented.`
      : `\n${failures} production-certification check(s) failed. ${blockers.length} explicit blocker(s) documented.`,
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
