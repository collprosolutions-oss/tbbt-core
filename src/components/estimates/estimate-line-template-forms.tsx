"use client";

import { useActionState } from "react";
import {
  applyEstimateLineTemplate,
  archiveEstimateLineTemplateAction,
  renameEstimateLineTemplateAction,
  replaceEstimateLineTemplateLinesAction,
  restoreEstimateLineTemplateAction,
  saveEstimateLineTemplate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { ActionForm } from "@/components/action-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NO_CATALOG_PRICE_WRITE_MESSAGE,
  NO_PUBLIC_HOURLY_PRICE_MESSAGE,
  REVIEW_BEFORE_SEND_MESSAGE,
  TEMPLATE_FUTURE_ONLY_MESSAGE,
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

export type ManagedEstimateLineTemplate = {
  id: string;
  name: string;
  archived: boolean;
  lineCount: number;
};

export function ManageEstimateLineTemplates({
  templates,
  estimateId,
  canReplaceFromDraft,
}: {
  templates: ManagedEstimateLineTemplate[];
  estimateId?: string;
  canReplaceFromDraft?: boolean;
}) {
  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No named templates in this workspace yet. Save one from a draft to
        rename, replace its lines, or archive it later. {TEMPLATE_FUTURE_ONLY_MESSAGE}
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {templates.map((template) => (
        <li key={template.id} className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">{template.name}</p>
              <p className="text-sm text-muted-foreground">
                {template.lineCount} line{template.lineCount === 1 ? "" : "s"}
              </p>
            </div>
            {template.archived ? (
              <Badge variant="outline">Archived</Badge>
            ) : (
              <Badge variant="secondary">Active</Badge>
            )}
          </div>

          <ActionForm action={renameEstimateLineTemplateAction} className="flex flex-wrap items-end gap-2">
            {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
            <input type="hidden" name="templateId" value={template.id} />
            <div className="min-w-48 flex-1 space-y-1">
              <Label htmlFor={`rename-template-${template.id}`}>Rename</Label>
              <Input
                id={`rename-template-${template.id}`}
                name="name"
                defaultValue={template.name}
                required
                maxLength={80}
              />
            </div>
            <Button type="submit" size="sm" variant="outline">
              Rename template
            </Button>
          </ActionForm>

          {estimateId && canReplaceFromDraft && !template.archived ? (
            <ActionForm action={replaceEstimateLineTemplateLinesAction}>
              <input type="hidden" name="estimateId" value={estimateId} />
              <input type="hidden" name="templateId" value={template.id} />
              <Button type="submit" size="sm" variant="outline">
                Replace saved lines from this draft
              </Button>
            </ActionForm>
          ) : null}

          {template.archived ? (
            <ActionForm action={restoreEstimateLineTemplateAction}>
              {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
              <input type="hidden" name="templateId" value={template.id} />
              <Button type="submit" size="sm" variant="outline">
                Restore
              </Button>
            </ActionForm>
          ) : (
            <ActionForm action={archiveEstimateLineTemplateAction}>
              {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
              <input type="hidden" name="templateId" value={template.id} />
              <Button type="submit" size="sm" variant="outline">
                Archive
              </Button>
            </ActionForm>
          )}
        </li>
      ))}
      <li className="text-xs text-muted-foreground">{TEMPLATE_FUTURE_ONLY_MESSAGE}</li>
    </ul>
  );
}
