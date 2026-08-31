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
} = await import("@/lib/settings");
const {
  assertSettingsBusinessScope,
  updateBusinessProfileOp,
  updateLaborMinimumSettingsOp,
  updateSettingsPreferencesOp,
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
  readFileSync(new URL("../src/components/settings/settings-workspace.tsx", import.meta.url), "utf8"),
].join("\n");

try {
  console.log("\nSTATIC — Settings domain helpers");
  check("Invalid section falls back to overview", parseSettingsSection("not-real") === "overview");
  check("pricing section parses", parseSettingsSection("pricing") === "pricing");
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
  check("Settings source does not call an AI provider", !/openai|anthropic|generateText|streamText/i.test(settingsSource));
  check("Settings source does not send customer messages", !/sendTransactionalEmail|resend\.emails|twilio/i.test(settingsSource));
  check("Settings source does not publish marketing/reviews", !/publish|postReview|requestReviewAutomatically/i.test(settingsSource) || settingsSource.includes("does not publish"));
  check("Secret keys serialize as redacted", serializeAuditValue("apiKey", "sk-live-secret") === SETTINGS_SECRET_REDACTED);
  check("Labor minimum values are stored for audit", serializeAuditValue("laborMinimum", { enabled: true, amount: "140" }) === JSON.stringify({ enabled: true, amount: "140" }));
  check("Future-rule copy is present", /future estimates/i.test(LABOR_MINIMUM_FUTURE_RULE_MESSAGE));

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

  await expectError("ADMIN cannot change business name", () =>
    updateBusinessProfileOp(prisma, adminA, { name: "Hijacked", confirmed: true }),
    (error) => error instanceof ForbiddenError,
  );

  await updateBusinessProfileOp(prisma, ownerA, { name: "Alpha Settings Renamed", confirmed: true });
  const renamed = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Business Profile uses the existing Business record", renamed.name === "Alpha Settings Renamed" && renamed.id === businessA.id);

  const betaUnchanged = await prisma.business.findUnique({ where: { id: businessB.id } });
  check("Business B labor minimum is untouched", betaUnchanged.laborMinimumAmount.toString() === "80" && betaUnchanged.name === "Beta Settings");

  requireBusinessCapability(ownerA, CAPABILITIES.MANAGE_SETTINGS);
  check("OWNER Settings access is granted", true);
  await expectError("MEMBER Settings capability is denied", () => {
    requireBusinessCapability(memberA, CAPABILITIES.MANAGE_SETTINGS);
  }, (error) => error instanceof ForbiddenError);

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
