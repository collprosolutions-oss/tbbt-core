/**
 * OWNER writes for named estimate-line templates.
 * businessId always comes from BusinessAccess. This module writes only
 * EstimateLineTemplate / EstimateLineTemplateLine rows and DRAFT
 * LineItem snapshots. Edit, rename, and archive change the stored
 * template for future applications only — they never rewrite LineItem
 * rows on estimates that already used the template. It never writes
 * ServiceCatalogItem prices, SENT/APPROVED estimates, invoices,
 * payments, or jobs. This file never writes ServiceCatalogItem.
 *
 * Apply claims the template with updateMany-WHERE-archived-false and the
 * estimate with the same updateMany-WHERE-DRAFT lock sendEstimate uses,
 * then inserts lines. If archive or send commits first, the later apply
 * or edit-from-draft matches zero rows and cannot change template lines
 * or leave a new draft. Create+apply share one transaction so an
 * invalid or archived template cannot leave a new draft behind.
 * Archived templates stay out of apply pickers.
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
  TEMPLATE_ARCHIVED_MESSAGE,
  TEMPLATE_ARCHIVED_OK_MESSAGE,
  TEMPLATE_LINES_REPLACED_MESSAGE,
  TEMPLATE_LIST_BOUND,
  TEMPLATE_NOT_FOUND_MESSAGE,
  TEMPLATE_RENAMED_MESSAGE,
  TEMPLATE_RESTORED_MESSAGE,
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

function prismaErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

export function isDuplicateEstimateLineTemplateNameError(error: unknown) {
  return prismaErrorCode(error) === "P2002";
}

export function missingEstimateLineTemplateSchema(error: unknown) {
  const code = prismaErrorCode(error);
  if (code === "P2002") return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /EstimateLineTemplate|estimateLineTemplate|does not exist/i.test(message)
  );
}

/**
 * Test-only barriers. Production never sets these.
 * - beforeApplyClaims: archive-versus-apply meets after the later apply
 *   has entered its write transaction and before it claims archived=false.
 * - beforeEditClaims: send-versus-edit meets after edit entered its write
 *   transaction and before it claims the source estimate as DRAFT.
 */
