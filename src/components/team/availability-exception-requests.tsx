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
import type { AvailabilityExceptionRequestRecord } from "@/lib/workforce";

function kindLabel(kind: AvailabilityExceptionRequestRecord["kind"]) {
  return kind === "UNAVAILABLE" ? "Time off / unavailable" : "Available override";
}

function RequestFacts({ request }: { request: AvailabilityExceptionRequestRecord }) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <p className="font-medium">
        {request.workerName} · {request.date}
      </p>
      <p className="text-sm text-muted-foreground">{kindLabel(request.kind)}</p>
      {request.note ? <p className="text-sm text-muted-foreground">Note: {request.note}</p> : null}
    </div>
  );
}

function OwnerDecisionButtons({ request }: { request: AvailabilityExceptionRequestRecord }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <ActionForm action={decideAvailabilityExceptionRequest}>
        <input type="hidden" name="requestId" value={request.id} />
        <input type="hidden" name="expectedUpdatedAt" value={request.updatedAt.toISOString()} />
        <input type="hidden" name="decision" value="ACCEPT" />
        <Button type="submit" size="sm">
          Accept
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
          acceptance writes recorded availability. Decline leaves weekly hours
          unchanged. TBBT does not cancel, reassign, or message anyone about
          existing jobs from this list.
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
                {request.workerName} · {request.date} · {kindLabel(request.kind)} —{" "}
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
