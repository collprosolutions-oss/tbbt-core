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
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  calculatorRatesEqual,
  calculatorTitle,
  catalogDefinitionFromSnapshot,
  computeCalculator,
  findCatalogCalculatorDefinition,
  normalizeCalculatorSnapshot,
  persistableCalculatorComponents,
  persistableCalculatorRates,
  resolveCalculatorId,
  startingCalculatorSnapshot,
  type CalculatorId,
  type CalculatorSnapshot,
} from "@/lib/estimate-calculators";
import {
  catalogCalculatorDefinition,
  catalogScopeText,
  joinCatalogDescription,
  joinLineDescription,
  lineCalculatorSnapshot,
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
import { resolveCustomerPolicies } from "@/lib/estimate-policies";
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

  const calculatorDefinition =
    catalogCalculatorDefinition(catalogItem.description) ??
    catalogDefinitionFromSnapshot(null, catalogItem.name);
  const catalogScope = catalogScopeText(catalogItem.description);

  let unitPrice = input.unitPrice ?? catalogItem.price;
  if (catalogItem.pricingMode === "CUSTOM_QUOTE") {
    unitPrice = input.unitPrice ?? (catalogItem.price && catalogItem.price.gt(0) ? catalogItem.price : null);
    if ((!unitPrice || unitPrice.lte(0)) && !calculatorDefinition) {
      throw new EstimateLineError("Enter the price for this job.");
    }
    if (!unitPrice || unitPrice.lte(0)) {
      unitPrice = new Prisma.Decimal(0);
    }
  } else if (!unitPrice || unitPrice.lte(0)) {
    throw new EstimateLineError("That service has no saved price.");
  }

  const total = input.quantity.mul(unitPrice);
  const title =
    unitPrice.lte(0) && catalogItem.pricingMode === "CUSTOM_QUOTE"
      ? `${catalogItem.name} ${CUSTOM_QUOTE_DRAFT_MARKER}`
      : catalogItem.name;

  let createdId = "";
  await db.$transaction(async (tx) => {
    const created = await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        serviceCatalogItemId: catalogItem.id,
        description: joinLineDescription(
          title,
          catalogScope,
          startingCalculatorSnapshot({
            title: catalogItem.name,
            definition: calculatorDefinition,
          }),
          calculatorDefinition
            ? resolveCustomerPolicies(calculatorDefinition.customerPolicies)
            : null,
        ),
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
      description: joinLineDescription(
        parts.title,
        input.includedWork,
        parts.calculatorSnapshot,
        parts.customerPolicies,
      ),
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
  const lineParts = splitLineDescription(line.description);
  const calculatorDefinition = catalogDefinitionFromSnapshot(
    lineParts.calculatorSnapshot,
    name,
  );
  if (calculatorDefinition) {
    calculatorDefinition.customerPolicies = resolveCustomerPolicies(
      lineParts.customerPolicies.length > 0
        ? lineParts.customerPolicies
        : calculatorDefinition.customerPolicies,
    );
  }
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
          description: joinCatalogDescription(includedWork, calculatorDefinition),
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
          description: joinCatalogDescription(includedWork, calculatorDefinition),
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

export async function applyDraftEstimateCalculator(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    inputs: Record<string, unknown>;
    rates?: Record<string, unknown>;
    customerPolicies?: Array<{ id: string; title: string; body: string }> | null;
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
    throw new EstimateLineError("Only a draft estimate can be recalculated.");
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
  const calculatorId = resolveCalculatorId({
    title: customQuoteDisplayDescription(parts.title),
    snapshot: parts.calculatorSnapshot,
  });
  if (!calculatorId) {
    throw new EstimateLineError("This line does not have a pricing calculator.");
  }

  const snapshot = normalizeCalculatorSnapshot({
    calculatorId,
    inputs: input.inputs,
    rates: input.rates ?? parts.calculatorSnapshot?.rates ?? {},
    components: persistableCalculatorComponents(
      calculatorId,
      parts.calculatorSnapshot?.components,
    ),
  });
  if (
    calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID &&
    (!(Number(snapshot.inputs.wallWidthFt) > 0) ||
      !(Number(snapshot.inputs.wallHeightFt) > 0))
  ) {
    throw new EstimateLineError(
      "Enter wall width and height before applying a recommended price.",
    );
  }
  const result = computeCalculator(
    calculatorId,
    snapshot.inputs,
    snapshot.rates,
    snapshot.components,
  );
  snapshot.result = result;
  snapshot.recommendedAmount = result.recommendedAmount;
  snapshot.appliedAmount = result.recommendedAmount;
  snapshot.overriddenAmount = null;
  if (result.recommendedAmount <= 0) {
    throw new EstimateLineError("The calculator did not produce a recommended labor price.");
  }
  const unitPrice = new Prisma.Decimal(result.recommendedAmount.toFixed(2));
  const total = line.quantity.mul(unitPrice);
  const customerPolicies = resolveCustomerPolicies(
    input.customerPolicies ??
      (parts.customerPolicies.length > 0 ? parts.customerPolicies : null),
  );
  const description = pricedCustomQuoteDescription(
    joinLineDescription(parts.title, parts.includedWork, snapshot, customerPolicies),
  );
  const nextRates = persistableCalculatorRates(
    calculatorId,
    snapshot.rates,
    snapshot.inputs,
    snapshot.components,
  );
  const baselineRates = parts.calculatorSnapshot
    ? persistableCalculatorRates(
        calculatorId,
        parts.calculatorSnapshot.rates,
        parts.calculatorSnapshot.inputs,
        parts.calculatorSnapshot.components,
      )
    : persistableCalculatorRates(calculatorId, undefined, undefined, snapshot.components);
  const ratesEdited = !calculatorRatesEqual(nextRates, baselineRates);

  await db.$transaction(async (tx) => {
    await tx.lineItem.update({
      where: { id: line.id },
      data: {
        unitPrice,
        total,
        description,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
    if (ratesEdited) {
      await writeBusinessCalculatorRates(tx, access, {
        calculatorId,
        catalogItemId: line.serviceCatalogItemId,
        title: customQuoteDisplayDescription(parts.title),
        includedWork: parts.includedWork,
        rates: nextRates,
        components: snapshot.components,
        lineItemId: line.id,
      });
    }
  });

  return db.lineItem.findFirstOrThrow({
    where: { id: line.id, businessId: access.businessId },
  });
}

/**
 * Persist calculator RATES as the business/service default.
 * Job quantities, notes, and final-price overrides are never written here.
 */
export async function persistDraftEstimateCalculatorRates(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    rates: Record<string, unknown>;
    inputs?: Record<string, unknown>;
    customerPolicies?: Array<{ id: string; title: string; body: string }> | null;
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
    throw new EstimateLineError("Only a draft estimate can update saved calculator rates.");
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
  const calculatorId = resolveCalculatorId({
    title: customQuoteDisplayDescription(parts.title),
    snapshot: parts.calculatorSnapshot,
  });
  if (!calculatorId) {
    throw new EstimateLineError("This line does not have a pricing calculator.");
  }

  const components = persistableCalculatorComponents(
    calculatorId,
    parts.calculatorSnapshot?.components,
  );
  const rates = persistableCalculatorRates(
    calculatorId,
    input.rates,
    input.inputs,
    components,
  );
  await writeBusinessCalculatorRates(db, access, {
    calculatorId,
    catalogItemId: line.serviceCatalogItemId,
    title: customQuoteDisplayDescription(parts.title),
    includedWork: parts.includedWork,
    rates,
    components,
    customerPolicies: input.customerPolicies,
    lineItemId: line.id,
  });

  const catalogItems = await db.serviceCatalogItem.findMany({
    where: { ...access.scope },
    select: { id: true, name: true, description: true },
  });
  return findCatalogCalculatorDefinition(catalogItems, {
    calculatorId,
    catalogItemId: line.serviceCatalogItemId,
    title: customQuoteDisplayDescription(parts.title),
  });
}

async function writeBusinessCalculatorRates(
  db: Pick<Db, "serviceCatalogItem" | "lineItem">,
  access: BusinessAccess,
  input: {
    calculatorId: CalculatorId;
    catalogItemId?: string | null;
    title: string;
    includedWork?: string | null;
    rates: Record<string, unknown>;
    components?: CalculatorSnapshot["components"];
    customerPolicies?: Array<{ id: string; title: string; body: string }> | null;
    lineItemId: string;
  },
) {
  const calculatorId = input.calculatorId;
  if (!calculatorId) return;
  const name = input.title.trim() || calculatorTitle(calculatorId);

  const linked = input.catalogItemId
    ? await db.serviceCatalogItem.findFirst({
        where: { id: input.catalogItemId, ...access.scope },
        select: { id: true, description: true, businessId: true },
      })
    : null;
  const named =
    linked ??
    (await db.serviceCatalogItem.findFirst({
      where: {
        ...access.scope,
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true, description: true, businessId: true },
    })) ??
    (await db.serviceCatalogItem.findFirst({
      where: {
        ...access.scope,
        name: { equals: calculatorTitle(calculatorId), mode: "insensitive" },
      },
      select: { id: true, description: true, businessId: true },
    }));

  let marked: { id: string; description: string | null; businessId: string } | null = null;
  if (!named) {
    const candidates = await db.serviceCatalogItem.findMany({
      where: {
        ...access.scope,
        description: { contains: "TBBT Calculator Definition" },
      },
      select: { id: true, description: true, businessId: true },
    });
    marked =
      candidates.find(
        (item) =>
          catalogCalculatorDefinition(item.description)?.calculatorId === calculatorId,
      ) ?? null;
  }

  const existing = named ?? marked;
  const existingDefinition = catalogCalculatorDefinition(existing?.description);
  const components = persistableCalculatorComponents(
    calculatorId,
    input.components ?? existingDefinition?.components,
  );
  const definition = {
    calculatorId,
    rates: persistableCalculatorRates(calculatorId, input.rates, null, components),
    customerPolicies: resolveCustomerPolicies(
      input.customerPolicies ?? existingDefinition?.customerPolicies,
    ),
    ...(components ? { components } : {}),
  };
  const catalog = existing
    ? await db.serviceCatalogItem.update({
        where: { id: existing.id },
        data: {
          description: joinCatalogDescription(
            catalogScopeText(existing.description),
            definition,
          ),
          active: true,
        },
      })
    : await db.serviceCatalogItem.create({
        data: {
          businessId: access.businessId,
          name,
          description: joinCatalogDescription(input.includedWork, definition),
          pricingMode: "CUSTOM_QUOTE",
          price: null,
          category: DEFAULT_SERVICE_CATEGORY,
          active: true,
        },
      });

  if (input.lineItemId && catalog.id) {
    const line = await db.lineItem.findFirst({
      where: { id: input.lineItemId, businessId: access.businessId },
      select: { id: true, serviceCatalogItemId: true },
    });
    if (line && line.serviceCatalogItemId !== catalog.id) {
      await db.lineItem.update({
        where: { id: line.id },
        data: { serviceCatalogItemId: catalog.id },
      });
    }
  }

  return catalog;
}

export async function overrideDraftEstimateLinePrice(
  db: Db,
  access: BusinessAccess,
  input: {
    estimateId: string;
    lineItemId: string;
    unitPrice: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const unitPrice = parsePositiveDecimal(input.unitPrice, "price");

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
  const snapshot = parts.calculatorSnapshot
    ? {
        ...parts.calculatorSnapshot,
        overriddenAmount: Number(unitPrice.toFixed(2)),
      }
    : parts.calculatorSnapshot;
  const description = pricedCustomQuoteDescription(
    joinLineDescription(
      parts.title,
      parts.includedWork,
      snapshot,
      parts.customerPolicies,
    ),
  );
  const total = line.quantity.mul(unitPrice);

  await db.$transaction(async (tx) => {
    await tx.lineItem.update({
      where: { id: line.id },
      data: {
        unitPrice,
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
