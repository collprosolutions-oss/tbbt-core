"use client";

import { useActionState } from "react";
import {
  recordWarrantyCallbackAction,
  recordWarrantyCallbackOutcomeAction,
  recordWarrantyTermAction,
  reviewWarrantyCallbackAction,
  type WarrantyCallbackActionState,
} from "@/app/actions/warranty-callback";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { WARRANTY_CALLBACK_NO_SIDE_EFFECTS_MESSAGE } from "@/lib/warranty-callback";

const initialState: WarrantyCallbackActionState = {};

const fieldClass =
  "min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function FormError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function RecordWarrantyTermForm({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(recordWarrantyTermAction, initialState);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <FormError error={state.error} />
      <div className="space-y-1.5">
        <Label htmlFor={`warranty-statement-${jobId}`}>Warranty terms</Label>
        <textarea
          id={`warranty-statement-${jobId}`}
          name="statement"
          required
          rows={3}
          placeholder="Type the warranty terms already agreed for this job."
          className={fieldClass}
        />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record warranty terms"}
      </Button>
    </form>
  );
}

export function RecordWarrantyCallbackForm({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(
    recordWarrantyCallbackAction,
    initialState,
  );
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <FormError error={state.error} />
      <div className="space-y-1.5">
        <Label htmlFor={`warranty-callback-report-${jobId}`}>Customer report</Label>
        <textarea
          id={`warranty-callback-report-${jobId}`}
          name="report"
          required
          rows={3}
          placeholder="What the customer reported."
          className={fieldClass}
        />
      </div>
      <p className="text-xs text-muted-foreground">{WARRANTY_CALLBACK_NO_SIDE_EFFECTS_MESSAGE}</p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record callback"}
      </Button>
    </form>
  );
}

export function ReviewWarrantyCallbackForm({
  jobId,
  callbackId,
}: {
  jobId: string;
  callbackId: string;
}) {
  const [state, formAction, pending] = useActionState(reviewWarrantyCallbackAction, initialState);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="callbackId" value={callbackId} />
      <FormError error={state.error} />
      <div className="space-y-1.5">
        <Label htmlFor={`warranty-review-${callbackId}`}>Review note</Label>
        <textarea
          id={`warranty-review-${callbackId}`}
          name="reviewNote"
          rows={2}
          placeholder="Optional note from your review."
          className={fieldClass}
        />
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Review callback"}
      </Button>
    </form>
  );
}

export function RecordWarrantyCallbackOutcomeForm({
  jobId,
  callbackId,
}: {
  jobId: string;
  callbackId: string;
}) {
  const [state, formAction, pending] = useActionState(
    recordWarrantyCallbackOutcomeAction,
    initialState,
  );
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="callbackId" value={callbackId} />
      <FormError error={state.error} />
      <div className="space-y-1.5">
        <Label htmlFor={`warranty-outcome-${callbackId}`}>Outcome</Label>
        <textarea
          id={`warranty-outcome-${callbackId}`}
          name="outcomeNote"
          required
          rows={3}
          placeholder="What you decided. This does not create a job, an invoice, or a message."
          className={fieldClass}
        />
      </div>
      <p className="text-xs text-muted-foreground">{WARRANTY_CALLBACK_NO_SIDE_EFFECTS_MESSAGE}</p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record outcome"}
      </Button>
    </form>
  );
}
