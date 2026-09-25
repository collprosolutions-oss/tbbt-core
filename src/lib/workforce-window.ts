/**
 * Canonical occupied window for a scheduled job.
 *
 * Customer appointment time (scheduledAt) is never moved.
 * Explicit or configured material pickup occupies time BEFORE that
 * appointment. Configured buffer occupies time AFTER the job work.
 */
import { createHash } from "node:crypto";
import {
  pickupMinutesForJob,
  type PickupKind,
  type SchedulingPolicy,
} from "@/lib/workforce";

export type OccupiedWindow = {
  appointmentStart: Date;
  pickupStart: Date;
  workEnd: Date;
  occupiedStart: Date;
  occupiedEnd: Date;
  durationMinutes: number;
  pickupMinutes: number;
  pickupKind: PickupKind;
};

export function occupiedWindow(input: {
  scheduledAt: Date;
  scheduledDurationMinutes?: number | null;
  pickupDurationMinutes?: number | null;
  policy: SchedulingPolicy;
}): OccupiedWindow {
  const pickup = pickupMinutesForJob(input.pickupDurationMinutes, input.policy);
  const durationMinutes = Math.max(input.scheduledDurationMinutes ?? 0, 0);
  const appointmentStart = input.scheduledAt;
  const pickupStart = new Date(appointmentStart.getTime() - pickup.minutes * 60 * 1000);
  const workEnd = new Date(appointmentStart.getTime() + durationMinutes * 60 * 1000);
  return {
    appointmentStart,
    pickupStart,
    workEnd,
    occupiedStart: pickupStart,
    occupiedEnd: workEnd,
    durationMinutes,
    pickupMinutes: pickup.minutes,
    pickupKind: pickup.kind,
  };
}

export function withConfiguredBuffer(window: OccupiedWindow, bufferMinutes: number): OccupiedWindow {
  const buffer = Math.max(bufferMinutes, 0);
  return {
    ...window,
    occupiedEnd: new Date(window.workEnd.getTime() + buffer * 60 * 1000),
  };
}

export function windowsOverlap(a: OccupiedWindow, b: OccupiedWindow): boolean {
  return a.occupiedStart.getTime() < b.occupiedEnd.getTime() && b.occupiedStart.getTime() < a.occupiedEnd.getTime();
}

export function overlapMinutes(start: Date, end: Date, rangeStart: Date, rangeEnd: Date): number {
  const from = Math.max(start.getTime(), rangeStart.getTime());
  const to = Math.min(end.getTime(), rangeEnd.getTime());
  return Math.max(0, Math.round((to - from) / 60000));
}

export function conflictAcknowledgement(input: {
  jobId: string;
  start: Date;
  durationMinutes: number | null;
  pickupMinutes: number;
  assignedMembershipId?: string | null;
  conflicts: Array<{ kind: string; jobId: string; otherJobId?: string; severity: string }>;
}): string {
  const snapshot = input.conflicts
    .map((row) => `${row.severity}:${row.kind}:${row.jobId}:${row.otherJobId ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256")
    .update(
      [
        input.jobId,
        input.start.toISOString(),
        String(input.durationMinutes ?? 0),
        String(input.pickupMinutes),
        input.assignedMembershipId ?? "",
        snapshot,
      ].join("::"),
    )
    .digest("hex");
}

export function shouldAcceptConflictAcknowledgement(input: {
  submittedAck: string | null | undefined;
  currentAck: string;
  conflicts: unknown[];
}): "accept" | "warn" {
  if (input.conflicts.length === 0) return "accept";
  if (input.submittedAck && input.submittedAck === input.currentAck) return "accept";
  return "warn";
}
