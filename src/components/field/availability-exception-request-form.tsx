"use client";

import { useActionState, useState } from "react";
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
  startMinutes: number | null;
  endMinutes: number | null;
  note: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED";
};

function minutesToTime(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function kindLabel(request: FieldAvailabilityRequest) {
  if (request.kind === "UNAVAILABLE") return "Time off";
  if (request.startMinutes != null && request.endMinutes != null) {
    return `Available ${minutesToTime(request.startMinutes)}–${minutesToTime(request.endMinutes)}`;
  }
  return "Available override";
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
  const [kind, setKind] = useState<"AVAILABLE" | "UNAVAILABLE">("UNAVAILABLE");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time off / date exception</CardTitle>
        <CardDescription>
          Request a dated change. An available override needs start and end
          times. The owner must accept before recorded availability changes.
          Existing jobs are not cancelled, reassigned, or messaged from this
          request.
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
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE")
                }
              >
                <option value="UNAVAILABLE">Time off / unavailable</option>
                <option value="AVAILABLE">Available (overrides weekly)</option>
              </select>
            </div>
          </div>
          {kind === "AVAILABLE" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="availability-request-start">Start</Label>
                <Input
                  id="availability-request-start"
                  name="start"
                  type="time"
                  required
                  defaultValue="08:00"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="availability-request-end">End</Label>
                <Input
                  id="availability-request-end"
                  name="end"
                  type="time"
                  required
                  defaultValue="17:00"
                />
              </div>
            </div>
          ) : null}
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
                  {request.date} · {kindLabel(request)}
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
