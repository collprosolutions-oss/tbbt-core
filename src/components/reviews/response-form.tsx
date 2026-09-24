"use client";

import { useActionState, useEffect, useState } from "react";
import { upsertReviewResponseAction, type ReviewsActionState } from "@/app/actions/reviews";
import { draftReviewResponseAssistAction, type AiActionState } from "@/app/actions/ai";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { WritingAssistBar } from "@/components/ai/writing-assist-bar";

const initial: ReviewsActionState = {};
const assistInitial: AiActionState = {};

export function ResponseForm({
  reviewId,
  body,
}: {
  reviewId: string;
  body: string;
}) {
  const [draft, setDraft] = useState(body);
  const [state, formAction, pending] = useActionState(upsertReviewResponseAction, initial);
  const [assist, assistAction, assistPending] = useActionState(draftReviewResponseAssistAction, assistInitial);
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (assist.text) setDraft(assist.text);
  }, [assist.text]);

  useEffect(() => {
    if (assist.text || assist.error || assist.message) {
      setAttemptId(crypto.randomUUID());
    }
  }, [assist.text, assist.error, assist.message]);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <input type="hidden" name="attemptId" value={attemptId} />
      <Label htmlFor={`response-${reviewId}`}>Response draft</Label>
      <textarea
        id={`response-${reviewId}`}
        name="body"
        rows={4}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <WritingAssistBar original={draft} onSuggestion={setDraft} />
      <Button formAction={assistAction} type="submit" name="reviewId" value={reviewId} size="sm" variant="outline" disabled={assistPending}>
        {assistPending ? "Drafting…" : "AI response draft"}
      </Button>
      {assist.text ? (
        <button type="button" className="block w-full rounded-md border p-2 text-left text-xs" onClick={() => setDraft(assist.text || draft)}>
          Suggested: {assist.text}
        </button>
      ) : null}
      {assist.message ? <p className="text-xs text-muted-foreground">{assist.message}</p> : null}
      <p className="text-xs text-muted-foreground">
        Do not invent facts about the customer&apos;s job. This draft is not published.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save response draft"}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
