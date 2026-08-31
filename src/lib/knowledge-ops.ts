/**
 * Knowledge Hub mutations. Tenant scope always comes from BusinessAccess
 * (authenticated workspace), never from a client-supplied businessId.
 *
 * These writes only touch KnowledgeEntry. They never create, update, or
 * delete ServiceCatalogItem, Estimate, Job, Expense, TimeEntry, Marketing,
 * or Review records, and they never change pricing.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  SYSTEM_DERIVED_DISABLED_MESSAGE,
  isKnowledgeCategory,
  isKnowledgeSourceKind,
  isKnowledgeSourceType,
  isKnowledgeTrustState,
  isUsefulKnowledgeBody,
  type KnowledgeCategory,
  type KnowledgeSourceKind,
  type KnowledgeSourceType,
  type KnowledgeTrustState,
} from "@/lib/knowledge";

type Db = PrismaClient | Prisma.TransactionClient;

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeError";
  }
}

export function knowledgeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof KnowledgeError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

async function requireOwnedEntry(db: Db, access: BusinessAccess, entryId: string) {
  return access.assertOwned(
    await db.knowledgeEntry.findFirst({
      where: { id: entryId, ...access.scope },
    }),
  );
}

async function resolveTbbtSource(
  db: Db,
  access: BusinessAccess,
  kind: KnowledgeSourceKind,
  sourceReferenceId: string,
): Promise<{ sourceKind: KnowledgeSourceKind; sourceReferenceId: string; sourceLabel: string }> {
  if (kind === "SERVICE") {
    const row = access.assertOwned(
      await db.serviceCatalogItem.findFirst({
        where: { id: sourceReferenceId, ...access.scope },
        select: { id: true, businessId: true, name: true },
      }),
    );
    return { sourceKind: kind, sourceReferenceId: row.id, sourceLabel: row.name };
  }
  if (kind === "ESTIMATE") {
    const row = access.assertOwned(
      await db.estimate.findFirst({
        where: { id: sourceReferenceId, ...access.scope },
        select: { id: true, businessId: true, status: true },
      }),
    );
    return { sourceKind: kind, sourceReferenceId: row.id, sourceLabel: `Estimate (${row.status})` };
  }
  if (kind === "JOB") {
    const row = access.assertOwned(
      await db.job.findFirst({
        where: { id: sourceReferenceId, ...access.scope },
        select: { id: true, businessId: true, status: true },
      }),
    );
    if (row.status !== "COMPLETED") {
      throw new KnowledgeError("Only a completed job can be referenced as job experience.");
    }
    return { sourceKind: kind, sourceReferenceId: row.id, sourceLabel: "Completed job" };
  }
  if (kind === "EXPENSE") {
    const row = access.assertOwned(
      await db.expense.findFirst({
        where: { id: sourceReferenceId, ...access.scope },
        select: { id: true, businessId: true, description: true, vendor: true },
      }),
    );
    return {
      sourceKind: kind,
      sourceReferenceId: row.id,
      sourceLabel: row.vendor ? `${row.description} · ${row.vendor}` : row.description,
    };
  }
  if (kind === "TIME") {
    const row = access.assertOwned(
      await db.timeEntry.findFirst({
        where: { id: sourceReferenceId, ...access.scope },
        select: { id: true, businessId: true, status: true },
      }),
    );
    if (row.status !== "APPROVED") {
      throw new KnowledgeError("Only approved time can be used as finalized labor context.");
    }
    return { sourceKind: kind, sourceReferenceId: row.id, sourceLabel: "Approved time" };
  }
  if (kind === "MARKETING") {
    const row = access.assertOwned(
      await db.marketingContent.findFirst({
        where: { id: sourceReferenceId, ...access.scope },
        select: { id: true, businessId: true, title: true },
      }),
    );
    return { sourceKind: kind, sourceReferenceId: row.id, sourceLabel: row.title };
  }
  const row = access.assertOwned(
    await db.review.findFirst({
      where: { id: sourceReferenceId, ...access.scope },
      select: { id: true, businessId: true, platform: true },
    }),
  );
  return { sourceKind: kind, sourceReferenceId: row.id, sourceLabel: `Review (${row.platform})` };
}

function assertWritableTrust(
  category: KnowledgeCategory,
  sourceType: KnowledgeSourceType,
  trustState: KnowledgeTrustState,
) {
  if (trustState === "VERIFIED" && sourceType === "OWNER_CREATED") {
    throw new KnowledgeError(
      "Verified requires a supporting TBBT record or external reference. Owner-entered text is not verified just because it was typed.",
    );
  }
  if (category === "SAFETY_COMPLIANCE" && trustState === "VERIFIED") {
    if (sourceType !== "TBBT_RECORD" && sourceType !== "EXTERNAL_REFERENCE") {
      throw new KnowledgeError(
        "Safety / compliance cannot be marked Verified without a TBBT record or external reference.",
      );
    }
  }
}

function normalizeProvenance(input: {
  sourceType: string;
  sourceKind?: string;
  sourceReferenceId?: string;
  sourceLabel?: string;
}): {
  sourceType: KnowledgeSourceType;
  sourceKind: KnowledgeSourceKind | null;
  sourceReferenceId: string | null;
  sourceLabel: string | null;
  needsRecord: boolean;
} {
  if (!isKnowledgeSourceType(input.sourceType)) {
    throw new KnowledgeError("Choose a source type.");
  }
  if (input.sourceType === "SYSTEM_DERIVED") {
    throw new KnowledgeError(SYSTEM_DERIVED_DISABLED_MESSAGE);
  }

  const sourceKind = input.sourceKind?.trim() || "";
  const sourceReferenceId = input.sourceReferenceId?.trim() || "";
  const sourceLabel = input.sourceLabel?.trim() || "";

  if (input.sourceType === "TBBT_RECORD") {
    if (!isKnowledgeSourceKind(sourceKind) || !sourceReferenceId) {
      throw new KnowledgeError("A TBBT record source needs a record type and a record from this business.");
    }
    return {
      sourceType: input.sourceType,
      sourceKind,
      sourceReferenceId,
      sourceLabel: sourceLabel || null,
      needsRecord: true,
    };
  }

  if (input.sourceType === "EXTERNAL_REFERENCE") {
    if (!sourceLabel) {
      throw new KnowledgeError("An external reference needs a source label (citation or URL text).");
    }
    return {
      sourceType: input.sourceType,
      sourceKind: null,
      sourceReferenceId: null,
      sourceLabel,
      needsRecord: false,
    };
  }

  return {
    sourceType: "OWNER_CREATED",
    sourceKind: null,
    sourceReferenceId: null,
    sourceLabel: sourceLabel || null,
    needsRecord: false,
  };
}

export type CreateKnowledgeEntryInput = {
  title: string;
  body: string;
  category: string;
  sourceType: string;
  sourceKind?: string;
  sourceReferenceId?: string;
  sourceLabel?: string;
  trustState?: string;
};

export async function createKnowledgeEntry(
  db: Db,
  access: BusinessAccess,
  input: CreateKnowledgeEntryInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);

  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) {
    throw new KnowledgeError("Enter a title.");
  }
  if (!isUsefulKnowledgeBody(body)) {
    throw new KnowledgeError("Enter useful knowledge notes — a title alone is not enough.");
  }
  if (!isKnowledgeCategory(input.category)) {
    throw new KnowledgeError("Choose a knowledge category.");
  }

  const trustState = input.trustState?.trim() || "UNKNOWN";
  if (!isKnowledgeTrustState(trustState)) {
    throw new KnowledgeError("Choose a trust state.");
  }

  const provenance = normalizeProvenance(input);
  assertWritableTrust(input.category, provenance.sourceType, trustState);

  let sourceKind = provenance.sourceKind;
  let sourceReferenceId = provenance.sourceReferenceId;
  let sourceLabel = provenance.sourceLabel;
  if (provenance.needsRecord && provenance.sourceKind && provenance.sourceReferenceId) {
    const resolved = await resolveTbbtSource(db, access, provenance.sourceKind, provenance.sourceReferenceId);
    sourceKind = resolved.sourceKind;
    sourceReferenceId = resolved.sourceReferenceId;
    sourceLabel = provenance.sourceLabel || resolved.sourceLabel;
  }

  return db.knowledgeEntry.create({
    data: {
      businessId: access.businessId,
      title,
      body,
      category: input.category,
      sourceType: provenance.sourceType,
      sourceKind,
      sourceReferenceId,
      sourceLabel,
      trustState,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export type UpdateKnowledgeEntryInput = {
  entryId: string;
  title?: string;
  body?: string;
  category?: string;
  trustState?: string;
  sourceType?: string;
  sourceKind?: string;
  sourceReferenceId?: string;
  sourceLabel?: string;
};

export async function updateKnowledgeEntry(
  db: Db,
  access: BusinessAccess,
  input: UpdateKnowledgeEntryInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  const existing = await requireOwnedEntry(db, access, input.entryId);

  const data: Prisma.KnowledgeEntryUpdateInput = {};

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new KnowledgeError("Enter a title.");
    data.title = title;
  }
  if (input.body !== undefined) {
    const body = input.body.trim();
    if (!isUsefulKnowledgeBody(body)) {
      throw new KnowledgeError("Enter useful knowledge notes — a title alone is not enough.");
    }
    data.body = body;
  }

  const nextCategory = input.category !== undefined ? input.category : existing.category;
  if (input.category !== undefined) {
    if (!isKnowledgeCategory(input.category)) {
      throw new KnowledgeError("Choose a knowledge category.");
    }
    data.category = input.category;
  }

  const nextTrust = input.trustState !== undefined ? input.trustState : existing.trustState;
  if (input.trustState !== undefined) {
    if (!isKnowledgeTrustState(input.trustState)) {
      throw new KnowledgeError("Choose a trust state.");
    }
    data.trustState = input.trustState;
  }

  const provenanceTouched =
    input.sourceType !== undefined ||
    input.sourceKind !== undefined ||
    input.sourceReferenceId !== undefined ||
    input.sourceLabel !== undefined;

  let nextSourceType = existing.sourceType;
  if (provenanceTouched) {
    const provenance = normalizeProvenance({
      sourceType: input.sourceType ?? existing.sourceType,
      sourceKind: input.sourceKind !== undefined ? input.sourceKind : existing.sourceKind ?? undefined,
      sourceReferenceId:
        input.sourceReferenceId !== undefined
          ? input.sourceReferenceId
          : existing.sourceReferenceId ?? undefined,
      sourceLabel: input.sourceLabel !== undefined ? input.sourceLabel : existing.sourceLabel ?? undefined,
    });
    nextSourceType = provenance.sourceType;
    data.sourceType = provenance.sourceType;
    if (provenance.needsRecord && provenance.sourceKind && provenance.sourceReferenceId) {
      const resolved = await resolveTbbtSource(db, access, provenance.sourceKind, provenance.sourceReferenceId);
      data.sourceKind = resolved.sourceKind;
      data.sourceReferenceId = resolved.sourceReferenceId;
      data.sourceLabel = provenance.sourceLabel || resolved.sourceLabel;
    } else {
      data.sourceKind = provenance.sourceKind;
      data.sourceReferenceId = provenance.sourceReferenceId;
      data.sourceLabel = provenance.sourceLabel;
    }
  }

  if (!isKnowledgeCategory(nextCategory) || !isKnowledgeTrustState(nextTrust) || !isKnowledgeSourceType(nextSourceType)) {
    throw new KnowledgeError("That knowledge entry could not be updated.");
  }
  assertWritableTrust(nextCategory, nextSourceType, nextTrust);

  return db.knowledgeEntry.update({
    where: { id: existing.id },
    data,
  });
}

export async function markKnowledgeReviewed(
  db: Db,
  access: BusinessAccess,
  input: { entryId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  const existing = await requireOwnedEntry(db, access, input.entryId);
  return db.knowledgeEntry.update({
    where: { id: existing.id },
    data: {
      lastReviewedAt: new Date(),
      lastReviewedByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function setKnowledgeArchived(
  db: Db,
  access: BusinessAccess,
  input: { entryId: string; archived: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_KNOWLEDGE);
  const existing = await requireOwnedEntry(db, access, input.entryId);
  return db.knowledgeEntry.update({
    where: { id: existing.id },
    data: { archived: input.archived },
  });
}
