"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  installOnboardingStarterServicesAction,
  skipOnboardingStarterServicesAction,
  type StarterServicesSetupState,
} from "@/app/actions/starter-services-setup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

const initialState: StarterServicesSetupState = {};

export function StarterServicesSetupForm() {
  const [state, installAction, pending] = useActionState(
    installOnboardingStarterServicesAction,
    initialState,
  );

  if (state.installed) {
    return (
      <div className="space-y-4">
        {state.message ? (
          <Alert>
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        ) : null}
        <Link href="/dashboard" className={buttonVariants({ className: "w-full" })}>
          Continue to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <form action={installAction}>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Adding…" : "Add Handyman Starter Services"}
        </Button>
      </form>

      <form action={skipOnboardingStarterServicesAction}>
        <Button type="submit" variant="outline" className="w-full" disabled={pending}>
          Skip for now
        </Button>
      </form>
    </div>
  );
}
