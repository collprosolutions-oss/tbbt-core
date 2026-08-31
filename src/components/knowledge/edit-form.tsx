"use client";

import { useActionState } from "react";
import { updateKnowledgeEntryAction, type KnowledgeActionState } from "@/app/actions/knowledge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_TRUST_LABELS,
  KNOWLEDGE_TRUST_STATES,
} from "@/lib/knowledge";
import type { KnowledgeEntryView } from "@/lib/knowledge-data";

const initial: KnowledgeActionState = {};

export function KnowledgeEditForm({ entry }: { entry: KnowledgeEntryView }) {
  const [state, formAction, pending] = useActionState(updateKnowledgeEntryAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="entryId" value={entry.id} />
      <div className="space-y-1.5">
        <Label htmlFor={`edit-category-${entry.id}`}>Category</Label>
        <select
          id={`edit-category-${entry.id}`}
          name="category"
          defaultValue={entry.category}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {KNOWLEDGE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {KNOWLEDGE_CATEGORY_LABELS[category]}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-title-${entry.id}`}>Title</Label>
        <Input id={`edit-title-${entry.id}`} name="title" defaultValue={entry.title} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-body-${entry.id}`}>Knowledge / Notes</Label>
        <textarea
          id={`edit-body-${entry.id}`}
          name="body"
          rows={5}
          defaultValue={entry.body}
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`edit-trust-${entry.id}`}>Confidence / trust</Label>
        <select
          id={`edit-trust-${entry.id}`}
          name="trustState"
          defaultValue={entry.trustState}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {KNOWLEDGE_TRUST_STATES.map((state) => (
            <option key={state} value={state}>
              {KNOWLEDGE_TRUST_LABELS[state]}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Provenance stays {entry.sourceTypeLabel}
        {entry.sourceLabel ? ` · ${entry.sourceLabel}` : ""}. Changing trust does not rewrite the origin.
      </p>
      <Button type="submit" disabled={pending} variant="outline">
        {pending ? "Saving…" : "Save changes"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
