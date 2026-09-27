/**
 * Read helpers for the Cleaning recurring-visit + crew-checklist workflow.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  cleaningVisitWorkflowEligible,
  packCrewChecklist,
  parseChecklistJson,
  parseVisitOutcomeStatus,
  resolveJobTradeCode,
  visitCadenceSummary,
  visitOutcomeLabel,
  type CrewChecklistItem,
} from "@/lib/cleaning-visit-workflow";

type Db = PrismaClient | Prisma.TransactionClient;

const JOB_TRADE_INCLUDE = {
  estimate: {
    select: {
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { serviceCatalogItem: { select: { tradeCode: true } } },
      },
    },
  },
} as const;

export type CleaningVisitView = {
  eligible: boolean;
  tradeCode: string;
  jobId: string;
  cadenceLabel: string;
  serviceIntent: string;
  recurrenceCadence: string;
  outcomeStatus: string;
  outcomeLabel: string;
  checklist: CrewChecklistItem[];
  procedureId: string | null;
  procedureTitle: string | null;
  checklists: Array<{ id: string; title: string }>;
};

export async function loadCleaningVisitView(
  db: Db,
  access: BusinessAccess,
  jobId: string,
): Promise<CleaningVisitView | null> {
  const job = await db.job.findFirst({
    where: { id: jobId, ...access.scope },
    select: {
      id: true,
      businessId: true,
      serviceIntent: true,
      recurrenceCadence: true,
      ...JOB_TRADE_INCLUDE,
    },
  });
  if (!job) return null;
  access.assertOwned(job);
  const tradeCode = resolveJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningVisitWorkflowEligible(tradeCode)) {
    return {
      eligible: false,
      tradeCode,
      jobId: job.id,
      cadenceLabel: visitCadenceSummary(job),
      serviceIntent: job.serviceIntent,
      recurrenceCadence: job.recurrenceCadence,
      outcomeStatus: "NONE",
      outcomeLabel: visitOutcomeLabel("NONE"),
      checklist: [],
      procedureId: null,
      procedureTitle: null,
      checklists: [],
    };
  }

  const [visit, checklists] = await Promise.all([
    db.jobCrewVisit.findFirst({
      where: { jobId: job.id, businessId: access.businessId },
      include: { procedure: { select: { id: true, title: true } } },
    }),
    db.operatingProcedure.findMany({
      where: {
        businessId: access.businessId,
        archived: false,
        approvalState: "APPROVED",
        OR: [{ tradeCode: "CLEANING" }, { tradeCode: null }],
      },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
  ]);

  const checklist = visit
    ? parseChecklistJson(visit.checklistJson)
    : packCrewChecklist();
  const outcomeStatus = parseVisitOutcomeStatus(visit?.outcomeStatus);

  return {
    eligible: true,
    tradeCode,
    jobId: job.id,
    cadenceLabel: visitCadenceSummary(job),
    serviceIntent: job.serviceIntent,
    recurrenceCadence: job.recurrenceCadence,
    outcomeStatus,
    outcomeLabel: visitOutcomeLabel(outcomeStatus),
    checklist,
    procedureId: visit?.procedureId ?? null,
    procedureTitle: visit?.procedure?.title ?? null,
    checklists,
  };
}

export async function loadAssignedCleaningVisitView(
  db: Db,
  actor: { businessId: string; membershipId: string },
  jobId: string,
) {
  const job = await db.job.findFirst({
    where: {
      id: jobId,
      businessId: actor.businessId,
      assignedMembershipId: actor.membershipId,
    },
    select: {
      id: true,
      businessId: true,
      serviceIntent: true,
      recurrenceCadence: true,
      ...JOB_TRADE_INCLUDE,
    },
  });
  if (!job) return null;
  const tradeCode = resolveJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningVisitWorkflowEligible(tradeCode)) return null;
  const visit = await db.jobCrewVisit.findFirst({
    where: { jobId: job.id, businessId: actor.businessId },
    include: { procedure: { select: { title: true } } },
  });
  const outcomeStatus = parseVisitOutcomeStatus(visit?.outcomeStatus);
  return {
    eligible: true,
    tradeCode,
    jobId: job.id,
    cadenceLabel: visitCadenceSummary(job),
    outcomeStatus,
    outcomeLabel: visitOutcomeLabel(outcomeStatus),
    checklist: visit ? parseChecklistJson(visit.checklistJson) : packCrewChecklist(),
    procedureTitle: visit?.procedure?.title ?? null,
    hasCadence: job.serviceIntent === "RECURRING",
  };
}
