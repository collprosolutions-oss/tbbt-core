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

export type AssigneeHint = {
  membershipId: string;
  name: string;
  reason: string;
  available: boolean;
};

/**
 * OWNER/ADMIN-only control on the Work Order: assign, change, or remove the
 * one worker assigned to this Job. Another worker must be an active MEMBER
 * of this Job's own Business. OWNER/ADMIN may also assign themselves.
 * `eligibleMembers` is a UX convenience only -- assignJobMember()
 * re-validates the target server-side regardless (see
 * src/app/actions/job.ts). Workforce recommendations stay MEMBER-only.
 */
export function AssignJobMemberForm({
  jobId,
  eligibleMembers,
  assignedMembershipId,
  recommendations = [],
}: {
  jobId: string;
  eligibleMembers: EligibleMember[];
  assignedMembershipId: string | null;
  recommendations?: AssigneeHint[];
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
      {recommendations.length > 0 ? (
        <p className="w-full text-xs text-muted-foreground">
          Recommendation only — you make the assignment.{" "}
          {recommendations
            .slice(0, 3)
            .map((row) => `${row.name}${row.available ? "" : " (busy)"}`)
            .join("; ")}
        </p>
      ) : null}
      {state.error ? (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
