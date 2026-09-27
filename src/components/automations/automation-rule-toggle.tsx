"use client";

import { toggleAutomationRuleEnabledAction } from "@/app/actions/automations";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";

export function AutomationRuleToggle({
  ruleId,
  enabled,
}: {
  ruleId: string;
  enabled: boolean;
}) {
  return (
    <ActionForm action={toggleAutomationRuleEnabledAction} className="mt-3">
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <Button type="submit" size="sm" variant="outline">
        {enabled ? "Disable" : "Enable"}
      </Button>
    </ActionForm>
  );
}
