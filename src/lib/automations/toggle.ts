import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { isSupportedAutomationRule } from "@/lib/automations/registry";
import { requireAutomationCenterAccess } from "@/lib/automations/access";

type Db = PrismaClient | Prisma.TransactionClient;

export const UNSUPPORTED_RULE_TOGGLE_ERROR =
  "This recorded rule is unsupported and cannot be enabled or disabled from the Automation Center.";

/**
 * Enable or disable one owned, supported AutomationRule.
 *
 * Writes only `enabled` on AutomationRule. Does not queue, process, retry,
 * or mutate AutomationRun.
 */
export async function toggleOwnedAutomationRuleEnabled(
  db: Db,
  access: BusinessAccess,
  input: { ruleId: string; enabled: boolean },
) {
  requireAutomationCenterAccess(access);

  const ruleId = input.ruleId.trim();
  if (!ruleId) {
    access.assertOwned(null);
  }

  const rule = access.assertOwned(
    await db.automationRule.findFirst({
      where: { id: ruleId, businessId: access.businessId },
      select: {
        id: true,
        businessId: true,
        eventType: true,
        purpose: true,
        kind: true,
        enabled: true,
      },
    }),
  );

  if (!isSupportedAutomationRule(rule)) {
    throw new Error(UNSUPPORTED_RULE_TOGGLE_ERROR);
  }

  const updated = await db.automationRule.updateMany({
    where: {
      id: rule.id,
      businessId: access.businessId,
    },
    data: { enabled: input.enabled },
  });

  if (updated.count !== 1) {
    access.assertOwned(null);
  }

  return db.automationRule.findFirstOrThrow({
    where: { id: rule.id, businessId: access.businessId },
  });
}
