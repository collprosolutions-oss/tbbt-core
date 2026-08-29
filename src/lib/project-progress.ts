/**
 * Locked customer-facing "project progress" structure for the Customer
 * Project Portal (see src/app/p/[token]/page.tsx).
 *
 * Exactly five steps, mapped from REAL Job.status / Invoice.status values --
 * never a fake step added just to make a progress bar look complete. Do not
 * add a step here without a real, currently-implemented status backing it.
 */
export const PROJECT_PROGRESS_STEPS = [
  "ESTIMATE_APPROVED",
  "SCHEDULED",
  "WORK_IN_PROGRESS",
  "COMPLETED",
  "INVOICE_RECEIPT",
] as const;

export type ProjectProgressStep = (typeof PROJECT_PROGRESS_STEPS)[number];

export const PROJECT_PROGRESS_LABELS: Record<ProjectProgressStep, string> = {
  ESTIMATE_APPROVED: "Estimate Approved",
  SCHEDULED: "Scheduled",
  WORK_IN_PROGRESS: "Work In Progress",
  COMPLETED: "Completed",
  INVOICE_RECEIPT: "Invoice / Receipt",
};

/**
 * Maps a Job's real status (and whether an Invoice exists yet) to the
 * single current step of the locked progress structure above.
 *
 * A Job only exists once its source Estimate is APPROVED (see
 * createJobFromEstimate in src/app/actions/job.ts), so every Job -- even a
 * brand-new UNSCHEDULED one -- has already cleared "Estimate Approved".
 * An Invoice only exists once the Job is COMPLETED (see
 * createInvoiceFromJob in src/app/actions/invoice.ts), so its presence is
 * always the highest-reached step regardless of the Job's own status
 * string.
 */
export function resolveProjectProgressStep(
  job: { status: string },
  invoice: { status: string } | null,
): ProjectProgressStep {
  if (invoice) {
    return "INVOICE_RECEIPT";
  }
  if (job.status === "COMPLETED") {
    return "COMPLETED";
  }
  if (job.status === "IN_PROGRESS") {
    return "WORK_IN_PROGRESS";
  }
  if (job.status === "SCHEDULED") {
    return "SCHEDULED";
  }
  // UNSCHEDULED (or any unrecognized legacy value) has cleared exactly the
  // first step: the Job could not exist without an approved Estimate.
  return "ESTIMATE_APPROVED";
}

/**
 * Customer-facing language for a Job's internal status string. Internal
 * terminology (Job/Work Order, UNSCHEDULED/SCHEDULED/IN_PROGRESS/COMPLETED)
 * is preserved everywhere it already exists (see JOB STATUS in the Step 1
 * spec) -- this is presentation-only, for the customer-facing portal.
 */
export function customerFacingJobStatusLabel(status: string): string {
  switch (status) {
    case "UNSCHEDULED":
      return "Awaiting Scheduling";
    case "SCHEDULED":
      return "Scheduled";
    case "IN_PROGRESS":
      return "Work In Progress";
    case "COMPLETED":
      return "Completed";
    default:
      return status;
  }
}
