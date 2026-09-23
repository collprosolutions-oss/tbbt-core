"use client";

import { useActionState } from "react";
import {
  completePasswordResetAction,
  type PasswordResetCompleteState,
} from "@/app/actions/password-reset";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: PasswordResetCompleteState = {};

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(
    completePasswordResetAction,
    initialState,
  );

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
