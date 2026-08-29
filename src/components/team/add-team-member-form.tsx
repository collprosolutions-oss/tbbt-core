"use client";

import { useActionState } from "react";
import { addTeamMember, type TeamActionState } from "@/app/actions/team";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopySetupLinkButton } from "@/components/team/copy-setup-link-button";

const initialState: TeamActionState = {};

/**
 * OWNER/ADMIN-only. Role is fixed at MEMBER for this first implementation
 * (see the Launch Blocker Fix scope note in src/app/actions/team.ts) -- no
 * role picker.
 */
export function AddTeamMemberForm() {
  const [state, action, pending] = useActionState(addTeamMember, initialState);

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription className="space-y-2">
            <p>{state.message}</p>
            {state.setupUrl ? (
              <div className="space-y-1.5">
                <p className="text-xs">
                  Share this one-time link so they can set their own
                  password. It works once and expires in 7 days.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 text-xs">
                    {state.setupUrl}
                  </code>
                  <CopySetupLinkButton url={state.setupUrl} />
                </div>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" autoComplete="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <p className="text-xs text-muted-foreground">
        Role: Field team member (MEMBER). They can sign in and see their
        assigned jobs at /field, but cannot open the management console.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add team member"}
      </Button>
    </form>
  );
}
