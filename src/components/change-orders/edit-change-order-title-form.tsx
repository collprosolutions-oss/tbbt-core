"use client";

import { useActionState, useState } from "react";
import {
  updateChangeOrderTitle,
  type ChangeOrderActionState,
} from "@/app/actions/change-order";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: ChangeOrderActionState = {};

export function EditChangeOrderTitleForm({
  changeOrderId,
  title,
}: {
  changeOrderId: string;
  title: string;
}) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(
    updateChangeOrderTitle,
    initialState,
  );

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditing(true)}
        >
          Edit title
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="changeOrderId" value={changeOrderId} />
      <Input name="title" defaultValue={title} required className="max-w-sm" />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
      {state.error ? (
        <p className="w-full text-sm text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
