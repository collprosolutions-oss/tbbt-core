"use client";

import { useMemo, useState } from "react";
import type {
  ExpenseCustomerOption,
  ExpenseJobOption,
} from "@/components/expenses/types";
import { Label } from "@/components/ui/label";

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30";

export function ExpenseAssociationFields({
  jobs,
  customers,
  includeCustomerSelect = true,
}: {
  jobs: ExpenseJobOption[];
  customers: ExpenseCustomerOption[];
  includeCustomerSelect?: boolean;
}) {
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");

  const selectedJob = jobs.find((job) => job.id === jobId) ?? null;
  const derivedCustomerName =
    selectedJob?.customerName ??
    customers.find((customer) => customer.id === (selectedJob?.customerId ?? customerId))?.name ??
    null;

  const visibleJobs = useMemo(() => {
    if (!customerId) return jobs;
    return jobs.filter((job) => !job.customerId || job.customerId === customerId);
  }, [jobs, customerId]);

  function onCustomerChange(nextCustomerId: string) {
    setCustomerId(nextCustomerId);
    if (!nextCustomerId) return;
    const job = jobs.find((row) => row.id === jobId);
    if (job?.customerId && job.customerId !== nextCustomerId) {
      setJobId("");
    }
  }

  function onJobChange(nextJobId: string) {
    setJobId(nextJobId);
    const job = jobs.find((row) => row.id === nextJobId);
    if (job?.customerId) {
      setCustomerId(job.customerId);
    }
  }

  return (
    <div className="space-y-3">
      {includeCustomerSelect ? (
        <div className="space-y-1.5">
          <Label htmlFor="expense-customerId">Customer / project (optional)</Label>
          <select
            id="expense-customerId"
            name="customerId"
            value={customerId}
            onChange={(event) => onCustomerChange(event.target.value)}
            className={selectClass}
          >
            <option value="">No customer — general business expense</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            The homeowner or project this purchase is for. Not the person who paid.
          </p>
        </div>
      ) : (
        <input type="hidden" name="customerId" value={customerId} />
      )}

      <div className="space-y-1.5">
        <Label htmlFor="expense-jobId">Job (optional)</Label>
        <select
          id="expense-jobId"
          name="jobId"
          value={jobId}
          onChange={(event) => onJobChange(event.target.value)}
          className={selectClass}
        >
          <option value="">No job</option>
          {visibleJobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.label}
            </option>
          ))}
        </select>
        {selectedJob && derivedCustomerName ? (
          <p className="text-xs text-foreground">
            Job customer: <span className="font-medium">{derivedCustomerName}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Linking a job stores this cost on that job. The job&apos;s customer is
            selected automatically.
          </p>
        )}
      </div>
    </div>
  );
}
