"use client";

import { useActionState, useMemo, useState } from "react";
import {
  updateEstimateTerms,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import {
  PROJECT_CONDITIONS_POLICY_ID,
  PROJECT_CONDITIONS_TITLE,
  TERMS_AND_CONDITIONS_TITLE,
} from "@/lib/estimate-terms/types";

const initialState: EstimateActionState = {};

export function EstimateTermsEditor({
  estimateId,
  policies,
}: {
  estimateId: string;
  policies: CalculatorCustomerPolicy[];
}) {
  const [state, action, pending] = useActionState(
    updateEstimateTerms,
    initialState,
  );
  const [items, setItems] = useState(policies);
  const [customTitle, setCustomTitle] = useState("");
  const [customBody, setCustomBody] = useState("");

  const project = items.find(
    (policy) =>
      policy.id === PROJECT_CONDITIONS_POLICY_ID || policy.family === "project",
  );
  const terms = items.filter(
    (policy) =>
      policy.id !== PROJECT_CONDITIONS_POLICY_ID && policy.family !== "project",
  );
  const payload = useMemo(() => JSON.stringify(items), [items]);

  function updateTerm(id: string, patch: Partial<CalculatorCustomerPolicy>) {
    setItems((current) =>
      current.map((policy) =>
        policy.id === id ? { ...policy, ...patch } : policy,
      ),
    );
  }

  function addCustomTerm() {
    const title = customTitle.trim();
    const body = customBody.trim();
    if (!title || !body) return;
    setItems((current) => [
      ...current,
      {
        id: `business-${crypto.randomUUID()}`,
        family: "business",
        title,
        body,
      },
    ]);
    setCustomTitle("");
    setCustomBody("");
  }

  return (
    <div className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : null}
      {project ? (
        <section>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground">
            {PROJECT_CONDITIONS_TITLE}
          </p>
          <p className="mt-2 whitespace-pre-line text-xs leading-snug">
            {project.body}
          </p>
        </section>
      ) : null}
      <section className="space-y-3">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground">
          {TERMS_AND_CONDITIONS_TITLE}
        </p>
        {terms.map((policy) => (
          <div key={policy.id} className="space-y-1 rounded-lg border border-border/60 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor={`term-${policy.id}`} className="text-sm">
                {policy.title}
              </Label>
              {policy.optional ? (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={!policy.disabled}
                    onChange={(event) =>
                      updateTerm(policy.id, { disabled: !event.target.checked })
                    }
                  />
                  Include on this estimate
                </label>
              ) : null}
            </div>
            <textarea
              id={`term-${policy.id}`}
              rows={3}
              value={policy.body}
              onChange={(event) => updateTerm(policy.id, { body: event.target.value })}
              className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug"
            />
          </div>
        ))}
      </section>
      <section className="space-y-2 rounded-lg border border-dashed border-border p-2">
        <p className="text-sm font-medium">Add estimate-specific term</p>
        <Input
          value={customTitle}
          onChange={(event) => setCustomTitle(event.target.value)}
          placeholder="Title"
        />
        <textarea
          rows={3}
          value={customBody}
          onChange={(event) => setCustomBody(event.target.value)}
          placeholder="Wording for this estimate only"
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-xs"
        />
        <Button type="button" size="sm" variant="outline" onClick={addCustomTerm}>
          Add term
        </Button>
      </section>
      <form action={action}>
        <input type="hidden" name="estimateId" value={estimateId} />
        <input type="hidden" name="termsJson" value={payload} />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save terms"}
        </Button>
      </form>
    </div>
  );
}
