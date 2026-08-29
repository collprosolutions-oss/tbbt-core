/**
 * Shared Job lifecycle transition rules.
 *
 * Both the OWNER/ADMIN Work Order actions (startJob/markJobComplete in
 * src/app/actions/job.ts) and the assigned-MEMBER Field actions
 * (startAssignedJob/completeAssignedJob in src/app/actions/field-job.ts)
 * must apply the EXACT same SCHEDULED/UNSCHEDULED -> IN_PROGRESS ->
 * COMPLETED rules -- there is only ever one Job lifecycle, never a second
 * "field" version of it. Pure functions only: callers own the actual
 * `prisma.job.update()` call, so this module has no database dependency
 * and cannot be called from the wrong authorization context by accident.
 */

export type JobLifecycleResult =
  | { ok: true; nextStatus: "IN_PROGRESS" | "COMPLETED" | null }
  | { ok: false; error: string };

/**
 * A completed Job can never be (re)started. Already-IN_PROGRESS is a
 * successful no-op (nextStatus: null) rather than an error, matching the
 * existing startJob() behavior -- pressing Start twice is harmless.
 * Otherwise (SCHEDULED or UNSCHEDULED) starts it. Deliberately does not
 * special-case UNSCHEDULED: the existing app already allows starting an
 * unscheduled Job (see startJob() in src/app/actions/job.ts predating this
 * step), and this preserves that rule rather than expanding or narrowing it.
 */
export function evaluateStartJob(status: string): JobLifecycleResult {
  if (status === "COMPLETED") {
    return { ok: false, error: "A completed job cannot be started." };
  }
  if (status === "IN_PROGRESS") {
    return { ok: true, nextStatus: null };
  }
  return { ok: true, nextStatus: "IN_PROGRESS" };
}

/**
 * Already-COMPLETED is a successful no-op. A Job must be IN_PROGRESS to be
 * completed -- this is the only path to COMPLETED, for both OWNER/ADMIN and
 * the assigned MEMBER.
 */
export function evaluateCompleteJob(status: string): JobLifecycleResult {
  if (status === "COMPLETED") {
    return { ok: true, nextStatus: null };
  }
  if (status !== "IN_PROGRESS") {
    return { ok: false, error: "Start the job before completing it." };
  }
  return { ok: true, nextStatus: "COMPLETED" };
}
