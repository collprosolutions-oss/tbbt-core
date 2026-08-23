"use client";

import { useState } from "react";
import { approveEstimate } from "@/app/actions/public-estimate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function ApproveEstimateButton({
  publicToken,
  status,
}: {
  publicToken: string;
  status: string;
}) {
  const [currentStatus, setCurrentStatus] = useState(status);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (currentStatus !== "DRAFT") {
    return (
      <p className="text-sm font-medium">Status: {currentStatus}</p>
    );
  }

  return (
    <form
      action={async () => {
        setPending(true);
        setError(null);
        const result = await approveEstimate(publicToken);
        setPending(false);
        if (result.error) {
          setError(result.error);
          return;
        }
        if (result.status) {
          setCurrentStatus(result.status);
        }
      }}
    >
      {error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <p className="mb-3 text-sm">Status: {currentStatus}</p>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Approving…" : "Approve"}
      </Button>
    </form>
  );
}
