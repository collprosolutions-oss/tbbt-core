"use client";

import { useActionState, useState } from "react";
import {
  sendProjectConversationReplyAction,
  type ProjectConversationActionState,
} from "@/app/actions/project-conversation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import {
  MAX_PROJECT_CONVERSATION_BODY_LENGTH,
  PROJECT_CONVERSATION_OWNER_CHANNELS,
  PROJECT_CONVERSATION_OWNER_WORKFLOW_MESSAGE,
  PROJECT_CONVERSATION_SUBJECT,
} from "@/lib/project-conversation";
import {
  nextCommunicationAttemptId,
  shouldRotateCommunicationSendAttemptId,
} from "@/lib/communications/compose-flow";
import type { OwnerProjectConversationReview } from "@/lib/project-conversation-data";

const initialState: ProjectConversationActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

function directionLabel(direction: "INBOUND" | "OUTBOUND") {
  return direction === "INBOUND" ? "Customer" : "Owner reply";
}

export function ProjectConversationPanel({
  review,
}: {
  review: OwnerProjectConversationReview;
}) {
  const [attemptId, setAttemptId] = useState(newAttemptId);
  const [state, formAction, pending] = useActionState(
    async (prev: ProjectConversationActionState, formData: FormData) => {
      const result = await sendProjectConversationReplyAction(prev, formData);
      setAttemptId((current) =>
        nextCommunicationAttemptId(
          current,
          result,
          shouldRotateCommunicationSendAttemptId,
          newAttemptId,
        ),
      );
      return result;
    },
    initialState,
  );

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">{review.workflowMessage}</p>
      {review.messages.length === 0 ? (
        <p className="text-muted-foreground">No project conversation yet.</p>
      ) : (
        review.messages.map((message) => (
          <div key={message.id} className="space-y-1 rounded-lg border p-3">
            <p className="font-medium">
              {directionLabel(message.direction)}
              {" · "}
              {message.channel}
              {" · "}
              {message.status}
            </p>
            <p className="text-muted-foreground">
              {formatDateTime(message.occurredAt, review.timeZone)}
            </p>
            {message.body.trim() ? (
              <p className="whitespace-pre-line">{message.body}</p>
            ) : null}
          </div>
        ))
      )}

      {review.canReply ? (
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="jobId" value={review.jobId} />
          <input type="hidden" name="attemptId" value={attemptId} />
          <input type="hidden" name="subject" value={PROJECT_CONVERSATION_SUBJECT} />
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
            <Label htmlFor="job-project-conversation-channel">Channel</Label>
            <select
              id="job-project-conversation-channel"
              name="channel"
              required
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              defaultValue="EMAIL"
            >
              {PROJECT_CONVERSATION_OWNER_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel === "EMAIL" ? "Email" : "SMS"}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="job-project-conversation-body">Reply</Label>
            <textarea
              id="job-project-conversation-body"
              name="body"
              required
              rows={4}
              maxLength={MAX_PROJECT_CONVERSATION_BODY_LENGTH}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="Reply to this customer about this job."
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {PROJECT_CONVERSATION_OWNER_WORKFLOW_MESSAGE}
          </p>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground">
          {review.eligible
            ? "This project conversation has reached its message limit. Opening this page does not send a message."
            : "Replies are only available on an active Handyman job. Opening this page does not send a message."}
        </p>
      )}
    </div>
  );
}
