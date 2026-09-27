/**
 * Automation Rules Owner Center proofs.
 *
 * Reuses the existing AutomationRule / AutomationRun engine. Does not add
 * schema, a second dispatcher, or owner manual execution.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-automation-owner-center.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, roleHasCapability } = await import("@/lib/authorization");
const { DEFAULT_AUTOMATION_RULES } = await import("@/lib/automation/types");
const { ensureDefaultAutomationRules } = await import("@/lib/automation/rules");
const {
  AUTOMATION_RUN_HISTORY_LIMIT,
  AUTOMATIONS_PATH,
  CONFIGURATION_RECORDED_LABEL,
  NO_RECORDED_AUTOMATION_RULES_MESSAGE,
  PROCESSOR_ONLY_UNSEEDED_PURPOSES,
  UNSUPPORTED_AUTOMATION_RULE_LABEL,
  UNSUPPORTED_RULE_TOGGLE_ERROR,
  automationPairKey,
  canManageAutomationCenter,
  isSupportedAutomationRule,
  listSupportedAutomationPairKeys,
  listSupportedAutomationPairs,
  loadAutomationOwnerCenter,
  projectAutomationRuleForOwner,
  projectSafeAutomationConfig,
  projectionTextContains,
  toggleOwnedAutomationRuleEnabled,
} = await import("@/lib/automations");
const { APP_NAV } = await import("@/lib/nav");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_automation_owner_center_test";
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
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
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

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Owner Center Co", timezone: "America/Los_Angeles" },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function snapshotRuns(runs) {
  return runs
    .map((run) => ({
      id: run.id,
      businessId: run.businessId,
      ruleId: run.ruleId,
      status: run.status,
      resultSummary: run.resultSummary,
      lastError: run.lastError,
      attemptCount: run.attemptCount,
      processedAt: run.processedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const registrySrc = readRepo("src/lib/automations/registry.ts");
const configSrc = readRepo("src/lib/automations/config.ts");
const centerSrc = readRepo("src/lib/automations/center.ts");
const toggleSrc = readRepo("src/lib/automations/toggle.ts");
const accessSrc = readRepo("src/lib/automations/access.ts");
const indexSrc = readRepo("src/lib/automations/index.ts");
const actionSrc = readRepo("src/app/actions/automations.ts");
const pageSrc = readRepo("src/app/(app)/automations/page.tsx");
const uiSrc = readRepo("src/components/automations/automation-center.tsx");
const toggleUiSrc = readRepo("src/components/automations/automation-rule-toggle.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const packageSrc = readRepo("package.json");
const existingActionSrc = readRepo("src/app/actions/automation.ts");
const processorSrc = readRepo("src/lib/automation/processor.ts");
const ownerLibSrc = [registrySrc, configSrc, centerSrc, toggleSrc, accessSrc, indexSrc].join("\n");
const ownerAppSrc = [actionSrc, pageSrc, uiSrc, toggleUiSrc].join("\n");

try {
  console.log("\nSTATIC — isolated owner center on the existing engine");
  check("Route is /automations", AUTOMATIONS_PATH === "/automations" && pageSrc.includes("AutomationsPage"));
  check(
    "Page uses management access and MANAGE_SETTINGS",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.includes("CAPABILITIES.MANAGE_SETTINGS") &&
      pageSrc.includes("requireBusinessCapability"),
  );
  check(
    "Shared nav was not given an Automations link",
    !APP_NAV.some((item) => item.href === "/automations") && !navSrc.includes('href: "/automations"'),
  );
  check("No npm script was invented for this check", !packageSrc.includes("check-automation-owner-center"));
  check(
    "Canonical toggle action is isolated and does not process runs",
    actionSrc.includes("toggleOwnedAutomationRuleEnabled") &&
      actionSrc.includes("requireOperatingBusinessAccess") &&
      !actionSrc.includes("processPendingAutomationRuns") &&
      !actionSrc.includes("processDueAutomationsAction") &&
      !actionSrc.includes("emitAndProcessBusinessEvent") &&
      !actionSrc.includes("queueAutomationRunsForEvent") &&
      !actionSrc.includes("businessId"),
  );
  check(
    "Toggle writes enabled only through id + businessId",
    toggleSrc.includes("updateMany") &&
      toggleSrc.includes("id: rule.id") &&
      toggleSrc.includes("businessId: access.businessId") &&
      toggleSrc.includes("updated.count !== 1") &&
      !toggleSrc.includes("processPendingAutomationRuns") &&
      !toggleSrc.includes("automationRun.create") &&
      !toggleSrc.includes("automationRun.update"),
  );
  check(
    "No owner manual execution was added",
    !ownerAppSrc.includes("Run now") &&
      !ownerAppSrc.includes("Test automation") &&
      !ownerAppSrc.includes("Replay") &&
      !ownerAppSrc.includes("Retry") &&
      !uiSrc.includes("processDueAutomationsAction"),
  );
  check(
    "No custom trigger/action builder was added",
    !ownerAppSrc.includes("Custom trigger") &&
      !ownerAppSrc.includes("Custom action") &&
      !ownerAppSrc.includes("free-form JSON") &&
      !toggleUiSrc.includes("name=\"eventType\"") &&
      !toggleUiSrc.includes("name=\"purpose\"") &&
      !actionSrc.includes("createAutomationRule"),
  );
  check(
    "Existing engine is reused, not copied",
    registrySrc.includes("DEFAULT_AUTOMATION_RULES") &&
      !centerSrc.includes("createMany") &&
      !centerSrc.includes("ensureDefaultAutomationRules") &&
      !toggleSrc.includes("applyCommunicationRule"),
  );
  check(
    "10/11. Page load does not initialize default rules",
    !centerSrc.includes("ensureDefaultAutomationRules") &&
      !pageSrc.includes("ensureDefaultAutomationRules") &&
      !actionSrc.includes("ensureDefaultAutomationRules") &&
      uiSrc.includes("NO_RECORDED_AUTOMATION_RULES_MESSAGE"),
  );
  check(
    "Supported classification requires canonical kind",
    registrySrc.includes("isSupportedAutomationRule") &&
      registrySrc.includes("definition.kind === rule.kind") &&
      toggleSrc.includes("isSupportedAutomationRule(rule)") &&
      centerSrc.includes("getSupportedAutomationRule(rule)"),
  );
  check(
    "No request-time DDL in owner-center files",
    !ownerLibSrc.includes("$executeRaw") &&
      !ownerLibSrc.includes("CREATE TABLE") &&
      !ownerLibSrc.includes("prisma migrate") &&
      !ownerLibSrc.includes("ensureAutomation") &&
      !ownerAppSrc.includes("$executeRaw") &&
      !ownerAppSrc.includes("CREATE TABLE"),
  );
  const automationRuleModel = schemaSrc.slice(
    schemaSrc.indexOf("model AutomationRule {"),
    schemaSrc.indexOf("model AutomationRun {"),
  );
  check(
    "Prisma schema was not given trigger/action/config columns",
    automationRuleModel.includes("eventType") &&
      automationRuleModel.includes("purpose") &&
      !/\btrigger\b/.test(automationRuleModel) &&
      !/\baction\b/.test(automationRuleModel) &&
      !/\bconfig\b/.test(automationRuleModel),
  );
  check(
    "Raw config is never rendered",
    !uiSrc.includes("JSON.stringify") &&
      !pageSrc.includes("JSON.stringify") &&
      !uiSrc.includes(".config.") &&
      !uiSrc.includes("webhookSecret") &&
      !uiSrc.includes("apiKey") &&
      !uiSrc.includes("messageBody") &&
      configSrc.includes("void extraConfig"),
  );

  const supportedKeys = listSupportedAutomationPairKeys();
  const defaultKeys = DEFAULT_AUTOMATION_RULES.map((rule) =>
    automationPairKey(rule.eventType, rule.purpose),
  );
  check(
    "12. Supported pairs are exactly the seeded runtime defaults",
    supportedKeys.join("|") === defaultKeys.join("|") &&
      supportedKeys.length === DEFAULT_AUTOMATION_RULES.length,
  );
  check(
    "9. Processor-only JOB_UPDATE is not listed as supported",
    PROCESSOR_ONLY_UNSEEDED_PURPOSES.includes("JOB_UPDATE") &&
      !supportedKeys.some((key) => key.endsWith(":JOB_UPDATE")) &&
      !isSupportedAutomationRule({
        eventType: "APPOINTMENT_SCHEDULED",
        purpose: "JOB_UPDATE",
        kind: "COMMUNICATION",
      }) &&
      processorSrc.includes('rule.purpose === "JOB_UPDATE"'),
  );
  check(
    "1. Canonical eventType + purpose + kind is supported",
    isSupportedAutomationRule({
      eventType: "ESTIMATE_SENT",
      purpose: "ESTIMATE_READY",
      kind: "COMMUNICATION",
    }) &&
      isSupportedAutomationRule({
        eventType: "JOB_COMPLETED",
        purpose: "JOB_FOLLOW_UP",
        kind: "ACTION_SUGGESTION",
      }),
  );
  check(
    "2. Correct pair with wrong kind is unsupported",
    !isSupportedAutomationRule({
      eventType: "ESTIMATE_SENT",
      purpose: "ESTIMATE_READY",
      kind: "ACTION_SUGGESTION",
    }) &&
      !isSupportedAutomationRule({
        eventType: "JOB_COMPLETED",
        purpose: "JOB_FOLLOW_UP",
        kind: "COMMUNICATION",
      }),
  );
  check(
    "Registry does not invent custom pairs",
    !supportedKeys.includes("CUSTOM:CUSTOM") &&
      listSupportedAutomationPairs().every((definition) =>
        DEFAULT_AUTOMATION_RULES.some(
          (rule) => rule.eventType === definition.eventType && rule.purpose === definition.purpose,
        ),
      ),
  );

  const ownerA = await prisma.user.create({
    data: { name: "A Owner", email: `a-auto-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminA = await prisma.user.create({
    data: { name: "A Admin", email: `a-admin-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberA = await prisma.user.create({
    data: { name: "A Member", email: `a-member-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "B Owner", email: `b-auto-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Center", slug: `alpha-center-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Center", slug: `beta-center-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminA.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberA.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });

  const accessOwnerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerA.id);
  const accessAdminA = makeAccess(businessA.id, "ADMIN", memAdminA.id, adminA.id);
  const accessMemberA = makeAccess(businessA.id, "MEMBER", memMemberA.id, memberA.id);
  const accessOwnerB = makeAccess(businessB.id, "OWNER", memOwnerB.id, ownerB.id);

  console.log("\nAUTH — owner / admin / member");
  check(
    "2. ADMIN matches canonical MANAGE_SETTINGS permission",
    roleHasCapability("ADMIN", CAPABILITIES.MANAGE_SETTINGS) &&
      canManageAutomationCenter(accessAdminA) &&
      canManageAutomationCenter(accessOwnerA) &&
      !canManageAutomationCenter(accessMemberA),
  );
  await expectError(
    "12. MEMBER cannot load office-wide automation management",
    () => loadAutomationOwnerCenter(prisma, accessMemberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "12. MEMBER cannot toggle rules",
    () =>
      toggleOwnedAutomationRuleEnabled(prisma, accessMemberA, {
        ruleId: "not-used",
        enabled: true,
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nREAD-ONLY LOAD — zero recorded rules");
  const emptyRuleCountBefore = await prisma.automationRule.count({ where: { businessId: businessA.id } });
  const emptyRunCountBefore = await prisma.automationRun.count({ where: { businessId: businessA.id } });
  const emptyCenter = await loadAutomationOwnerCenter(prisma, accessOwnerA);
  const emptyRuleCountAfter = await prisma.automationRule.count({ where: { businessId: businessA.id } });
  const emptyRunCountAfter = await prisma.automationRun.count({ where: { businessId: businessA.id } });
  const emptyCenterAgain = await loadAutomationOwnerCenter(prisma, accessOwnerA);
  const emptyRuleCountRepeat = await prisma.automationRule.count({ where: { businessId: businessA.id } });
  const emptyRunCountRepeat = await prisma.automationRun.count({ where: { businessId: businessA.id } });
  check(
    "1. Business with zero AutomationRule rows loads an empty center",
    emptyCenter.rules.length === 0 &&
      emptyRuleCountBefore === 0 &&
      NO_RECORDED_AUTOMATION_RULES_MESSAGE === "No automation rules are recorded for this business.",
  );
  check("10. Loading center creates zero AutomationRule rows", emptyRuleCountAfter === 0);
  check("11. Loading center creates zero AutomationRun rows", emptyRunCountAfter === emptyRunCountBefore);
  check(
    "Repeated center loads remain read-only",
    emptyCenterAgain.rules.length === 0 &&
      emptyRuleCountRepeat === 0 &&
      emptyRunCountRepeat === emptyRunCountBefore,
  );

  await ensureDefaultAutomationRules(prisma, businessA.id);
  await ensureDefaultAutomationRules(prisma, businessB.id);

  const centerA = await loadAutomationOwnerCenter(prisma, accessOwnerA);
  const centerB = await loadAutomationOwnerCenter(prisma, accessOwnerB);
  const centerAdmin = await loadAutomationOwnerCenter(prisma, accessAdminA);

  const seededRuleCount = await prisma.automationRule.count({ where: { businessId: businessA.id } });
  const seededRunCount = await prisma.automationRun.count({ where: { businessId: businessA.id } });
  await loadAutomationOwnerCenter(prisma, accessOwnerA);
  check(
    "5. Business with existing rules reads them normally",
    centerA.rules.length > 0 &&
      centerA.rules.every((rule) => !centerB.rules.some((other) => other.id === rule.id)) &&
      centerA.businessId === businessA.id &&
      (await prisma.automationRule.count({ where: { businessId: businessA.id } })) === seededRuleCount &&
      (await prisma.automationRun.count({ where: { businessId: businessA.id } })) === seededRunCount,
  );
  check(
    "2. ADMIN sees the same owned rule set as OWNER",
    centerAdmin.rules.map((rule) => rule.id).join(",") ===
      centerA.rules.map((rule) => rule.id).join(","),
  );

  const disabledSupported = await prisma.automationRule.findFirst({
    where: {
      businessId: businessA.id,
      eventType: "ESTIMATE_SENT",
      purpose: "ESTIMATE_READY",
    },
  });
  const enabledSupported = await prisma.automationRule.findFirst({
    where: {
      businessId: businessA.id,
      eventType: "REVIEW_OPPORTUNITY_CREATED",
      purpose: "REVIEW_REQUEST",
    },
  });
  const foreignSupported = await prisma.automationRule.findFirst({
    where: {
      businessId: businessB.id,
      eventType: "ESTIMATE_SENT",
      purpose: "ESTIMATE_READY",
    },
  });
  const reminderSupported = await prisma.automationRule.findFirst({
    where: {
      businessId: businessA.id,
      eventType: "APPOINTMENT_SCHEDULED",
      purpose: "APPOINTMENT_REMINDER",
    },
  });
  check("Seeded supported rules exist for toggle proofs", Boolean(disabledSupported && enabledSupported && foreignSupported && reminderSupported));
  check("Seeded disabled supported rule starts disabled", disabledSupported?.enabled === false);
  check("Seeded enabled supported rule starts enabled", enabledSupported?.enabled === true);

  const customizedChannel = await prisma.automationRule.update({
    where: { id: disabledSupported.id },
    data: { channel: "EMAIL" },
  });
  const customizedDelay = await prisma.automationRule.update({
    where: { id: reminderSupported.id },
    data: { delayMinutes: 180 },
  });

  const businessKind = await prisma.business.create({
    data: { name: "Kind Center", slug: `kind-center-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const memKind = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessKind.id, role: "OWNER" },
  });
  const accessKind = makeAccess(businessKind.id, "OWNER", memKind.id, ownerA.id);
  const wrongKindEstimate = await prisma.automationRule.create({
    data: {
      businessId: businessKind.id,
      eventType: "ESTIMATE_SENT",
      purpose: "ESTIMATE_READY",
      kind: "ACTION_SUGGESTION",
      channel: "SMS",
      delayMinutes: 0,
      templateKey: "estimate-ready",
      enabled: false,
    },
  });
  const wrongKindJob = await prisma.automationRule.create({
    data: {
      businessId: businessKind.id,
      eventType: "JOB_COMPLETED",
      purpose: "JOB_FOLLOW_UP",
      kind: "COMMUNICATION",
      channel: "NONE",
      delayMinutes: 0,
      templateKey: "job-follow-up-opportunity",
      enabled: false,
    },
  });

  const plantedSecret = `planted-webhook-secret-${randomUUID()}`;
  const unknownRule = await prisma.automationRule.create({
    data: {
      businessId: businessA.id,
      eventType: "LEGACY_UNKNOWN_TRIGGER",
      purpose: "LEGACY_UNKNOWN_ACTION",
      kind: "COMMUNICATION",
      channel: "SMS",
      delayMinutes: 0,
      templateKey: "legacy-unknown",
      enabled: false,
    },
  });
  const foreignUnknown = await prisma.automationRule.create({
    data: {
      businessId: businessB.id,
      eventType: "FOREIGN_UNKNOWN_TRIGGER",
      purpose: "FOREIGN_UNKNOWN_ACTION",
      kind: "COMMUNICATION",
      channel: "SMS",
      delayMinutes: 0,
      templateKey: "foreign-unknown",
      enabled: false,
    },
  });

  const eventA = await prisma.businessEvent.create({
    data: {
      businessId: businessA.id,
      type: "ESTIMATE_SENT",
      subjectType: "ESTIMATE",
      subjectId: `estimate-${randomUUID()}`,
      idempotencyKey: `evt-a-${randomUUID()}`,
    },
  });
  const eventB = await prisma.businessEvent.create({
    data: {
      businessId: businessB.id,
      type: "ESTIMATE_SENT",
      subjectType: "ESTIMATE",
      subjectId: `estimate-${randomUUID()}`,
      idempotencyKey: `evt-b-${randomUUID()}`,
    },
  });

  const olderRuns = [];
  for (let i = 0; i < 11; i += 1) {
    olderRuns.push(
      await prisma.automationRun.create({
        data: {
          businessId: businessA.id,
          eventId: eventA.id,
          ruleId: disabledSupported.id,
          kind: "COMMUNICATION",
          status: "SKIPPED",
          resultSummary: `older-run-${i}`,
          attemptCount: 1,
          idempotencyKey: `run-old-${i}-${randomUUID()}`,
          createdAt: new Date(Date.now() - (i + 1) * 60_000),
        },
      }),
    );
  }
  const lastRun = await prisma.automationRun.create({
    data: {
      businessId: businessA.id,
      eventId: eventA.id,
      ruleId: disabledSupported.id,
      kind: "COMMUNICATION",
      status: "FAILED",
      resultSummary: "planted-last-run-result",
      lastError: "planted-last-run-error",
      attemptCount: 2,
      idempotencyKey: `run-last-${randomUUID()}`,
      processedAt: new Date(),
    },
  });
  const foreignRun = await prisma.automationRun.create({
    data: {
      businessId: businessB.id,
      eventId: eventB.id,
      ruleId: foreignSupported.id,
      kind: "COMMUNICATION",
      status: "SUCCEEDED",
      resultSummary: "foreign-run-must-not-leak",
      attemptCount: 1,
      idempotencyKey: `run-b-${randomUUID()}`,
    },
  });

  const beforeRuns = snapshotRuns(
    await prisma.automationRun.findMany({ where: { businessId: { in: [businessA.id, businessB.id] } } }),
  );
  const beforeRunCount = beforeRuns.length;

  console.log("\nTOGGLE — supported, unsupported, foreign, no execution");
  await expectError(
    "13. Foreign rule cannot be toggled",
    () =>
      toggleOwnedAutomationRuleEnabled(prisma, accessOwnerA, {
        ruleId: foreignSupported.id,
        enabled: true,
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );
  const foreignStill = await prisma.automationRule.findUnique({ where: { id: foreignSupported.id } });
  check("13. Foreign rule stayed unchanged", foreignStill.enabled === false);

  const enabled = await toggleOwnedAutomationRuleEnabled(prisma, accessOwnerA, {
    ruleId: disabledSupported.id,
    enabled: true,
  });
  check("5. Supported disabled rule can enable", enabled.enabled === true);

  const disabled = await toggleOwnedAutomationRuleEnabled(prisma, accessAdminA, {
    ruleId: enabledSupported.id,
    enabled: false,
  });
  check("6. ADMIN can disable a supported enabled rule", disabled.enabled === false);

  const afterToggleRuns = snapshotRuns(
    await prisma.automationRun.findMany({ where: { businessId: { in: [businessA.id, businessB.id] } } }),
  );
  check("7. Toggle does not run automation / import processor", !toggleSrc.includes("@/lib/automation/processor"));
  check("8. Toggle does not create AutomationRun", afterToggleRuns.length === beforeRunCount);
  check("9. Prior runs remain unchanged", JSON.stringify(afterToggleRuns) === JSON.stringify(beforeRuns));

  await expectError(
    "8. Unknown trigger/action rule cannot be enabled from this UI",
    () =>
      toggleOwnedAutomationRuleEnabled(prisma, accessOwnerA, {
        ruleId: unknownRule.id,
        enabled: true,
      }),
    (error) => error instanceof Error && error.message === UNSUPPORTED_RULE_TOGGLE_ERROR,
  );
  const unknownStill = await prisma.automationRule.findUnique({ where: { id: unknownRule.id } });
  check("8. Unknown rule stayed disabled", unknownStill.enabled === false);

  const afterUnknownToggleRuns = await prisma.automationRun.count({
    where: { businessId: { in: [businessA.id, businessB.id] } },
  });
  check("Unknown toggle still created no runs", afterUnknownToggleRuns === beforeRunCount);

  const kindCenter = await loadAutomationOwnerCenter(prisma, accessKind);
  const wrongEstimateProjection = kindCenter.rules.find((rule) => rule.id === wrongKindEstimate.id);
  const wrongJobProjection = kindCenter.rules.find((rule) => rule.id === wrongKindJob.id);
  check(
    "2. Wrong-kind recorded rows are unsupported and not reinterpreted",
    wrongEstimateProjection?.supported === false &&
      wrongEstimateProjection.canToggle === false &&
      wrongEstimateProjection.label === UNSUPPORTED_AUTOMATION_RULE_LABEL &&
      !wrongEstimateProjection.sentence.startsWith("When ") &&
      wrongJobProjection?.supported === false &&
      wrongJobProjection.canToggle === false &&
      wrongJobProjection.label === UNSUPPORTED_AUTOMATION_RULE_LABEL,
  );
  await expectError(
    "3. Wrong-kind row cannot be enabled",
    () =>
      toggleOwnedAutomationRuleEnabled(prisma, accessKind, {
        ruleId: wrongKindEstimate.id,
        enabled: true,
      }),
    (error) => error instanceof Error && error.message === UNSUPPORTED_RULE_TOGGLE_ERROR,
  );
  const wrongKindStill = await prisma.automationRule.findUnique({ where: { id: wrongKindEstimate.id } });
  check("4. Wrong-kind row remains unchanged after failed toggle", wrongKindStill.enabled === false && wrongKindStill.kind === "ACTION_SUGGESTION");

  const customizedCenter = await loadAutomationOwnerCenter(prisma, accessOwnerA);
  const customizedChannelProjection = customizedCenter.rules.find((rule) => rule.id === customizedChannel.id);
  const customizedDelayProjection = customizedCenter.rules.find((rule) => rule.id === customizedDelay.id);
  check(
    "6. Customized channel does not make a canonical rule unsupported",
    customizedChannelProjection?.supported === true &&
      customizedChannelProjection.canToggle === true &&
      customizedChannel.channel === "EMAIL",
  );
  check(
    "7. Customized delay does not make a canonical rule unsupported",
    customizedDelayProjection?.supported === true &&
      customizedDelayProjection.canToggle === true &&
      customizedDelay.delayMinutes === 180,
  );

  console.log("\nPROJECTION — labels, secrets, last-run truth, isolation");
  const reloaded = await loadAutomationOwnerCenter(prisma, accessOwnerA, {
    ruleId: disabledSupported.id,
  });
  const unknownProjection = reloaded.rules.find((rule) => rule.id === unknownRule.id);
  const supportedProjection = reloaded.rules.find((rule) => rule.id === disabledSupported.id);
  const foreignOnA = reloaded.rules.find((rule) => rule.id === foreignUnknown.id);

  check(
    "11. Unknown rule is labeled truthfully, not reinterpreted",
    unknownProjection?.label === UNSUPPORTED_AUTOMATION_RULE_LABEL &&
      unknownProjection.supported === false &&
      unknownProjection.canToggle === false &&
      unknownProjection.recordedTrigger === "LEGACY_UNKNOWN_TRIGGER" &&
      unknownProjection.recordedAction === "LEGACY_UNKNOWN_ACTION" &&
      !unknownProjection.sentence.startsWith("When ") &&
      !unknownProjection.sentence.includes("TBBT queues") &&
      !unknownProjection.sentence.includes("TBBT records"),
  );
  check("1. Foreign unknown rule does not appear on owner A", !foreignOnA);
  check(
    "15. Last-run status comes from persisted AutomationRun",
    supportedProjection?.lastRun?.id === lastRun.id &&
      supportedProjection.lastRun.status === "FAILED" &&
      supportedProjection.lastRun.resultSummary === "planted-last-run-result" &&
      supportedProjection.lastRun.lastError === "planted-last-run-error" &&
      supportedProjection.lastRun.status !== "successful",
  );
  check(
    "16. Foreign run cannot leak into owner A center",
    !reloaded.rules.some((rule) => rule.lastRun?.id === foreignRun.id) &&
      !reloaded.selectedHistory.some((run) => run.id === foreignRun.id) &&
      !JSON.stringify(reloaded).includes("foreign-run-must-not-leak"),
  );
  check(
    "14. Run history is bounded",
    reloaded.selectedHistory.length === AUTOMATION_RUN_HISTORY_LIMIT &&
      AUTOMATION_RUN_HISTORY_LIMIT === 10 &&
      reloaded.selectedHistory[0].id === lastRun.id,
  );

  await expectError(
    "16. Foreign rule history fails closed",
    () => loadAutomationOwnerCenter(prisma, accessOwnerA, { ruleId: foreignSupported.id }),
    (error) =>
      error instanceof Error &&
      error.message === "Record is not in the authorized business workspace.",
  );

  const secretProjection = projectSafeAutomationConfig(
    { channel: "SMS", delayMinutes: 0, kind: "COMMUNICATION" },
    {
      webhookSecret: plantedSecret,
      apiKey: plantedSecret,
      token: plantedSecret,
      messageBody: plantedSecret,
      credentials: plantedSecret,
    },
  );
  const secretRuleProjection = projectAutomationRuleForOwner(
    {
      id: unknownRule.id,
      eventType: unknownRule.eventType,
      purpose: unknownRule.purpose,
      kind: unknownRule.kind,
      channel: unknownRule.channel,
      delayMinutes: unknownRule.delayMinutes,
      enabled: false,
      createdAt: unknownRule.createdAt,
      updatedAt: unknownRule.updatedAt,
      config: {
        webhookSecret: plantedSecret,
        apiKey: plantedSecret,
        token: plantedSecret,
        messageBody: plantedSecret,
      },
    },
    null,
    "America/Los_Angeles",
    { webhookSecret: plantedSecret },
  );
  check(
    "15. Planted secret is absent from config projection",
    !projectionTextContains(secretProjection, plantedSecret) &&
      !projectionTextContains(secretRuleProjection, plantedSecret) &&
      !JSON.stringify(secretRuleProjection.config).includes(plantedSecret) &&
      typeof secretRuleProjection.config.summary === "string" &&
      secretRuleProjection.config.summary.length > 0,
  );
  check(
    "13. Supported config uses whitelist labels, not raw JSON",
    supportedProjection.config.channelLabel === "Email" &&
      !JSON.stringify(supportedProjection.config).includes(plantedSecret) &&
      supportedProjection.config.summary !== "",
  );
  check(
    "Unsupported config stays non-secret",
    unknownProjection.config.summary.length > 0 &&
      (unknownProjection.config.summary === CONFIGURATION_RECORDED_LABEL ||
        unknownProjection.config.channelLabel === "Text message (SMS)"),
  );

  const existingActionStillProcesses = existingActionSrc.includes("processPendingAutomationRuns");
  check(
    "Existing automation action file was not rewritten into this center",
    existingActionStillProcesses && !existingActionSrc.includes("toggleOwnedAutomationRuleEnabled"),
  );

  console.log("\n16. No schema / request-time DDL");
  check("16. Owner-center libraries do not migrate", !ownerLibSrc.includes("db.push") && !ownerLibSrc.includes("migrate"));
  check("AutomationRule model still uses eventType/purpose", schemaSrc.includes("eventType") && schemaSrc.includes("purpose"));
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nAutomation owner center check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAutomation owner center check passed.");
