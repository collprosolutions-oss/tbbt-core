"use client";

import { useActionState } from "react";
import { setTeamMemberActive, type TeamActionState } from "@/app/actions/team";
import { Button } from "@/components/ui/button";

const initialState: TeamActionState = {};

/**
 * OWNER/ADMIN-only. Toggles Membership.active for one MEMBER -- see
 * setTeamMemberActive() in src/app/actions/team.ts for why this is the
 * complete, sufficient enforcement point (no separate session revocation
 * needed).
 */
export function SetTeamMemberActiveForm({
  membershipId,
  active,
}: {
  membershipId: string;
  active: boolean;
}) {
  const [state, action, pending] = useActionState(
    setTeamMemberActive,
    initialState,
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="membershipId" value={membershipId} />
      <input type="hidden" name="active" value={active ? "0" : "1"} />
      <Button
        type="submit"
        size="sm"
        variant={active ? "outline" : "default"}
        disabled={pending}
      >
        {pending ? "Saving…" : active ? "Remove from team" : "Reactivate"}
      </Button>
      {state.error ? (
        <p className="text-xs text-destructive">{state.error}</p>
      ) : null}
    </form>
  );
}
