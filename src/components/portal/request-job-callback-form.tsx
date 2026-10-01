"use client";

import { useActionState } from "react";
import {
  requestPortalJobCallback,
  type PortalJobCallbackActionState,
} from "@/app/actions/portal-job-callback";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  JOB_CALLBACK_PREFERRED_CONTACT,
  JOB_CALLBACK_PREFERRED_CONTACT_LABELS,
  JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE,
  MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH,
} from "@/lib/job-callback";

const initialState: PortalJobCallbackActionState = {};

export function RequestJobCallbackForm({ projectToken }: { projectToken: string }) {
  const [state, formAction, pending] = useActionState(
    requestPortalJobCallback,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectToken" value={projectToken} />
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
      <div className="space-y-1">
        <Label htmlFor="portal-callback-description">What should we review?</Label>
        <textarea
          id="portal-callback-description"
          name="description"
          required
          rows={4}
          maxLength={MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Describe the concern in a few sentences."
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="portal-callback-preferred-contact">Preferred contact</Label>
        <select
          id="portal-callback-preferred-contact"
          name="preferredContact"
          required
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue="PHONE"
        >
          {JOB_CALLBACK_PREFERRED_CONTACT.map((value) => (
            <option key={value} value={value}>
              {JOB_CALLBACK_PREFERRED_CONTACT_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">{JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE}</p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Sending…" : "Send callback request"}
      </Button>
    </form>
  );
}
