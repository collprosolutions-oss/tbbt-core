"use client";

import { useActionState, useState } from "react";
import {
  recordOwnerAppointmentConfirmation,
  type JobActionState,
} from "@/app/actions/job";
import {
  AccessArrangementFields,
  type AccessArrangementFieldValues,
} from "@/components/appointments/access-arrangement-fields";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { OWNER_CONFIRMATION_METHODS } from "@/lib/appointment-confirmation";

const initialState: JobActionState = {};

export function RecordOwnerAppointmentConfirmationForm({
  jobId,
  existingAccess,
}: {
  jobId: string;
  existingAccess: AccessArrangementFieldValues;
}) {
  const [state, formAction, pending] = useActionState(
    recordOwnerAppointmentConfirmation,
    initialState,
  );
  const [access, setAccess] = useState<AccessArrangementFieldValues>(existingAccess);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="jobId" value={jobId} />
      <div className="space-y-2">
        <Label htmlFor={`confirmationMethod-${jobId}`}>How the customer confirmed</Label>
        <select
          id={`confirmationMethod-${jobId}`}
          name="confirmationMethod"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          required
          defaultValue=""
        >
          <option value="">Choose a method</option>
          {OWNER_CONFIRMATION_METHODS.map((method) => (
            <option key={method.id} value={method.id}>
              {method.label}
            </option>
          ))}
        </select>
      </div>
      <AccessArrangementFields
        idPrefix={`owner-${jobId}`}
        values={access}
        onChange={setAccess}
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record confirmation"}
      </Button>
      {state.message ? <p className="text-sm">{state.message}</p> : null}
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
    </form>
  );
}
