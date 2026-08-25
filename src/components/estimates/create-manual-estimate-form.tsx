"use client";

import { useActionState, useState } from "react";
import {
  createManualEstimate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

type CustomerOption = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
};

function customerLabel(customer: CustomerOption) {
  const details = [customer.phone, customer.email].filter(Boolean).join(" · ");
  return details ? `${customer.name} — ${details}` : customer.name;
}

export function CreateManualEstimateForm({
  customers,
}: {
  customers: CustomerOption[];
}) {
  const [mode, setMode] = useState<"existing" | "new">(
    customers.length > 0 ? "existing" : "new",
  );
  const [state, action, pending] = useActionState(
    createManualEstimate,
    initialState,
  );

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <input type="hidden" name="mode" value={mode} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Customer</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="customerSource"
            checked={mode === "existing"}
            disabled={customers.length === 0}
            onChange={() => setMode("existing")}
          />
          Existing customer
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="customerSource"
            checked={mode === "new"}
            onChange={() => setMode("new")}
          />
          New customer
        </label>
      </fieldset>

      {mode === "existing" ? (
        <div className="space-y-2">
          <Label htmlFor="customerId">Choose customer</Label>
          {customers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No customers in this workspace yet. Create one below.
            </p>
          ) : (
            <select
              id="customerId"
              name="customerId"
              required
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
            >
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customerLabel(customer)}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone (optional)</Label>
            <Input id="phone" name="phone" type="tel" autoComplete="tel" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email (optional)</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">Service address (optional)</Label>
            <Input
              id="address"
              name="address"
              autoComplete="street-address"
            />
          </div>
        </div>
      )}

      <Button type="submit" disabled={pending || (mode === "existing" && customers.length === 0)}>
        {pending ? "Creating…" : "Create estimate"}
      </Button>
    </form>
  );
}
