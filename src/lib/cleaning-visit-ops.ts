/**
 * Cleaning visit workflow mutations.
 *
 * OWNER sets cadence on the existing Job. The assigned worker updates the
 * crew checklist and records VISIT_COMPLETED or RE_CLEAN_REQUESTED.
 * Never creates Job rows, never sends customer messages, never writes
 * CRM or payment records, and never invents a quality stamp.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  ASSIGNED_WORKER_ONLY_MESSAGE,
  CLEANING_VISIT_ONLY_MESSAGE,
  OWNER_SETS_CADENCE_MESSAGE,
  START_BEFORE_COMPLETE_MESSAGE,
  checklistFromProcedureSteps,
  cleaningVisitWorkflowEligible,
  ownerCadencePlan,
  packCrewChecklist,
  parseChecklistJson,
  parseRecordedVisitOutcome,
  resolveJobTradeCode,
  serializeChecklist,
  toggleChecklistItem,
  nextOccurrenceForCadence,
  type CrewChecklistItem,
} from "@/lib/cleaning-visit-workflow";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { completeJobWithRunningTimeSafety } from "@/lib/time-card-ops";
import { parseRecurrenceCadence } from "@/lib/recurrence";

type Db = PrismaClient | Prisma.TransactionClient;

export class CleaningVisitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleaningVisitError";
  }
}

export function cleaningVisitErrorMessage(error: unknown, fallback: string) {
  if (error instanceof CleaningVisitError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export type AssignedVisitActor = {
  businessId: string;
  membershipId: string;
};

const JOB_TRADE_SELECT = {
  id: true,
  businessId: true,
  status: true,
  scheduledAt: true,
  assignedMembershipId: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
  estimate: {
    select: {
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { serviceCatalogItem: { select: { tradeCode: true } } },
      },
    },
  },
} as const;

type JobTradeRow = Prisma.JobGetPayload<{ select: typeof JOB_TRADE_SELECT }>;

function jobTradeCode(job: JobTradeRow) {
  return resolveJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
}

function assertCleaningJob(job: JobTradeRow) {
  if (!cleaningVisitWorkflowEligible(jobTradeCode(job))) {
    throw new CleaningVisitError(CLEANING_VISIT_ONLY_MESSAGE);
  }
}

async function loadScopedJob(db: Db, businessId: string, jobId: string) {
  return db.job.findFirst({
    where: { id: jobId, businessId },
    select: JOB_TRADE_SELECT,
  });
}

async function requireOwnedCleaningJob(
  db: Db,
  access: BusinessAccess,
  jobId: string,
) {
  const job = access.assertOwned(await loadScopedJob(db, access.businessId, jobId));
  assertCleaningJob(job);
  return job;
}

async function requireAssignedCleaningJob(
  db: Db,
  actor: AssignedVisitActor,
  jobId: string,
) {
  const job = await db.job.findFirst({
    where: {
      id: jobId,
      businessId: actor.businessId,
      assignedMembershipId: actor.membershipId,
    },
    select: JOB_TRADE_SELECT,
  });
  if (!job) {
    throw new CleaningVisitError(ASSIGNED_WORKER_ONLY_MESSAGE);
  }
  assertCleaningJob(job);
  return job;
}

async function loadApprovedCleaningProcedure(
  db: Db,
  businessId: string,
  procedureId: string,
) {
  const procedure = await db.operatingProcedure.findFirst({
    where: {
      id: procedureId,
      businessId,
      archived: false,
      approvalState: "APPROVED",
      OR: [{ tradeCode: "CLEANING" }, { tradeCode: null }],
    },
    include: { steps: { orderBy: { sortOrder: "asc" } } },
  });
  if (!procedure || procedure.steps.length === 0) {
    throw new CleaningVisitError("Choose an approved Cleaning checklist.");
  }
  return procedure;
}

function checklistForProcedure(procedure: {
  steps: Array<{ id: string; title: string; required: boolean }>;
}): CrewChecklistItem[] {
  const items = checklistFromProcedureSteps(procedure.steps);
  if (items.length === 0) {
    throw new CleaningVisitError("That checklist has no steps.");
  }
  return items;
}

async function upsertVisitRecord(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    procedureId?: string | null;
    checklist: CrewChecklistItem[];
  },
) {
  return db.jobCrewVisit.upsert({
    where: { jobId: input.jobId },
    create: {
      businessId: input.businessId,
      jobId: input.jobId,
      procedureId: input.procedureId ?? null,
      checklistJson: serializeChecklist(input.checklist),
      outcomeStatus: "NONE",
    },
    update: {
      procedureId: input.procedureId ?? null,
      checklistJson: serializeChecklist(input.checklist),
    },
  });
}

export async function setCleaningVisitCadence(
  db: Db,
  access: BusinessAccess,
  input: { jobId: string; cadence: string; timeZone?: string },
) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_SETS_CADENCE_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
  const job = await requireOwnedCleaningJob(db, access, input.jobId);
  const planned = ownerCadencePlan(input.cadence);
  if (!planned.ok) {
    throw new CleaningVisitError(planned.error);
  }
  const plan = planned.plan;
  const timeZone =
    input.timeZone ?? resolveBusinessTimeZone(access.workspace.business);
  const nextOccurrenceAt =
    plan.serviceIntent === "RECURRING"
      ? nextOccurrenceForCadence({
          scheduledAt: job.scheduledAt,
          cadence: parseRecurrenceCadence(plan.recurrenceCadence),
          existingNext: null,
          timeZone,
        })
      : null;

  await db.job.update({
    where: { id: job.id },
    data: {
      serviceIntent: plan.serviceIntent,
      recurrenceCadence: plan.recurrenceCadence,
      recurrenceStatus: plan.recurrenceStatus,
      nextOccurrenceAt,
    },
  });

  const existing = await db.jobCrewVisit.findFirst({
    where: { jobId: job.id, businessId: access.businessId },
  });
  if (!existing) {
    await upsertVisitRecord(db, {
      businessId: access.businessId,
      jobId: job.id,
      checklist: packCrewChecklist(),
    });
  }

  return db.job.findFirstOrThrow({
    where: { id: job.id, businessId: access.businessId },
    select: {
      id: true,
      serviceIntent: true,
      recurrenceCadence: true,
      recurrenceStatus: true,
      nextOccurrenceAt: true,
    },
  });
}

export async function attachCleaningCrewChecklist(
  db: Db,
  access: BusinessAccess,
  input: { jobId: string; procedureId: string },
) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_SETS_CADENCE_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
  const job = await requireOwnedCleaningJob(db, access, input.jobId);
  const procedure = await loadApprovedCleaningProcedure(
    db,
    access.businessId,
    input.procedureId,
  );
  return upsertVisitRecord(db, {
    businessId: access.businessId,
    jobId: job.id,
    procedureId: procedure.id,
    checklist: checklistForProcedure(procedure),
  });
}

export async function setAssignedChecklistItem(
  db: Db,
  actor: AssignedVisitActor,
  input: { jobId: string; itemKey: string; checked: boolean },
) {
  const job = await requireAssignedCleaningJob(db, actor, input.jobId);
  const visit = await db.jobCrewVisit.findFirst({
    where: { jobId: job.id, businessId: actor.businessId },
  });
  if (!visit) {
    throw new CleaningVisitError("The owner has not set a visit cadence yet.");
  }
  const items = parseChecklistJson(visit.checklistJson);
  if (!items.some((item) => item.key === input.itemKey)) {
    throw new CleaningVisitError("That checklist item is not on this visit.");
  }
  const next = toggleChecklistItem(items, input.itemKey, input.checked);
  return db.jobCrewVisit.update({
    where: { id: visit.id },
    data: { checklistJson: serializeChecklist(next) },
  });
}

export async function recordAssignedVisitOutcome(
  db: PrismaClient,
  actor: AssignedVisitActor,
  input: { jobId: string; outcomeStatus: string },
) {
  const outcome = parseRecordedVisitOutcome(input.outcomeStatus);
  if (!outcome) {
    throw new CleaningVisitError("Choose visit completed or requested re-clean.");
  }
  const job = await requireAssignedCleaningJob(db, actor, input.jobId);
  let visit = await db.jobCrewVisit.findFirst({
    where: { jobId: job.id, businessId: actor.businessId },
  });
  if (!visit) {
    visit = await upsertVisitRecord(db, {
      businessId: actor.businessId,
      jobId: job.id,
      checklist: packCrewChecklist(),
    });
  }

  if (outcome === "VISIT_COMPLETED" && job.status !== "IN_PROGRESS" && job.status !== "COMPLETED") {
    throw new CleaningVisitError(START_BEFORE_COMPLETE_MESSAGE);
  }

  const recorded = await db.jobCrewVisit.update({
    where: { id: visit.id },
    data: {
      outcomeStatus: outcome,
      outcomeRecordedAt: new Date(),
      outcomeRecordedByMembershipId: actor.membershipId,
    },
  });

  let jobStatus = job.status;
  if (outcome === "VISIT_COMPLETED" && job.status === "IN_PROGRESS") {
    const completed = await completeJobWithRunningTimeSafety(db, {
      businessId: actor.businessId,
      jobId: job.id,
      actorMembershipId: actor.membershipId,
    });
    if (!completed.ok) {
      throw new CleaningVisitError(completed.error);
    }
    jobStatus = "COMPLETED";
  }

  return { visit: recorded, jobStatus };
}

export async function countBusinessJobs(db: Db, businessId: string) {
  return db.job.count({ where: { businessId } });
}
