"use client";

import { useActionState, useState } from "react";
import {
  logMissedCallAction,
  recordInboundCallEventAction,
  type CommunicationsActionState,
} from "@/app/actions/communications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  nextCommunicationAttemptId,
  shouldRotateCommunicationSendAttemptId,
} from "@/lib/communications/compose-flow";

function newAttemptId() {
  return crypto.randomUUID();
}

export function MissedCallForm({
  customers,
}: {
  customers: Array<{ id: string; name: string }>;
}) {
  const [attemptId, setAttemptId] = useState(newAttemptId);
  const [state, action] = useActionState(async (prev: CommunicationsActionState, formData: FormData) => {
    const result = await logMissedCallAction(prev, formData);
    setAttemptId((current) =>
      nextCommunicationAttemptId(current, result, shouldRotateCommunicationSendAttemptId, newAttemptId),
    );
    return result;
  }, {});
  const [inboundState, inboundAction] = useActionState(recordInboundCallEventAction, {});

  return (
    <div className="space-y-6">
      <form
        action={async (formData) => {
          formData.set("attemptId", attemptId);
          await action(formData);
        }}
        className="space-y-3"
      >
        <div className="space-y-1">
          <Label htmlFor="call-kind">Log type</Label>
          <select
            id="call-kind"
            name="kind"
            defaultValue="MISSED_CALL"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="MISSED_CALL">Missed call</option>
            <option value="MANUAL_PHONE">Manual phone note</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="call-customer">Linked customer</Label>
          <select
            id="call-customer"
            name="customerId"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">Unknown caller</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="call-phone">Caller phone</Label>
          <Input id="call-phone" name="callerPhone" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="call-summary">Summary</Label>
          <textarea
            id="call-summary"
            name="summary"
            required
            rows={4}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="callbackNeeded" />
          Callback needed
        </label>
        <Button type="submit" size="sm">
          Log call
        </Button>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
      </form>

      <form
        action={async (formData) => {
          formData.set("attemptId", crypto.randomUUID());
          await inboundAction(formData);
        }}
        className="space-y-3 rounded-md border border-border/70 p-3"
      >
        <p className="text-sm font-medium">Inbound call event (voice not connected)</p>
        <Input name="callerPhone" placeholder="Caller phone" />
        <Input name="summary" placeholder="What the caller needed" />
        <Button type="submit" size="sm" variant="outline">
          Record inbound event
        </Button>
        {inboundState.message ? (
          <p className="text-xs text-muted-foreground">{inboundState.message}</p>
        ) : null}
      </form>
    </div>
  );
}
