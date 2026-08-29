"use client";

import { useActionState } from "react";
import {
  approveEstimate,
  type ApproveEstimateResult,
} from "@/app/actions/public-estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: ApproveEstimateResult = {};

export function ApproveEstimateButton({
  publicToken,
  status,
  currentVersionId,
}: {
  publicToken: string;
  status: string;
  /**
   * The version this page rendered. Sent back as a staleness check: if the
   * estimate has been re-sent (a newer version now exists) between page
   * load and this submit, the server rejects the approval instead of
   * silently approving content the customer never saw.
   */
  currentVersionId?: string;
}) {
  const [state, formAction, pending] = useActionState(
    approveEstimate,
    initialState,
  );
  const currentStatus = state.status ?? status;

  if (currentStatus === "APPROVED") {
    return <p className="text-sm font-medium">Status: APPROVED</p>;
  }

  if (currentStatus !== "SENT") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">Status: {currentStatus}</p>
        <p className="text-sm text-muted-foreground">
          This estimate is not ready to approve.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="publicToken" value={publicToken} />
      <input
        type="hidden"
        name="estimateVersionId"
        value={currentVersionId ?? ""}
      />
      {state.error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <p className="mb-3 text-sm">Status: SENT</p>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Approving…" : "Approve"}
      </Button>
    </form>
  );
}
