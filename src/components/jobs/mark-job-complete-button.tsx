"use client";

import { markJobComplete } from "@/app/actions/job";
import { Button } from "@/components/ui/button";

export function MarkJobCompleteButton({ jobId }: { jobId: string }) {
  return (
    <form
      action={async () => {
        await markJobComplete(jobId);
      }}
    >
      <Button type="submit" size="sm">
        Mark complete
      </Button>
    </form>
  );
}
