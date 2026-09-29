"use client";

import { useActionState, useState } from "react";
import {
  recordEquipmentItemAction,
  type EquipmentActionState,
} from "@/app/actions/equipment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EQUIPMENT_KIND_LABELS, EQUIPMENT_KINDS } from "@/lib/equipment";
import type { EquipmentWorkspace } from "@/lib/equipment";

const initial: EquipmentActionState = {};

export function RecordEquipmentItemForm({ workspace }: { workspace: EquipmentWorkspace }) {
  const [state, formAction, pending] = useActionState(recordEquipmentItemAction, initial);
  const [attemptKey] = useState(() => crypto.randomUUID());

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="attemptKey" value={attemptKey} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="equipment-kind">Kind</Label>
          <select
            id="equipment-kind"
            name="kind"
            defaultValue="TOOL"
            className="block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
          >
            {EQUIPMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {EQUIPMENT_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="equipment-name">Name</Label>
          <Input id="equipment-name" name="name" placeholder="Shop vac, van, ladder…" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="equipment-service-on">Service date</Label>
          <Input id="equipment-service-on" name="serviceOn" type="date" />
          <p className="text-xs text-muted-foreground">
            Optional. Due uses this recorded date only.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="equipment-purchase">Purchase expense</Label>
          <select
            id="equipment-purchase"
            name="purchaseExpenseId"
            className="block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
          >
            <option value="">None</option>
            {workspace.purchaseChoices.map((expense) => (
              <option key={expense.id} value={expense.id}>
                {expense.occurredOn} · {expense.description}
              </option>
            ))}
          </select>
          {workspace.purchaseChoiceOverflow ? (
            <p className="text-xs text-muted-foreground">
              Showing {workspace.purchaseChoices.length} unused purchase expenses, capped at{" "}
              {workspace.purchaseChoiceLimit}.
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="equipment-notes">Notes</Label>
        <textarea
          id="equipment-notes"
          name="notes"
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Recording…" : "Record item"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
