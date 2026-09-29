/**
 * OWNER writes for priced estimate options.
 * businessId always comes from BusinessAccess. This module writes only
 * EstimateOption rows and LineItem.optionId on DRAFT estimates. It never
 * writes SENT/APPROVED estimates, EstimateVersion snapshots, invoices,
 * payments, or jobs.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductCapability } from "@/lib/product-entitlements";
import {
  DRAFT_ONLY_OPTIONS_MESSAGE,
  MAX_ESTIMATE_OPTIONS,
  MAX_OPTION_NAME_LENGTH,
  MIN_ESTIMATE_OPTIONS,
  OPTION_ADDED_MESSAGE,
  OPTION_BOUND_MESSAGE,
  OPTION_NAME_REQUIRED_MESSAGE,
  OPTION_NOT_FOUND_MESSAGE,
  OPTION_REMOVED_MESSAGE,
  OPTION_RENAMED_MESSAGE,
  OPTIONS_REMOVED_MESSAGE,
  OPTIONS_STARTED_MESSAGE,
  assertCanManageEstimateOptions,
  defaultOptionName,
  parseOptionName,
} from "@/lib/estimate-options";

type Db = PrismaClient | Prisma.TransactionClient;

export class EstimateOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateOptionError";
  }
}

export function estimateOptionErrorMessage(error: unknown, fallback: string) {
  if (error instanceof EstimateOptionError) return error.message;
  if (error instanceof Error && error.name === "EstimateOptionError") return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "SaasSubscriptionRequiredError") {
    return error.message;
  }
  return fallback;
}

async function requireDraftEstimate(
  db: Db,
  access: BusinessAccess,
  estimateId: string,
) {
  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: estimateId, businessId: access.businessId },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateOptionError(DRAFT_ONLY_OPTIONS_MESSAGE);
  }
  return estimate;
}

async function claimDraftEstimate(
  tx: Prisma.TransactionClient,
  access: BusinessAccess,
  estimateId: string,
) {
  const claimed = await tx.estimate.updateMany({
    where: {
      id: estimateId,
      businessId: access.businessId,
      status: "DRAFT",
    },
    data: { updatedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new EstimateOptionError(DRAFT_ONLY_OPTIONS_MESSAGE);
  }
}

export async function resolveDraftLineOptionId(
  db: Db,
  input: {
    estimateId: string;
    businessId: string;
    optionId?: string | null;
  },
): Promise<string | null> {
  const options = await db.estimateOption.findMany({
    where: { estimateId: input.estimateId, businessId: input.businessId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, businessId: true, sortOrder: true },
  });
  if (options.length === 0) {
    if (input.optionId) {
      throw new EstimateOptionError(OPTION_NOT_FOUND_MESSAGE);
    }
    return null;
  }
  if (input.optionId) {
    const match = options.find((option) => option.id === input.optionId);
    if (!match || match.businessId !== input.businessId) {
      throw new EstimateOptionError(OPTION_NOT_FOUND_MESSAGE);
    }
    return match.id;
  }
  return options[0]?.id ?? null;
}

export async function startEstimateOptions(
  db: PrismaClient,
  access: BusinessAccess,
  estimateId: string,
) {
  assertCanManageEstimateOptions(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
  const estimate = await requireDraftEstimate(db, access, estimateId);

  await db.$transaction(async (tx) => {
    await claimDraftEstimate(tx, access, estimate.id);
    const existing = await tx.estimateOption.count({
      where: { estimateId: estimate.id, businessId: access.businessId },
    });
    if (existing > 0) {
      throw new EstimateOptionError("This draft already has priced options.");
    }

    const first = await tx.estimateOption.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        name: defaultOptionName(1),
        sortOrder: 1,
      },
    });
    await tx.estimateOption.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        name: defaultOptionName(2),
        sortOrder: 2,
      },
    });
    await tx.lineItem.updateMany({
      where: {
        estimateId: estimate.id,
        businessId: access.businessId,
        optionId: null,
      },
      data: { optionId: first.id },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return { message: OPTIONS_STARTED_MESSAGE };
}

export async function addEstimateOption(
  db: PrismaClient,
  access: BusinessAccess,
  estimateId: string,
) {
  assertCanManageEstimateOptions(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
  const estimate = await requireDraftEstimate(db, access, estimateId);

  await db.$transaction(async (tx) => {
    await claimDraftEstimate(tx, access, estimate.id);
    const existing = await tx.estimateOption.findMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
      orderBy: { sortOrder: "asc" },
    });
    if (existing.length === 0) {
      throw new EstimateOptionError(
        "Start priced options on this draft before adding another.",
      );
    }
    if (existing.length >= MAX_ESTIMATE_OPTIONS) {
      throw new EstimateOptionError(OPTION_BOUND_MESSAGE);
    }
    const sortOrder = (existing[existing.length - 1]?.sortOrder ?? existing.length) + 1;
    await tx.estimateOption.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        name: defaultOptionName(sortOrder),
        sortOrder,
      },
    });
  });

  return { message: OPTION_ADDED_MESSAGE };
}

export async function renameEstimateOption(
  db: PrismaClient,
  access: BusinessAccess,
  input: { estimateId: string; optionId: string; name: string },
) {
  assertCanManageEstimateOptions(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
  const parsed = parseOptionName(input.name);
  if (!parsed.name) {
    throw new EstimateOptionError(parsed.error ?? OPTION_NAME_REQUIRED_MESSAGE);
  }
  const estimate = await requireDraftEstimate(db, access, input.estimateId);

  const updated = await db.estimateOption.updateMany({
    where: {
      id: input.optionId,
      estimateId: estimate.id,
      businessId: access.businessId,
    },
    data: { name: parsed.name },
  });
  if (updated.count !== 1) {
    throw new EstimateOptionError(OPTION_NOT_FOUND_MESSAGE);
  }
  return { message: OPTION_RENAMED_MESSAGE };
}

export async function removeEstimateOption(
  db: PrismaClient,
  access: BusinessAccess,
  input: { estimateId: string; optionId: string },
) {
  assertCanManageEstimateOptions(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
  const estimate = await requireDraftEstimate(db, access, input.estimateId);

  await db.$transaction(async (tx) => {
    await claimDraftEstimate(tx, access, estimate.id);
    const options = await tx.estimateOption.findMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
      orderBy: { sortOrder: "asc" },
    });
    const target = options.find((option) => option.id === input.optionId);
    if (!target) {
      throw new EstimateOptionError(OPTION_NOT_FOUND_MESSAGE);
    }

    if (options.length <= MIN_ESTIMATE_OPTIONS) {
      await tx.lineItem.updateMany({
        where: { estimateId: estimate.id, businessId: access.businessId },
        data: { optionId: null },
      });
      await tx.estimateOption.deleteMany({
        where: { estimateId: estimate.id, businessId: access.businessId },
      });
      await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
      return;
    }

    await tx.lineItem.deleteMany({
      where: {
        estimateId: estimate.id,
        businessId: access.businessId,
        optionId: target.id,
      },
    });
    await tx.estimateOption.delete({
      where: { id: target.id },
    });
    const remaining = await tx.estimateOption.findMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
      orderBy: { sortOrder: "asc" },
    });
    for (const [index, option] of remaining.entries()) {
      if (option.sortOrder !== index + 1) {
        await tx.estimateOption.update({
          where: { id: option.id },
          data: { sortOrder: index + 1 },
        });
      }
    }
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return { message: OPTION_REMOVED_MESSAGE };
}

export async function collapseEstimateOptions(
  db: PrismaClient,
  access: BusinessAccess,
  estimateId: string,
) {
  assertCanManageEstimateOptions(access);
  await requireOperatingProductCapability(db, access, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
  const estimate = await requireDraftEstimate(db, access, estimateId);

  await db.$transaction(async (tx) => {
    await claimDraftEstimate(tx, access, estimate.id);
    await tx.lineItem.updateMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
      data: { optionId: null },
    });
    await tx.estimateOption.deleteMany({
      where: { estimateId: estimate.id, businessId: access.businessId },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return { message: OPTIONS_REMOVED_MESSAGE };
}

export { MAX_OPTION_NAME_LENGTH };
