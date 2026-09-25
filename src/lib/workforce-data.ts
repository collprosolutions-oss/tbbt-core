/**
 * Tenant-scoped workforce / capacity loaders.
 * Every query is keyed by the authenticated businessId.
 * Schema ownership is the Prisma migration — these paths never run DDL.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadAvailabilitySettings } from "@/lib/availability-data";
import { resolveBusinessTimeZone, startOfZonedDay, addZonedCalendarDays } from "@/lib/business-timezone";
import {
  isAssignableFieldMember,
  isWorkforceProgression,
  parseSkillList,
  parseWorkforceProgression,
  schedulingPolicyFromRow,
  type FillInBenchRecord,
  type SchedulingPolicy,
  type WorkforceMember,
  type WorkforceMemberRole,
} from "@/lib/workforce";
import { buildWorkforceRecommendations } from "@/lib/workforce-agent";
import {
  calculateTeamWeeklyCapacity,
  type CapacityJob,
} from "@/lib/workforce-capacity";
import {
  detectScheduleConflicts,
  type ConflictJob,
} from "@/lib/workforce-conflicts";
import { recommendAssignees } from "@/lib/workforce-matching";

type WorkforceClient = PrismaClient | Prisma.TransactionClient;

export async function loadSchedulingPolicy(
  db: WorkforceClient,
  businessId: string,
): Promise<SchedulingPolicy> {
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
  role: string;
  active: boolean;
  schedulingActive: boolean;
  progression: string;
  maxDailyJobMinutes: number | null;
  preferredJobTypes: string;
  allowedJobTypes: string;
  workforceNotes: string;
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
    role: row.role as WorkforceMemberRole,
    active: row.active,
    schedulingActive: row.schedulingActive,
    progression: parseWorkforceProgression(row.progression),
    maxDailyJobMinutes: row.maxDailyJobMinutes,
    preferredJobTypes: parseSkillList(row.preferredJobTypes),
    allowedJobTypes: parseSkillList(row.allowedJobTypes),
    workforceNotes: row.workforceNotes,
    skills: row.workforceSkills.map((skill) => ({
      skillKey: skill.skillKey,
      proficiency: parseWorkforceProgression(skill.proficiency),
    })),
    weeklyAvailability: row.weeklyAvailability,
    exceptions: row.availabilityExceptions.map((exception) => ({
      date: exception.date,
      kind: exception.kind === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
      startMinutes: exception.startMinutes,
      endMinutes: exception.endMinutes,
    })),
  };
}

export async function loadWorkforceMembers(
  db: WorkforceClient,
  businessId: string,
): Promise<WorkforceMember[]> {
  const rows = await db.membership.findMany({
    where: { businessId },
    select: {
      id: true,
      role: true,
      active: true,
      schedulingActive: true,
      progression: true,
      maxDailyJobMinutes: true,
      preferredJobTypes: true,
      allowedJobTypes: true,
      workforceNotes: true,
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
    requiredProgression?: string | null;
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
            requiredProgression: row.requiredProgression ?? "",
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
  requiredProgression: true,
  customer: { select: { name: true } },
} as const;

export async function loadCapacityJobs(
  db: WorkforceClient,
  businessId: string,
  range?: { start: Date; end: Date },
): Promise<ConflictJob[]> {
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

export async function loadWorkforceTimeZone(db: WorkforceClient, businessId: string) {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  return resolveBusinessTimeZone(business);
}

let workforceSnapshotLoadCount = 0;
let workforceScopedLookupCount = 0;

export function resetWorkforceSnapshotLoadCount() {
  workforceSnapshotLoadCount = 0;
}

export function getWorkforceSnapshotLoadCount() {
  return workforceSnapshotLoadCount;
}

export function resetWorkforceScopedLookupCount() {
  workforceScopedLookupCount = 0;
}

export function getWorkforceScopedLookupCount() {
  return workforceScopedLookupCount;
}

export type OwnedWorkforceJob = {
  id: string;
  businessId: string;
  scheduledAt: Date | null;
  scheduledDurationMinutes: number | null;
  pickupDurationMinutes: number | null;
  assignedMembershipId: string | null;
  status: string | null;
  serviceIntent: string | null;
  recurrenceCadence: string | null;
  recurrenceStatus: string | null;
  nextOccurrenceAt: Date | null;
  recurrenceSourceJobId: string | null;
  requiredSkills: string | null;
  requiredProgression: string | null;
  customerName: string | null;
};

const OWNED_JOB_SELECT = {
  ...CAPACITY_JOB_SELECT,
  businessId: true,
} as const;

/**
 * Narrow tenant-owned job lookup. Not a second Workforce snapshot.
 * Used only when an authorized target is missing from the already-loaded
 * 21-day snapshot window.
 */
