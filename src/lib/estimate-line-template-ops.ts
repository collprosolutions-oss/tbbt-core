/**
 * OWNER writes for named estimate-line templates.
 * businessId always comes from BusinessAccess. This module writes only
 * EstimateLineTemplate / EstimateLineTemplateLine rows and DRAFT
 * LineItem snapshots. It never writes ServiceCatalogItem prices,
 * SENT/APPROVED estimates, invoices, payments, or jobs.
 *
 * Apply claims the estimate with the same updateMany-WHERE-DRAFT lock
 * sendEstimate uses, then inserts lines. Create+apply share one
 * transaction so an invalid template cannot leave a new draft behind.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import {
  DRAFT_ONLY_APPLY_MESSAGE,
  DRAFT_ONLY_SAVE_MESSAGE,
  DUPLICATE_TEMPLATE_NAME_MESSAGE,
  NO_APPROVED_CHANGE_MESSAGE,
  NO_CATALOG_PRICE_WRITE_MESSAGE,
  REVIEW_BEFORE_SEND_MESSAGE,
  TEMPLATE_LIST_BOUND,
  TEMPLATE_NOT_FOUND_MESSAGE,
  TEMPLATE_UNAVAILABLE_MESSAGE,
  assertCanManageEstimateLineTemplates,
  canAccessEstimateLineTemplates,
  collectTemplateLines,
  parseTemplateName,
  templateNameKey,
  toSavedEstimateLineTemplate,
  type EstimateLineTemplateSnapshotLine,
  type SavedEstimateLineTemplate,
} from "@/lib/estimate-line-templates";

type Db = PrismaClient | Prisma.TransactionClient;

export class EstimateLineTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateLineTemplateError";
  }
}

export class EstimateLineTemplateUnavailableError extends EstimateLineTemplateError {
  constructor(message = TEMPLATE_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "EstimateLineTemplateUnavailableError";
  }
}

export function missingEstimateLineTemplateSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /EstimateLineTemplate|estimateLineTemplate|does not exist/i.test(message)
  );
}

export function estimateLineTemplateErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof EstimateLineTemplateError ||
    error instanceof EstimateLineTemplateUnavailableError ||
    error instanceof ForbiddenError
  ) {
    return error.message;
  }
  if (missingEstimateLineTemplateSchema(error)) {
    return TEMPLATE_UNAVAILABLE_MESSAGE;
  }
  if (
    error instanceof Error &&
    /template name|Name the estimate template|hourly pricing|draft line/i.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return fallback;
}

async function requireTemplateAccess(db: Db, access: BusinessAccess) {
  assertCanManageEstimateLineTemplates(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
}

export async function listEstimateLineTemplates(
  db: Db,
  access: BusinessAccess,
): Promise<{ templates: SavedEstimateLineTemplate[]; truncated: boolean }> {
  await requireTemplateAccess(db, access);
  try {
    const rows = await db.estimateLineTemplate.findMany({
      where: { businessId: access.businessId },
      include: {
        lines: {
          where: { businessId: access.businessId },
          orderBy: { sortOrder: "asc" },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      take: TEMPLATE_LIST_BOUND + 1,
    });
    const truncated = rows.length > TEMPLATE_LIST_BOUND;
    return {
      templates: rows
        .slice(0, TEMPLATE_LIST_BOUND)
        .filter((row) => row.businessId === access.businessId)
        .map((row) => toSavedEstimateLineTemplate(row)),
      truncated,
    };
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }
}

export async function loadEstimateLineTemplateOptions(
  db: Db,
  access: BusinessAccess,
): Promise<Array<{ id: string; name: string; lineCount: number }>> {
  if (!canAccessEstimateLineTemplates(access.workspace.role)) return [];
  try {
    const listed = await listEstimateLineTemplates(db, access);
    return listed.templates.map((template) => ({
      id: template.id,
      name: template.name,
      lineCount: template.lineCount,
    }));
  } catch (error) {
    if (
      error instanceof EstimateLineTemplateUnavailableError ||
      missingEstimateLineTemplateSchema(error)
    ) {
      return [];
    }
    throw error;
  }
}

async function loadOwnedTemplateLines(
  db: Db,
  access: BusinessAccess,
  templateId: string,
): Promise<EstimateLineTemplateSnapshotLine[]> {
  const templateRow = await db.estimateLineTemplate.findFirst({
    where: { id: templateId, ...access.scope },
    include: {
      lines: {
        where: { businessId: access.businessId },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!templateRow) {
    throw new EstimateLineTemplateError(TEMPLATE_NOT_FOUND_MESSAGE);
  }
  const template = access.assertOwned(templateRow);
  if (template.businessId !== access.businessId) {
    throw new ForbiddenError();
  }

  const collected = collectTemplateLines(template.lines);
  if (collected.error) {
    throw new EstimateLineTemplateError(collected.error);
  }
  return collected.lines;
}

/**
 * Claim the estimate with the same updateMany-WHERE-status-DRAFT lock
 * sendEstimate uses, then insert snapshot lines. A send that already
 * flipped SENT wins the row; this write then matches zero rows and
 * cannot leave template lines on a SENT estimate.
 */
