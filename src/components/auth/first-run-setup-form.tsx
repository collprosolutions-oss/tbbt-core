"use client";

import { useActionState } from "react";
import {
  completeFirstRunSetupAction,
  type FirstRunSetupState,
} from "@/app/actions/first-run-setup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COMMON_BUSINESS_TIMEZONES } from "@/lib/business-timezone";

const initialState: FirstRunSetupState = {};

const TIMEZONE_LIST_ID = "first-run-timezone-suggestions";

export function FirstRunSetupForm({
  businessName,
  publicPhone,
  publicEmail,
  publicWebsite,
  timezone,
}: {
  businessName: string;
  publicPhone: string;
  publicEmail: string;
  publicWebsite: string;
  timezone?: string;
}) {
  const [state, action, pending] = useActionState(
    completeFirstRunSetupAction,
    initialState,
  );

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="businessName">Business name</Label>
        <Input
          id="businessName"
          name="businessName"
          defaultValue={businessName}
          autoComplete="organization"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="publicPhone">Public phone</Label>
        <Input
          id="publicPhone"
          name="publicPhone"
          defaultValue={publicPhone}
          autoComplete="tel"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="publicEmail">Public email</Label>
        <Input
          id="publicEmail"
          name="publicEmail"
          type="email"
          defaultValue={publicEmail}
          autoComplete="email"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="publicWebsite">Public website (optional)</Label>
        <Input
          id="publicWebsite"
          name="publicWebsite"
          type="url"
          defaultValue={publicWebsite}
          placeholder="https://"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="timezone">Business timezone</Label>
        <Input
          id="timezone"
          name="timezone"
          list={TIMEZONE_LIST_ID}
          defaultValue={timezone ?? ""}
          placeholder="America/Los_Angeles"
          autoComplete="off"
        />
        <datalist id={TIMEZONE_LIST_ID}>
          {COMMON_BUSINESS_TIMEZONES.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          Used for schedule, Today, and time cards. You can change this later in
          Settings. Leave blank to keep the America/New_York default.
        </p>
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Save and continue"}
      </Button>
    </form>
  );
}
