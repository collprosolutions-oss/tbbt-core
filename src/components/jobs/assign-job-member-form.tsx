"use client";

import { useActionState } from "react";
import { assignJobMember } from "@/app/actions/job";
import type { JobActionState } from "@/app/actions/job";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: JobActionState = {};

export type EligibleMember = {
  id: string;
  name: string;
  email: string;
};

/**
 * OWNER/ADMIN-only control on the Work Order: assign, change, or remove the
 * one MEMBER assigned to this Job. `eligibleMembers` is already scoped to
 * this Job's own Business and to role MEMBER (see the Prisma query in
 * src/app/(app)/jobs/[jobId]/page.tsx) -- assignJobMember() re-validates
 * that server-side regardless, so this list is a UX convenience only, never
 * the enforcement boundary.
 */
export function AssignJobMemberForm({
  jobId,
  eligibleMembers,
  assignedMembershipId,
}: {
  jobId: string;
  eligibleMembers: EligibleMember[];
  assignedMembershipId: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    assignJobMember,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="jobId" value={jobId} />
      <select
        name="membershipId"
        defaultValue={assignedMembershipId ?? ""}
        className="h-8 min-w-48 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        aria-label="Assigned team member"
      >
        <option value="">Unassigned</option>
        {eligibleMembers.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name} ({member.email})
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save assignment"}
      </Button>
      {state.error ? (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
