/**
 * Day-route appointment change copy and input parsing.
 *
 * The owner picks a new recorded start. Duration, buffers, and material
 * pickup stay on the existing scheduling gates. This path does not send a
 * customer message and does not claim travel optimization.
 */
import {
  describeScheduleWarning,
  hasScheduleWarning,
  type AvailabilitySettings,
  type ScheduleEvaluation,
} from "@/lib/availability";
import { formatDateTime } from "@/lib/format";
import { parseOwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/snapshot";
import type { OwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/types";
import {
  JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE,
  JOB_COMPLETED_CANNOT_RESCHEDULE_MESSAGE,
} from "@/lib/job-lifecycle";
import { describeConflicts, type ScheduleConflict } from "@/lib/workforce-conflicts";

export const DAY_ROUTE_APPOINTMENT_OWNER_ONLY_MESSAGE =
  "Only the business owner can change an appointment from the day route.";

export const DAY_ROUTE_APPOINTMENT_STALE_MESSAGE =
  "This appointment changed since the page was loaded. Refresh and try again.";

export const DAY_ROUTE_APPOINTMENT_CONFLICT_MESSAGE =
  "That appointment window conflicts with another recorded job, working hours, buffer, or material pickup.";

export const DAY_ROUTE_APPOINTMENT_COMPLETED_MESSAGE =
  JOB_COMPLETED_CANNOT_RESCHEDULE_MESSAGE;

export const DAY_ROUTE_APPOINTMENT_CANCELLED_MESSAGE =
  JOB_CANCELLED_CANNOT_RESCHEDULE_MESSAGE;

export const DAY_ROUTE_APPOINTMENT_INVALID_MESSAGE =
  "Choose a valid date and start time.";

export const DAY_ROUTE_APPOINTMENT_MISSING_JOB_MESSAGE =
  "That job could not be changed from the day route.";

export const DAY_ROUTE_APPOINTMENT_UNSCHEDULED_MESSAGE =
  "Only a recorded scheduled job can change its appointment from the day route.";

export const DAY_ROUTE_APPOINTMENT_SCHEMA_UNAVAILABLE_MESSAGE =
  "Appointment changes are unavailable because the appointment schema is missing.";

export const DAY_ROUTE_APPOINTMENT_CHANGED_MESSAGE =
  "Appointment updated. Stops now follow the new recorded order. The customer was not messaged.";

export const DAY_ROUTE_APPOINTMENT_FORM_NOTE =
  "Choose a new recorded appointment start. Existing duration, scheduling buffers, and material pickup still apply. Conflicts and stale submissions are rejected. This does not rearrange travel and does not send a customer message.";

export const DAY_ROUTE_APPOINTMENT_SUBMIT_LABEL = "Change appointment";

export function parseDayRouteAppointmentSnapshot(
  raw: string,
  jobId: string,
): OwnerDayRouteScheduleSnapshot | null {
  const snapshot = parseOwnerDayRouteScheduleSnapshot(raw);
  if (!snapshot || snapshot.jobId !== jobId) return null;
  return snapshot;
}

export function blockingDayRouteConflicts(conflicts: ScheduleConflict[], jobId: string) {
  return conflicts.filter(
    (conflict) =>
      (conflict.severity === "ERROR" || conflict.severity === "WARNING") &&
      (conflict.jobId === jobId || conflict.otherJobId === jobId),
  );
}

export function describeRejectedDayRouteAppointment(input: {
  evaluation: ScheduleEvaluation;
  conflicts: ScheduleConflict[];
  start: Date;
  settings: AvailabilitySettings;
  timeZone: string;
}): string {
  const availability = hasScheduleWarning(input.evaluation)
    ? describeScheduleWarning(
        input.evaluation,
        input.start,
        (value) => formatDateTime(value, input.timeZone),
        input.settings,
        input.timeZone,
      )
    : null;
  const cleaned = availability?.replace(/\s*You can schedule anyway if needed\./g, "").trim() ?? null;
  const workforce = describeConflicts(input.conflicts);
  const text = [cleaned, workforce].filter(Boolean).join(" ").trim();
  return text || DAY_ROUTE_APPOINTMENT_CONFLICT_MESSAGE;
}
