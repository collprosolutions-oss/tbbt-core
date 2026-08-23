"use client";

import { createJobFromEstimate } from "@/app/actions/job";
import { Button } from "@/components/ui/button";

export function CreateJobButton({ estimateId }: { estimateId: string }) {
  return (
    <form
      action={async () => {
        await createJobFromEstimate(estimateId);
      }}
    >
      <Button type="submit" size="sm">
        Create job
      </Button>
    </form>
  );
}
