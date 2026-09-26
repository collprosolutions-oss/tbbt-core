/**
 * Integration Center proofs: supported registry only, Go-live status reuse,
 * secret safety, tenant isolation, entitlement honesty, and no provider
 * mutations.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-integration-center.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const {
  assertGoLiveProjectionSafe,
  buildGoLiveCenter,
  classifyCustomDomain,
  classifyR2,
  classifyResend,
  classifyStripeConnect,
  classifyTwilioSms,
  goLiveCardById,
} = await import("@/lib/go-live");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog/codes");
const { getPlanDefinition, resolvePlanCapabilities } = await import(
  "@/lib/product-catalog/plans"
);
const {
  INTEGRATION_CENTER_PATH,
  INTEGRATION_REGISTRY,
  UNSUPPORTED_INTEGRATIONS,
  assertRegistryUsesGoLiveCapabilities,
  buildIntegrationCenter,
  composeIntegrationRegistry,
  integrationCenterWithFutureProvider,
  listSupportedIntegrationKeys,
  loadIntegrationCenter,
  requireIntegrationCenterAccess,
} = await import("@/lib/integrations");

const libSource = [
  readFileSync(new URL("../src/lib/integrations/types.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/integrations/registry.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/integrations/center.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/integrations/data.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/integrations/index.ts", import.meta.url), "utf8"),
].join("\n");
const pageSource = readFileSync(
  new URL("../src/app/(app)/integrations/page.tsx", import.meta.url),
  "utf8",
);
const uiSource = readFileSync(
  new URL("../src/components/integrations/integration-center.tsx", import.meta.url),
  "utf8",
);
const navSource = readFileSync(new URL("../src/lib/nav.ts", import.meta.url), "utf8");
const goLiveSource = readFileSync(new URL("../src/lib/go-live.ts", import.meta.url), "utf8");

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

function sampleGoLiveInput({ saas, connect, twilio, domain, ...rest } = {}) {
  return {
    saas: {
      configured: true,
      checkoutPossible: true,
      entitlementState: "subscribed_active",
      canOperate: true,
      statusLabel: "Subscribed",
      ...saas,
    },
    connect: {
      platformConfigured: true,
      appUrlConfigured: true,
      paymentReady: true,
      status: "connected",
      onlineCheckoutPossible: true,
      ...connect,
    },
    emailConfigured: true,
    r2Configured: true,
    twilio: { platformConfigured: false, dedicatedNumberAssigned: false, ...twilio },
    aiConnected: false,
    domain: {
      verifiedHostname: null,
      unverifiedHostname: null,
      failedHostname: null,
      ...domain,
    },
    ...rest,
  };
}

function sampleEntitlement(businessId, extras = []) {
  const plan = getPlanDefinition("FOUNDER");
  return {
    businessId,
    planCode: plan.code,
    planName: plan.displayName,
    capabilities: [...resolvePlanCapabilities("FOUNDER"), ...extras],
  };
}

function makeAccess(businessId, role) {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId },
    },
  };
}

console.log("\nSTATIC — supported registry and ownership");
assertRegistryUsesGoLiveCapabilities();
check("Registry helper accepts the live registry", true);
check(
  "Supported keys are the real first-party integrations",
  listSupportedIntegrationKeys().join(",") ===
    "stripe_saas,stripe_connect,resend,r2,twilio_sms,custom_domain,ai_provider",
);
check(
  "Unsupported marketplace placeholders stay out of the live registry",
  UNSUPPORTED_INTEGRATIONS.every(
    (item) => !listSupportedIntegrationKeys().includes(item.key),
  ),
);
check(
  "Calendar / live accounting / bank / e-sign / supplier commerce / voice / social are excluded",
  [
    "google_calendar",
    "finance_bank",
    "accounting_connection",
    "supplier_commerce",
    "esign",
    "voice_receptionist",
    "social_publishing",
  ].every((key) => UNSUPPORTED_INTEGRATIONS.some((item) => item.key === key)),
);
check(
  "Optional integrations keep the Go-live OPTIONAL requirement",
  INTEGRATION_REGISTRY.filter((item) =>
    ["twilio_sms", "custom_domain", "ai_provider"].includes(item.key),
  ).every((item) => item.requirement === "OPTIONAL"),
);
check(
  "Conditional integrations are not labeled required",
  INTEGRATION_REGISTRY.filter((item) =>
    ["stripe_connect", "resend", "r2"].includes(item.key),
  ).every((item) => item.requirement === "CONDITIONAL"),
);
check(
  "SaaS billing stays REQUIRED",
  INTEGRATION_REGISTRY.find((item) => item.key === "stripe_saas")?.requirement === "REQUIRED",
);
check("Owner route is /integrations", INTEGRATION_CENTER_PATH === "/integrations");
check(
  "Global nav is unchanged",
  !navSource.includes("/integrations") && navSource.includes('href: "/settings"'),
);
check(
  "Page is management-gated before the loader",
  pageSource.includes("requireManagementPageAccess") &&
    pageSource.includes("loadIntegrationCenter") &&
    pageSource.indexOf("requireManagementPageAccess") <
      pageSource.indexOf("loadIntegrationCenter"),
);
check(
  "Page does not accept a browser-supplied businessId",
  !pageSource.includes("searchParams") && !pageSource.includes("businessId"),
);
check(
  "UI iterates projected categories instead of hardcoding providers",
  uiSource.includes("center.categories.map") &&
    uiSource.includes("category.items.map") &&
    !uiSource.includes("stripe_connect") &&
    !uiSource.includes("twilio_sms") &&
    !uiSource.includes("google_calendar"),
);
check(
  "Loader reuses loadGoLiveCenter and does not re-classify",
  libSource.includes("loadGoLiveCenter") &&
    libSource.includes("goLiveCardById") &&
    !/function classify/.test(libSource),
);
check(
  "Go-live health engine stays the single classifier source",
  /export function classifyStripeConnect/.test(goLiveSource) &&
    !libSource.includes("export function classifyStripeConnect"),
);
check(
  "No provider mutation APIs in Integration Center files",
  !/accounts\.create|webhookEndpoints|domains\.create|incomingPhoneNumbers|startStripeConnectOnboarding|oauth|createCheckoutSession/.test(
    `${libSource}\n${pageSource}\n${uiSource}`,
  ) &&
    !pageSource.includes("use server") &&
    !uiSource.includes("use server"),
);
check(
  "Secrets are not logged or rendered as fields",
  !/console\.(log|info|debug|error)\(.*?(SECRET|TOKEN|API_KEY|password)/i.test(
    `${libSource}\n${pageSource}\n${uiSource}`,
  ) &&
    !/stripeAccountId|authToken|secretAccessKey|STRIPE_SECRET_KEY|RESEND_API_KEY/.test(
      `${pageSource}\n${uiSource}`,
    ),
);

console.log("\nUNIT — status comes from canonical Go-live truth");
const businessId = "biz_alpha_center";
const goLive = buildGoLiveCenter(sampleGoLiveInput());
const center = buildIntegrationCenter({
  businessId,
  goLive,
  entitlement: sampleEntitlement(businessId),
});
check("Center is read-only", center.readOnly === true);
check(
  "Only supported integrations appear",
  center.items.map((item) => item.key).join(",") === listSupportedIntegrationKeys().join(","),
);
check(
  "Unsupported go-live placeholders are omitted",
  !center.items.some((item) =>
    ["finance_bank", "supplier_commerce", "esign", "voice_receptionist", "social_publishing"].includes(
      item.key,
    ),
  ),
);
for (const item of center.items) {
  const health = goLiveCardById(goLive, item.key);
  check(
    `${item.key} status matches Go-live ${health.status}`,
    item.status === health.status &&
      item.currentState === health.currentState &&
      item.statusLabel !== "Connected",
  );
}

const missing = buildIntegrationCenter({
  businessId,
  goLive: buildGoLiveCenter(
    sampleGoLiveInput({
      emailConfigured: false,
      r2Configured: false,
      connect: {
        platformConfigured: false,
        appUrlConfigured: false,
        paymentReady: false,
        status: "not_connected",
        onlineCheckoutPossible: false,
      },
    }),
  ),
  entitlement: sampleEntitlement(businessId),
});
const resendMissing = missing.items.find((item) => item.key === "resend");
const r2Missing = missing.items.find((item) => item.key === "r2");
const connectMissing = missing.items.find((item) => item.key === "stripe_connect");
check(
  "Missing Resend config is UNAVAILABLE, not Connected",
  resendMissing.status === "UNAVAILABLE" &&
    classifyResend(false) === "UNAVAILABLE" &&
    resendMissing.statusLabel === "Unavailable",
);
check(
  "Missing R2 config is NOT_CONFIGURED",
  r2Missing.status === "NOT_CONFIGURED" &&
    classifyR2(false) === "NOT_CONFIGURED" &&
    r2Missing.statusLabel === "Not configured",
);
check(
  "Stripe platform env alone does not mark Connect live",
  connectMissing.status === "NOT_CONFIGURED" &&
    classifyStripeConnect({
      platformConfigured: false,
      appUrlConfigured: false,
      paymentReady: false,
      status: "not_connected",
      onlineCheckoutPossible: false,
    }) === "NOT_CONFIGURED",
);
check(
  "Optional SMS is not labeled required when unavailable",
  missing.items.find((item) => item.key === "twilio_sms")?.requirement === "OPTIONAL" &&
    missing.items.find((item) => item.key === "twilio_sms")?.requirementLabel === "Optional" &&
    classifyTwilioSms({ platformConfigured: false, dedicatedNumberAssigned: false }) ===
      "UNAVAILABLE",
);

const envOnlyConnect = buildIntegrationCenter({
  businessId,
  goLive: buildGoLiveCenter(
    sampleGoLiveInput({
      connect: {
        platformConfigured: true,
        appUrlConfigured: true,
        paymentReady: false,
        status: "not_connected",
        onlineCheckoutPossible: false,
      },
    }),
  ),
  entitlement: sampleEntitlement(businessId),
});
check(
  "Connect env without merchant proof stays DISCONNECTED",
  envOnlyConnect.items.find((item) => item.key === "stripe_connect")?.status === "DISCONNECTED",
);

const domainLive = buildIntegrationCenter({
  businessId,
  goLive: buildGoLiveCenter(
    sampleGoLiveInput({
      domain: {
        verifiedHostname: "alpha-live.example.test",
        unverifiedHostname: null,
        failedHostname: null,
      },
    }),
  ),
  entitlement: sampleEntitlement(businessId),
});
const domainOther = buildIntegrationCenter({
  businessId: "biz_beta_center",
  goLive: buildGoLiveCenter(
    sampleGoLiveInput({
      domain: {
        verifiedHostname: null,
        unverifiedHostname: "beta-pending.example.test",
        failedHostname: null,
      },
    }),
  ),
  entitlement: sampleEntitlement("biz_beta_center"),
});
check(
  "Verified domain status is the Go-live LIVE classifier",
  domainLive.items.find((item) => item.key === "custom_domain")?.status === "LIVE" &&
    classifyCustomDomain({
      verifiedHostname: "alpha-live.example.test",
      unverifiedHostname: null,
      failedHostname: null,
    }) === "LIVE",
);
check(
  "Tenant A projection does not include tenant B hostname",
  JSON.stringify(domainLive).includes("alpha-live.example.test") &&
    !JSON.stringify(domainLive).includes("beta-pending.example.test") &&
    domainLive.businessId === businessId,
);
check(
  "Tenant B projection does not include tenant A hostname",
  JSON.stringify(domainOther).includes("beta-pending.example.test") &&
    !JSON.stringify(domainOther).includes("alpha-live.example.test") &&
    domainOther.businessId === "biz_beta_center",
);

console.log("\nUNIT — product entitlement truth is preserved");
const entitled = buildIntegrationCenter({
  businessId,
  goLive,
  entitlement: sampleEntitlement(businessId),
});
const sms = entitled.items.find((item) => item.key === "twilio_sms");
const website = entitled.items.find((item) => item.key === "custom_domain");
const ai = entitled.items.find((item) => item.key === "ai_provider");
check(
  "Founder includes Website Builder and not SMS Messaging",
  website.entitlement?.entitled === true &&
    website.entitlement?.capability === PRODUCT_CAPABILITIES.WEBSITE_BUILDER &&
    sms.entitlement?.entitled === false &&
    sms.entitlement?.capability === PRODUCT_CAPABILITIES.SMS_MESSAGING,
);
check(
  "AI Business Coach stays not included on Founder",
  ai.entitlement?.entitled === false &&
    ai.entitlement?.capability === PRODUCT_CAPABILITIES.AI_BUSINESS_COACH,
);
check(
  "SMS status is still Go-live status when the add-on is absent",
  sms.status === goLiveCardById(goLive, "twilio_sms")?.status,
);
const smsGranted = buildIntegrationCenter({
  businessId,
  goLive,
  entitlement: sampleEntitlement(businessId, [PRODUCT_CAPABILITIES.SMS_MESSAGING]),
});
check(
  "Granting SMS_MESSAGING flips entitlement without inventing a live connection",
  smsGranted.items.find((item) => item.key === "twilio_sms")?.entitlement?.entitled === true &&
    smsGranted.items.find((item) => item.key === "twilio_sms")?.status === sms.status,
);
check(
  "Integrations without a product capability omit entitlement chrome",
  entitled.items.find((item) => item.key === "resend")?.entitlement === null &&
    entitled.items.find((item) => item.key === "stripe_connect")?.entitlement === null,
);

console.log("\nUNIT — future provider registers without a page redesign");
const future = {
  key: "future_catalog_partner",
  displayName: "Future catalog partner",
  category: "Materials/Suppliers",
  requirement: "OPTIONAL",
  goLiveCapabilityId: "supplier_commerce",
  description: "Future partner add-on. Billing and commissions are not built.",
  settingsHref: "/settings?section=vendors",
};
const expanded = integrationCenterWithFutureProvider(
  { businessId, goLive, entitlement: sampleEntitlement(businessId) },
  future,
);
check(
  "Composed registry can add a future provider",
  composeIntegrationRegistry([future]).some((item) => item.key === "future_catalog_partner"),
);
check(
  "Projected center includes the future provider under a new category",
  expanded.items.some((item) => item.key === "future_catalog_partner") &&
    expanded.categories.some(
      (category) =>
        category.id === "Materials/Suppliers" &&
        category.items.some((item) => item.key === "future_catalog_partner"),
    ),
);
check(
  "Future provider still uses the existing Go-live classifier",
  expanded.items.find((item) => item.key === "future_catalog_partner")?.status ===
    goLiveCardById(goLive, "supplier_commerce")?.status,
);
check(
  "Page and UI do not need a new hardcoded card for the future provider",
  !pageSource.includes("future_catalog_partner") &&
    !uiSource.includes("future_catalog_partner") &&
    !uiSource.includes("Materials/Suppliers"),
);

const secretValues = [
  "re_secret_TESTKEY_12345",
  "sk_test_healthcenter_secret_value",
  "whsec_healthcenter_webhook",
  "acct_foreignleak123",
];
let secretSafe = true;
try {
  assertGoLiveProjectionSafe(center, secretValues);
  assertGoLiveProjectionSafe(expanded, secretValues);
} catch {
  secretSafe = false;
}
check("Projected center is secret-safe", secretSafe);
check(
  "Rendered JSON omits secret-looking material",
  secretValues.every((value) => !JSON.stringify(center).includes(value)) &&
    !/"apiKey"|"authToken"|"stripeAccountId"|"secretAccessKey"/.test(JSON.stringify(center)),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run Integration Center tenant proofs.");
  process.exit(1);
}

const testDbName = "tbbt_integration_center_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for Integration Center test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — tenant isolation and management access");
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Integrations",
      slug: `alpha-int-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Integrations",
      slug: `beta-int-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.websiteHostBinding.create({
    data: {
      businessId: businessA.id,
      hostname: "alpha-int.example.test",
      status: "VERIFIED",
    },
  });
  await prisma.websiteHostBinding.create({
    data: {
      businessId: businessB.id,
      hostname: "beta-int.example.test",
      status: "UNVERIFIED",
    },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessA.id,
      provider: "stripe",
      stripeAccountId: "acct_alpha_secret_999",
    },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessB.id,
      provider: "stripe",
      stripeAccountId: "acct_beta_secret_888",
    },
  });

  const ownerA = makeAccess(businessA.id, "OWNER");
  const adminA = makeAccess(businessA.id, "ADMIN");
  const memberA = makeAccess(businessA.id, "MEMBER");
  const ownerB = makeAccess(businessB.id, "OWNER");
  const mismatched = {
    businessId: businessA.id,
    workspace: { role: "OWNER", business: { id: businessB.id } },
  };

  requireIntegrationCenterAccess(ownerA);
  requireIntegrationCenterAccess(adminA);
  check("OWNER and ADMIN can open Integration Center", true);
  await expectError(
    "MEMBER is blocked from Integration Center",
    () => requireIntegrationCenterAccess(memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Mismatched workspace business cannot load Integration Center",
    () => loadIntegrationCenter(prisma, mismatched),
    (error) => error instanceof ForbiddenError,
  );

  const loadedA = await loadIntegrationCenter(prisma, ownerA);
  const loadedB = await loadIntegrationCenter(prisma, ownerB);
  check("Loaded A is scoped to business A", loadedA.businessId === businessA.id);
  check("Loaded B is scoped to business B", loadedB.businessId === businessB.id);
  check(
    "A shows only A's verified host",
    loadedA.items.find((item) => item.key === "custom_domain")?.status === "LIVE" &&
      JSON.stringify(loadedA).includes("alpha-int.example.test") &&
      !JSON.stringify(loadedA).includes("beta-int.example.test") &&
      !JSON.stringify(loadedA).includes(businessB.id),
  );
  check(
    "B shows only B's unverified host",
    loadedB.items.find((item) => item.key === "custom_domain")?.status === "PARTIAL" &&
      JSON.stringify(loadedB).includes("beta-int.example.test") &&
      !JSON.stringify(loadedB).includes("alpha-int.example.test") &&
      !JSON.stringify(loadedB).includes(businessA.id),
  );
  check(
    "Foreign Stripe account IDs never appear",
    !JSON.stringify(loadedA).includes("acct_alpha_secret_999") &&
      !JSON.stringify(loadedA).includes("acct_beta_secret_888") &&
      !JSON.stringify(loadedB).includes("acct_alpha_secret_999") &&
      !JSON.stringify(loadedB).includes("acct_beta_secret_888"),
  );
  await expectError(
    "MEMBER cannot load Integration Center for the same tenant",
    () => loadIntegrationCenter(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  let loadedSafe = true;
  try {
    assertGoLiveProjectionSafe(loadedA, [
      "acct_alpha_secret_999",
      "acct_beta_secret_888",
      "sk_live",
      "whsec_",
    ]);
    assertGoLiveProjectionSafe(loadedB, [
      "acct_alpha_secret_999",
      "acct_beta_secret_888",
      "sk_live",
      "whsec_",
    ]);
  } catch {
    loadedSafe = false;
  }
  check("Loaded tenant projections stay secret-safe", loadedSafe);
  check(
    "Loading the page projection does not create payment or host rows",
    (await prisma.businessPaymentAccount.count()) === 2 &&
      (await prisma.websiteHostBinding.count()) === 2,
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

console.log(
  failures === 0
    ? "\nAll Integration Center checks passed."
    : `\n${failures} Integration Center check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
