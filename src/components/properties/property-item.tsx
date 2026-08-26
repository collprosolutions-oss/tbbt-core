"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  updateCustomerProperty,
  type PropertyActionState,
} from "@/app/actions/property";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAddress } from "@/lib/format";

const initialState: PropertyActionState = {};

export type PropertyDetails = {
  id: string;
  label: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
};

export function PropertyItem({ property }: { property: PropertyDetails }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(
    updateCustomerProperty,
    initialState,
  );
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      setEditing(false);
    }
    wasPending.current = pending;
  }, [pending, state]);

  if (!editing) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {property.label ? `${property.label}: ` : null}
          {formatAddress(property)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
      </li>
    );
  }

  return (
    <li>
      <form action={formAction} className="space-y-3 rounded-lg border p-3">
        <input type="hidden" name="propertyId" value={property.id} />
        {state.error ? (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`label-${property.id}`}>Label (optional)</Label>
          <Input
            id={`label-${property.id}`}
            name="label"
            defaultValue={property.label ?? ""}
            placeholder="Home, rental unit, etc."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`addressLine1-${property.id}`}>Street address</Label>
          <Input
            id={`addressLine1-${property.id}`}
            name="addressLine1"
            defaultValue={property.addressLine1}
            autoComplete="address-line1"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`addressLine2-${property.id}`}>
            Address line 2 (optional)
          </Label>
          <Input
            id={`addressLine2-${property.id}`}
            name="addressLine2"
            defaultValue={property.addressLine2 ?? ""}
            autoComplete="address-line2"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor={`city-${property.id}`}>City</Label>
            <Input
              id={`city-${property.id}`}
              name="city"
              defaultValue={property.city ?? ""}
              autoComplete="address-level2"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`region-${property.id}`}>State</Label>
            <Input
              id={`region-${property.id}`}
              name="region"
              defaultValue={property.region ?? ""}
              autoComplete="address-level1"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`postalCode-${property.id}`}>ZIP</Label>
            <Input
              id={`postalCode-${property.id}`}
              name="postalCode"
              defaultValue={property.postalCode ?? ""}
              autoComplete="postal-code"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </form>
    </li>
  );
}
