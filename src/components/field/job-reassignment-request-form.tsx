"use client";

import { useActionState } from "react";
import {
  requestJobReassignment,
  type JobReassignmentRequestActionState,
} from "@/app/actions/job-reassignment-request";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { JOB_REASSIGNMENT_REQUEST_REASON_MAX } from "@/lib/job-reassignment-request";

const initialState: JobReassignmentRequestActionState = {};

type FieldReassignmentRequest = {
  id: string;
  jobId: string;
  jobLabel: string;
  reason: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED";
};

function statusLabel(status: FieldReassignmentRequest["status"]) {
  if (status === "ACCEPTED") return "Accepted — owner unassigned this job";
  if (status === "DECLINED") return "Declined — you stay assigned";
  return "Pending owner decision. Assignment and schedule are unchanged.";
}

export function JobReassignmentRequestForm({
  jobs,
  requests,
  defaultJobId,
}: {
  jobs: Array<{ id: string; label: string }>;
  requests: FieldReassignmentRequest[];
  defaultJobId?: string;
}) {
  const [state, action, pending] = useActionState(requestJobReassignment, initialState);
  const pendingJobIds = new Set(
    requests.filter((request) => request.status === "PENDING").map((request) => request.jobId),
  );
  const requestableJobs = jobs.filter((job) => !pendingJobIds.has(job.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask to be reassigned</CardTitle>
        <CardDescription>
          Request that the owner take you off one currently assigned upcoming
          job. Include a reason. The job assignment and schedule stay
          unchanged until the owner accepts. No customer message is sent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {requestableJobs.length > 0 ? (
          <form action={action} className="space-y-3">
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
            <div className="space-y-1">
              <Label htmlFor="job-reassignment-job">Upcoming assigned job</Label>
              <select
                id="job-reassignment-job"
                name="jobId"
                required
                defaultValue={
                  defaultJobId && requestableJobs.some((job) => job.id === defaultJobId)
                    ? defaultJobId
                    : requestableJobs[0]?.id
                }
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
              >
                {requestableJobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="job-reassignment-reason">Reason</Label>
              <Input
                id="job-reassignment-reason"
                name="reason"
                required
                maxLength={JOB_REASSIGNMENT_REQUEST_REASON_MAX}
                placeholder="Why the owner should reassign this job"
              />
            </div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Sending…" : "Request owner decision"}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            {jobs.length === 0
              ? "No upcoming assigned jobs can be requested right now."
              : "A reassignment request is already pending for each upcoming job."}
          </p>
        )}
        {requests.length > 0 ? (
          <ul className="space-y-2 text-sm">
            {requests.map((request) => (
              <li key={request.id} className="rounded-lg border p-3">
                <p className="font-medium">{request.jobLabel}</p>
                <p className="text-muted-foreground">{statusLabel(request.status)}</p>
                {request.reason ? (
                  <p className="text-muted-foreground">{request.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No reassignment requests yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
