"use client";

import { useActionState } from "react";
import {
  approveOperatingProcedureAction,
  createOperatingProcedureAction,
  type ProcedureActionState,
} from "@/app/actions/operating-procedures";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { KnowledgeSource } from "@/lib/knowledge-data";

const initial: ProcedureActionState = {};

export function ProcedurePanel({ source }: { source: KnowledgeSource }) {
  const [createState, createAction, createPending] = useActionState(createOperatingProcedureAction, initial);
  const [approveState, approveAction, approvePending] = useActionState(approveOperatingProcedureAction, initial);

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Procedures / checklists</CardTitle>
        <CardDescription>
          Reusable operating steps linked to a service or trade. This is not a workflow engine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {source.procedures.map((procedure) => (
          <div key={procedure.id} className="rounded-md border p-3 space-y-2">
            <p className="font-medium">{procedure.title}</p>
            <p className="text-xs text-muted-foreground">
              {procedure.approvalState} · {procedure.stepCount} steps
              {procedure.tradeCode ? ` · ${procedure.tradeCode}` : ""}
            </p>
            <ol className="list-decimal pl-5 text-sm">
              {procedure.steps.map((step) => (
                <li key={step.id}>{step.title}</li>
              ))}
            </ol>
            {procedure.approvalState !== "APPROVED" ? (
              <form action={approveAction}>
                <input type="hidden" name="procedureId" value={procedure.id} />
                <input type="hidden" name="approvalState" value="APPROVED" />
                <Button type="submit" size="sm" disabled={approvePending}>
                  Approve and save as knowledge
                </Button>
              </form>
            ) : null}
          </div>
        ))}
        <form action={createAction} className="space-y-2">
          <Label htmlFor="procedure-title">New procedure</Label>
          <Input id="procedure-title" name="title" required placeholder="First-visit checklist" />
          <textarea
            name="summary"
            placeholder="When to use it"
            className="min-h-16 w-full rounded-md border bg-background p-2 text-sm"
          />
          <textarea
            name="steps"
            required
            placeholder={"Confirm the work\nPhotograph existing conditions\nNote extras before doing them"}
            className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
          />
          <Button type="submit" size="sm" disabled={createPending}>
            Save checklist
          </Button>
        </form>
        {createState.error || approveState.error ? (
          <p className="text-xs text-destructive">{createState.error || approveState.error}</p>
        ) : null}
        {createState.message || approveState.message ? (
          <p className="text-xs text-muted-foreground">{createState.message || approveState.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
