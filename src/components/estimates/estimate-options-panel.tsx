"use client";

import { useActionState } from "react";
import {
  addDraftEstimateOption,
  collapseDraftEstimateOptions,
  removeDraftEstimateOption,
  renameDraftEstimateOption,
  startDraftEstimateOptions,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_ESTIMATE_OPTIONS } from "@/lib/estimate-options";

const initialState: EstimateActionState = {};

type OptionRow = {
  id: string;
  name: string;
  sortOrder: number;
  totalLabel: string;
  lineCount: number;
};

export function EstimateOptionsPanel({
  estimateId,
  isDraft,
  canManage,
  options,
}: {
  estimateId: string;
  isDraft: boolean;
  canManage: boolean;
  options: OptionRow[];
}) {
  if (!canManage && options.length === 0) return null;

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div>
        <h2 className="text-sm font-semibold">Priced options</h2>
        <p className="text-sm text-muted-foreground">
          OWNER can prepare two or three alternatives on a draft. Sending
          freezes them. The customer must choose one before a job can use
          this estimate.
        </p>
      </div>
      {options.length === 0 && canManage && isDraft ? (
        <StartOptionsForm estimateId={estimateId} />
      ) : null}
      {options.length > 0 ? (
        <ul className="space-y-3">
          {options.map((option) => (
            <li key={option.id} className="rounded-lg border border-border/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {option.name}{" "}
                  <span className="text-muted-foreground">
                    · {option.totalLabel} · {option.lineCount} line
                    {option.lineCount === 1 ? "" : "s"}
                  </span>
                </p>
                {canManage && isDraft ? (
                  <RemoveOptionForm estimateId={estimateId} optionId={option.id} />
                ) : null}
              </div>
              {canManage && isDraft ? (
                <RenameOptionForm
                  estimateId={estimateId}
                  optionId={option.id}
                  name={option.name}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canManage && isDraft && options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {options.length < MAX_ESTIMATE_OPTIONS ? (
            <AddOptionForm estimateId={estimateId} />
          ) : null}
          <CollapseOptionsForm estimateId={estimateId} />
        </div>
      ) : null}
    </div>
  );
}

function ActionMessage({ state }: { state: EstimateActionState }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  if (state.message) {
    return <p className="text-sm text-muted-foreground">{state.message}</p>;
  }
  return null;
}

function StartOptionsForm({ estimateId }: { estimateId: string }) {
  const [state, action, pending] = useActionState(startDraftEstimateOptions, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="estimateId" value={estimateId} />
      <ActionMessage state={state} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Starting…" : "Offer two priced options"}
      </Button>
    </form>
  );
}

function AddOptionForm({ estimateId }: { estimateId: string }) {
  const [state, action, pending] = useActionState(addDraftEstimateOption, initialState);
  return (
    <form action={action}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <ActionMessage state={state} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Adding…" : "Add a third option"}
      </Button>
    </form>
  );
}

function CollapseOptionsForm({ estimateId }: { estimateId: string }) {
  const [state, action, pending] = useActionState(
    collapseDraftEstimateOptions,
    initialState,
  );
  return (
    <form action={action}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <ActionMessage state={state} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        {pending ? "Removing…" : "Remove priced options"}
      </Button>
    </form>
  );
}

function RenameOptionForm({
  estimateId,
  optionId,
  name,
}: {
  estimateId: string;
  optionId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(renameDraftEstimateOption, initialState);
  return (
    <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="optionId" value={optionId} />
      <Input name="name" defaultValue={name} className="h-8 max-w-xs" required />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Rename"}
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

function RemoveOptionForm({
  estimateId,
  optionId,
}: {
  estimateId: string;
  optionId: string;
}) {
  const [state, action, pending] = useActionState(removeDraftEstimateOption, initialState);
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (
          !window.confirm(
            "Remove this option and delete its line items? This cannot be undone.",
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="optionId" value={optionId} />
      <ActionMessage state={state} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      <p className="mt-1 text-xs text-muted-foreground">
        Removes this option and deletes its line items.
      </p>
    </form>
  );
}
