"use client";

import { useActionState } from "react";
import {
  addChangeOrderLineItem,
  type ChangeOrderActionState,
} from "@/app/actions/change-order";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: ChangeOrderActionState = {};

export function AddChangeOrderLineItemForm({
  changeOrderId,
}: {
  changeOrderId: string;
}) {
  const [state, action, pending] = useActionState(
    addChangeOrderLineItem,
    initialState,
  );

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <input type="hidden" name="changeOrderId" value={changeOrderId} />
      <div className="space-y-2">
        <Label htmlFor="co-line-type">Type</Label>
        <select
          id="co-line-type"
          name="type"
          defaultValue="LABOR"
          required
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="LABOR">Labor</option>
          <option value="MATERIAL">Material</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="co-line-description">Description</Label>
        <Input id="co-line-description" name="description" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="co-line-quantity">Quantity</Label>
        <Input
          id="co-line-quantity"
          name="quantity"
          inputMode="decimal"
          defaultValue="1"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="co-line-unitPrice">Unit price</Label>
        <Input id="co-line-unitPrice" name="unitPrice" inputMode="decimal" required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add line item"}
      </Button>
    </form>
  );
}
