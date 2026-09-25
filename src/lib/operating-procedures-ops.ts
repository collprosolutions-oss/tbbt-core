/**
 * Operating procedure / checklist mutations. Not a workflow engine.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { createKnowledgeEntry } from "@/lib/knowledge-ops";
import { isConfiguredTrade } from "@/lib/trades";
import type { ProcedureStepInput } from "@/lib/operating-procedures";
import { isProcedureApprovalState } from "@/lib/operating-procedures";

type Db = PrismaClient | Prisma.TransactionClient;

export class ProcedureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureError";
  }
}

export function procedureErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ProcedureError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "KnowledgeError") return error.message;
  return fallback;
}

async function requireOwnedProcedure(db: Db, access: BusinessAccess, procedureId: string) {
  return access.assertOwned(
    await db.operatingProcedure.findFirst({
      where: { id: procedureId, ...access.scope },
      include: { steps: { orderBy: { sortOrder: "asc" } } },
    }),
  );
}

export async function createOperatingProcedure(
  db: Db,
  access: BusinessAccess,
  input: {
    title: string;
    summary?: string;
    tradeCode?: string | null;
    serviceCatalogItemId?: string | null;
    jobType?: string | null;
    steps: ProcedureStepInput[];
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  const title = input.title.trim();
  if (!title) throw new ProcedureError("A procedure needs a title.");
  const steps = input.steps
    .map((step, index) => ({
      title: step.title.trim(),
      body: step.body?.trim() ?? "",
      required: step.required !== false,
      sortOrder: index,
    }))
    .filter((step) => step.title);
  if (steps.length === 0) {
    throw new ProcedureError("Add at least one checklist step.");
  }
  if (input.tradeCode && !isConfiguredTrade(input.tradeCode)) {
    throw new ProcedureError("That trade is not configured.");
  }
  if (input.serviceCatalogItemId) {
    access.assertOwned(
      await db.serviceCatalogItem.findFirst({
        where: { id: input.serviceCatalogItemId, ...access.scope },
      }),
    );
  }

  return db.operatingProcedure.create({
    data: {
      businessId: access.businessId,
      title,
      summary: input.summary?.trim() ?? "",
      tradeCode: input.tradeCode?.trim() || null,
      serviceCatalogItemId: input.serviceCatalogItemId || null,
      jobType: input.jobType?.trim() || null,
      createdByMembershipId: access.workspace.membership.id,
      steps: {
        create: steps.map((step) => ({
          businessId: access.businessId,
          sortOrder: step.sortOrder,
          title: step.title,
          body: step.body,
          required: step.required,
        })),
      },
    },
    include: { steps: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function setOperatingProcedureApproval(
  db: Db,
  access: BusinessAccess,
  input: { procedureId: string; approvalState: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  if (!isProcedureApprovalState(input.approvalState)) {
    throw new ProcedureError("Choose an approval state.");
  }
  const existing = await requireOwnedProcedure(db, access, input.procedureId);
  let knowledgeEntryId = existing.knowledgeEntryId;
  if (input.approvalState === "APPROVED" && !knowledgeEntryId) {
    const body = [
      existing.summary,
      ...existing.steps.map((step, index) => `${index + 1}. ${step.title}${step.body ? ` — ${step.body}` : ""}`),
    ]
      .filter(Boolean)
      .join("\n");
    const entry = await createKnowledgeEntry(db, access, {
      title: existing.title,
      body: body || existing.title,
      category: "JOB_PROCEDURES",
      sourceType: "OWNER_CREATED",
      knowledgeKind: "STANDARD_OPERATING_PROCEDURE",
    });
    knowledgeEntryId = entry.id;
  }
  return db.operatingProcedure.update({
    where: { id: existing.id },
    data: {
      approvalState: input.approvalState,
      knowledgeEntryId,
    },
    include: { steps: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function setOperatingProcedureArchived(
  db: Db,
  access: BusinessAccess,
  input: { procedureId: string; archived: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  const existing = await requireOwnedProcedure(db, access, input.procedureId);
  return db.operatingProcedure.update({
    where: { id: existing.id },
    data: { archived: input.archived },
  });
}
