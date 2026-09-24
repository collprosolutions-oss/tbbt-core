"use client";

import { useActionState } from "react";
import {
  updateBusinessPublicContactSettings,
  type SettingsActionState,
} from "@/app/actions/settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SettingsActionState = {};

export function BusinessPublicContactForm({
  phone,
  email,
  website,
  serviceArea,
  fallbackPhone,
  canEdit,
}: {
  phone: string;
  email: string;
  website: string;
  serviceArea: string;
  fallbackPhone: string | null;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    updateBusinessPublicContactSettings,
    initialState,
  );

  if (!canEdit) {
    return (
      <div className="space-y-1 text-sm">
        <p>
          Phone:{" "}
          <span className="font-medium text-foreground">
            {phone || fallbackPhone || "Not set"}
          </span>
        </p>
        <p>
          Email:{" "}
          <span className="font-medium text-foreground">{email || "Not set"}</span>
        </p>
        <p>
          Website:{" "}
          <span className="font-medium text-foreground">
            {website || "Not set"}
          </span>
        </p>
        <p>
          Service area:{" "}
          <span className="font-medium text-foreground">
            {serviceArea || "Not set"}
          </span>
        </p>
        <p className="text-muted-foreground">
          Only the owner can change customer-facing contact information.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Shown on customer estimates, invoices, and the public website. Leave
        phone blank to keep the existing public number
        {fallbackPhone ? ` (${fallbackPhone})` : " if one is already on file"}.
        Email and website appear only after they are saved. Service area is the
        short label shown on the public site. This does not rewrite sent prices
        or paid invoices.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="publicPhone">Phone</Label>
          <Input
            id="publicPhone"
            name="publicPhone"
            defaultValue={phone}
            autoComplete="tel"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="publicEmail">Email</Label>
          <Input
            id="publicEmail"
            name="publicEmail"
            type="email"
            defaultValue={email}
            autoComplete="email"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="publicWebsite">Website</Label>
          <Input
            id="publicWebsite"
            name="publicWebsite"
            type="url"
            defaultValue={website}
            placeholder="https://your-business-site.example"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="publicServiceAreaLabel">Primary service area</Label>
          <Input
            id="publicServiceAreaLabel"
            name="publicServiceAreaLabel"
            defaultValue={serviceArea}
            placeholder="e.g. Reno, NV"
          />
        </div>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save contact information"}
      </Button>
    </form>
  );
}
