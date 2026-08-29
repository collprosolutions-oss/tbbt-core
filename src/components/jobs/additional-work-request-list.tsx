"use client";

import { useActionState, useState } from "react";
import {
  createChangeOrder,
  type ChangeOrderActionState,
} from "@/app/actions/change-order";
import {
  dismissAdditionalWorkRequest,
  type AdditionalWorkRequestActionState,
} from "@/app/actions/additional-work-request";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";

export type OpenAdditionalWorkRequest = {
  id: string;
  description: string;
  createdAt: Date;
  source: "CUSTOMER" | "EMPLOYEE";
};

const createInitialState: ChangeOrderActionState = {};
const dismissInitialState: AdditionalWorkRequestActionState = {};

/**
 * Internal-only review queue for "+ Request Additional Work" submissions
 * from the Customer Project Portal (see
 * src/app/actions/public-additional-work-request.ts). A request here has
 * NEVER changed approved scope, price, Job total, or Invoice total by
 * itself -- owner/admin decides here whether to price it into a Change
 * Order or dismiss it.
 */
export function AdditionalWorkRequestList({
  jobId,
  requests,
}: {
  jobId: string;
  requests: OpenAdditionalWorkRequest[];
}) {
  if (requests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No open additional-work requests.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {requests.map((request) => (
        <RequestRow key={request.id} jobId={jobId} request={request} />
      ))}
    </ul>
  );
}

function RequestRow({
  jobId,
  request,
}: {
  jobId: string;
  request: OpenAdditionalWorkRequest;
}) {
  const [creating, setCreating] = useState(false);
  const [createState, createAction, createPending] = useActionState(
    createChangeOrder,
    createInitialState,
  );
  const [dismissState, dismissAction, dismissPending] = useActionState(
    dismissAdditionalWorkRequest,
    dismissInitialState,
  );

  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="whitespace-pre-wrap">{request.description}</p>
      <p className="text-xs text-muted-foreground">
        {request.source === "EMPLOYEE"
          ? "Reported by field employee"
          : "Requested by customer"}{" "}
        · {formatDateTime(request.createdAt)}
      </p>
      {createState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{createState.error}</AlertDescription>
        </Alert>
      ) : null}
      {dismissState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{dismissState.error}</AlertDescription>
        </Alert>
      ) : null}
      {creating ? (
        <form action={createAction} className="space-y-2">
          <input type="hidden" name="jobId" value={jobId} />
          <input
            type="hidden"
            name="additionalWorkRequestId"
            value={request.id}
          />
          <div className="space-y-1">
            <Label htmlFor={`co-title-${request.id}`}>
              Change order title
            </Label>
            <Input
              id={`co-title-${request.id}`}
              name="title"
              defaultValue={request.description.slice(0, 80)}
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={createPending}>
              {createPending ? "Creating…" : "Create draft"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={createPending}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            Create Change Order
          </Button>
          <form action={dismissAction}>
            <input type="hidden" name="requestId" value={request.id} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={dismissPending}
            >
              {dismissPending ? "Dismissing…" : "Dismiss"}
            </Button>
          </form>
        </div>
      )}
    </li>
  );
}
