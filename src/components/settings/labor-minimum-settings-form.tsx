"use client";

import { useActionState } from "react";
import {
  updateLaborMinimumSettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SettingsActionState = {};

export function LaborMinimumSettingsForm({
  enabled,
  amount,
}: {
  enabled: boolean;
  amount: string;
}) {
  const [state, action, pending] = useActionState(
    updateLaborMinimumSettings,
    initialState,
  );

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          className="size-4"
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
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
