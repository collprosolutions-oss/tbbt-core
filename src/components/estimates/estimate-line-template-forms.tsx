"use client";

import { useActionState } from "react";
import {
  applyEstimateLineTemplate,
  saveEstimateLineTemplate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NO_CATALOG_PRICE_WRITE_MESSAGE,
  NO_PUBLIC_HOURLY_PRICE_MESSAGE,
  REVIEW_BEFORE_SEND_MESSAGE,
} from "@/lib/estimate-line-templates";

const initialState: EstimateActionState = {};

export type EstimateTemplateOption = {
  id: string;
  name: string;
  lineCount: number;
};

export function SaveEstimateLineTemplateForm({
  estimateId,
  canSave,
}: {
  estimateId: string;
  canSave: boolean;
}) {
  const [state, action, pending] = useActionState(
    saveEstimateLineTemplate,
    initialState,
  );

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      <input type="hidden" name="estimateId" value={estimateId} />
      <div className="space-y-2">
        <Label htmlFor="template-name">Template name</Label>
        <Input
          id="template-name"
          name="name"
          required
          maxLength={80}
          disabled={!canSave || pending}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {NO_CATALOG_PRICE_WRITE_MESSAGE} {NO_PUBLIC_HOURLY_PRICE_MESSAGE}
      </p>
      <Button type="submit" disabled={!canSave || pending}>
        {pending ? "Saving…" : "Save as estimate template"}
      </Button>
    </form>
  );
}

export function ApplyEstimateLineTemplateForm({
  estimateId,
  templates,
}: {
  estimateId: string;
  templates: EstimateTemplateOption[];
}) {
  const [state, action, pending] = useActionState(
    applyEstimateLineTemplate,
    initialState,
  );

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No named templates in this workspace yet. Save one from a draft, then
        apply it here. {REVIEW_BEFORE_SEND_MESSAGE}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      <input type="hidden" name="estimateId" value={estimateId} />
      <div className="space-y-2">
        <Label htmlFor="apply-templateId">Named template</Label>
        <select
          id="apply-templateId"
          name="templateId"
          required
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({template.lineCount} line
              {template.lineCount === 1 ? "" : "s"})
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        {REVIEW_BEFORE_SEND_MESSAGE} {NO_CATALOG_PRICE_WRITE_MESSAGE}
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Applying…" : "Apply template to this draft"}
      </Button>
    </form>
  );
}