async function applyCollectedTemplateLinesInTx(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  input: { estimateId: string; lines: EstimateLineTemplateSnapshotLine[] },
) {
  const claimed = await tx.estimate.updateMany({
    where: {
      id: input.estimateId,
      businessId: access.businessId,
      status: "DRAFT",
    },
    data: { updatedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new EstimateLineTemplateError(DRAFT_ONLY_APPLY_MESSAGE);
  }

  await tx.lineItem.createMany({
    data: input.lines.map((line) => ({
      businessId: access.businessId,
      estimateId: input.estimateId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: line.quantity.mul(line.unitPrice),
      type: line.type,
    })),
  });
  await persistDraftEstimateTotal(tx, input.estimateId, access.businessId);
}

export async function applyEstimateLineTemplateInTx(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  input: { templateId: string; estimateId: string },
): Promise<{ addedLineCount: number }> {
  await requireTemplateAccess(tx, access);
  const lines = await loadOwnedTemplateLines(tx, access, input.templateId);
  await applyCollectedTemplateLinesInTx(tx, access, {
    estimateId: input.estimateId,
    lines,
  });
  return { addedLineCount: lines.length };
}

export async function createDraftEstimateWithOptionalTemplate(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    customerId?: string | null;
    propertyId?: string | null;
    serviceRequestId?: string | null;
    templateId?: string | null;
    leadSource?: string | null;
  },
): Promise<{ estimateId: string; appliedTemplate: boolean; addedLineCount: number }> {
  try {
    return await db.$transaction(async (tx) => {
      const estimate = await tx.estimate.create({
        data: {
          businessId: access.businessId,
          customerId: input.customerId ?? undefined,
          propertyId: input.propertyId ?? undefined,
          serviceRequestId: input.serviceRequestId ?? undefined,
          total: new Prisma.Decimal(0),
          publicToken: randomUUID(),
          leadSource: input.leadSource ?? "MANUAL",
        },
      });
      if (!input.templateId) {
        return { estimateId: estimate.id, appliedTemplate: false, addedLineCount: 0 };
      }
      const applied = await applyEstimateLineTemplateInTx(tx, access, {
        templateId: input.templateId,
        estimateId: estimate.id,
      });
      return {
        estimateId: estimate.id,
        appliedTemplate: true,
        addedLineCount: applied.addedLineCount,
      };
    });
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }
}

export async function saveEstimateLineTemplateFromDraft(
  db: PrismaClient,
  access: BusinessAccess,
  input: { estimateId: string; name: string },
): Promise<{
  template: SavedEstimateLineTemplate;
  message: string;
}> {
  await requireTemplateAccess(db, access);
  const named = parseTemplateName(input.name);
  if (named.error || !named.name) {
    throw new EstimateLineTemplateError(named.error ?? "Name the estimate template before saving.");
  }
  const templateName = named.name;
  const nameKey = templateNameKey(templateName);

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        lineItems: {
          where: { businessId: access.businessId },
          orderBy: { createdAt: "asc" },
          select: {
            type: true,
            description: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineTemplateError(DRAFT_ONLY_SAVE_MESSAGE);
  }

  const collected = collectTemplateLines(estimate.lineItems);
  if (collected.error) {
    throw new EstimateLineTemplateError(collected.error);
  }

  const duplicate = await db.estimateLineTemplate.findFirst({
    where: {
      businessId: access.businessId,
      nameKey,
    },
    select: { id: true, businessId: true },
  });
  if (duplicate) {
    if (duplicate.businessId !== access.businessId) {
      throw new ForbiddenError();
    }
    throw new EstimateLineTemplateError(DUPLICATE_TEMPLATE_NAME_MESSAGE);
  }

  try {
    const created = await db.$transaction(async (tx) => {
      const template = await tx.estimateLineTemplate.create({
        data: {
          businessId: access.businessId,
          name: templateName,
          nameKey,
          createdByMembershipId: access.workspace.membership.id,
        },
      });
      if (template.businessId !== access.businessId) {
        throw new ForbiddenError();
      }
      await tx.estimateLineTemplateLine.createMany({
        data: collected.lines.map((line) => ({
          businessId: access.businessId,
          templateId: template.id,
          sortOrder: line.sortOrder,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          type: line.type,
        })),
      });
      return tx.estimateLineTemplate.findFirstOrThrow({
        where: { id: template.id, businessId: access.businessId },
        include: {
          lines: {
            where: { businessId: access.businessId },
            orderBy: { sortOrder: "asc" },
          },
        },
      });
    });

    return {
      template: toSavedEstimateLineTemplate(created),
      message: NO_CATALOG_PRICE_WRITE_MESSAGE,
    };
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: string }).code) === "P2002"
    ) {
      throw new EstimateLineTemplateError(DUPLICATE_TEMPLATE_NAME_MESSAGE);
    }
    throw error;
  }
}

export async function applyEstimateLineTemplateToDraft(
  db: PrismaClient,
  access: BusinessAccess,
  input: { templateId: string; estimateId: string },
): Promise<{
  estimateId: string;
  status: "DRAFT";
  addedLineCount: number;
  message: string;
}> {
  await requireTemplateAccess(db, access);

  const lines = await loadOwnedTemplateLines(db, access, input.templateId);

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineTemplateError(
      estimate.status === "APPROVED" ? NO_APPROVED_CHANGE_MESSAGE : DRAFT_ONLY_APPLY_MESSAGE,
    );
  }

  try {
    await db.$transaction(async (tx) => {
      await applyCollectedTemplateLinesInTx(tx, access, {
        estimateId: estimate.id,
        lines,
      });
    });
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }

  return {
    estimateId: estimate.id,
    status: "DRAFT",
    addedLineCount: lines.length,
    message: REVIEW_BEFORE_SEND_MESSAGE,
  };
}
