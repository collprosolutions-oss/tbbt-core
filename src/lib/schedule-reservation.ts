/**
 * Tenant-wide lock for claiming a scheduled Job slot.
 *
 * Recurring-series materialization and day-route appointment changes both
 * take this lock before reading occupancy and writing scheduledAt, so two
 * writers cannot check-then-insert the same window.
 */
import type { Prisma } from "@prisma/client";

export function businessScheduleReservationLockKey(businessId: string) {
  return `schedule-reservation:${businessId}`;
}

export async function lockBusinessScheduleReservation(
  tx: Prisma.TransactionClient,
  businessId: string,
) {
  const lockKey = businessScheduleReservationLockKey(businessId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}
