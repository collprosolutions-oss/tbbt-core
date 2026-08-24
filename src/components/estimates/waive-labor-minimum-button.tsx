"use client";

import { setEstimateLaborMinimumWaived } from "@/app/actions/estimate";
import { Button } from "@/components/ui/button";

export function WaiveLaborMinimumButton({
  estimateId,
  waived,
}: {
  estimateId: string;
  waived: boolean;
}) {
  return (
    <form
      action={async () => {
        await setEstimateLaborMinimumWaived(estimateId, !waived);
      }}
    >
      <Button type="submit" size="sm" variant="outline">
        {waived
          ? "Apply labor minimum"
          : "Waive labor minimum for this estimate"}
      </Button>
    </form>
  );
}
