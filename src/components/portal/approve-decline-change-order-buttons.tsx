"use client";

import { useActionState } from "react";
import {
  approveChangeOrder,
  declineChangeOrder,
  type CustomerChangeOrderActionState,
} from "@/app/actions/public-change-order";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: CustomerChangeOrderActionState = {};

export function ApproveDeclineChangeOrderButtons({
  projectToken,
  changeOrderId,
}: {
  projectToken: string;
  changeOrderId: string;
}) {
  const [approveState, approveAction, approvePending] = useActionState(
    approveChangeOrder,
    initialState,
  );
  const [declineState, declineAction, declinePending] = useActionState(
    declineChangeOrder,
    initialState,
  );

  if (approveState.status === "APPROVED") {
    return <p className="text-sm font-medium">Status: Approved</p>;
  }
  if (declineState.status === "DECLINED") {
    return <p className="text-sm font-medium">Status: Declined</p>;
  }

  return (
    <div className="space-y-2">
      {approveState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{approveState.error}</AlertDescription>
        </Alert>
      ) : null}
      {declineState.error ? (
        <Alert variant="destructive">
          <AlertDescription>{declineState.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <form action={approveAction}>
          <input type="hidden" name="projectToken" value={projectToken} />
          <input type="hidden" name="changeOrderId" value={changeOrderId} />
          <Button type="submit" size="sm" disabled={approvePending || declinePending}>
            {approvePending ? "Approving…" : "Approve"}
          </Button>
        </form>
        <form action={declineAction}>
          <input type="hidden" name="projectToken" value={projectToken} />
          <input type="hidden" name="changeOrderId" value={changeOrderId} />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={approvePending || declinePending}
          >
            {declinePending ? "Declining…" : "Decline"}
          </Button>
        </form>
      </div>
    </div>
  );
}
