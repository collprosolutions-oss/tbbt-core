"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { logLead, type LogLeadActionState } from "@/app/actions/request";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  OWNER_LEAD_CHANNEL_LABELS,
  OWNER_LEAD_CHANNELS,
} from "@/lib/owner-log-lead";
import { US_STATES } from "@/lib/service-address";

const initialState: LogLeadActionState = {};

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

type CatalogOption = {
  id: string;
  name: string;
};

function customerLabel(customer: CustomerOption) {
  const details = [customer.phone, customer.email].filter(Boolean).join(" · ");
  return details ? `${customer.name} — ${details}` : customer.name;
}

export function LogLeadForm({
  customers,
  catalogItems,
}: {
  customers: CustomerOption[];
  catalogItems: CatalogOption[];
}) {
  const [mode, setMode] = useState<"existing" | "new">(
    customers.length > 0 ? "existing" : "new",
  );
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [propertyChoice, setPropertyChoice] = useState(
    customers[0]?.properties[0]?.id ?? "none",
  );
  const [state, action, pending] = useActionState(logLead, initialState);
  const submissionIdRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, "")
      : `lead${Date.now()}`,
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

  function handleModeChange(next: "existing" | "new") {
    setMode(next);
    if (next === "new") {
      setPropertyChoice("none");
    } else {
      setPropertyChoice(selectedCustomer?.properties[0]?.id ?? "none");
    }
  }

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="submissionId" value={submissionIdRef.current} />

      <div className="space-y-2">
        <Label htmlFor="channel">Lead source</Label>
        <select
          id="channel"
          name="channel"
          defaultValue="PHONE"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          {OWNER_LEAD_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {OWNER_LEAD_CHANNEL_LABELS[channel]}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Customer</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="customerSource"
            checked={mode === "existing"}
            disabled={customers.length === 0}
            onChange={() => handleModeChange("existing")}
          />
          Existing customer
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="customerSource"
            checked={mode === "new"}
            onChange={() => handleModeChange("new")}
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
                Optional. Skip it if you do not have the property yet.
              </p>
              <input type="hidden" name="propertyChoice" value={propertyChoice} />
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="propertyChoiceDisplay"
                  checked={propertyChoice === "none"}
                  onChange={() => setPropertyChoice("none")}
                />
                <span>No property yet</span>
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
                <span>New property</span>
              </label>
              {propertyChoice === "new" ? <StructuredAddressFields /> : null}
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
            <Input id="email" name="email" type="email" autoComplete="email" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Service address</legend>
            <p className="text-sm text-muted-foreground">
              Optional. Skip it if you do not have the property yet.
            </p>
            <input type="hidden" name="propertyChoice" value={propertyChoice} />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="propertyChoiceDisplay"
                checked={propertyChoice === "none"}
                onChange={() => setPropertyChoice("none")}
              />
              <span>No property yet</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="propertyChoiceDisplay"
                checked={propertyChoice === "new"}
                onChange={() => setPropertyChoice("new")}
              />
              <span>New property</span>
            </label>
            {propertyChoice === "new" ? <StructuredAddressFields /> : null}
          </fieldset>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="summary">Scope / summary</Label>
        <Input
          id="summary"
          name="summary"
          required
          placeholder="Kitchen faucet leak"
        />
      </div>

      {catalogItems.length > 0 ? (
        <div className="space-y-2">
          <Label htmlFor="serviceCatalogItemId">Service (optional)</Label>
          <select
            id="serviceCatalogItemId"
            name="serviceCatalogItemId"
            defaultValue=""
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">No service yet</option>
            {catalogItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm"
          placeholder="Anything useful from the call"
        />
      </div>

      <Button type="submit" disabled={pending || (mode === "existing" && customers.length === 0)}>
        {pending ? "Saving…" : "Log lead"}
      </Button>
    </form>
  );
}

function StructuredAddressFields() {
  return (
    <div className="space-y-3 pl-6">
      <div className="space-y-2">
        <Label htmlFor="streetAddress">Street address</Label>
        <Input
          id="streetAddress"
          name="streetAddress"
          autoComplete="address-line1"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="unit">Unit / apt (optional)</Label>
        <Input id="unit" name="unit" autoComplete="address-line2" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="city">City</Label>
          <Input id="city" name="city" autoComplete="address-level2" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="region">State</Label>
          <select
            id="region"
            name="region"
            required
            defaultValue=""
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="" disabled>
              State
            </option>
            {US_STATES.map((state) => (
              <option key={state.code} value={state.code}>
                {state.code}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="postalCode">ZIP</Label>
          <Input
            id="postalCode"
            name="postalCode"
            autoComplete="postal-code"
            required
          />
        </div>
      </div>
    </div>
  );
}
