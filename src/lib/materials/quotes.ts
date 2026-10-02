/**
 * OWNER-recorded dated supplier quotes.
 *
 * Record two or more quotes for the same material, compare unit price,
 * quantity, delivery cost, and availability, then choose one for a
 * purchase list. Original quote rows are append-only. Selecting a quote
 * never rewrites SupplierPriceRecord, MaterialPriceHistory, or any
 * SENT / APPROVED estimate or invoice snapshot. TBBT does not scrape
 * retailers or place live orders from this path.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  DEFAULT_BUSINESS_TIMEZONE,
  formatISODateInTimeZone,
  parseCivilDateInTimeZone,
  resolveBusinessTimeZone,
} from "@/lib/business-timezone";
import { formatDate } from "@/lib/format";
import {
  requireMaterialsCatalogAccess,
  requireOwnerSupplierQuoteWrite,
  requirePurchaseListWriteAccess,
} from "@/lib/materials/access";
import { MaterialsError } from "@/lib/materials/errors";
import {
  decimalMoney,
  decimalMoneyAllowZero,
  decimalQuantity,
  landedCost,
} from "@/lib/materials/money";
import { lockTenantOwnedPurchaseListItem } from "@/lib/materials/quote-lock";
import {
  canSelectSupplierQuoteForPurchaseItem,
  classifySupplierQuoteFreshness,
  isSupplierQuoteAvailability,
  SUPPLIER_QUOTE_AVAILABILITY_LABELS,
  SUPPLIER_QUOTE_FRESHNESS_LABELS,
  SUPPLIER_QUOTE_FUTURE_SLACK_MS,
  type SupplierQuoteAvailability,
  type SupplierQuoteCompareRow,
} from "@/lib/materials/types";
import { convertMaterialQuoteUnits, quoteCostForNeededQuantity } from "@/lib/materials/units";

type Db = PrismaClient | Prisma.TransactionClient;

export const MATERIAL_SUPPLIER_QUOTE_SCHEMA_SOURCE = "prisma-migrate" as const;

export type RecordSupplierQuoteInput = {
  materialId: string;
  supplierId: string;
  quotedAt: Date | string;
  unit: string;
  unitPrice: string | number;
  quantity: string | number;
  deliveryCost?: string | number | null;
  availability?: string | null;
  notes?: string | null;
  now?: Date;
};

const CIVIL_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CIVIL_UTC_MIDNIGHT = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.\d+)?Z$/;

export function businessLocalQuoteDateInput(
  now: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
) {
  return formatISODateInTimeZone(now, timeZone);
}

function parseCivilQuoteDate(raw: string, timeZone: string) {
  const match = raw.match(CIVIL_DATE_ONLY) ?? raw.match(CIVIL_UTC_MIDNIGHT);
  if (!match) return { kind: "other" as const };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = parseCivilDateInTimeZone(year, month, day, timeZone);
  return at ? { kind: "ok" as const, at } : { kind: "invalid" as const };
}

export function parseQuotedAt(
  raw: Date | string,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
  now: Date = new Date(),
) {
  let at: Date | null = null;
  if (raw instanceof Date) {
    at = Number.isNaN(raw.getTime()) ? null : raw;
  } else {
    const text = raw.trim();
    const civil = parseCivilQuoteDate(text, timeZone);
    if (civil.kind === "invalid") {
      throw new MaterialsError("Enter a valid quote date.");
    }
    if (civil.kind === "ok") {
      at = civil.at;
    } else {
      const parsed = new Date(text);
      at = Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
  if (!at) {
    throw new MaterialsError("Enter a valid quote date.");
  }
  const todayCivil = formatISODateInTimeZone(now, timeZone);
  const quotedCivil = formatISODateInTimeZone(at, timeZone);
  if (quotedCivil > todayCivil || at.getTime() > now.getTime() + SUPPLIER_QUOTE_FUTURE_SLACK_MS) {
    throw new MaterialsError(
      "Quote date cannot be in the future. Use the business-local date the supplier quoted.",
    );
  }
  return at;
}

function quoteTimeZone(access: BusinessAccess) {
  return resolveBusinessTimeZone(access.workspace?.business);
}

export async function recordSupplierQuote(
  db: Db,
  access: BusinessAccess,
  input: RecordSupplierQuoteInput,
) {
  requireOwnerSupplierQuoteWrite(access);
  await requireMaterialsCatalogAccess(db as PrismaClient, access);
  const material = access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: input.materialId, businessId: access.businessId },
      select: { id: true, businessId: true, unit: true },
    }),
  );
  const supplier = access.assertOwned(
    await db.supplier.findFirst({
      where: { id: input.supplierId, businessId: access.businessId },
      select: { id: true, businessId: true, active: true },
    }),
  );
  const unitPrice = decimalMoney(input.unitPrice);
  const quantity = decimalQuantity(input.quantity);
  if (!unitPrice || !quantity) {
    throw new MaterialsError("Enter a quote quantity and unit price greater than zero.");
  }
  const deliveryCost =
    input.deliveryCost == null || input.deliveryCost === ""
      ? new Prisma.Decimal(0)
      : decimalMoneyAllowZero(input.deliveryCost);
  if (!deliveryCost) {
    throw new MaterialsError("Delivery cost must be zero or greater.");
  }
  const availability = input.availability?.trim() || "UNKNOWN";
  if (!isSupplierQuoteAvailability(availability)) {
    throw new MaterialsError("Choose a valid quote availability.");
  }
  return db.materialSupplierQuote.create({
    data: {
      businessId: access.businessId,
      materialId: material.id,
      supplierId: supplier.id,
      quotedAt: parseQuotedAt(input.quotedAt, quoteTimeZone(access), input.now),
      unit: input.unit.trim() || material.unit,
      unitPrice,
      quantity,
      deliveryCost,
      availability,
      notes: input.notes?.trim() || null,
    },
  });
}

export async function listSupplierQuotes(
  db: Db,
  access: BusinessAccess,
  materialId: string,
) {
  await requireMaterialsCatalogAccess(db as PrismaClient, access);
  access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: materialId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
  );
  return db.materialSupplierQuote.findMany({
    where: { businessId: access.businessId, materialId },
    include: { supplier: { select: { id: true, name: true } } },
    orderBy: [{ quotedAt: "desc" }, { createdAt: "desc" }],
  });
}

export function buildSupplierQuoteComparison(input: {
  quotes: Array<{
    id: string;
    supplierId: string;
    supplierName: string;
    quotedAt: Date;
    unit: string;
    unitPrice: Prisma.Decimal;
    quantity: Prisma.Decimal;
    deliveryCost: Prisma.Decimal;
    availability: string;
  }>;
  targetUnit: string;
  neededQuantity?: Prisma.Decimal | number | string | null;
  packSize?: Prisma.Decimal | number | string | null;
  now?: Date;
  timeZone?: string;
}): SupplierQuoteCompareRow[] {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const needed =
    input.neededQuantity == null || input.neededQuantity === ""
      ? null
      : decimalQuantity(input.neededQuantity);
  const rows = input.quotes.map((quote) => {
    const freshness = classifySupplierQuoteFreshness(quote.quotedAt, now);
    const availability = isSupplierQuoteAvailability(quote.availability)
      ? quote.availability
      : ("UNKNOWN" satisfies SupplierQuoteAvailability);
    const quoteLanded = landedCost(quote.quantity, quote.unitPrice, quote.deliveryCost);
    let conversionLabel: string | null = null;
    let conversionError: string | null = null;
    let comparableUnit: string | null = null;
    let comparableUnitPrice: Prisma.Decimal | null = null;
    let comparableQuantity: Prisma.Decimal | null = null;
    let neededLanded: Prisma.Decimal | null = null;
    try {
      const converted = convertMaterialQuoteUnits({
        quantity: quote.quantity,
        unitPrice: quote.unitPrice,
        fromUnit: quote.unit,
        toUnit: input.targetUnit,
        packSize: input.packSize,
      });
      comparableUnit = converted.toUnit;
      comparableUnitPrice = converted.unitPrice.toDecimalPlaces(2);
      comparableQuantity = converted.quantity;
      conversionLabel = converted.label;
      neededLanded = needed
        ? quoteCostForNeededQuantity({
            unitPrice: quote.unitPrice,
            fromUnit: quote.unit,
            toUnit: input.targetUnit,
            neededQuantity: needed,
            deliveryCost: quote.deliveryCost,
            packSize: input.packSize,
          }).plannedCost
        : quoteLanded;
    } catch (error) {
      conversionError =
        error instanceof MaterialsError
          ? error.message
          : "Those units cannot be converted for comparison.";
    }
    return {
      quoteId: quote.id,
      supplierId: quote.supplierId,
      supplierName: quote.supplierName,
      quotedAt: quote.quotedAt.toISOString(),
      quotedOn: formatISODateInTimeZone(quote.quotedAt, timeZone),
      quotedOnLabel: formatDate(quote.quotedAt, timeZone),
      freshness,
      freshnessLabel: SUPPLIER_QUOTE_FRESHNESS_LABELS[freshness],
      stale: freshness === "stale",
      availability,
      availabilityLabel: SUPPLIER_QUOTE_AVAILABILITY_LABELS[availability],
      unit: quote.unit,
      unitPrice: quote.unitPrice.toDecimalPlaces(2).toString(),
      quantity: quote.quantity.toDecimalPlaces(4).toString(),
      deliveryCost: quote.deliveryCost.toDecimalPlaces(2).toString(),
      quoteLandedTotal: (quoteLanded ?? new Prisma.Decimal(0)).toString(),
      comparableUnit,
      comparableUnitPrice: comparableUnitPrice?.toString() ?? null,
      comparableQuantity: comparableQuantity?.toString() ?? null,
      neededQuantity: needed?.toString() ?? null,
      neededLandedTotal: neededLanded?.toString() ?? null,
      conversionLabel,
      conversionError,
      lowestLanded: false,
    } satisfies SupplierQuoteCompareRow;
  });
  let lowest: string | null = null;
  for (const row of rows) {
    if (!row.neededLandedTotal || row.conversionError || row.stale) continue;
    if (lowest == null || new Prisma.Decimal(row.neededLandedTotal).lt(lowest)) {
      lowest = row.neededLandedTotal;
    }
  }
  return rows.map((row) => ({
    ...row,
    lowestLanded: Boolean(lowest && row.neededLandedTotal === lowest && !row.conversionError),
  }));
}

export async function compareSupplierQuotes(
  db: Db,
  access: BusinessAccess,
  input: {
    materialId: string;
    targetUnit?: string | null;
    neededQuantity?: Prisma.Decimal | number | string | null;
    now?: Date;
  },
) {
  const quotes = await listSupplierQuotes(db, access, input.materialId);
  const material = access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: input.materialId, businessId: access.businessId },
      select: { id: true, businessId: true, unit: true, packSize: true },
    }),
  );
  return buildSupplierQuoteComparison({
    quotes: quotes.map((quote) => ({
      id: quote.id,
      supplierId: quote.supplierId,
      supplierName: quote.supplier.name,
      quotedAt: quote.quotedAt,
      unit: quote.unit,
      unitPrice: quote.unitPrice,
      quantity: quote.quantity,
      deliveryCost: quote.deliveryCost,
      availability: quote.availability,
    })),
    targetUnit: input.targetUnit?.trim() || material.unit,
    neededQuantity: input.neededQuantity,
    packSize: material.packSize,
    now: input.now,
    timeZone: quoteTimeZone(access),
  });
}

export type SelectSupplierQuoteInput = {
  purchaseListItemId: string;
  quoteId: string;
  expectedSelectedQuoteId?: string | null;
  acceptStale?: boolean;
  now?: Date;
};

async function selectSupplierQuoteForPurchaseListInTx(
  db: Prisma.TransactionClient,
  access: BusinessAccess,
  input: SelectSupplierQuoteInput,
) {
  requireOwnerSupplierQuoteWrite(access);
  const locked = await lockTenantOwnedPurchaseListItem(
    db,
    access.businessId,
    input.purchaseListItemId,
  );
  if (!locked) {
    throw new MaterialsError("That purchase-list item was not found in this workspace.");
  }
  const list = access.assertOwned(
    await db.materialPurchaseList.findFirst({
      where: { id: locked.purchaseListId, businessId: access.businessId },
      select: { id: true, businessId: true, jobId: true, estimateId: true },
    }),
  );
  await requirePurchaseListWriteAccess(db as PrismaClient, access, list);
  if (!canSelectSupplierQuoteForPurchaseItem(locked.status)) {
    throw new MaterialsError(
      "That purchase-list item can no longer take a supplier quote. Only needed and planned rows can be updated; ordered, purchased, received, and cancelled rows stay as recorded.",
    );
  }
  const activePurchaseOrderItem = await db.materialPurchaseOrderItem.findFirst({
    where: {
      businessId: access.businessId,
      purchaseListItemId: locked.id,
      purchaseOrder: { status: { not: "CANCELLED" } },
    },
    select: { id: true },
  });
  if (activePurchaseOrderItem) {
    throw new MaterialsError(
      "That purchase-list item is already on a purchase order. Cancel the order before choosing a different supplier quote.",
    );
  }
  const expected = input.expectedSelectedQuoteId ? input.expectedSelectedQuoteId : null;
  if (expected !== (locked.selectedQuoteId ?? null)) {
    throw new MaterialsError(
      "That purchase-list item already has a different selected quote. Refresh and compare again.",
    );
  }
  if (!locked.materialId) {
    throw new MaterialsError("Link a catalog material before choosing a supplier quote.");
  }
  const quote = access.assertOwned(
    await db.materialSupplierQuote.findFirst({
      where: { id: input.quoteId, businessId: access.businessId },
      include: { supplier: { select: { id: true, name: true } } },
    }),
  );
  if (quote.materialId !== locked.materialId) {
    throw new MaterialsError("That quote is for a different material.");
  }
  const material = access.assertOwned(
    await db.materialCatalogItem.findFirst({
      where: { id: locked.materialId, businessId: access.businessId },
      select: { id: true, businessId: true, packSize: true },
    }),
  );
  const freshness = classifySupplierQuoteFreshness(quote.quotedAt, input.now ?? new Date());
  if (freshness === "stale" && !input.acceptStale) {
    throw new MaterialsError(
      "That supplier quote is stale. Record a newer dated quote or confirm you want to use the stale quote.",
    );
  }
  const converted = convertMaterialQuoteUnits({
    quantity: quote.quantity,
    unitPrice: quote.unitPrice,
    fromUnit: quote.unit,
    toUnit: locked.unit,
    packSize: material.packSize,
  });
  const priced = quoteCostForNeededQuantity({
    unitPrice: quote.unitPrice,
    fromUnit: quote.unit,
    toUnit: locked.unit,
    neededQuantity: locked.quantityNeeded,
    deliveryCost: quote.deliveryCost,
    packSize: material.packSize,
  });
  const plannedUnitCost = priced.plannedUnitCost;
  const plannedCost = priced.plannedCost;
  const nextStatus = locked.status === "NEEDED" ? "PLANNED" : locked.status;
  const updated = await db.materialPurchaseListItem.update({
    where: { id: locked.id },
    data: {
      selectedQuoteId: quote.id,
      supplierId: quote.supplierId,
      plannedUnitCost,
      plannedCost,
      status: nextStatus,
    },
  });
  return {
    item: updated,
    quote,
    conversion: converted,
    plannedUnitCost,
    plannedCost,
    freshness,
  };
}

export async function selectSupplierQuoteForPurchaseList(
  db: Db,
  access: BusinessAccess,
  input: SelectSupplierQuoteInput,
) {
  if ("$transaction" in db) {
    return (db as PrismaClient).$transaction((tx) =>
      selectSupplierQuoteForPurchaseListInTx(tx, access, input),
    );
  }
  return selectSupplierQuoteForPurchaseListInTx(db, access, input);
}
