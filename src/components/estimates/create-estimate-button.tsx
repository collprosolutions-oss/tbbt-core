"use client";

import { createEstimate } from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

export function CreateEstimateButton({
  serviceRequestId,
}: {
  serviceRequestId: string;
}) {
  return (
    <form action={() => createEstimate(serviceRequestId)}>
      <Button type="submit" size="sm">
        Create estimate
      </Button>
    </form>
  );
}
