"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  addCustomerProperty,
  type PropertyActionState,
} from "@/app/actions/property";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: PropertyActionState = {};

export function AddPropertyForm({ customerId }: { customerId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    addCustomerProperty,
    initialState,
  );
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      setOpen(false);
    }
    wasPending.current = pending;
  }, [pending, state]);

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        Add another address
      </Button>
    );
  }

  return (
    <form action={formAction} className="space-y-3 rounded-lg border p-3">
      <input type="hidden" name="customerId" value={customerId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="new-label">Label (optional)</Label>
        <Input id="new-label" name="label" placeholder="Home, rental unit, etc." />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-addressLine1">Street address</Label>
        <Input
          id="new-addressLine1"
          name="addressLine1"
          autoComplete="address-line1"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-addressLine2">Address line 2 (optional)</Label>
        <Input
          id="new-addressLine2"
          name="addressLine2"
          autoComplete="address-line2"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="new-city">City</Label>
          <Input id="new-city" name="city" autoComplete="address-level2" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-region">State</Label>
          <Input id="new-region" name="region" autoComplete="address-level1" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-postalCode">ZIP</Label>
          <Input
            id="new-postalCode"
            name="postalCode"
            autoComplete="postal-code"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save address"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
