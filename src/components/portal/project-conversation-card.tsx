"use client";

import { useActionState, useState } from "react";
import {
  submitPortalProjectConversationAction,
  type PortalProjectConversationActionState,
} from "@/app/actions/portal-project-conversation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import {
  MAX_PROJECT_CONVERSATION_BODY_LENGTH,
  PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE,
} from "@/lib/project-conversation";
import {
  nextCommunicationAttemptId,
  shouldRotateCommunicationSendAttemptId,
} from "@/lib/communications/compose-flow";
import type { PortalProjectConversationView } from "@/lib/project-conversation-data";

const initialState: PortalProjectConversationActionState = {};

function newAttemptId() {
  return crypto.randomUUID();
}

function directionLabel(direction: "INBOUND" | "OUTBOUND") {
  return direction === "INBOUND" ? "You" : "Owner";
}

export function ProjectConversationCard({
  projectToken,
  view,
  timeZone,
}: {
  projectToken: string;
  view: Extract<PortalProjectConversationView, { jobId: string }>;
  timeZone: string;
}) {
  const [attemptId, setAttemptId] = useState(newAttemptId);
  const [state, formAction, pending] = useActionState(
    async (prev: PortalProjectConversationActionState, formData: FormData) => {
      const result = await submitPortalProjectConversationAction(prev, formData);
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
    <Card id="project-conversation">
      <CardHeader>
        <CardTitle>Project conversation</CardTitle>
        <CardDescription>{view.workflowMessage}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {view.messages.length === 0 ? (
          <p className="text-muted-foreground">No project messages yet.</p>
        ) : (
          view.messages.map((message) => (
            <div key={message.id} className="space-y-1 rounded-lg border p-3">
              <p className="font-medium">
                {directionLabel(message.direction)}
                {message.direction === "OUTBOUND" ? " · From us" : ""}
              </p>
              <p className="text-muted-foreground">
                {formatDateTime(message.occurredAt, timeZone)}
                {" · "}
                {message.channel}
              </p>
              {message.body.trim() ? (
                <p className="whitespace-pre-line">{message.body}</p>
              ) : null}
            </div>
          ))
        )}

        {view.canWrite ? (
          <form action={formAction} className="space-y-3">
            <input type="hidden" name="projectToken" value={projectToken} />
            <input type="hidden" name="attemptId" value={attemptId} />
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
              <Label htmlFor="portal-project-conversation-body">Message</Label>
              <textarea
                id="portal-project-conversation-body"
                name="body"
                required
                rows={4}
                maxLength={MAX_PROJECT_CONVERSATION_BODY_LENGTH}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="Ask a question about this job."
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {PROJECT_CONVERSATION_PORTAL_WORKFLOW_MESSAGE}
            </p>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Sending…" : "Send message"}
            </Button>
          </form>
        ) : view.status === "full" ? (
          <p className="text-muted-foreground">
            This project conversation has reached its message limit.
          </p>
        ) : (
          <p className="text-muted-foreground">
            This conversation is closed for new messages.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
