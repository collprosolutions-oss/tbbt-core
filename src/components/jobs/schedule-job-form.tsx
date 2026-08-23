"use client";

import { useState } from "react";
import { scheduleJob } from "@/app/actions/job";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ScheduleJobForm({
  jobId,
  scheduledAt,
}: {
  jobId: string;
  scheduledAt: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="space-y-3"
      action={async (formData) => {
        setPending(true);
        setError(null);
        const result = await scheduleJob(
          jobId,
          String(formData.get("scheduledAt") ?? ""),
        );
        setPending(false);
        if (result.error) {
          setError(result.error);
        }
      }}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="scheduledAt">Date and time</Label>
        <Input
          id="scheduledAt"
          name="scheduledAt"
          type="datetime-local"
          defaultValue={scheduledAt}
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
