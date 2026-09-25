/**
 * Tenant-scoped workforce / capacity loaders.
 * Every query is keyed by the authenticated businessId.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadAvailabilitySettings } from "@/lib/availability-data";
import { addDays, startOfDay } from "@/lib/schedule";
import {
  parseSkillList,
  parseWorkforceProgression,
  schedulingPolicyFromRow,
  type FillInBenchRecord,
  type SchedulingPolicy,
  type WorkforceMember,
} from "@/lib/workforce";
import { buildWorkforceRecommendations } from "@/lib/workforce-agent";
import {
  calculateWeeklyCapacity,
  type CapacityJob,
} from "@/lib/workforce-capacity";
import {
  detectScheduleConflicts,
  type ConflictJob,
} from "@/lib/workforce-conflicts";
import { recommendAssignees } from "@/lib/workforce-matching";

type WorkforceClient = PrismaClient | Prisma.TransactionClient;

const ENSURE_WORKFORCE_SQL = [
  `ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "schedulingActive" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "progression" TEXT NOT NULL DEFAULT 'CAPABLE'`,
  `ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "maxDailyJobMinutes" INTEGER`,
  `ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "preferredJobTypes" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "allowedJobTypes" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "workforceNotes" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "pickupDurationMinutes" INTEGER`,
  `ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "arrivalWindowMinutes" INTEGER`,
  `ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "requiredSkills" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "requiredProgression" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "firstAppointmentMode" TEXT NOT NULL DEFAULT 'EXACT'`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "laterAppointmentMode" TEXT NOT NULL DEFAULT 'WINDOW'`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "defaultArrivalWindowMinutes" INTEGER NOT NULL DEFAULT 120`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "dayBeforeChangeCutoffHours" INTEGER NOT NULL DEFAULT 24`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "defaultPickupMinutes" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "travelPlaceholderMinutes" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "helperRecommendationThresholdMinutes" INTEGER NOT NULL DEFAULT 60`,
  `ALTER TABLE "BusinessSettings" ADD COLUMN IF NOT EXISTS "overloadThresholdPercent" INTEGER NOT NULL DEFAULT 90`,
];

let ensureSchemaPromise: Promise<void> | null = null;

export function resetWorkforceSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureWorkforceSchema(db: WorkforceClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = (async () => {
      for (const statement of ENSURE_WORKFORCE_SQL) {
        await db.$executeRawUnsafe(statement);
      }
    })().catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export async function loadSchedulingPolicy(
  db: WorkforceClient,
  businessId: string,
): Promise<SchedulingPolicy> {
  await ensureWorkforceSchema(db);
  const row = await db.businessSettings.findUnique({
    where: { businessId },
    select: {
      firstAppointmentMode: true,
      laterAppointmentMode: true,
      defaultArrivalWindowMinutes: true,
      dayBeforeChangeCutoffHours: true,
      defaultPickupMinutes: true,
      travelPlaceholderMinutes: true,
      helperRecommendationThresholdMinutes: true,
      overloadThresholdPercent: true,
    },
  });
  return schedulingPolicyFromRow(row);
}

function toWorkforceMember(row: {
  id: string;
  active: boolean;
  schedulingActive: boolean;
  progression: string;
  maxDailyJobMinutes: number | null;
  preferredJobTypes: string;
  allowedJobTypes: string;
  user: { name: string };
  workforceSkills: Array<{ skillKey: string; proficiency: string }>;
  weeklyAvailability: Array<{ weekday: number; startMinutes: number; endMinutes: number }>;
  availabilityExceptions: Array<{
    date: string;
    kind: string;
    startMinutes: number | null;
    endMinutes: number | null;
  }>;
}): WorkforceMember {
  return {
    membershipId: row.id,
    name: row.user.name,
    active: row.active,
    schedulingActive: row.schedulingActive,
    progression: parseWorkforceProgression(row.progression),
    maxDailyJobMinutes: row.maxDailyJobMinutes,
    preferredJobTypes: parseSkillList(row.preferredJobTypes),
    allowedJobTypes: parseSkillList(row.allowedJobTypes),
    skills: row.workforceSkills.map((skill) => ({
      skillKey: skill.skillKey,
      proficiency: parseWorkforceProgression(skill.proficiency),
    })),
    weeklyAvailability: row.weeklyAvailability,
    exceptions: row.availabilityExceptions.map((row) => ({
      date: row.date,
      kind: row.kind === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
      startMinutes: row.startMinutes,
      endMinutes: row.endMinutes,
    })),
  };
}

export async function loadWorkforceMembers(
  db: WorkforceClient,
  businessId: string,
): Promise<WorkforceMember[]> {
  await ensureWorkforceSchema(db);
  const rows = await db.membership.findMany({
    where: { businessId },
    select: {
      id: true,
      active: true,
      schedulingActive: true,
      progression: true,
      maxDailyJobMinutes: true,
      preferredJobTypes: true,
      allowedJobTypes: true,
      user: { select: { name: true } },
      workforceSkills: { select: { skillKey: true, proficiency: true } },
      weeklyAvailability: { select: { weekday: true, startMinutes: true, endMinutes: true } },
      availabilityExceptions: {
        select: { date: true, kind: true, startMinutes: true, endMinutes: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toWorkforceMember);
}

export async function loadFillInBench(
  db: WorkforceClient,
  businessId: string,
): Promise<FillInBenchRecord[]> {
  await ensureWorkforceSchema(db);
  const rows = await db.fillInBenchWorker.findMany({
    where: { businessId },
    orderBy: [{ lastUsedAt: "desc" }, { displayName: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    contactPreference: row.contactPreference as FillInBenchRecord["contactPreference"],
    contactValue: row.contactValue,
    skills: parseSkillList(row.skills),
    availabilityNotes: row.availabilityNotes,
    approved: row.approved,
    active: row.active,
    lastUsedAt: row.lastUsedAt,
    notes: row.notes,
    membershipId: row.membershipId,
  }));
}

export function capacityJobsFromRows(
  rows: Array<{
    id: string;
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
    pickupDurationMinutes?: number | null;
    assignedMembershipId?: string | null;
    status?: string | null;
    serviceIntent?: string | null;
    recurrenceCadence?: string | null;
    recurrenceStatus?: string | null;
    nextOccurrenceAt?: Date | null;
    recurrenceSourceJobId?: string | null;
    customer?: { name: string } | null;
    requiredSkills?: string | null;
  }>,
): ConflictJob[] {
  return rows.flatMap((row) =>
    row.scheduledAt
      ? [
          {
            id: row.id,
            scheduledAt: row.scheduledAt,
            scheduledDurationMinutes: row.scheduledDurationMinutes,
            pickupDurationMinutes: row.pickupDurationMinutes ?? null,
            assignedMembershipId: row.assignedMembershipId ?? null,
            status: row.status ?? null,
            serviceIntent: row.serviceIntent ?? null,
            recurrenceCadence: row.recurrenceCadence ?? null,
            recurrenceStatus: row.recurrenceStatus ?? null,
            nextOccurrenceAt: row.nextOccurrenceAt ?? null,
            recurrenceSourceJobId: row.recurrenceSourceJobId ?? null,
            customerName: row.customer?.name ?? null,
            requiredSkills: parseSkillList(row.requiredSkills),
          } satisfies ConflictJob,
        ]
      : [],
  );
}

const CAPACITY_JOB_SELECT = {
  id: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  pickupDurationMinutes: true,
  assignedMembershipId: true,
  status: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
  recurrenceSourceJobId: true,
  requiredSkills: true,
  customer: { select: { name: true } },
} as const;

export async function loadCapacityJobs(
  db: WorkforceClient,
  businessId: string,
  range?: { start: Date; end: Date },
): Promise<ConflictJob[]> {
  await ensureWorkforceSchema(db);
  const rows = await db.job.findMany({
    where: {
      businessId,
      ...(range
        ? {
            OR: [
              { scheduledAt: { gte: range.start, lt: range.end } },
              {
                serviceIntent: "RECURRING",
                recurrenceStatus: "ACTIVE",
                scheduledAt: { not: null },
              },
            ],
          }
        : {}),
    },
    select: CAPACITY_JOB_SELECT,
    orderBy: { scheduledAt: "asc" },
  });
  return capacityJobsFromRows(rows);
}

export async function loadWorkforceSnapshot(db: WorkforceClient, businessId: string, now = new Date()) {
  const range = { start: startOfDay(now), end: addDays(startOfDay(now), 21) };
  const [settings, policy, members, bench, jobs] = await Promise.all([
    loadAvailabilitySettings(db, businessId),
    loadSchedulingPolicy(db, businessId),
    loadWorkforceMembers(db, businessId),
    loadFillInBench(db, businessId),
    loadCapacityJobs(db, businessId, range),
  ]);
  const week = calculateWeeklyCapacity({
    start: range.start,
    settings,
    policy,
    jobs,
  });
  const conflicts = detectScheduleConflicts({ jobs, settings, policy, members });
  const recommendations = buildWorkforceRecommendations({
    now,
    settings,
    policy,
    jobs,
    members,
    bench,
  });
  return { settings, policy, members, bench, jobs, week, conflicts, recommendations };
}

export async function loadJobAssignmentSuggestions(
  db: WorkforceClient,
  businessId: string,
  job: {
    id: string;
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
    pickupDurationMinutes?: number | null;
    requiredSkills?: string | null;
  },
) {
  const [settings, policy, members, jobs] = await Promise.all([
    loadAvailabilitySettings(db, businessId),
    loadSchedulingPolicy(db, businessId),
    loadWorkforceMembers(db, businessId),
    loadCapacityJobs(db, businessId),
  ]);
  return recommendAssignees({
    start: job.scheduledAt,
    durationMinutes: job.scheduledDurationMinutes,
    pickupMinutes: job.pickupDurationMinutes ?? 0,
    requiredSkills: parseSkillList(job.requiredSkills),
    members: members.filter((member) => member.active),
    jobs,
    settings,
    policy,
    excludeJobId: job.id,
  });
}

export function asCapacityJobs(jobs: ConflictJob[]): CapacityJob[] {
  return jobs;
}
