import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { DEFAULT_AUTOMATION_RULES, type AutomationChannel } from "@/lib/automation/types";

type Db = PrismaClient | Prisma.TransactionClient;

export async function ensureDefaultAutomationRules(db: Db, businessId: string) {
  const existing = await db.automationRule.findMany({
    where: { businessId },
    select: { eventType: true, purpose: true },
  });
  const have = new Set(existing.map((row) => `${row.eventType}:${row.purpose}`));
  const missing = DEFAULT_AUTOMATION_RULES.filter(
    (rule) => !have.has(`${rule.eventType}:${rule.purpose}`),
  );
  if (missing.length === 0) {
    return db.automationRule.findMany({
      where: { businessId },
      orderBy: [{ eventType: "asc" }, { purpose: "asc" }],
    });
  }
  await db.automationRule.createMany({
    data: missing.map((rule) => ({
      businessId,
      eventType: rule.eventType,
      purpose: rule.purpose,
      kind: rule.kind,
      channel: rule.channel,
      delayMinutes: rule.delayMinutes,
      templateKey: rule.templateKey,
      enabled: rule.enabled,
    })),
    skipDuplicates: true,
  });
  return db.automationRule.findMany({
    where: { businessId },
    orderBy: [{ eventType: "asc" }, { purpose: "asc" }],
  });
}

export async function updateAutomationRule(
  db: Db,
  access: BusinessAccess,
  input: {
    ruleId: string;
    enabled?: boolean;
    channel?: string;
    delayMinutes?: number;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const rule = access.assertOwned(
    await db.automationRule.findFirst({
      where: { id: input.ruleId, ...access.scope },
    }),
  );
  const channel = rule.kind === "ACTION_SUGGESTION" ? "NONE" : input.channel;
  if (
    channel &&
    channel !== "EMAIL" &&
    channel !== "SMS" &&
    channel !== "BOTH" &&
    channel !== "NONE"
  ) {
    throw new Error("Choose a valid automation channel.");
  }
  return db.automationRule.update({
    where: { id: rule.id },
    data: {
      enabled: input.enabled ?? rule.enabled,
      channel: (channel as AutomationChannel | undefined) ?? rule.channel,
      delayMinutes:
        input.delayMinutes == null ? rule.delayMinutes : Math.max(0, Math.min(input.delayMinutes, 60 * 24 * 30)),
    },
  });
}
