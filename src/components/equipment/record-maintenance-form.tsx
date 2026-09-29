"use client";

import { useActionState, useState } from "react";
import {
  recordEquipmentMaintenanceAction,
  type EquipmentActionState,
} from "@/app/actions/equipment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EquipmentItemView } from "@/lib/equipment";

const initial: EquipmentActionState = {};

export function RecordEquipmentMaintenanceForm({ item }: { item: EquipmentItemView }) {
  const [state, formAction, pending] = useActionState(
    recordEquipmentMaintenanceAction,
    initial,
  );
  const [attemptKey] = useState(() => crypto.randomUUID());

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="attemptKey" value={attemptKey} />
      <input type="hidden" name="equipmentId" value={item.id} />
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`maintenance-on-${item.id}`}>Date</Label>
          <Input id={`maintenance-on-${item.id}`} name="occurredOn" type="date" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`maintenance-notes-${item.id}`}>What was done</Label>
          <Input
            id={`maintenance-notes-${item.id}`}
            name="notes"
            placeholder="Oil change, blade sharpen…"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Record maintenance"}
        </Button>
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
