/**
 * Tenant-scoped availability loader. Every query is keyed by the
 * authenticated (or public-site-resolved) businessId — never a client-
 * supplied business id.
 *
 * Preview shares Production and skips migrate, so reads/writes first
 * ensure the additive availability columns/table exist. Production
 * migrate deploy is then a no-op for this additive migration.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  DEFAULT_AVAILABILITY_SETTINGS,
  DEFAULT_SCHEDULING_BUFFER_MINUTES,
  DEFAULT_WORK_END_MINUTES,
  DEFAULT_WORK_START_MINUTES,
  PUBLIC_NEXT_AVAILABLE_DURATION_MINUTES,
  findNextAvailableStart,
  formatNextAvailableDate,
  parseWorkingWeekdays,
  type AvailabilitySettings,
  type AvailabilitySnapshot,
  type OccupiedJob,
} from "@/lib/availability";

type AvailabilityClient = PrismaClient | Prisma.TransactionClient;

const ENSURE_AVAILABILITY_SQL = [
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "workStartMinutes" INTEGER NOT NULL DEFAULT 480`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "workEndMinutes" INTEGER NOT NULL DEFAULT 1020`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "workingWeekdays" TEXT NOT NULL DEFAULT '1,2,3,4,5'`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "schedulingBufferMinutes" INTEGER NOT NULL DEFAULT 30`,
  `CREATE TABLE IF NOT EXISTS "BusinessUnavailableDate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessUnavailableDate_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessUnavailableDate_businessId_date_key" ON "BusinessUnavailableDate"("businessId", "date")`,
  `CREATE INDEX IF NOT EXISTS "BusinessUnavailableDate_businessId_idx" ON "BusinessUnavailableDate"("businessId")`,
];

let ensureSchemaPromise: Promise<void> | null = null;

export function resetBusinessAvailabilitySchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureBusinessAvailabilitySchema(db: AvailabilityClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      for (const statement of ENSURE_AVAILABILITY_SQL) {
        await db.$executeRawUnsafe(statement);
      }
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export function availabilitySettingsFromRow(
  row:
    | {
        workStartMinutes?: number | null;
        workEndMinutes?: number | null;
        workingWeekdays?: string | null;
        schedulingBufferMinutes?: number | null;
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
    workStartMinutes: row.workStartMinutes ?? DEFAULT_WORK_START_MINUTES,
    workEndMinutes: row.workEndMinutes ?? DEFAULT_WORK_END_MINUTES,
    schedulingBufferMinutes: row.schedulingBufferMinutes ?? DEFAULT_SCHEDULING_BUFFER_MINUTES,
    unavailableDates: [...unavailableDates].sort(),
  };
}

export async function loadAvailabilitySettings(
  db: AvailabilityClient,
  businessId: string,
): Promise<AvailabilitySettings> {
  await ensureBusinessAvailabilitySchema(db);
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
