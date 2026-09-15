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

const initialState: FirstRunSetupState = {};

export function FirstRunSetupForm({
  businessName,
  publicPhone,
  publicEmail,
  publicWebsite,
}: {
  businessName: string;
  publicPhone: string;
  publicEmail: string;
  publicWebsite: string;
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

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : "Save and continue"}
      </Button>
    </form>
  );
}
