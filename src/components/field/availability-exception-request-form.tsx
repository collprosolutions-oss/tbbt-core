"use client";

import { useActionState } from "react";
import { requestAvailabilityException, type WorkforceActionState } from "@/app/actions/workforce";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
const initialState: WorkforceActionState = {};

type FieldAvailabilityRequest = {
  id: string;
  date: string;
  kind: "AVAILABLE" | "UNAVAILABLE";
  note: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED";
};

function kindLabel(kind: FieldAvailabilityRequest["kind"]) {
  return kind === "UNAVAILABLE" ? "Time off" : "Available override";
}

function statusLabel(status: FieldAvailabilityRequest["status"]) {
  if (status === "ACCEPTED") return "Accepted";
  if (status === "DECLINED") return "Declined";
  return "Pending owner decision";
}

export function AvailabilityExceptionRequestForm({
  membershipId,
  requests,
}: {
  membershipId: string;
  requests: FieldAvailabilityRequest[];
}) {
  const [state, action, pending] = useActionState(requestAvailabilityException, initialState);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time off / date exception</CardTitle>
        <CardDescription>
          Request a dated change. The owner must accept before recorded
          availability changes. Existing jobs are not cancelled, reassigned,
          or messaged from this request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form action={action} className="space-y-3">
          <input type="hidden" name="membershipId" value={membershipId} />
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
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="availability-request-date">Date</Label>
              <Input id="availability-request-date" name="date" type="date" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="availability-request-kind">Kind</Label>
              <select
                id="availability-request-kind"
                name="kind"
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                defaultValue="UNAVAILABLE"
              >
                <option value="UNAVAILABLE">Time off / unavailable</option>
                <option value="AVAILABLE">Available (overrides weekly)</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="availability-request-note">Note (optional)</Label>
            <Input
              id="availability-request-note"
              name="note"
              maxLength={240}
              placeholder="Reason the owner should see"
            />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Sending…" : "Request owner decision"}
          </Button>
        </form>
        {requests.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {requests.map((request) => (
              <li key={request.id} className="rounded-lg border p-3">
                <p className="font-medium">
                  {request.date} · {kindLabel(request.kind)}
                </p>
                <p className="text-muted-foreground">{statusLabel(request.status)}</p>
                {request.note ? <p className="text-muted-foreground">{request.note}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
