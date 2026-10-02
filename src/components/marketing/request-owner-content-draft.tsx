"use client";

import { useActionState, useEffect, useState } from "react";
import {
  requestOwnerMarketingContentDraftAction,
  type OwnerContentDraftActionState,
} from "@/app/actions/marketing";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { shouldRotateAiAttemptId } from "@/lib/ai/types";
import {
  MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE,
  OWNER_CONTENT_DRAFT_MESSAGE,
  canRequestOwnerMarketingContentDraft,
} from "@/lib/marketing";

const initial: OwnerContentDraftActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

export function RequestOwnerContentDraftForm({
  providerConfigured,
  viewerRole,
  completedJobs,
}: {
  providerConfigured: boolean;
  viewerRole: string;
  completedJobs: Array<{ jobId: string; workPerformed: string }>;
}) {
  const [state, action, pending] = useActionState(requestOwnerMarketingContentDraftAction, initial);
  const [attemptId, setAttemptId] = useState(newAttemptId);

  useEffect(() => {
    if (shouldRotateAiAttemptId(state)) {
      setAttemptId(newAttemptId());
    }
  }, [state.text, state.error, state.inProgress, state.status]);

  if (!canRequestOwnerMarketingContentDraft(viewerRole)) {
    return <p className="text-sm text-muted-foreground">{OWNER_CONTENT_DRAFT_MESSAGE}</p>;
  }

  if (!providerConfigured) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">{MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE}</p>
        <p className="text-xs text-muted-foreground">
          The AI provider is not configured. TBBT did not invent a draft, publish a website, post,
          or send a customer message.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <form action={action} className="space-y-3">
        <input type="hidden" name="attemptId" value={attemptId} />
        <div className="space-y-1.5">
          <Label htmlFor="owner-draft-job">Completed job (optional)</Label>
          <select
            id="owner-draft-job"
            name="jobId"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            defaultValue=""
          >
            <option value="">Recorded business facts only</option>
            {completedJobs.map((job) => (
              <option key={job.jobId} value={job.jobId}>
                {job.workPerformed}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-draft-note">Owner note (optional)</Label>
          <textarea
            id="owner-draft-note"
            name="ownerNote"
            rows={3}
            maxLength={400}
            placeholder="Recorded context only. Do not add customer names, phones, or invented results."
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Requesting draft…" : "Request content draft"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        The provider writes a reviewable DRAFT only. TBBT will not publish a website, post socially,
        send a customer message, or invent business facts.
      </p>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.status === "UNAVAILABLE" ? (
        <p className="text-sm font-medium">{MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE}</p>
      ) : null}
      {state.message && state.status !== "UNAVAILABLE" ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      {state.text ? (
        <div className="rounded-md border bg-muted/40 p-2">
          <p className="text-xs font-medium">Owner-requested draft — review required</p>
          <p className="whitespace-pre-wrap text-sm">{state.text}</p>
        </div>
      ) : null}
    </div>
  );
}
