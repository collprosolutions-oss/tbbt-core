"use client";

import { useActionState, useState } from "react";
import {
  updateLaborMinimumSettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LABOR_MINIMUM_FUTURE_RULE_MESSAGE } from "@/lib/settings";
import { formatMoney } from "@/lib/format";

const initialState: SettingsActionState = {};

function formatCurrent(amount: string, enabled: boolean) {
  if (!enabled || !amount) return "Off";
  const numeric = Number(amount);
  return Number.isNaN(numeric) ? amount : formatMoney(numeric);
}

export function LaborMinimumSettingsForm({
  enabled,
  amount,
  canEdit,
  blockedMessage,
}: {
  enabled: boolean;
  amount: string;
  canEdit: boolean;
  blockedMessage?: string;
}) {
  const [state, action, pending] = useActionState(
    updateLaborMinimumSettings,
    initialState,
  );
  const [confirming, setConfirming] = useState(false);

  if (!canEdit) {
    return (
      <div className="space-y-2 text-sm">
        <p>
          Current labor minimum:{" "}
          <span className="font-medium">{formatCurrent(amount, enabled)}</span>
        </p>
        <p className="text-muted-foreground">
          {blockedMessage ??
            `Only the owner can change this pricing rule. ${LABOR_MINIMUM_FUTURE_RULE_MESSAGE}`}
        </p>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="space-y-4"
      onSubmit={(event) => {
        if (!confirming) {
          event.preventDefault();
          setConfirming(true);
        }
      }}
    >
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Current labor minimum:{" "}
        <span className="font-medium text-foreground">{formatCurrent(amount, enabled)}</span>
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          className="size-4"
          onChange={() => setConfirming(false)}
        />
        Enabled
      </label>
      <div className="space-y-2">
        <Label htmlFor="labor-minimum-amount">Minimum amount</Label>
        <Input
          id="labor-minimum-amount"
          name="amount"
          inputMode="decimal"
          defaultValue={amount}
          onChange={() => setConfirming(false)}
        />
      </div>
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Confirm pricing-rule change</p>
          <p>{LABOR_MINIMUM_FUTURE_RULE_MESSAGE}</p>
          <input type="hidden" name="confirmConsequential" value="1" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Confirm & Save Changes"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" disabled={pending}>
          Save Changes
        </Button>
      )}
    </form>
  );
}
