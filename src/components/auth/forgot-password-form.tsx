"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  requestPasswordResetAction,
  type PasswordResetRequestState,
} from "@/app/actions/password-reset";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: PasswordResetRequestState = {};

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(
    requestPasswordResetAction,
    initialState,
  );

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

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/sign-in" className="text-foreground underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