export const estimateLineTemplateTestHooks: {
  beforeApplyClaims?: (input: {
    templateId: string;
    estimateId: string;
  }) => Promise<void> | void;
  beforeEditClaims?: (input: {
    templateId: string;
    estimateId: string;
  }) => Promise<void> | void;
} = {};

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
    /template name|Name the estimate template|hourly pricing|draft line|archived/i.test(
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
  options: { includeArchived?: boolean } = {},
): Promise<{ templates: SavedEstimateLineTemplate[]; truncated: boolean }> {
  await requireTemplateAccess(db, access);
  try {
    const rows = await db.estimateLineTemplate.findMany({
      where: {
        businessId: access.businessId,
        ...(options.includeArchived ? {} : { archived: false }),
      },
      include: {
        lines: {
          where: { businessId: access.businessId },
          orderBy: { sortOrder: "asc" },
        },
      },
      orderBy: [{ archived: "asc" }, { updatedAt: "desc" }, { name: "asc" }],
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
    const listed = await listEstimateLineTemplates(db, access, {
      includeArchived: false,
    });
    return listed.templates
      .filter((template) => !template.archived)
      .map((template) => ({
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

export type EstimateLineTemplateDirectory = {
  available: boolean;
  templates: SavedEstimateLineTemplate[];
  truncated: boolean;
};

export async function loadEstimateLineTemplateDirectory(
  db: Db,
  access: BusinessAccess,
): Promise<EstimateLineTemplateDirectory> {
  if (!canAccessEstimateLineTemplates(access.workspace.role)) {
    return { available: true, templates: [], truncated: false };
  }
  try {
    const listed = await listEstimateLineTemplates(db, access, {
      includeArchived: true,
    });
    return { available: true, ...listed };
  } catch (error) {
    if (
      error instanceof EstimateLineTemplateUnavailableError ||
      missingEstimateLineTemplateSchema(error)
    ) {
      return { available: false, templates: [], truncated: false };
    }
    throw error;
  }
}

async function loadOwnedTemplate(
  db: Db,
  access: BusinessAccess,
  templateId: string,
) {
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
  return template;
}

async function loadOwnedTemplateLines(
  db: Db,
  access: BusinessAccess,
  templateId: string,
  options: { allowArchived?: boolean } = {},
): Promise<EstimateLineTemplateSnapshotLine[]> {
  const template = await loadOwnedTemplate(db, access, templateId);
  if (template.archived && !options.allowArchived) {
    throw new EstimateLineTemplateError(TEMPLATE_ARCHIVED_MESSAGE);
  }

  const collected = collectTemplateLines(template.lines);
  if (collected.error) {
    throw new EstimateLineTemplateError(collected.error);
  }
  return collected.lines;
}

async function assertUniqueTemplateName(
  db: Db,
  access: BusinessAccess,
  nameKey: string,
  exceptTemplateId?: string,
) {
  const duplicate = await db.estimateLineTemplate.findFirst({
    where: {
      businessId: access.businessId,
      nameKey,
      ...(exceptTemplateId ? { id: { not: exceptTemplateId } } : {}),
    },
    select: { id: true, businessId: true },
  });
  if (!duplicate) return;
  if (duplicate.businessId !== access.businessId) {
    throw new ForbiddenError();
  }
  throw new EstimateLineTemplateError(DUPLICATE_TEMPLATE_NAME_MESSAGE);
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

async function claimActiveTemplateForApply(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  templateId: string,
) {
  const claimed = await tx.estimateLineTemplate.updateMany({
    where: {
      id: templateId,
      businessId: access.businessId,
      archived: false,
    },
    data: { updatedAt: new Date() },
  });
  if (claimed.count === 1) return;
  const existing = await tx.estimateLineTemplate.findFirst({
    where: { id: templateId, ...access.scope },
    select: { id: true, businessId: true, archived: true },
  });
  if (!existing) {
    throw new EstimateLineTemplateError(TEMPLATE_NOT_FOUND_MESSAGE);
  }
  if (existing.businessId !== access.businessId) {
    throw new ForbiddenError();
  }
  throw new EstimateLineTemplateError(TEMPLATE_ARCHIVED_MESSAGE);
}

export async function applyEstimateLineTemplateInTx(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  input: { templateId: string; estimateId: string },
): Promise<{ addedLineCount: number }> {
  await requireTemplateAccess(tx, access);
  await estimateLineTemplateTestHooks.beforeApplyClaims?.({
    templateId: input.templateId,
    estimateId: input.estimateId,
  });
  await claimActiveTemplateForApply(tx, access, input.templateId);
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
    }, { timeout: 15_000 });
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

  const collected = await loadOwnedDraftTemplateSourceLines(db, access, input.estimateId);
  await assertUniqueTemplateName(db, access, nameKey);

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
        data: collected.map((line) => ({
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
    if (isDuplicateEstimateLineTemplateNameError(error)) {
      throw new EstimateLineTemplateError(DUPLICATE_TEMPLATE_NAME_MESSAGE);
    }
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
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
    const applied = await db.$transaction(async (tx) => {
      return applyEstimateLineTemplateInTx(tx, access, {
        templateId: input.templateId,
        estimateId: estimate.id,
      });
    }, { timeout: 15_000 });
    return {
      estimateId: estimate.id,
      status: "DRAFT",
      addedLineCount: applied.addedLineCount,
      message: REVIEW_BEFORE_SEND_MESSAGE,
    };
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }
}

async function loadOwnedDraftTemplateSourceLines(
  db: Db,
  access: BusinessAccess,
  estimateId: string,
): Promise<EstimateLineTemplateSnapshotLine[]> {
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
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
  return collected.lines;
}

export async function renameEstimateLineTemplate(
  db: PrismaClient,
  access: BusinessAccess,
  input: { templateId: string; name: string },
): Promise<{ template: SavedEstimateLineTemplate; message: string }> {
  await requireTemplateAccess(db, access);
  const named = parseTemplateName(input.name);
  if (named.error || !named.name) {
    throw new EstimateLineTemplateError(named.error ?? "Name the estimate template before saving.");
  }
  const templateName = named.name;
  const nameKey = templateNameKey(templateName);
  const existing = await loadOwnedTemplate(db, access, input.templateId);
  await assertUniqueTemplateName(db, access, nameKey, existing.id);

  try {
    const updated = await db.estimateLineTemplate.update({
      where: { id: existing.id },
      data: { name: templateName, nameKey },
      include: {
        lines: {
          where: { businessId: access.businessId },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (updated.businessId !== access.businessId) {
      throw new ForbiddenError();
    }
    return {
      template: toSavedEstimateLineTemplate(updated),
      message: TEMPLATE_RENAMED_MESSAGE,
    };
  } catch (error) {
    if (isDuplicateEstimateLineTemplateNameError(error)) {
      throw new EstimateLineTemplateError(DUPLICATE_TEMPLATE_NAME_MESSAGE);
    }
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }
}

/**
 * Replace the stored snapshot lines from a DRAFT estimate. Existing
 * LineItem rows on estimates that already applied this template are not
 * read or written.
 */
export async function replaceEstimateLineTemplateLinesFromDraft(
  db: PrismaClient,
  access: BusinessAccess,
  input: { templateId: string; estimateId: string },
): Promise<{ template: SavedEstimateLineTemplate; message: string }> {
  await requireTemplateAccess(db, access);
  const existing = await loadOwnedTemplate(db, access, input.templateId);

  try {
    const updated = await db.$transaction(async (tx) => {
      await estimateLineTemplateTestHooks.beforeEditClaims?.({
        templateId: existing.id,
        estimateId: input.estimateId,
      });
      const claimedEstimate = await tx.estimate.updateMany({
        where: {
          id: input.estimateId,
          businessId: access.businessId,
          status: "DRAFT",
        },
        data: { updatedAt: new Date() },
      });
      if (claimedEstimate.count !== 1) {
        throw new EstimateLineTemplateError(DRAFT_ONLY_SAVE_MESSAGE);
      }
      const collected = await loadOwnedDraftTemplateSourceLines(
        tx,
        access,
        input.estimateId,
      );
      const claimed = await tx.estimateLineTemplate.updateMany({
        where: { id: existing.id, businessId: access.businessId },
        data: { updatedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new EstimateLineTemplateError(TEMPLATE_NOT_FOUND_MESSAGE);
      }
      await tx.estimateLineTemplateLine.deleteMany({
        where: { templateId: existing.id, businessId: access.businessId },
      });
      await tx.estimateLineTemplateLine.createMany({
        data: collected.map((line) => ({
          businessId: access.businessId,
          templateId: existing.id,
          sortOrder: line.sortOrder,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          type: line.type,
        })),
      });
      return tx.estimateLineTemplate.findFirstOrThrow({
        where: { id: existing.id, businessId: access.businessId },
        include: {
          lines: {
            where: { businessId: access.businessId },
            orderBy: { sortOrder: "asc" },
          },
        },
      });
    }, { timeout: 15_000 });

    return {
      template: toSavedEstimateLineTemplate(updated),
      message: TEMPLATE_LINES_REPLACED_MESSAGE,
    };
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }
}

export async function setEstimateLineTemplateArchived(
  db: PrismaClient,
  access: BusinessAccess,
  input: { templateId: string; archived: boolean },
): Promise<{ template: SavedEstimateLineTemplate; message: string }> {
  await requireTemplateAccess(db, access);
  const existing = await loadOwnedTemplate(db, access, input.templateId);

  try {
    const updated = await db.estimateLineTemplate.update({
      where: { id: existing.id },
      data: { archived: input.archived },
      include: {
        lines: {
          where: { businessId: access.businessId },
          orderBy: { sortOrder: "asc" },
        },
      },
    });
    if (updated.businessId !== access.businessId) {
      throw new ForbiddenError();
    }
    return {
      template: toSavedEstimateLineTemplate(updated),
      message: input.archived ? TEMPLATE_ARCHIVED_OK_MESSAGE : TEMPLATE_RESTORED_MESSAGE,
    };
  } catch (error) {
    if (missingEstimateLineTemplateSchema(error)) {
      throw new EstimateLineTemplateUnavailableError();
    }
    throw error;
  }
}
