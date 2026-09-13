"use client";

import { useActionState } from "react";
import {
  clearOperationalTestData,
  type ClearTestDataActionState,
} from "@/app/actions/test-data-cleanup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CLEAR_TEST_DATA_CONFIRMATION,
  type TestDataCleanupPreview,
} from "@/lib/test-data-cleanup-constants";

const initialState: ClearTestDataActionState = {};

const COUNT_LABELS: Array<[keyof TestDataCleanupPreview["willDelete"], string]> = [
  ["customers", "Customers"],
  ["properties", "Properties"],
  ["serviceRequests", "Service requests"],
  ["estimates", "Estimates"],
  ["jobs", "Jobs"],
  ["invoices", "Invoices"],
  ["payments", "Payments"],
  ["lineItems", "Line items"],
  ["changeOrders", "Change orders"],
  ["additionalWorkRequests", "Additional-work requests"],
  ["jobProblemReports", "Job problem reports"],
  ["timeEntries", "Time entries"],
  ["timesheetWeeks", "Timesheet weeks"],
  ["payrollRuns", "Payroll runs"],
  ["expenses", "Expenses"],
  ["pipelineOpportunities", "Pipeline opportunities"],
  ["reviews", "Reviews"],
  ["reviewRequests", "Review requests"],
  ["marketingContents", "Marketing drafts"],
  ["operationalStoredAssets", "Customer/job stored files"],
];

export function ClearTestDataForm({ preview }: { preview: TestDataCleanupPreview }) {
  const [state, action, pending] = useActionState(clearOperationalTestData, initialState);
  const total =
    preview.willDelete.customers +
    preview.willDelete.serviceRequests +
    preview.willDelete.estimates +
    preview.willDelete.jobs +
    preview.willDelete.invoices +
    preview.willDelete.payments;

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-muted-foreground">
        Founder/owner pre-launch cleanup for this workspace only. It never runs on
        deploy. Type {CLEAR_TEST_DATA_CONFIRMATION} to execute. Public routes cannot
        reach this action.
      </p>

      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">Will delete ({total} primary operational records)</p>
        <ul className="mt-2 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
          {COUNT_LABELS.map(([key, label]) => (
            <li key={key}>
              {label}: {preview.willDelete[key]}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">Will keep</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {preview.willPreserve.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <Label htmlFor="clear-test-data-confirmation">
          Type {CLEAR_TEST_DATA_CONFIRMATION} to confirm
        </Label>
        <Input
          id="clear-test-data-confirmation"
          name="confirmation"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>

      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Clearing…" : "Clear test data"}
      </Button>
    </form>
  );
}
