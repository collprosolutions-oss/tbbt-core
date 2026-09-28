/**
 * OWNER writes for named estimate-line templates.
 * businessId always comes from BusinessAccess. This module writes only
 * EstimateLineTemplate / EstimateLineTemplateLine rows and DRAFT
 * LineItem snapshots. It never writes ServiceCatalogItem prices,
 * SENT/APPROVED estimates, invoices, payments, or jobs.
 */
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
  toSavedEstimateLineTemplate,
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
      name: { equals: named.name, mode: "insensitive" },
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
          name: named.name,
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

  const templateRow = await db.estimateLineTemplate.findFirst({
    where: { id: input.templateId, ...access.scope },
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

  await db.$transaction(async (tx) => {
    const stillDraft = await tx.estimate.findFirst({
      where: { id: estimate.id, businessId: access.businessId, status: "DRAFT" },
      select: { id: true, status: true },
    });
    if (!stillDraft || stillDraft.status !== "DRAFT") {
      throw new EstimateLineTemplateError(DRAFT_ONLY_APPLY_MESSAGE);
    }
    await tx.lineItem.createMany({
      data: collected.lines.map((line) => ({
        businessId: access.businessId,
        estimateId: estimate.id,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        total: line.quantity.mul(line.unitPrice),
        type: line.type,
      })),
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  const refreshed = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimate.id, ...access.scope },
      select: { id: true, status: true },
    }),
  );
  if (refreshed.status !== "DRAFT") {
    throw new EstimateLineTemplateError(DRAFT_ONLY_APPLY_MESSAGE);
  }

  return {
    estimateId: refreshed.id,
    status: "DRAFT",
    addedLineCount: collected.lines.length,
    message: REVIEW_BEFORE_SEND_MESSAGE,
  };
}
