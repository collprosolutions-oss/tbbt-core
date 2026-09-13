"use client";

import { useActionState, useState } from "react";
import { startJob, type JobActionState } from "@/app/actions/job";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  START_WITHOUT_CONFIRMATION_REASONS,
} from "@/lib/appointment-confirmation";

const initialState: JobActionState = {};

export function StartJobButton({
  jobId,
  unpaidDepositWarning,
  appointmentConfirmed,
}: {
  jobId: string;
  unpaidDepositWarning?: string | null;
  appointmentConfirmed: boolean;
}) {
  const [state, formAction, pending] = useActionState(startJob, initialState);
  const [reason, setReason] = useState("");

  if (!appointmentConfirmed) {
    return (
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="jobId" value={jobId} />
        <input type="hidden" name="startWithoutConfirmation" value="1" />
        <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
          {CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT}
        </p>
        {unpaidDepositWarning ? (
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {unpaidDepositWarning}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`overrideReason-${jobId}`}>Start without customer confirmation</Label>
          <select
            id={`overrideReason-${jobId}`}
            name="overrideReason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            required
          >
            <option value="">Choose a reason</option>
            {START_WITHOUT_CONFIRMATION_REASONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        {reason === "OTHER" ? (
          <div className="space-y-2">
            <Label htmlFor={`overrideOther-${jobId}`}>Reason</Label>
            <textarea
              id={`overrideOther-${jobId}`}
              name="overrideOther"
              required
              className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
            />
          </div>
        ) : null}
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Starting…" : "Start Without Customer Confirmation"}
        </Button>
        {state.error ? (
          <p className="text-sm text-destructive">{state.error}</p>
        ) : null}
      </form>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={
        unpaidDepositWarning
          ? (event) => {
              if (
                !window.confirm(
                  `${unpaidDepositWarning}\n\nStart the job anyway?`,
                )
              ) {
                event.preventDefault();
              }
            }
          : undefined
      }
    >
      <input type="hidden" name="jobId" value={jobId} />
      {unpaidDepositWarning ? (
        <p className="mb-2 text-sm font-medium text-amber-800 dark:text-amber-300">
          {unpaidDepositWarning}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Starting…" : "Start Job"}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
