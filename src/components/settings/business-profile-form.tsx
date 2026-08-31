"use client";

import { useActionState, useState } from "react";
import {
  updateBusinessProfileSettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BUSINESS_NAME_CHANGE_MESSAGE } from "@/lib/settings";

const initialState: SettingsActionState = {};

export function BusinessProfileForm({
  name,
  canEdit,
}: {
  name: string;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    updateBusinessProfileSettings,
    initialState,
  );
  const [confirming, setConfirming] = useState(false);

  if (!canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        Only the owner can change the business name. Current name:{" "}
        <span className="font-medium text-foreground">{name}</span>
      </p>
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
      <div className="space-y-2">
        <Label htmlFor="business-name">Business name</Label>
        <Input
          id="business-name"
          name="name"
          defaultValue={name}
          onChange={() => setConfirming(false)}
        />
      </div>
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Confirm business-name change</p>
          <p>{BUSINESS_NAME_CHANGE_MESSAGE}</p>
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
