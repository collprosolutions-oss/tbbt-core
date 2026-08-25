"use client";

import { useActionState, useMemo, useState } from "react";
import {
  createManualEstimate,
  type EstimateActionState,
} from "@/app/actions/estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: EstimateActionState = {};

type PropertyOption = {
  id: string;
  label: string;
};

type CustomerOption = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  properties: PropertyOption[];
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
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [propertyChoice, setPropertyChoice] = useState(
    customers[0]?.properties[0]?.id ?? "none",
  );
  const [state, action, pending] = useActionState(
    createManualEstimate,
    initialState,
  );

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === customerId) ?? null,
    [customerId, customers],
  );

  function handleCustomerChange(nextId: string) {
    setCustomerId(nextId);
    const next = customers.find((customer) => customer.id === nextId);
    setPropertyChoice(next?.properties[0]?.id ?? "none");
  }

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
        <div className="space-y-4">
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
                value={customerId}
                onChange={(event) => handleCustomerChange(event.target.value)}
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

          {selectedCustomer ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Service address</legend>
              <p className="text-sm text-muted-foreground">
                This address is used if this estimate becomes a job. Choose one,
                add a new one, or continue without an address.
              </p>
              <input type="hidden" name="propertyChoice" value={propertyChoice} />
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="propertyChoiceDisplay"
                  checked={propertyChoice === "none"}
                  onChange={() => setPropertyChoice("none")}
                />
                <span>No service address</span>
              </label>
              {selectedCustomer.properties.map((property) => (
                <label key={property.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="propertyChoiceDisplay"
                    checked={propertyChoice === property.id}
                    onChange={() => setPropertyChoice(property.id)}
                  />
                  <span>{property.label}</span>
                </label>
              ))}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="propertyChoiceDisplay"
                  checked={propertyChoice === "new"}
                  onChange={() => setPropertyChoice("new")}
                />
                <span>New service address</span>
              </label>
              {propertyChoice === "new" ? (
                <div className="space-y-2 pl-6">
                  <Label htmlFor="address">New address</Label>
                  <Input
                    id="address"
                    name="address"
                    autoComplete="street-address"
                    required
                  />
                </div>
              ) : null}
            </fieldset>
          ) : null}
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
            <Label htmlFor="new-customer-address">
              Service address (optional)
            </Label>
            <Input
              id="new-customer-address"
              name="address"
              autoComplete="street-address"
            />
            <p className="text-sm text-muted-foreground">
              If entered, this address is saved on the customer and used for the
              job after approval.
            </p>
          </div>
        </div>
      )}

      <Button type="submit" disabled={pending || (mode === "existing" && customers.length === 0)}>
        {pending ? "Creating…" : "Create estimate"}
      </Button>
    </form>
  );
}
