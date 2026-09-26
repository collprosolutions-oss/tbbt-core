"use client";

import { useActionState, useState } from "react";
import {
  updateBusinessTimeZoneSettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BUSINESS_TIMEZONE_CHANGE_MESSAGE,
  COMMON_BUSINESS_TIMEZONES,
  businessTimeZoneDisplayLabel,
} from "@/lib/business-timezone";

const initialState: SettingsActionState = {};
const SUGGESTION_LIST_ID = "business-timezone-suggestions";

export function BusinessTimeZoneForm({
  storedTimezone,
  resolvedTimezone,
  isExplicit,
  canEdit,
}: {
  storedTimezone: string | null;
  resolvedTimezone: string;
  isExplicit: boolean;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    updateBusinessTimeZoneSettings,
    initialState,
  );
  const [confirming, setConfirming] = useState(false);
  const currentLabel = businessTimeZoneDisplayLabel({
    timezone: storedTimezone,
  });

  if (!canEdit) {
    return (
      <div className="space-y-2 text-sm">
        <p className="font-medium text-foreground">{currentLabel}</p>
        {!isExplicit ? (
          <p className="text-muted-foreground">
            Operations currently use {resolvedTimezone}. That default is not a
            saved owner preference.
          </p>
        ) : null}
        <p className="text-muted-foreground">
          Only the owner can change the business timezone.
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
      <p className="text-sm font-medium text-foreground">{currentLabel}</p>
      <div className="space-y-2">
        <Label htmlFor="business-timezone">IANA timezone</Label>
        <Input
          id="business-timezone"
          name="timezone"
          list={SUGGESTION_LIST_ID}
          defaultValue={isExplicit ? storedTimezone?.trim() ?? "" : ""}
          placeholder="America/Los_Angeles"
          autoComplete="off"
          onChange={() => setConfirming(false)}
        />
        <datalist id={SUGGESTION_LIST_ID}>
          {COMMON_BUSINESS_TIMEZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p className="text-sm text-muted-foreground">
          Suggestions include common US zones. Any valid IANA timezone can be
          saved. To use Eastern, store America/New_York explicitly.
        </p>
      </div>
      {confirming ? (
        <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium">Confirm business-timezone change</p>
          <p>{BUSINESS_TIMEZONE_CHANGE_MESSAGE}</p>
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
