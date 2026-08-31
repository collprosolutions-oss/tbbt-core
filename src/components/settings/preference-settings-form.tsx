"use client";

import { useActionState } from "react";
import {
  updateSettingsPreferences,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SettingsPreferenceFlags } from "@/lib/settings";

const initialState: SettingsActionState = {};

type PreferenceField = {
  key: keyof SettingsPreferenceFlags;
  label: string;
  help: string;
};

export function PreferenceSettingsForm({
  values,
  fields,
  canEdit,
  disclaimer,
}: {
  values: SettingsPreferenceFlags;
  fields: PreferenceField[];
  canEdit: boolean;
  disclaimer: string;
}) {
  const [state, action, pending] = useActionState(
    updateSettingsPreferences,
    initialState,
  );

  return (
    <form action={action} className="space-y-4">
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
      <p className="text-sm text-muted-foreground">{disclaimer}</p>
      <div className="space-y-3">
        {fields.map((field) => (
          <label key={field.key} className="flex items-start gap-3 text-sm">
            <input type="hidden" name={`pref_${field.key}`} value="1" />
            <input
              type="checkbox"
              name={field.key}
              defaultChecked={values[field.key]}
              disabled={!canEdit}
              className="mt-0.5 size-4"
            />
            <span>
              <span className="font-medium">{field.label}</span>
              <span className="mt-0.5 block text-muted-foreground">{field.help}</span>
            </span>
          </label>
        ))}
      </div>
      {canEdit ? (
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Changes"}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          You can view these preferences. Editing requires owner or admin access.
        </p>
      )}
    </form>
  );
}
