import type { OwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/types";

export function scheduleSnapshotFromJob(job: {
  id: string;
  scheduledAt: Date | null;
  status: string;
  pickupDurationMinutes: number | null;
  arrivalWindowMinutes: number | null;
  assignedMembershipId: string | null;
}): OwnerDayRouteScheduleSnapshot {
  return {
    jobId: job.id,
    scheduledAt: job.scheduledAt ? job.scheduledAt.toISOString() : null,
    status: job.status,
    pickupDurationMinutes: job.pickupDurationMinutes,
    arrivalWindowMinutes: job.arrivalWindowMinutes,
    assignedMembershipId: job.assignedMembershipId,
  };
}

export function ownerDayRouteScheduleSnapshotsEqual(
  left: OwnerDayRouteScheduleSnapshot,
  right: OwnerDayRouteScheduleSnapshot,
) {
  return (
    left.jobId === right.jobId &&
    left.scheduledAt === right.scheduledAt &&
    left.status === right.status &&
    left.pickupDurationMinutes === right.pickupDurationMinutes &&
    left.arrivalWindowMinutes === right.arrivalWindowMinutes &&
    left.assignedMembershipId === right.assignedMembershipId
  );
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

export function parseOwnerDayRouteScheduleSnapshot(
  raw: string,
): OwnerDayRouteScheduleSnapshot | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    if (typeof value.jobId !== "string" || !value.jobId.trim()) return null;
    if (typeof value.status !== "string" || !value.status.trim()) return null;
    const scheduledAt = readNullableString(value.scheduledAt);
    const pickupDurationMinutes = readNullableNumber(value.pickupDurationMinutes);
    const arrivalWindowMinutes = readNullableNumber(value.arrivalWindowMinutes);
    const assignedMembershipId = readNullableString(value.assignedMembershipId);
    if (
      scheduledAt === undefined ||
      pickupDurationMinutes === undefined ||
      arrivalWindowMinutes === undefined ||
      assignedMembershipId === undefined
    ) {
      return null;
    }
    return {
      jobId: value.jobId,
      scheduledAt,
      status: value.status,
      pickupDurationMinutes,
      arrivalWindowMinutes,
      assignedMembershipId,
    };
  } catch {
    return null;
  }
}

export function serializeOwnerDayRouteScheduleSnapshot(
  snapshot: OwnerDayRouteScheduleSnapshot,
) {
  return JSON.stringify(snapshot);
}

export function ownerDayRouteScheduleSnapshotWhere(
  businessId: string,
  snapshot: OwnerDayRouteScheduleSnapshot,
) {
  return {
    id: snapshot.jobId,
    businessId,
    status: snapshot.status,
    scheduledAt: snapshot.scheduledAt ? new Date(snapshot.scheduledAt) : null,
    pickupDurationMinutes: snapshot.pickupDurationMinutes,
    arrivalWindowMinutes: snapshot.arrivalWindowMinutes,
    assignedMembershipId: snapshot.assignedMembershipId,
  };
}