export async function loadOwnedWorkforceJob(
  db: WorkforceClient,
  businessId: string,
  jobId: string,
): Promise<OwnedWorkforceJob | null> {
  workforceScopedLookupCount += 1;
  const row = await db.job.findFirst({
    where: { id: jobId, businessId },
    select: OWNED_JOB_SELECT,
  });
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.businessId,
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
    requiredSkills: row.requiredSkills ?? null,
    requiredProgression: row.requiredProgression ?? null,
    customerName: row.customer?.name ?? null,
  };
}

export function ownedJobToConflictJob(job: OwnedWorkforceJob): ConflictJob | null {
  if (!job.scheduledAt) return null;
  return {
    id: job.id,
    scheduledAt: job.scheduledAt,
    scheduledDurationMinutes: job.scheduledDurationMinutes,
    pickupDurationMinutes: job.pickupDurationMinutes,
    assignedMembershipId: job.assignedMembershipId,
    status: job.status,
    serviceIntent: job.serviceIntent,
    recurrenceCadence: job.recurrenceCadence,
    recurrenceStatus: job.recurrenceStatus,
    nextOccurrenceAt: job.nextOccurrenceAt,
    recurrenceSourceJobId: job.recurrenceSourceJobId,
    customerName: job.customerName,
    requiredSkills: parseSkillList(job.requiredSkills),
    requiredProgression: job.requiredProgression ?? "",
  };
}

export async function loadWorkforceSnapshot(db: WorkforceClient, businessId: string, now = new Date()) {
  workforceSnapshotLoadCount += 1;
  const timeZone = await loadWorkforceTimeZone(db, businessId);
  const range = { start: startOfZonedDay(now, timeZone), end: addZonedCalendarDays(startOfZonedDay(now, timeZone), 21, timeZone) };
  const [settings, policy, members, bench, jobs] = await Promise.all([
    loadAvailabilitySettings(db, businessId),
    loadSchedulingPolicy(db, businessId),
    loadWorkforceMembers(db, businessId),
    loadFillInBench(db, businessId),
    loadCapacityJobs(db, businessId, range),
  ]);
  const week = calculateTeamWeeklyCapacity({
    start: range.start,
    settings,
    policy,
    jobs,
    members,
    timeZone,
  });
  const conflicts = detectScheduleConflicts({ jobs, settings, policy, members, timeZone });
  const recommendations = buildWorkforceRecommendations({
    now,
    settings,
    policy,
    jobs,
    members,
    bench,
    timeZone,
  });
  return { settings, policy, members, bench, jobs, week, conflicts, recommendations, timeZone };
}

export type WorkforceSnapshot = Awaited<ReturnType<typeof loadWorkforceSnapshot>>;

export async function loadJobAssignmentSuggestions(
  db: WorkforceClient,
  businessId: string,
  job: {
    id: string;
    scheduledAt: Date | null;
    scheduledDurationMinutes: number | null;
    pickupDurationMinutes?: number | null;
    requiredSkills?: string | null;
    requiredProgression?: string | null;
  },
) {
  const [settings, policy, members, jobs, timeZone] = await Promise.all([
    loadAvailabilitySettings(db, businessId),
    loadSchedulingPolicy(db, businessId),
    loadWorkforceMembers(db, businessId),
    loadCapacityJobs(db, businessId),
    loadWorkforceTimeZone(db, businessId),
  ]);
  return recommendAssignees({
    start: job.scheduledAt,
    durationMinutes: job.scheduledDurationMinutes,
    pickupMinutes: job.pickupDurationMinutes ?? 0,
    requiredSkills: parseSkillList(job.requiredSkills),
    requiredProgression: isWorkforceProgression(job.requiredProgression) ? job.requiredProgression : "",
    members: members.filter((member) => isAssignableFieldMember(member)),
    jobs,
    settings,
    policy,
    excludeJobId: job.id,
    timeZone,
  });
}

export function asCapacityJobs(jobs: ConflictJob[]): CapacityJob[] {
  return jobs;
}
