"use client";

import { useActionState } from "react";
import {
  completeJobMilestoneAction,
  recordJobMilestonesAction,
  setJobMilestoneCustomerVisibleAction,
  type JobMilestoneActionState,
} from "@/app/actions/job-milestones";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  CUSTOMER_HIDDEN_BY_DEFAULT_MESSAGE,
  MAX_JOB_MILESTONES,
  NO_AUTOMATIC_MESSAGE_MESSAGE,
  type OwnerJobMilestoneView,
} from "@/lib/job-milestones";

const initialState: JobMilestoneActionState = {};

export function JobMilestonesCard({
  jobId,
  milestones,
  canManage,
}: {
  jobId: string;
  milestones: OwnerJobMilestoneView[];
  canManage: boolean;
}) {
  return (
    <div className="space-y-4">
      {milestones.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No owner-recorded milestones yet. Job status, invoices, and crew
          checklists do not create these.
        </p>
      ) : (
        <ol className="space-y-3">
          {milestones.map((milestone, index) => (
            <MilestoneRow
              key={milestone.id}
              milestone={milestone}
              index={index}
              canManage={canManage}
            />
          ))}
        </ol>
      )}
      {canManage && milestones.length < MAX_JOB_MILESTONES ? (
        <RecordMilestonesForm jobId={jobId} remaining={MAX_JOB_MILESTONES - milestones.length} />
      ) : null}
      {canManage ? (
        <p className="text-xs text-muted-foreground">{NO_AUTOMATIC_MESSAGE_MESSAGE}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only the owner can record or complete milestones.
        </p>
      )}
    </div>
  );
}

function MilestoneRow({
  milestone,
  index,
  canManage,
}: {
  milestone: OwnerJobMilestoneView;
  index: number;
  canManage: boolean;
}) {
  return (
    <li className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {index + 1}. {milestone.title}
        </span>
        <Badge variant={milestone.status === "COMPLETED" ? "success" : "secondary"}>
          {milestone.statusLabel}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {milestone.customerVisible ? "Shown to customer" : "Hidden from customer"}
        </span>
      </div>
      {milestone.completedAtLabel ? (
        <p className="text-xs text-muted-foreground">Completed {milestone.completedAtLabel}</p>
      ) : (
        <p className="text-xs text-muted-foreground">Not yet marked complete</p>
      )}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {milestone.status === "OPEN" ? (
            <CompleteMilestoneForm milestoneId={milestone.id} />
          ) : null}
          <VisibilityForm
            milestoneId={milestone.id}
            customerVisible={milestone.customerVisible}
          />
        </div>
      ) : null}
    </li>
  );
}

function RecordMilestonesForm({
  jobId,
  remaining,
}: {
  jobId: string;
  remaining: number;
}) {
  const [state, formAction, pending] = useActionState(
    recordJobMilestonesAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="jobId" value={jobId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`job-milestones-${jobId}`}>
          Record milestones in order (one per line, up to {remaining})
        </Label>
        <textarea
          id={`job-milestones-${jobId}`}
          name="titles"
          rows={Math.min(4, remaining)}
          className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
          placeholder={"Materials ordered\nSite prep\nInstall"}
          required
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="customerVisible" value="1" />
        Show these to the customer on their project link
      </label>
      <p className="text-xs text-muted-foreground">
        {CUSTOMER_HIDDEN_BY_DEFAULT_MESSAGE}
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record milestones"}
      </Button>
    </form>
  );
}

function CompleteMilestoneForm({ milestoneId }: { milestoneId: string }) {
  const [state, formAction, pending] = useActionState(
    completeJobMilestoneAction,
    initialState,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Mark this milestone complete? This cannot be undone.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="milestoneId" value={milestoneId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Mark complete"}
      </Button>
    </form>
  );
}

function VisibilityForm({
  milestoneId,
  customerVisible,
}: {
  milestoneId: string;
  customerVisible: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setJobMilestoneCustomerVisibleAction,
    initialState,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <input
        type="hidden"
        name="customerVisible"
        value={customerVisible ? "0" : "1"}
      />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending
          ? "Saving…"
          : customerVisible
            ? "Hide from customer"
            : "Show to customer"}
      </Button>
    </form>
  );
}
