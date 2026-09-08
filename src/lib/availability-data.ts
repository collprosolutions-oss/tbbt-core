/**
 * Tenant-scoped availability loader. Every query is keyed by the
 * authenticated (or public-site-resolved) businessId — never a client-
 * supplied business id.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_AVAILABILITY_SETTINGS,
  PUBLIC_NEXT_AVAILABLE_DURATION_MINUTES,
  findNextAvailableStart,
  formatNextAvailableDate,
  parseWorkingWeekdays,
  type AvailabilitySettings,
  type AvailabilitySnapshot,
  type OccupiedJob,
} from "@/lib/availability";

type AvailabilityClient = PrismaClient | Prisma.TransactionClient;

export function availabilitySettingsFromRow(
  row:
    | {
        workStartMinutes: number;
        workEndMinutes: number;
        workingWeekdays: string;
        schedulingBufferMinutes: number;
      }
    | null
    | undefined,
  unavailableDates: string[] = [],
): AvailabilitySettings {
  if (!row) {
    return {
      ...DEFAULT_AVAILABILITY_SETTINGS,
      unavailableDates: [...unavailableDates].sort(),
    };
  }
  return {
    workingWeekdays: parseWorkingWeekdays(row.workingWeekdays),
    workStartMinutes: row.workStartMinutes,
    workEndMinutes: row.workEndMinutes,
    schedulingBufferMinutes: row.schedulingBufferMinutes,
    unavailableDates: [...unavailableDates].sort(),
  };
}

export async function loadAvailabilitySettings(
  db: AvailabilityClient,
  businessId: string,
): Promise<AvailabilitySettings> {
  const [row, unavailable] = await Promise.all([
    db.businessSettings.findUnique({
      where: { businessId },
      select: {
        workStartMinutes: true,
        workEndMinutes: true,
        workingWeekdays: true,
        schedulingBufferMinutes: true,
      },
    }),
    db.businessUnavailableDate.findMany({
      where: { businessId },
      select: { date: true },
      orderBy: { date: "asc" },
    }),
  ]);
  return availabilitySettingsFromRow(
    row,
    unavailable.map((item) => item.date),
  );
}

export async function loadOccupiedJobs(
  db: AvailabilityClient,
  businessId: string,
  excludeJobId?: string,
): Promise<OccupiedJob[]> {
  const jobs = await db.job.findMany({
    where: {
      businessId,
      status: { not: "COMPLETED" },
      scheduledAt: { not: null },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: {
      id: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      customer: { select: { name: true } },
    },
    orderBy: { scheduledAt: "asc" },
  });
  return jobs.flatMap((job) =>
    job.scheduledAt
      ? [
          {
            id: job.id,
            scheduledAt: job.scheduledAt,
            scheduledDurationMinutes: job.scheduledDurationMinutes,
            customerName: job.customer?.name ?? null,
          },
        ]
      : [],
  );
}

export async function loadAvailabilitySnapshot(
  db: AvailabilityClient,
  businessId: string,
): Promise<AvailabilitySnapshot> {
  const [settings, jobs] = await Promise.all([
    loadAvailabilitySettings(db, businessId),
    loadOccupiedJobs(db, businessId),
  ]);
  return {
    settings,
    jobs: jobs.map((job) => ({
      id: job.id ?? "",
      scheduledAt: job.scheduledAt.toISOString(),
      scheduledDurationMinutes: job.scheduledDurationMinutes,
    })),
  };
}

export async function loadPublicNextAvailableLabel(
  db: AvailabilityClient,
  businessId: string,
  from = new Date(),
): Promise<string | null> {
  const [settings, existing] = await Promise.all([
    loadAvailabilitySettings(db, businessId),
    loadOccupiedJobs(db, businessId),
  ]);
  const next = findNextAvailableStart({
    from,
    durationMinutes: PUBLIC_NEXT_AVAILABLE_DURATION_MINUTES,
    settings,
    existing,
  });
  return next ? formatNextAvailableDate(next) : null;
}
