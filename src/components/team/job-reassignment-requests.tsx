import { decideJobReassignmentRequest } from "@/app/actions/job-reassignment-request";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { JobReassignmentRequestRecord } from "@/lib/job-reassignment-request";

function RequestFacts({
  request,
  timeZone,
}: {
  request: JobReassignmentRequestRecord;
  timeZone: string;
}) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <p className="font-medium">
        {request.workerName} · {request.jobLabel}
      </p>
      <p className="text-sm text-muted-foreground">
        {request.scheduledAt
          ? formatDateTime(request.scheduledAt, timeZone)
          : "Not yet scheduled"}
      </p>
      <p className="text-sm text-muted-foreground">Reason: {request.reason}</p>
    </div>
  );
}

function OwnerDecisionButtons({ request }: { request: JobReassignmentRequestRecord }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <ActionForm action={decideJobReassignmentRequest}>
        <input type="hidden" name="requestId" value={request.id} />
        <input type="hidden" name="expectedUpdatedAt" value={request.updatedAt.toISOString()} />
        <input type="hidden" name="decision" value="ACCEPT" />
        <Button type="submit" size="sm">
          Accept and unassign
        </Button>
      </ActionForm>
      <ActionForm action={decideJobReassignmentRequest}>
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

export function JobReassignmentRequestsPanel({
  pending,
  recent,
  canDecide,
  timeZone,
}: {
  pending: JobReassignmentRequestRecord[];
  recent: JobReassignmentRequestRecord[];
  canDecide: boolean;
  timeZone: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Job reassignment requests</CardTitle>
        <CardDescription>
          Workers can ask to be taken off one currently assigned upcoming job.
          Only owner acceptance unassigns through the canonical assignment
          write and schedule-reservation checks. Decline leaves the job
          assigned. TBBT does not send a customer message from this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending reassignment requests.</p>
        ) : (
          pending.map((request) => (
            <div key={request.id}>
              <RequestFacts request={request} timeZone={timeZone} />
              {canDecide ? (
                <OwnerDecisionButtons request={request} />
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Owner review is required to accept or decline. The job
                  assignment and schedule are unchanged.
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
                {request.workerName} · {request.jobLabel} —{" "}
                {request.status === "ACCEPTED"
                  ? "accepted and unassigned"
                  : "declined. Assignment unchanged"}
                . No customer message was sent.
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
