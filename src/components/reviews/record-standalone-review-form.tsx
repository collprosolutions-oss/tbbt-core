"use client";

import { useMemo, useState } from "react";
import { RecordReviewForm } from "@/components/reviews/record-review-form";
import { Label } from "@/components/ui/label";
import type { ReviewsSource } from "@/lib/reviews-data";

export function RecordStandaloneReviewForm({ source }: { source: ReviewsSource }) {
  const [customerId, setCustomerId] = useState(source.customers[0]?.id ?? "");
  const [jobId, setJobId] = useState("");
  const jobs = useMemo(
    () => source.opportunities.filter((row) => row.customerId === customerId),
    [customerId, source.opportunities],
  );

  if (!customerId) {
    return <p className="text-sm text-muted-foreground">No customers on file for review recording.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="standalone-customer">Customer</Label>
          <select
            id="standalone-customer"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={customerId}
            onChange={(event) => {
              setCustomerId(event.target.value);
              setJobId("");
            }}
          >
            {source.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="standalone-job">Related job (optional)</Label>
          <select
            id="standalone-job"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={jobId}
            onChange={(event) => setJobId(event.target.value)}
          >
            <option value="">No related job</option>
            {jobs.map((job) => (
              <option key={job.jobId} value={job.jobId}>
                {job.workPerformed}
              </option>
            ))}
          </select>
        </div>
      </div>
      <RecordReviewForm key={`${customerId}:${jobId}`} customerId={customerId} jobId={jobId || undefined} />
    </div>
  );
}
