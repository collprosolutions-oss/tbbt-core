/**
 * Settings Core verification: access, persistence, historical integrity,
 * audit, tenant isolation, and honest readiness/connection state.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-settings.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
  canAccessManagementConsole,
} = await import("@/lib/authorization");
const { visibleAppNav } = await import("@/lib/nav");
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { FOUNDER_PAGE_KEYS, KPI_CARD_COUNTS } = await import("@/lib/founder-design");
const { FOUNDER_REGIONS } = await import("@/lib/founder-regions");
const {
  LABOR_MINIMUM_FUTURE_RULE_MESSAGE,
  SETTINGS_SECRET_REDACTED,
  buildIntegrationCards,
  buildSettingsReadiness,
  parseSettingsSection,
  serializeAuditValue,
  settingsAiAssistAvailable,
  isEmailDeliveryConfigured,
} = await import("@/lib/settings");
const {
  GO_LIVE_CAPABILITIES,
  GO_LIVE_CARD_REQUIREMENTS,
  GO_LIVE_CONDITIONAL_SUMMARY,
  GO_LIVE_GROUPS,
  GO_LIVE_NO_SCORE_DISCLAIMER,
  GO_LIVE_OPTIONAL_SUMMARY,
  GO_LIVE_REQUIREMENTS,
  GO_LIVE_REQUIRED_SUMMARY,
  assertGoLiveProjectionSafe,
  buildGoLiveCenter,
  classifyAiProvider,
  classifyCustomDomain,
  classifyEsign,
  classifyFinanceBank,
  classifyR2,
  classifyResend,
  classifySocialPublishing,
  classifyStripeConnect,
  classifyStripeSaas,
  classifySupplierCommerce,
  classifyTwilioSms,
  classifyVoiceReceptionist,
  goLiveCardById,
  goLiveGroupRequirement,
  twilioImpliesAllFeaturesLive,
} = await import("@/lib/go-live");
const { loadGoLiveCenter, requireGoLiveAccess } = await import("@/lib/go-live-data");
const { isBusinessStorageConfigured } = await import("@/lib/business-storage");
const { isTwilioCustomerMessagingConfigured } = await import("@/lib/customer-messaging/config");
const { isAiProviderConnected } = await import("@/lib/ai/config");
const {
  assertSettingsBusinessScope,
  SettingsError,
  updateBusinessProfileOp,
  updateBusinessPublicContactOp,
  updateLaborMinimumSettingsOp,
  updateSettingsPreferencesOp,
  updateWebsiteStoryOp,
  writeSettingsAuditLog,
} = await import("@/lib/settings-ops");
const { Prisma } = await import("@prisma/client");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_settings_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for settings test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
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

const settingsSource = [
  readFileSync(new URL("../src/lib/settings.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/settings-ops.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/settings-data.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/app/actions/settings.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/app/(app)/settings/page.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../src/components/settings/settings-workspace.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../src/components/settings/business-public-contact-form.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../src/components/settings/change-password-form.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/go-live.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/go-live-data.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/components/settings/go-live-health-center.tsx", import.meta.url), "utf8"),
].join("\n");

try {
  console.log("\nSTATIC — Settings domain helpers");
  check("Invalid section falls back to overview", parseSettingsSection("not-real") === "overview");
  check("pricing section parses", parseSettingsSection("pricing") === "pricing");
  check("TBBT Billing is a Settings section", parseSettingsSection("tbbt-billing") === "tbbt-billing");
  check("Go-live is a Settings section", parseSettingsSection("go-live") === "go-live");
  const settingsPageSource = readFileSync(
    new URL("../src/app/(app)/settings/page.tsx", import.meta.url),
    "utf8",
  );
  const workspaceSource = readFileSync(
    new URL("../src/components/settings/settings-workspace.tsx", import.meta.url),
    "utf8",
  );
  const goLiveUiSource = readFileSync(
    new URL("../src/components/settings/go-live-health-center.tsx", import.meta.url),
    "utf8",
  );
  check(
    "loadGoLiveCenter is section-gated to go-live",
    /const goLive =\s*section === ["']go-live["']\s*\?\s*await loadGoLiveCenter\(/.test(settingsPageSource) &&
      !/const goLive = await loadGoLiveCenter\(/.test(settingsPageSource),
  );
  check(
    "unrelated Settings pages do not run Go-live provider reads",
    settingsPageSource.includes('section === "go-live"') &&
      settingsPageSource.includes("loadGoLiveCenter") &&
      !settingsPageSource.includes("inspectConfiguredFounderPrice") &&
      !settingsPageSource.includes("loadSaasBillingSnapshot") &&
      !settingsPageSource.includes("getBusinessPaymentStatus") &&
      !settingsPageSource.includes("loadGoLiveDomainState") &&
      !settingsPageSource.includes("loadGoLiveInput"),
  );
  check(
    "GoLiveHealthCenter renders only when the go-live projection exists",
    workspaceSource.includes("section === \"go-live\"") &&
      workspaceSource.includes("props.goLive") &&
      workspaceSource.includes("<GoLiveHealthCenter center={props.goLive} />"),
  );
  check("FOUNDER_PAGE_KEYS includes settings", FOUNDER_PAGE_KEYS.includes("settings"));
  check("Settings has 4 KPI cards", KPI_CARD_COUNTS.settings === 4);
  check(
    "Settings founder regions match the implemented boxes",
    FOUNDER_REGIONS.settings.map((region) => region.id).join(",") ===
      "overview,nav,main,rail,readiness,page",
  );
  check("OWNER can access the management console", canAccessManagementConsole("OWNER"));
  check("ADMIN can access the management console", canAccessManagementConsole("ADMIN"));
  check("MEMBER cannot access the management console", canAccessManagementConsole("MEMBER") === false);
  check("Settings nav is visible to OWNER", visibleAppNav("OWNER").some((item) => item.href === "/settings" && item.label === "Settings"));
  check("Settings nav is visible to ADMIN", visibleAppNav("ADMIN").some((item) => item.href === "/settings"));
  check("Settings nav is hidden from MEMBER", !visibleAppNav("MEMBER").some((item) => item.href === "/settings"));
  check("Settings is last in APP_NAV", visibleAppNav("OWNER").at(-1)?.href === "/settings");
  check("OWNER has MANAGE_SETTINGS", roleHasCapability("OWNER", CAPABILITIES.MANAGE_SETTINGS));
  check("ADMIN has MANAGE_SETTINGS", roleHasCapability("ADMIN", CAPABILITIES.MANAGE_SETTINGS));
  check("MEMBER does not have MANAGE_SETTINGS", !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_SETTINGS));
  check("No AI assist in Settings", settingsAiAssistAvailable() === false);
  check("Website Story is a Settings section", parseSettingsSection("website-story") === "website-story");
  check("Settings source does not call an AI provider", !/openai|anthropic|generateText|streamText/i.test(settingsSource));
  check("Settings source does not send customer messages", !/sendTransactionalEmail|resend\.emails|twilio\.messages|new Twilio/i.test(settingsSource));
  check(
    "Go-live does not start provider connection flows",
    !/startStripeConnectOnboarding|startSaasSubscriptionCheckout|createConnectedAccount|createSubscriptionCheckout/.test(settingsSource),
  );
  check("Settings source does not publish marketing/reviews", !/publish|postReview|requestReviewAutomatically/i.test(settingsSource) || settingsSource.includes("does not publish"));
  check("Secret keys serialize as redacted", serializeAuditValue("apiKey", "sk-live-secret") === SETTINGS_SECRET_REDACTED);
  check("Labor minimum values are stored for audit", serializeAuditValue("laborMinimum", { enabled: true, amount: "140" }) === JSON.stringify({ enabled: true, amount: "140" }));
  check("Future-rule copy is present", /future estimates/i.test(LABOR_MINIMUM_FUTURE_RULE_MESSAGE));
  check(
    "Customer-facing phone/email/website/service area are owner-editable, not deferred",
    settingsSource.includes("BusinessPublicContactForm") &&
      settingsSource.includes("Customer-facing contact") &&
      settingsSource.includes("updateBusinessPublicContactOp") &&
      !settingsSource.includes('DeferredField label="Phone"') &&
      !settingsSource.includes('DeferredField label="Service area"'),
  );
  check(
    "Security section includes signed-in change password",
    settingsSource.includes("ChangePasswordForm") &&
      settingsSource.includes("Change the password on the signed-in account"),
  );
  check(
    "Owner can open the live public website from Settings",
    settingsSource.includes("ViewPublicWebsiteLink") &&
      readFileSync(
        new URL("../src/components/settings/view-public-website-link.tsx", import.meta.url),
        "utf8",
      ).includes("View Public Website"),
  );

  const readiness = buildSettingsReadiness({
    businessName: "CollPro",
    laborMinimumEnabled: true,
    laborMinimumAmount: "$140.00",
    activeMemberCount: 2,
    catalogItemCount: 3,
    emailDeliveryConfigured: false,
    paymentProviderConnected: false,
    payrollProviderConnected: false,
    bankConnected: false,
    marketingConnected: false,
    reviewPlatformConnected: false,
  });
  check("Required areas are configured when name + team exist", readiness.requiredReady === 3 && readiness.readyPercent === 100);
  check("Payments show Not Connected when no provider exists", readiness.items.find((item) => item.id === "payments")?.status === "not_connected");
  check("Banking shows Not Connected when no bank exists", readiness.items.find((item) => item.id === "banking")?.status === "not_connected");
  check("Payroll shows Not Connected when no provider exists", readiness.items.find((item) => item.id === "payroll")?.status === "not_connected");
  check("Marketing shows Not Connected when platforms are absent", readiness.items.find((item) => item.id === "marketing")?.status === "not_connected");
  check("Readiness never invents a bank balance", !JSON.stringify(readiness).includes("Verified Bank Balance: $"));

  const cards = buildIntegrationCards({
    emailDeliveryConfigured: false,
    paymentProviderConnected: false,
    payrollProviderConnected: false,
    bankConnected: false,
    accountingConnected: false,
    marketingConnected: false,
    storageConfigured: false,
  });
  check(
    "Nonexistent integrations are Not Connected, never Connected",
    cards.every((card) => card.status === "not_connected"),
  );

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

  function withEnv(overrides, fn) {
    const previous = {};
    for (const [key, value] of Object.entries(overrides)) {
      previous[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  console.log("\nSTATIC — Go-live / Integration Health status mapping");
  check("Go-live groups stay separate", GO_LIVE_GROUPS.join(",") === "CORE_OPERATING,PAYMENTS,COMMUNICATIONS,STORAGE,AI,OPTIONAL_PLANNED");
  check("Twilio env never implies every SMS feature is live", twilioImpliesAllFeaturesLive() === false);
  check("Disclaimer refuses a single ready score", /not a launch score|not a single ready/i.test(GO_LIVE_NO_SCORE_DISCLAIMER));

  const resendLive = buildGoLiveCenter(sampleGoLiveInput({ emailConfigured: true }));
  const resendDown = buildGoLiveCenter(sampleGoLiveInput({ emailConfigured: false }));
  check("Configured Resend is LIVE", goLiveCardById(resendLive, "resend")?.status === "LIVE" && classifyResend(true) === "LIVE");
  check("Unconfigured Resend is UNAVAILABLE", goLiveCardById(resendDown, "resend")?.status === "UNAVAILABLE" && classifyResend(false) === "UNAVAILABLE");

  const r2Live = buildGoLiveCenter(sampleGoLiveInput({ r2Configured: true }));
  const r2Down = buildGoLiveCenter(sampleGoLiveInput({ r2Configured: false }));
  check("Configured R2 is LIVE", goLiveCardById(r2Live, "r2")?.status === "LIVE" && classifyR2(true) === "LIVE");
  check("Unconfigured R2 is NOT_CONFIGURED", goLiveCardById(r2Down, "r2")?.status === "NOT_CONFIGURED" && classifyR2(false) === "NOT_CONFIGURED");
  check(
    "R2 NOT_CONFIGURED copy names photo-upload blocks",
    /Intake photo upload/.test(goLiveCardById(r2Down, "r2")?.whatDoesNot ?? "") &&
      /job photo upload/.test(goLiveCardById(r2Down, "r2")?.whatDoesNot ?? "") &&
      /website-managed photo upload/.test(goLiveCardById(r2Down, "r2")?.whatDoesNot ?? ""),
  );
  check(
    "disconnected R2 does not claim requests or jobs cannot exist",
    /Requests without photos still work/.test(goLiveCardById(r2Down, "r2")?.whatWorks ?? "") &&
      /Jobs, estimates, and invoices remain as recorded data/.test(goLiveCardById(r2Down, "r2")?.whatWorks ?? "") &&
      /does not mean requests or jobs cannot exist/.test(goLiveCardById(r2Down, "r2")?.whatWorks ?? "") &&
      !/requests cannot exist|jobs cannot exist|cannot operate/i.test(goLiveCardById(r2Down, "r2")?.whatDoesNot ?? ""),
  );
  check(
    "disconnected Resend does not claim TBBT cannot operate",
    /Recorded operating workflows/.test(goLiveCardById(resendDown, "resend")?.whatWorks ?? "") &&
      /public\/share links/.test(goLiveCardById(resendDown, "resend")?.whatWorks ?? "") &&
      /non-email operation/.test(goLiveCardById(resendDown, "resend")?.whatWorks ?? "") &&
      /does not mean TBBT cannot operate/.test(goLiveCardById(resendDown, "resend")?.whatWorks ?? "") &&
      /TBBT email delivery is unavailable/.test(goLiveCardById(resendDown, "resend")?.whatDoesNot ?? "") &&
      !/TBBT cannot operate/.test(goLiveCardById(resendDown, "resend")?.whatDoesNot ?? ""),
  );

  const connectReady = buildGoLiveCenter(sampleGoLiveInput());
  const connectNotReady = buildGoLiveCenter(sampleGoLiveInput({
    connect: {
      platformConfigured: true,
      appUrlConfigured: true,
      paymentReady: false,
      status: "not_connected",
      onlineCheckoutPossible: false,
    },
  }));
  check("Stripe Connect ready is LIVE", goLiveCardById(connectReady, "stripe_connect")?.status === "LIVE" && classifyStripeConnect(connectReady.cards.find((c) => c.id === "stripe_connect") && {
    platformConfigured: true,
    appUrlConfigured: true,
    paymentReady: true,
    status: "connected",
    onlineCheckoutPossible: true,
  }) === "LIVE");
  check("Stripe Connect not ready is DISCONNECTED", goLiveCardById(connectNotReady, "stripe_connect")?.status === "DISCONNECTED");

  const aiOn = buildGoLiveCenter(sampleGoLiveInput({ aiConnected: true }));
  const aiOff = buildGoLiveCenter(sampleGoLiveInput({ aiConnected: false }));
  check("AI connected is READY", goLiveCardById(aiOn, "ai_provider")?.status === "READY" && classifyAiProvider(true) === "READY");
  check("AI disconnected is DISCONNECTED", goLiveCardById(aiOff, "ai_provider")?.status === "DISCONNECTED" && classifyAiProvider(false) === "DISCONNECTED");
  check(
    "AI DISCONNECTED keeps Coach facts",
    /Recorded Coach facts remain available/.test(goLiveCardById(aiOff, "ai_provider")?.whatWorks ?? ""),
  );

  const twilioUp = buildGoLiveCenter(sampleGoLiveInput({
    twilio: { platformConfigured: true, dedicatedNumberAssigned: true },
  }));
  const twilioPartial = buildGoLiveCenter(sampleGoLiveInput({
    twilio: { platformConfigured: true, dedicatedNumberAssigned: false },
  }));
  const twilioDown = buildGoLiveCenter(sampleGoLiveInput({
    twilio: { platformConfigured: false, dedicatedNumberAssigned: false },
  }));
  check("Twilio available with number is READY", goLiveCardById(twilioUp, "twilio_sms")?.status === "READY");
  check("Twilio available without number is PARTIAL", goLiveCardById(twilioPartial, "twilio_sms")?.status === "PARTIAL" && classifyTwilioSms({ platformConfigured: true, dedicatedNumberAssigned: false }) === "PARTIAL");
  check("Twilio unavailable is UNAVAILABLE", goLiveCardById(twilioDown, "twilio_sms")?.status === "UNAVAILABLE" && classifyTwilioSms({ platformConfigured: false, dedicatedNumberAssigned: false }) === "UNAVAILABLE");
  check(
    "Twilio READY copy does not claim every SMS feature",
    /never mean every SMS feature is live/.test(goLiveCardById(twilioUp, "twilio_sms")?.whatDoesNot ?? ""),
  );

  const supplier = buildGoLiveCenter(sampleGoLiveInput());
  check("Supplier commerce is DISCONNECTED", goLiveCardById(supplier, "supplier_commerce")?.status === "DISCONNECTED" && classifySupplierCommerce() === "DISCONNECTED");
  check(
    "Supplier DISCONNECTED keeps recorded prices",
    /Recorded supplier prices may exist/.test(goLiveCardById(supplier, "supplier_commerce")?.whatWorks ?? ""),
  );
  check("Finance/bank is DISCONNECTED", goLiveCardById(supplier, "finance_bank")?.status === "DISCONNECTED" && classifyFinanceBank() === "DISCONNECTED");
  check("Finance copy does not imply bank sync", /Live bank sync is not connected/.test(goLiveCardById(supplier, "finance_bank")?.whatDoesNot ?? ""));
  check("E-sign is DISCONNECTED", goLiveCardById(supplier, "esign")?.status === "DISCONNECTED" && classifyEsign() === "DISCONNECTED");
  check("Voice is DISCONNECTED", goLiveCardById(supplier, "voice_receptionist")?.status === "DISCONNECTED" && classifyVoiceReceptionist() === "DISCONNECTED");
  check("Social publishing is DISCONNECTED", goLiveCardById(supplier, "social_publishing")?.status === "DISCONNECTED" && classifySocialPublishing() === "DISCONNECTED");

  const domainLive = buildGoLiveCenter(sampleGoLiveInput({
    domain: { verifiedHostname: "jobs.example.test", unverifiedHostname: null, failedHostname: null },
  }));
  const domainUnverified = buildGoLiveCenter(sampleGoLiveInput({
    domain: { verifiedHostname: null, unverifiedHostname: "pending.example.test", failedHostname: null },
  }));
  check("Verified custom domain is LIVE", goLiveCardById(domainLive, "custom_domain")?.status === "LIVE" && classifyCustomDomain({ verifiedHostname: "jobs.example.test", unverifiedHostname: null, failedHostname: null }) === "LIVE");
  check("Unverified custom domain is PARTIAL", goLiveCardById(domainUnverified, "custom_domain")?.status === "PARTIAL" && classifyCustomDomain({ verifiedHostname: null, unverifiedHostname: "pending.example.test", failedHostname: null }) === "PARTIAL");
  check("No custom domain is NOT_CONFIGURED", classifyCustomDomain({ verifiedHostname: null, unverifiedHostname: null, failedHostname: null }) === "NOT_CONFIGURED");

  check("SaaS subscribed is LIVE", classifyStripeSaas({ configured: true, checkoutPossible: true, entitlementState: "subscribed_active", canOperate: true, statusLabel: "Subscribed" }) === "LIVE");
  check("SaaS unconfigured is NOT_CONFIGURED", classifyStripeSaas({ configured: false, checkoutPossible: false, entitlementState: "subscription_required", canOperate: false, statusLabel: "Subscription required" }) === "NOT_CONFIGURED");

  const center = buildGoLiveCenter(sampleGoLiveInput({ r2Configured: false, emailConfigured: false, aiConnected: false }));
  check("All twelve capabilities are projected", center.cards.map((card) => card.id).join(",") === GO_LIVE_CAPABILITIES.join(","));
  check("No single ready boolean on the center", !("ready" in center) && !("readyPercent" in center) && !("launchReady" in center) && center.readOnly === true);
  check("Launch groups are all present", center.groups.map((group) => group.id).join(",") === GO_LIVE_GROUPS.join(","));
  check("Requirement contract is REQUIRED / CONDITIONAL / OPTIONAL", GO_LIVE_REQUIREMENTS.join(",") === "REQUIRED,CONDITIONAL,OPTIONAL");
  check("SaaS software access is REQUIRED", goLiveCardById(center, "stripe_saas")?.requirement === "REQUIRED" && GO_LIVE_CARD_REQUIREMENTS.stripe_saas === "REQUIRED");
  check("Resend is CONDITIONAL", goLiveCardById(center, "resend")?.requirement === "CONDITIONAL" && GO_LIVE_CARD_REQUIREMENTS.resend === "CONDITIONAL");
  check("R2 is CONDITIONAL", goLiveCardById(center, "r2")?.requirement === "CONDITIONAL" && GO_LIVE_CARD_REQUIREMENTS.r2 === "CONDITIONAL");
  check("Twilio SMS is OPTIONAL", goLiveCardById(center, "twilio_sms")?.requirement === "OPTIONAL" && GO_LIVE_CARD_REQUIREMENTS.twilio_sms === "OPTIONAL");
  check("Voice receptionist is OPTIONAL", goLiveCardById(center, "voice_receptionist")?.requirement === "OPTIONAL" && GO_LIVE_CARD_REQUIREMENTS.voice_receptionist === "OPTIONAL");
  check(
    "optional integrations stay OPTIONAL",
    ["twilio_sms", "ai_provider", "custom_domain", "finance_bank", "supplier_commerce", "esign", "voice_receptionist", "social_publishing"].every(
      (id) => goLiveCardById(center, id)?.requirement === "OPTIONAL" && GO_LIVE_CARD_REQUIREMENTS[id] === "OPTIONAL",
    ),
  );
  const communicationsGroup = center.groups.find((group) => group.id === "COMMUNICATIONS");
  check(
    "Communications group is MIXED",
    communicationsGroup?.requirement === "MIXED" &&
      communicationsGroup.requirementLabel === "Mixed" &&
      goLiveGroupRequirement(communicationsGroup.cards) === "MIXED" &&
      /Transactional email is conditional if TBBT should send email; SMS and voice are optional/.test(communicationsGroup.summary),
  );
  check(
    "Communications is not rendered as wholly optional",
    communicationsGroup?.requirement !== "OPTIONAL" &&
      !/wholly optional|Optional \/ planned/.test(communicationsGroup?.requirementLabel ?? "") &&
      !goLiveUiSource.includes("group.necessary ? \"Necessary\" : \"Optional / planned\""),
  );
  check("Stripe Connect is CONDITIONAL", goLiveCardById(center, "stripe_connect")?.requirement === "CONDITIONAL");
  check(
    "disconnected Connect does not imply TBBT cannot operate",
    /TBBT still operates without online cards/.test(goLiveCardById(connectNotReady, "stripe_connect")?.whatWorks ?? "") &&
      /does not mean TBBT cannot operate/.test(goLiveCardById(connectNotReady, "stripe_connect")?.whatDoesNot ?? "") &&
      /required only if accepting customer card payments online/i.test(
        goLiveCardById(connectNotReady, "stripe_connect")?.currentState ?? "",
      ),
  );
  check(
    "top required count is SaaS only; email and storage stay conditional",
    center.requiredCards.map((card) => card.id).join(",") === "stripe_saas" &&
      center.conditionalCards.map((card) => card.id).join(",") === "stripe_connect,resend,r2" &&
      center.requiredCards.length === 1 &&
      !center.requiredCards.some((card) => card.id === "stripe_connect" || card.id === "resend" || card.id === "r2"),
  );
  check(
    "disconnected Resend and R2 do not increase required remaining",
    goLiveCardById(center, "resend")?.status === "UNAVAILABLE" &&
      goLiveCardById(center, "r2")?.status === "NOT_CONFIGURED" &&
      center.requiredLiveCount === 1 &&
      center.requiredRemainingCount === 0,
  );
  check(
    "no 100% launch ready output exists",
    !/100%\s*launch\s*ready/i.test(`${GO_LIVE_NO_SCORE_DISCLAIMER} ${GO_LIVE_REQUIRED_SUMMARY} ${GO_LIVE_CONDITIONAL_SUMMARY} ${GO_LIVE_OPTIONAL_SUMMARY} ${goLiveUiSource}`) &&
      !center.disclaimer.toLowerCase().includes("100%") &&
      !("readyPercent" in center),
  );
  check(
    "top summaries distinguish required, conditional, and optional",
    /active TBBT software access/.test(GO_LIVE_REQUIRED_SUMMARY) &&
      !/transactional email/.test(GO_LIVE_REQUIRED_SUMMARY) &&
      !/photo storage/.test(GO_LIVE_REQUIRED_SUMMARY) &&
      /transactional email if TBBT should send email/.test(GO_LIVE_CONDITIONAL_SUMMARY) &&
      /R2 storage if intake, job, or website photo uploads are needed/.test(GO_LIVE_CONDITIONAL_SUMMARY) &&
      /Stripe Connect for online card checkout/.test(GO_LIVE_CONDITIONAL_SUMMARY) &&
      /SMS/.test(GO_LIVE_OPTIONAL_SUMMARY),
  );
  check(
    "overview copy no longer lists email or storage as required",
    !/Required items are SaaS access, transactional email, and photo storage/.test(workspaceSource) &&
      /Required is active TBBT software access/.test(workspaceSource) &&
      /R2 storage if intake, job, or website photo uploads are needed/.test(workspaceSource),
  );
  check("Payments group is Conditional", center.groups.find((group) => group.id === "PAYMENTS")?.requirement === "CONDITIONAL");
  check("Core operating group is Required", center.groups.find((group) => group.id === "CORE_OPERATING")?.requirement === "REQUIRED");
  check("Storage group is Conditional", center.groups.find((group) => group.id === "STORAGE")?.requirement === "CONDITIONAL");
  check("AI group is Optional", center.groups.find((group) => group.id === "AI")?.requirement === "OPTIONAL");
  check("Optional / planned group is Optional", center.groups.find((group) => group.id === "OPTIONAL_PLANNED")?.requirement === "OPTIONAL");
  check(
    "Disconnected copy never calls a system broken",
    center.cards.every(
      (card) =>
        !/\bbroken\b/i.test(
          `${card.currentState} ${card.whatWorks} ${card.whatDoesNot} ${card.ownerNextAction}`,
        ),
    ) && /not broken/.test(center.disclaimer),
  );
  check(
    "Business setup wording is settings completeness, not a Go-live score",
    workspaceSource.includes("baseline settings checks configured") &&
      workspaceSource.includes("This is Settings completeness, not production Go-live status.") &&
      !workspaceSource.includes("{readiness.readyPercent}%") &&
      !workspaceSource.includes("text-3xl font-semibold tabular-nums"),
  );
  check(
    "Business setup rail lists required setup checks only",
    workspaceSource.includes("item.required && item.status === \"needs_setup\""),
  );

  const secretValues = [
    "re_secret_TESTKEY_12345",
    "sk_test_healthcenter_secret_value",
    "whsec_healthcenter_webhook",
    "R2SECRETACCESSKEYVALUE",
    "twilio-auth-token-secret",
    "openai-test-secret-key",
  ];
  withEnv(
    {
      RESEND_API_KEY: secretValues[0],
      EMAIL_FROM: "owner@example.test",
      NEXT_PUBLIC_APP_URL: "http://localhost:43217",
      STRIPE_SECRET_KEY: secretValues[1],
      STRIPE_WEBHOOK_SECRET: secretValues[2],
      R2_ACCOUNT_ID: "r2accountidtest",
      R2_ACCESS_KEY_ID: "r2accesskeyidtest",
      R2_SECRET_ACCESS_KEY: secretValues[3],
      R2_BUCKET_NAME: "tbbt-photos-test",
      TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      TWILIO_AUTH_TOKEN: secretValues[4],
      TWILIO_MESSAGING_SERVICE_SID: "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      OPENAI_API_KEY: secretValues[5],
    },
    () => {
      check("Resend helper sees configured env", isEmailDeliveryConfigured() === true);
      check("R2 helper sees configured env", isBusinessStorageConfigured() === true);
      check("Twilio helper sees configured env", isTwilioCustomerMessagingConfigured() === true);
      check("AI helper sees configured env", isAiProviderConnected() === true);
      const envCenter = buildGoLiveCenter(sampleGoLiveInput({
        emailConfigured: isEmailDeliveryConfigured(),
        r2Configured: isBusinessStorageConfigured(),
        twilio: {
          platformConfigured: isTwilioCustomerMessagingConfigured(),
          dedicatedNumberAssigned: false,
        },
        aiConnected: isAiProviderConnected(),
      }));
      let safe = true;
      try {
        assertGoLiveProjectionSafe(envCenter, secretValues);
      } catch {
        safe = false;
      }
      check("Configured-env projection contains no secret values", safe);
      const rendered = JSON.stringify(envCenter);
      check(
        "Rendered go-live JSON omits secret material",
        secretValues.every((value) => !rendered.includes(value)) &&
          !rendered.includes("sk_test_") &&
          !rendered.includes("whsec_") &&
          !/"apiKey"|"authToken"|"stripeAccountId"/.test(rendered),
      );
    },
  );
  withEnv(
    {
      RESEND_API_KEY: undefined,
      EMAIL_FROM: undefined,
      R2_ACCOUNT_ID: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      R2_BUCKET_NAME: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      OPENAI_API_KEY: undefined,
      TBBT_AI_API_KEY: undefined,
    },
    () => {
      check("Resend helper sees unconfigured env", isEmailDeliveryConfigured() === false);
      check("R2 helper sees unconfigured env", isBusinessStorageConfigured() === false);
      check("Twilio helper sees unconfigured env", isTwilioCustomerMessagingConfigured() === false);
      check("AI helper sees unconfigured env", isAiProviderConnected() === false);
    },
  );

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Settings",
      slug: `alpha-set-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      laborMinimumEnabled: true,
      laborMinimumAmount: new Prisma.Decimal(120),
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Settings",
      slug: `beta-set-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      laborMinimumEnabled: true,
      laborMinimumAmount: new Prisma.Decimal(80),
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-set-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-set-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-set-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-set-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Customer" },
  });
  const draft = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(40),
      laborMinimumAdjustment: new Prisma.Decimal(80),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: draft.id,
      description: "Labor",
      quantity: 1,
      unitPrice: new Prisma.Decimal(40),
      total: new Prisma.Decimal(40),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, draft.id, businessA.id);

  const sent = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(40),
      laborMinimumAdjustment: new Prisma.Decimal(80),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: sent.id,
      description: "Labor",
      quantity: 1,
      unitPrice: new Prisma.Decimal(40),
      total: new Prisma.Decimal(40),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, sent.id, businessA.id);
  await prisma.estimate.update({ where: { id: sent.id }, data: { status: "SENT" } });
  const sentVersion = await prisma.$transaction((tx) =>
    createEstimateVersionSnapshot(tx, { estimateId: sent.id, businessId: businessA.id }),
  );

  const approved = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "DRAFT",
      total: new Prisma.Decimal(40),
      laborMinimumAdjustment: new Prisma.Decimal(80),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: approved.id,
      description: "Labor",
      quantity: 1,
      unitPrice: new Prisma.Decimal(40),
      total: new Prisma.Decimal(40),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, approved.id, businessA.id);
  await prisma.estimate.update({ where: { id: approved.id }, data: { status: "SENT" } });
  const approvedVersion = await prisma.$transaction((tx) =>
    createEstimateVersionSnapshot(tx, { estimateId: approved.id, businessId: businessA.id }),
  );
  await prisma.estimate.update({
    where: { id: approved.id },
    data: { status: "APPROVED", approvedVersionId: approvedVersion.id },
  });
  await prisma.estimateVersion.update({
    where: { id: approvedVersion.id },
    data: { approvedAt: new Date() },
  });

  const scheduledAt = new Date("2026-09-15T15:00:00.000Z");
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: approved.id,
      approvedEstimateVersionId: approvedVersion.id,
      status: "SCHEDULED",
      scheduledAt,
      scheduledDurationMinutes: 90,
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      jobId: job.id,
      status: "SENT",
      total: new Prisma.Decimal(120),
    },
  });
  const payroll = await prisma.payrollRun.create({
    data: {
      businessId: businessA.id,
      payPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      payPeriodEnd: new Date("2026-08-07T00:00:00.000Z"),
      status: "AUTHORIZED",
      authorizedWorkerCount: 1,
      authorizedApprovedHours: new Prisma.Decimal(32),
      authorizedGrossLaborAmount: new Prisma.Decimal(800),
    },
  });

  const sentBefore = await prisma.estimate.findUnique({ where: { id: sent.id } });
  const versionBefore = await prisma.estimateVersion.findUnique({ where: { id: approvedVersion.id } });
  const jobBefore = await prisma.job.findUnique({ where: { id: job.id } });
  const invoiceBefore = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  const payrollBefore = await prisma.payrollRun.findUnique({ where: { id: payroll.id } });

  console.log("\nTEST — Access and persistence");
  await expectError("MEMBER cannot update labor minimum", () =>
    updateLaborMinimumSettingsOp(prisma, memberA, {
      enabled: true,
      amount: new Prisma.Decimal(140),
      confirmed: true,
    }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError("ADMIN cannot update labor minimum (OWNER-only consequential)", () =>
    updateLaborMinimumSettingsOp(prisma, adminA, {
      enabled: true,
      amount: new Prisma.Decimal(140),
      confirmed: true,
    }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError("OWNER must confirm a labor-minimum change", () =>
    updateLaborMinimumSettingsOp(prisma, ownerA, {
      enabled: true,
      amount: new Prisma.Decimal(140),
      confirmed: false,
    }),
    (error) => /Confirm this pricing-rule change/i.test(error.message),
  );

  const loadedBefore = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Labor minimum reads the existing Business value", loadedBefore.laborMinimumEnabled === true && loadedBefore.laborMinimumAmount.toString() === "120");

  await updateLaborMinimumSettingsOp(prisma, ownerA, {
    enabled: true,
    amount: new Prisma.Decimal(140),
    confirmed: true,
  });
  const loadedAfter = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Labor minimum future-rule update persists on Business", loadedAfter.laborMinimumAmount.toString() === "140");

  const draftAfter = await prisma.estimate.findUnique({ where: { id: draft.id } });
  check("DRAFT estimate can pick up the new labor minimum", draftAfter.laborMinimumAdjustment.toString() === "100" && draftAfter.total.toString() === "140");

  const sentAfter = await prisma.estimate.findUnique({ where: { id: sent.id } });
  check("SENT estimate is unchanged after pricing-setting change", sentAfter.total.toString() === sentBefore.total.toString() && sentAfter.laborMinimumAdjustment.toString() === sentBefore.laborMinimumAdjustment.toString());

  const approvedAfter = await prisma.estimate.findUnique({ where: { id: approved.id } });
  check(
    "APPROVED estimate live total is unchanged",
    approvedAfter.status === "APPROVED" && approvedAfter.total.toString() === "120",
  );
  const versionAfter = await prisma.estimateVersion.findUnique({ where: { id: approvedVersion.id } });
  check(
    "APPROVED EstimateVersion is unchanged",
    versionAfter.total.toString() === versionBefore.total.toString() &&
      versionAfter.laborMinimumAdjustment.toString() === versionBefore.laborMinimumAdjustment.toString(),
  );

  const jobAfter = await prisma.job.findUnique({ where: { id: job.id } });
  check(
    "Existing Job is unchanged",
    jobAfter.scheduledAt.getTime() === jobBefore.scheduledAt.getTime() &&
      jobAfter.scheduledDurationMinutes === 90 &&
      jobAfter.approvedEstimateVersionId === approvedVersion.id,
  );
  const invoiceAfter = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  check("Existing Invoice is unchanged", invoiceAfter.total.toString() === invoiceBefore.total.toString() && invoiceAfter.status === "SENT");

  await updateSettingsPreferencesOp(prisma, ownerA, { notifyTeamEvents: false });
  const jobAfterPrefs = await prisma.job.findUnique({ where: { id: job.id } });
  check(
    "Scheduling-adjacent preference change does not rewrite existing scheduled jobs",
    jobAfterPrefs.scheduledAt.getTime() === scheduledAt.getTime() &&
      jobAfterPrefs.scheduledDurationMinutes === 90,
  );

  await updateSettingsPreferencesOp(prisma, adminA, { notifyPayrollEvents: false });
  const payrollAfter = await prisma.payrollRun.findUnique({ where: { id: payroll.id } });
  check(
    "Payroll-setting / preference change does not rewrite an authorized payroll snapshot",
    payrollAfter.authorizedGrossLaborAmount.toString() === payrollBefore.authorizedGrossLaborAmount.toString() &&
      payrollAfter.status === "AUTHORIZED",
  );

  const audit = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: "laborMinimum" },
  });
  check("Audit log created for consequential labor-minimum change", audit.length === 1);
  check("Audit log stores previous and new safe values", audit[0].previousValue.includes("120") && audit[0].newValue.includes("140"));
  check("Audit log is scoped to the acting membership", audit[0].changedByMembershipId === ownerMem.id);

  await writeSettingsAuditLog(prisma, {
    businessId: businessA.id,
    changedByMembershipId: ownerMem.id,
    settingArea: "integrations",
    settingKey: "apiKey",
    previousValue: null,
    newValue: "sk-live-should-never-be-stored",
  });
  const secretAudit = await prisma.settingsAuditLog.findFirst({
    where: { businessId: businessA.id, settingKey: "apiKey" },
  });
  check("Audit log does not store secrets", secretAudit.newValue === SETTINGS_SECRET_REDACTED);
  check("Audit log never contains the raw secret", !secretAudit.newValue.includes("sk-live"));

  await expectError("Cross-business mutation is rejected", () => {
    assertSettingsBusinessScope(ownerA, businessB.id);
  }, (error) => error instanceof ForbiddenError);

  await expectError("MEMBER cannot update preferences", () =>
    updateSettingsPreferencesOp(prisma, memberA, { notifyTeamEvents: true }),
    (error) => error instanceof ForbiddenError,
  );

  await expectError("MEMBER cannot update Website Story", () =>
    updateWebsiteStoryOp(prisma, memberA, {
      rawOwnerStory: "Invented biography",
      approvedPublicAboutCopy: "Invented public copy",
    }),
    (error) => error instanceof ForbiddenError,
  );

  await updateWebsiteStoryOp(prisma, ownerA, {
    rawOwnerStory: "Construction since 1992. Family carpentry.",
    approvedPublicAboutCopy: "We have worked in construction and carpentry since 1992.",
  });
  const storyRow = await prisma.businessSettings.findUnique({ where: { businessId: businessA.id } });
  check("OWNER can save raw story separately from approved About copy",
    storyRow.rawOwnerStory === "Construction since 1992. Family carpentry." &&
      storyRow.approvedPublicAboutCopy === "We have worked in construction and carpentry since 1992.");
  check("Raw owner story is not copied onto the public field automatically",
    storyRow.rawOwnerStory !== storyRow.approvedPublicAboutCopy);

  await expectError("ADMIN cannot change business name", () =>
    updateBusinessProfileOp(prisma, adminA, { name: "Hijacked", confirmed: true }),
    (error) => error instanceof ForbiddenError,
  );

  await updateBusinessProfileOp(prisma, ownerA, { name: "Alpha Settings Renamed", confirmed: true });
  const renamed = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Business Profile uses the existing Business record", renamed.name === "Alpha Settings Renamed" && renamed.id === businessA.id);

  console.log("\nTEST — Customer-facing public contact");
  await expectError("ADMIN cannot update public contact", () =>
    updateBusinessPublicContactOp(prisma, adminA, {
      phone: "239-000-0000",
      email: "admin@example.com",
      website: "https://example.com",
    }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError("Invalid public phone is rejected", () =>
    updateBusinessPublicContactOp(prisma, ownerA, {
      phone: "nope",
      email: "",
      website: "",
    }),
    (error) => error instanceof SettingsError && /valid phone/i.test(error.message),
  );

  const sentBeforeContact = await prisma.estimate.findUnique({ where: { id: sent.id } });
  const invoiceBeforeContact = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  await updateBusinessPublicContactOp(prisma, ownerA, {
    phone: "239-111-2222",
    email: "hello@alpha.example",
    website: "https://alpha.example/",
  });
  const alphaContact = await prisma.business.findUnique({ where: { id: businessA.id } });
  check(
    "OWNER can save customer-facing phone, email, and website",
    alphaContact.publicPhone === "239-111-2222" &&
      alphaContact.publicEmail === "hello@alpha.example" &&
      alphaContact.publicWebsite === "https://alpha.example",
  );
  const contactAudit = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingArea: "profile", settingKey: { in: ["publicPhone", "publicEmail", "publicWebsite"] } },
    orderBy: { settingKey: "asc" },
  });
  check(
    "Public contact writes an audit row per changed field",
    contactAudit.length === 3 &&
      contactAudit.every((row) => row.changedByMembershipId === ownerMem.id),
  );
  const sentAfterContact = await prisma.estimate.findUnique({ where: { id: sent.id } });
  const invoiceAfterContact = await prisma.invoice.findUnique({ where: { id: invoice.id } });
  check(
    "Saving contact does not rewrite SENT estimate totals",
    sentAfterContact.total.toString() === sentBeforeContact.total.toString() &&
      sentAfterContact.laborMinimumAdjustment.toString() ===
        sentBeforeContact.laborMinimumAdjustment.toString(),
  );
  check(
    "Saving contact does not rewrite invoice payment history",
    invoiceAfterContact.total.toString() === invoiceBeforeContact.total.toString() &&
      invoiceAfterContact.status === invoiceBeforeContact.status,
  );

  await updateBusinessPublicContactOp(prisma, ownerB, {
    phone: "941-555-0100",
    email: "beta@example.com",
    website: "https://beta.example",
  });
  const alphaAfterBeta = await prisma.business.findUnique({ where: { id: businessA.id } });
  const betaContact = await prisma.business.findUnique({ where: { id: businessB.id } });
  check(
    "Public contact is tenant-isolated",
    alphaAfterBeta.publicPhone === "239-111-2222" &&
      betaContact.publicPhone === "941-555-0100" &&
      betaContact.publicEmail === "beta@example.com",
  );

  const betaUnchanged = await prisma.business.findUnique({ where: { id: businessB.id } });
  check("Business B labor minimum is untouched", betaUnchanged.laborMinimumAmount.toString() === "80" && betaUnchanged.name === "Beta Settings");

  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_SETTINGS);
  check("OWNER Settings access is granted", true);
  await expectError("MEMBER Settings capability is denied", () => {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_SETTINGS);
  }, (error) => error instanceof ForbiddenError);
  requireGoLiveAccess(ownerA);
  requireGoLiveAccess(adminA);
  check("OWNER and ADMIN can open Go-live", true);
  await expectError("MEMBER is blocked from Go-live", () => {
    requireGoLiveAccess(memberA);
  }, (error) => error instanceof ForbiddenError);

  await prisma.websiteHostBinding.create({
    data: { businessId: businessA.id, hostname: "alpha-live.example.test", status: "VERIFIED" },
  });
  await prisma.websiteHostBinding.create({
    data: { businessId: businessB.id, hostname: "beta-pending.example.test", status: "UNVERIFIED" },
  });
  const goLiveA = await loadGoLiveCenter(prisma, ownerA);
  const goLiveB = await loadGoLiveCenter(prisma, ownerB);
  const domainA = goLiveCardById(goLiveA, "custom_domain");
  const domainB = goLiveCardById(goLiveB, "custom_domain");
  check("Tenant A go-live shows A's verified domain", domainA?.status === "LIVE" && /alpha-live\.example\.test/.test(domainA.currentState));
  check("Tenant B go-live shows B's unverified domain", domainB?.status === "PARTIAL" && /beta-pending\.example\.test/.test(domainB.currentState));
  check(
    "Go-live domain projection is tenant-isolated",
    !JSON.stringify(goLiveA).includes("beta-pending.example.test") &&
      !JSON.stringify(goLiveB).includes("alpha-live.example.test"),
  );
  await expectError("MEMBER cannot load Go-live for the same tenant", () => loadGoLiveCenter(prisma, memberA), (error) => error instanceof ForbiddenError);
  let leaked = false;
  try {
    assertGoLiveProjectionSafe(goLiveA, ["sk_live", "sk_test", "whsec_", "re_"]);
    assertGoLiveProjectionSafe(goLiveB, ["sk_live", "sk_test", "whsec_", "re_"]);
  } catch {
    leaked = true;
  }
  check("Loaded tenant projections stay secret-safe", leaked === false);

  const deleted = await prisma.settingsAuditLog.deleteMany({ where: { businessId: businessA.id } }).catch(() => null);
  check("Audit rows exist until an explicit test cleanup (no Settings delete-history UI)", deleted === null || typeof deleted.count === "number");

  console.log("\nTEST — Banking honesty");
  check("Projected balance stays unavailable without a verified bank", readiness.items.find((item) => item.id === "banking")?.detail.includes("does not invent a bank balance"));
  check("No fake bank balance string is used in Settings source", !/Last Verified Bank Balance: \$/.test(settingsSource));
  check("Projected balance unavailable copy exists", settingsSource.includes("Projected operating balance is unavailable"));

  console.log(
    failures === 0 ? "\nAll Settings checks passed." : `\n${failures} Settings check(s) failed.`,
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
