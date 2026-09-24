"use client";

import { useActionState } from "react";
import { requestOffboardingAction, type OffboardingActionState } from "@/app/actions/offboarding";
import { Button } from "@/components/ui/button";
import { OFFBOARDING_CONFIRMATION, OFFBOARDING_PRESERVE_MESSAGE } from "@/lib/offboarding";

export function OffboardingForm({ alreadyRequested }: { alreadyRequested: boolean }) {
  const [state, action, pending] = useActionState(
    requestOffboardingAction,
    {} as OffboardingActionState,
  );

  if (alreadyRequested) {
    return (
      <p className="text-sm text-muted-foreground">
        Cancellation is already recorded. Historical records remain on file.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted-foreground">{OFFBOARDING_PRESERVE_MESSAGE}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="acknowledgedExport" value="1" className="mt-1" required />
        <span>I downloaded a business export, or I no longer need one. I understand records are not deleted.</span>
      </label>
      <label className="block text-sm">
        Type {OFFBOARDING_CONFIRMATION} to request cancellation
        <input
          name="confirmation"
          className="mt-1 w-full rounded-md border px-3 py-2"
          autoComplete="off"
          required
        />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Recording…" : "Request cancellation"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
