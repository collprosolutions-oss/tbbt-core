"use client";

import { useActionState } from "react";
import {
  addCustomLineItem,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

export function AddCustomLineForm({ estimateId }: { estimateId: string }) {
  const [state, action, pending] = useActionState(addCustomLineItem, initialState);

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <input type="hidden" name="estimateId" value={estimateId} />
      <div className="space-y-2">
        <Label htmlFor="custom-description">Description</Label>
        <Input id="custom-description" name="description" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="custom-quantity">Quantity</Label>
        <Input
          id="custom-quantity"
          name="quantity"
          inputMode="decimal"
          defaultValue="1"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="custom-unitPrice">Unit price</Label>
        <Input
          id="custom-unitPrice"
          name="unitPrice"
          inputMode="decimal"
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add custom item"}
      </Button>
    </form>
  );
}
