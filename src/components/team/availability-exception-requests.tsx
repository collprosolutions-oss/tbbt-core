import { decideAvailabilityExceptionRequest } from "@/app/actions/workforce";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AvailabilityExceptionRequestRecord, RecordedAvailabilityException } from "@/lib/workforce";

function minutesToTime(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function kindLabel(
  kind: AvailabilityExceptionRequestRecord["kind"],
  startMinutes?: number | null,
  endMinutes?: number | null,
) {
  if (kind === "UNAVAILABLE") return "Time off / unavailable";
  if (startMinutes != null && endMinutes != null) {
    return `Available override ${minutesToTime(startMinutes)}–${minutesToTime(endMinutes)}`;
  }
  return "Available override";
}

function recordedLabel(exception: RecordedAvailabilityException) {
  return `Recorded: ${kindLabel(exception.kind, exception.startMinutes, exception.endMinutes)}${
    exception.note ? ` — ${exception.note}` : ""
  }`;
}

function RequestFacts({ request }: { request: AvailabilityExceptionRequestRecord }) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <p className="font-medium">
        {request.workerName} · {request.date}
      </p>
      <p className="text-sm text-muted-foreground">
        {kindLabel(request.kind, request.startMinutes, request.endMinutes)}
      </p>
      {request.note ? <p className="text-sm text-muted-foreground">Note: {request.note}</p> : null}
      {request.existingException ? (
        <p className="text-sm text-muted-foreground">{recordedLabel(request.existingException)}</p>
      ) : null}
    </div>
  );
}

function OwnerDecisionButtons({ request }: { request: AvailabilityExceptionRequestRecord }) {
  const needsReplace = Boolean(request.existingException);
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <ActionForm action={decideAvailabilityExceptionRequest}>
        <input type="hidden" name="requestId" value={request.id} />
        <input type="hidden" name="expectedUpdatedAt" value={request.updatedAt.toISOString()} />
        <input type="hidden" name="decision" value="ACCEPT" />
        {needsReplace ? <input type="hidden" name="replaceExisting" value="1" /> : null}
        <Button type="submit" size="sm">
          {needsReplace ? "Accept and replace recorded exception" : "Accept"}
        </Button>
      </ActionForm>
      <ActionForm action={decideAvailabilityExceptionRequest}>
        <input type="hidden" name="requestId" value={request.id} />
        <input type="hidden" name="expectedUpdatedAt" value={request.updatedAt.toISOString()} />
        <input type="hidden" name="decision" value="DECLINE" />
        <Button type="submit" size="sm" variant="outline">
          Decline
        </Button>
      </ActionForm>
    </div>
  );
}

export function AvailabilityExceptionRequestsPanel({
  pending,
  recent,
  canDecide,
}: {
  pending: AvailabilityExceptionRequestRecord[];
  recent: AvailabilityExceptionRequestRecord[];
  canDecide: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Availability requests</CardTitle>
        <CardDescription>
          Workers can request a dated exception or time off. Only owner
          acceptance writes recorded availability. If a recorded exception
          already exists for that date, accept must explicitly replace it.
          Decline leaves weekly hours unchanged. TBBT does not cancel,
          reassign, or message anyone about existing jobs from this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending availability requests.</p>
        ) : (
          pending.map((request) => (
            <div key={request.id}>
              <RequestFacts request={request} />
              {canDecide ? (
                <OwnerDecisionButtons request={request} />
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Owner review is required to accept or decline. Recorded
                  availability is unchanged.
                </p>
              )}
            </div>
          ))
        )}
        {recent.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Recent decisions</p>
            {recent.map((request) => (
              <p key={request.id} className="text-sm text-muted-foreground">
                {request.workerName} · {request.date} ·{" "}
                {kindLabel(request.kind, request.startMinutes, request.endMinutes)} —{" "}
                {request.status === "ACCEPTED" ? "accepted" : "declined"}. Existing
                jobs were not changed.
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
