"use client";

import { useActionState } from "react";
import { transferOwnershipAction, type OwnershipActionState } from "@/app/actions/ownership";
import { Button } from "@/components/ui/button";
import { OWNERSHIP_TRANSFER_CONFIRMATION } from "@/lib/ownership-transfer";

export function OwnershipTransferForm({
  candidates,
}: {
  candidates: Array<{ id: string; name: string; email: string; role: string }>;
}) {
  const [state, action, pending] = useActionState(
    transferOwnershipAction,
    {} as OwnershipActionState,
  );

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Ownership can move only to another active OWNER or ADMIN. Add an ADMIN on Team first.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm">
        New owner
        <select name="targetMembershipId" className="mt-1 w-full rounded-md border px-3 py-2" required>
          <option value="">Select an active OWNER or ADMIN</option>
          {candidates.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name} ({member.email}) · {member.role}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Type {OWNERSHIP_TRANSFER_CONFIRMATION} to confirm
        <input
          name="confirmation"
          className="mt-1 w-full rounded-md border px-3 py-2"
          autoComplete="off"
          required
        />
      </label>
      <p className="text-sm text-muted-foreground">
        You become ADMIN. The new owner becomes OWNER. Audit history is preserved. Financial
        records are not rewritten.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Transferring…" : "Transfer ownership"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
