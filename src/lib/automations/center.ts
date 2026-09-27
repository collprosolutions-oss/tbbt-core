import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { formatDateTime } from "@/lib/format";
import { projectSafeAutomationConfig } from "@/lib/automations/config";
import { getSupportedAutomationRule } from "@/lib/automations/registry";
import { requireAutomationCenterAccess } from "@/lib/automations/access";
import {
  AUTOMATION_CENTER_DISCLAIMER,
  AUTOMATION_RUN_HISTORY_LIMIT,
  UNSUPPORTED_AUTOMATION_RULE_LABEL,
  type AutomationOwnerCenter,
  type AutomationRuleProjection,
  type AutomationRunProjection,
} from "@/lib/automations/types";

type Db = PrismaClient | Prisma.TransactionClient;

const AUTOMATION_RUN_SELECT = {
  id: true,
  status: true,
  resultSummary: true,
  lastError: true,
  attemptCount: true,
  availableAt: true,
  processedAt: true,
  createdAt: true,
  kind: true,
  ruleId: true,
  businessId: true,
} as const;

function timeZoneOf(access: BusinessAccess): string | undefined {
  return access.workspace.business?.timezone || undefined;
}

export function projectAutomationRun(
  run: {
    id: string;
    status: string;
    resultSummary: string | null;
    lastError: string | null;
    attemptCount: number;
    availableAt: Date;
    processedAt: Date | null;
    createdAt: Date;
    kind: string;
  },
  timeZone?: string,
): AutomationRunProjection {
  return {
    id: run.id,
    status: run.status,
    resultSummary: run.resultSummary,
    lastError: run.lastError,
    attemptCount: run.attemptCount,
    availableAt: formatDateTime(run.availableAt, timeZone),
    processedAt: run.processedAt ? formatDateTime(run.processedAt, timeZone) : null,
    createdAt: formatDateTime(run.createdAt, timeZone),
    kind: run.kind,
  };
}

export function projectAutomationRuleForOwner(
  rule: {
    id: string;
    eventType: string;
    purpose: string;
    kind: string;
    channel: string;
    delayMinutes: number;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
    config?: unknown;
  },
  lastRun: Parameters<typeof projectAutomationRun>[0] | null,
  timeZone?: string,
  extraConfig?: unknown,
): AutomationRuleProjection {
  const definition = getSupportedAutomationRule(rule);
  const supported = definition != null;
  const planted = extraConfig !== undefined ? extraConfig : rule.config;
  const config = projectSafeAutomationConfig(rule, planted);

  return {
    id: rule.id,
    supported,
    canToggle: supported,
    enabled: rule.enabled,
    label: supported && definition ? definition.sentence : UNSUPPORTED_AUTOMATION_RULE_LABEL,
    sentence:
      supported && definition
        ? definition.sentence
        : "This recorded rule is not a supported trigger/action pair and will not be reinterpreted.",
    triggerLabel: supported && definition ? definition.triggerLabel : UNSUPPORTED_AUTOMATION_RULE_LABEL,
    actionLabel:
      supported && definition ? definition.actionLabel : "Recorded action is unsupported",
    recordedTrigger: rule.eventType,
    recordedAction: rule.purpose,
    kind: rule.kind,
    createdAt: formatDateTime(rule.createdAt, timeZone),
    updatedAt: formatDateTime(rule.updatedAt, timeZone),
    config,
    configSummary: config.summary,
    lastRun: lastRun ? projectAutomationRun(lastRun, timeZone) : null,
  };
}

async function loadLatestRunByRuleId(
  db: Db,
  businessId: string,
  ruleId: string,
) {
  return db.automationRun.findFirst({
    where: { businessId, ruleId },
    orderBy: { createdAt: "desc" },
    select: AUTOMATION_RUN_SELECT,
  });
}

export async function loadAutomationRunHistory(
  db: Db,
  access: BusinessAccess,
  ruleId: string,
  limit = AUTOMATION_RUN_HISTORY_LIMIT,
) {
  requireAutomationCenterAccess(access);
  const owned = access.assertOwned(
    await db.automationRule.findFirst({
      where: { id: ruleId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
  );

  const runs = await db.automationRun.findMany({
    where: { businessId: access.businessId, ruleId: owned.id },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(limit, AUTOMATION_RUN_HISTORY_LIMIT)),
    select: AUTOMATION_RUN_SELECT,
  });

  return runs.map((run) => projectAutomationRun(run, timeZoneOf(access)));
}

export async function loadAutomationOwnerCenter(
  db: Db,
  access: BusinessAccess,
  input?: { ruleId?: string | null },
): Promise<AutomationOwnerCenter> {
  requireAutomationCenterAccess(access);

  const rules = await db.automationRule.findMany({
    where: { businessId: access.businessId },
    orderBy: [{ eventType: "asc" }, { purpose: "asc" }],
  });

  const selectedRuleId = input?.ruleId?.trim() || null;
  if (selectedRuleId && !rules.some((rule) => rule.id === selectedRuleId)) {
    access.assertOwned(null);
  }

  const latest = await Promise.all(
    rules.map((rule) => loadLatestRunByRuleId(db, access.businessId, rule.id)),
  );
  const timeZone = timeZoneOf(access);
  const projected = rules.map((rule, index) =>
    projectAutomationRuleForOwner(rule, latest[index], timeZone),
  );

  const selectedHistory = selectedRuleId
    ? await loadAutomationRunHistory(db, access, selectedRuleId)
    : [];

  return {
    businessId: access.businessId,
    disclaimer: AUTOMATION_CENTER_DISCLAIMER,
    rules: projected,
    selectedRuleId,
    selectedHistory,
    historyLimit: AUTOMATION_RUN_HISTORY_LIMIT,
  };
}
