"use client";

import { useActionState } from "react";
import { mergeCustomersAction, type CustomerMergeActionState } from "@/app/actions/customer-merge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  MERGE_CONFIRM_LABEL,
  NAME_IS_NOT_IDENTITY_MESSAGE,
} from "@/lib/customer-merge";

const initialState: CustomerMergeActionState = {};

export function MergeCustomersForm({
  leftId,
  rightId,
  leftName,
  rightName,
}: {
  leftId: string;
  rightId: string;
  leftName: string;
  rightName: string;
}) {
  const [state, action, pending] = useActionState(mergeCustomersAction, initialState);

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">{NAME_IS_NOT_IDENTITY_MESSAGE}</p>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Keep this record</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="keepCustomerId"
            value={leftId}
            defaultChecked
            required
            className="mt-1"
          />
          <span>Keep {leftName} and move the other record onto it</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="keepCustomerId" value={rightId} className="mt-1" />
          <span>Keep {rightName} and move the other record onto it</span>
        </label>
      </fieldset>

      <input type="hidden" name="leftCustomerId" value={leftId} />
      <input type="hidden" name="rightCustomerId" value={rightId} />

      <p className="text-xs text-muted-foreground">
        Jobs, estimates, invoices, properties, and communication history stay attached to the
        record you keep. SMS consent becomes the stricter of the two (REVOKED, then UNKNOWN,
        then GRANTED).
      </p>

      <div className="flex items-start gap-2">
        <input
          id="confirmSameCustomer"
          name="confirmSameCustomer"
          type="checkbox"
          value="yes"
          required
          className="mt-1"
        />
        <Label htmlFor="confirmSameCustomer" className="text-sm font-normal">
          {MERGE_CONFIRM_LABEL}
        </Label>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Merging…" : "Merge these two records"}
      </Button>
    </form>
  );
}
