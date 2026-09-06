/**
 * Draft estimate line mutations used by the estimate builder and the
 * focused custom-price check. Callers must already have
 * requireBusinessAccess(); this module never trusts a browser businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import {
  joinLineDescription,
  lineItemIncludedWork,
  splitLineDescription,
} from "@/lib/estimate-line-scope";
import {
  CUSTOM_QUOTE_DRAFT_MARKER,
  STARTING_AT_DRAFT_MARKER,
  customQuoteDisplayDescription,
  isUnpricedCustomQuoteDraftLine,
  pricedCustomQuoteDescription,
} from "@/lib/request-estimate-draft";
import { DEFAULT_SERVICE_CATEGORY } from "@/lib/service-catalog-category";

type Db = PrismaClient;

export class EstimateLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimateLineError";
  }
}

export function estimateLineErrorMessage(error: unknown, fallback: string) {
  if (error instanceof EstimateLineError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

function parsePositiveDecimal(raw: string, label: string) {
  if (!raw.trim()) {
    throw new EstimateLineError(`Enter a ${label}.`);
  }
  try {
    const value = new Prisma.Decimal(raw);
    if (value.isNaN() || value.lte(0)) {
      throw new EstimateLineError(`Enter a ${label} greater than zero.`);
    }
    return value;
  } catch (error) {
    if (error instanceof EstimateLineError) throw error;
    throw new EstimateLineError(`Enter a valid ${label}.`);
  }
}

export async function addCatalogItemToDraftEstimate(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    catalogItemId: string;
    quantity: Prisma.Decimal;
    unitPrice?: Prisma.Decimal | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }

  const catalogItem = access.assertOwned(
    await db.serviceCatalogItem.findFirst({
      where: { id: input.catalogItemId, ...access.scope },
    }),
  );
  if (!catalogItem.active) {
    throw new EstimateLineError("That service is not active.");
  }

  let unitPrice = input.unitPrice ?? catalogItem.price;
  if (catalogItem.pricingMode === "CUSTOM_QUOTE") {
    unitPrice = input.unitPrice ?? (catalogItem.price && catalogItem.price.gt(0) ? catalogItem.price : null);
    if (!unitPrice || unitPrice.lte(0)) {
      throw new EstimateLineError("Enter the price for this job.");
    }
  } else if (!unitPrice || unitPrice.lte(0)) {
    throw new EstimateLineError("That service has no saved price.");
  }

  const total = input.quantity.mul(unitPrice);

  let createdId = "";
  await db.$transaction(async (tx) => {
    const created = await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        serviceCatalogItemId: catalogItem.id,
        description: joinLineDescription(catalogItem.name, catalogItem.description),
        quantity: input.quantity,
        unitPrice,
        total,
        type: "LABOR",
      },
    });
    createdId = created.id;
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return db.lineItem.findFirstOrThrow({
    where: { id: createdId, businessId: access.businessId },
  });
}

/**
 * Assign the owner's job price (and optional quantity) on a prefilled
 * custom-quote / price-required draft line. Does not create a catalog
 * item and does not change existing catalog prices.
 */
export async function priceDraftEstimateLine(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    unitPrice: string;
    quantity?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);

  const unitPrice = parsePositiveDecimal(input.unitPrice, "price");
  const quantity = input.quantity?.trim()
    ? parsePositiveDecimal(input.quantity, "quantity")
    : null;

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }

  const line = access.assertOwned(
    await db.lineItem.findFirst({
      where: {
        id: input.lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );

  if (!isUnpricedCustomQuoteDraftLine(line)) {
    throw new EstimateLineError("This line already has a price.");
  }

  const nextQuantity = quantity ?? line.quantity;
  const total = nextQuantity.mul(unitPrice);
  const description = pricedCustomQuoteDescription(line.description);

  await db.$transaction(async (tx) => {
    await tx.lineItem.update({
      where: { id: line.id },
      data: {
        unitPrice,
        quantity: nextQuantity,
        total,
        description,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  return db.lineItem.findFirstOrThrow({
    where: { id: line.id, businessId: access.businessId },
  });
}

/**
 * Update Scope / Included Work on a DRAFT line. Does not change quantity,
 * price, totals, or the catalog master.
 */
export async function updateDraftEstimateLineIncludedWork(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    includedWork: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate can be changed.");
  }

  const line = access.assertOwned(
    await db.lineItem.findFirst({
      where: {
        id: input.lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );

  const parts = splitLineDescription(line.description);
  await db.lineItem.update({
    where: { id: line.id },
    data: {
      description: joinLineDescription(parts.title, input.includedWork),
    },
  });

  return db.lineItem.findFirstOrThrow({
    where: { id: line.id, businessId: access.businessId },
  });
}

/**
 * Explicit owner action: save this DRAFT line as a reusable
 * ServiceCatalogItem. Never runs automatically from add/price.
 */
export async function saveDraftEstimateLineAsCatalog(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    savePrice?: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);

  const estimate = access.assertOwned(
    await db.estimate.findFirst({
      where: { id: input.estimateId, ...access.scope },
      select: { id: true, businessId: true, status: true },
    }),
  );
  if (estimate.status !== "DRAFT") {
    throw new EstimateLineError("Only a draft estimate item can be saved for reuse.");
  }

  const line = access.assertOwned(
    await db.lineItem.findFirst({
      where: {
        id: input.lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );

  const name = customQuoteDisplayDescription(line.description)
    .replace(` ${STARTING_AT_DRAFT_MARKER}`, "")
    .replace(` ${CUSTOM_QUOTE_DRAFT_MARKER}`, "")
    .trim();
  if (!name) {
    throw new EstimateLineError("This line needs a title before it can be saved.");
  }

  const includedWork = lineItemIncludedWork(line.description);
  const linkedCatalog = line.serviceCatalogItemId
    ? await db.serviceCatalogItem.findFirst({
        where: { id: line.serviceCatalogItemId, ...access.scope },
        select: { id: true, pricingMode: true, price: true },
      })
    : null;
  const pricingMode = linkedCatalog?.pricingMode ?? "CUSTOM_QUOTE";
  const savePrice = input.savePrice === true;
  const defaultPrice = savePrice && line.unitPrice.gt(0) ? line.unitPrice : null;

  const existing =
    linkedCatalog ??
    (await db.serviceCatalogItem.findFirst({
      where: {
        ...access.scope,
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true, pricingMode: true, price: true },
    }));

  const catalog = existing
    ? await db.serviceCatalogItem.update({
        where: { id: existing.id },
        data: {
          name,
          description: includedWork,
          pricingMode,
          price: savePrice
            ? defaultPrice ?? (pricingMode === "CUSTOM_QUOTE" ? null : existing.price)
            : existing.price,
          active: true,
        },
      })
    : await db.serviceCatalogItem.create({
        data: {
          businessId: access.businessId,
          name,
          description: includedWork,
          pricingMode,
          price: defaultPrice,
          category: DEFAULT_SERVICE_CATEGORY,
          active: true,
        },
      });

  if (line.serviceCatalogItemId !== catalog.id) {
    await db.lineItem.update({
      where: { id: line.id },
      data: { serviceCatalogItemId: catalog.id },
    });
  }

  return catalog;
}
