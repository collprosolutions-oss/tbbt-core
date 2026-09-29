/**
 * OWNER-reviewed service catalog CSV write path.
 *
 * Preview stores sanitized rows. Confirm adds or updates ServiceCatalogItem
 * rows only after an explicit OWNER action. Retries reuse the same batch
 * (businessId + content hash, then writtenCatalogItemId).
 *
 * Browser-supplied businessId is never authorization. Confirm never writes
 * LineItem or EstimateVersionLineItem snapshots and never publishes hourly
 * rates.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import {
  authorizeCatalogTradeCode,
  listActiveTradeCodes,
  resolvePrimaryTradeCode,
} from "@/lib/business-trades";
import {
  catalogRecurrenceEligibleForTrade,
  catalogUnitLabelFromForm,
} from "@/lib/catalog-item-fields";
import { catalogDefinitionFromSnapshot } from "@/lib/estimate-calculators";
import {
  catalogCalculatorDefinition,
  joinCatalogDescription,
} from "@/lib/estimate-line-scope";
import {
  applyCatalogImportContext,
  CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE,
  CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
  CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  countCatalogPreviewStatuses,
  decodeCatalogCsvBytes,
  hashCatalogCsvBytes,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  parseServiceCatalogCsv,
  sanitizeCatalogSourceFilename,
  SERVICE_CATALOG_IMPORT_ROUTE,
  ServiceCatalogImportError,
  storedCatalogRowToParsed,
  type ParsedCatalogImportRow,
} from "@/lib/service-catalog-import";
import { allocateUnusedWebsiteSlug } from "@/lib/website-engine/slugs";

export { OWNER_ONLY_CATALOG_IMPORT_MESSAGE, SERVICE_CATALOG_IMPORT_ROUTE };

type Db = PrismaClient;
export type ServiceCatalogImportAccess = BusinessAccess;

export type StoredCatalogImportRow = {
  id: string;
  businessId: string;
  importId: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  rowFingerprint: string;
  name: string;
  description: string | null;
  pricingMode: string;
  price: Prisma.Decimal | null;
  category: string;
  tradeCode: string;
  unitLabel: string;
  recurrenceEligible: boolean;
  active: boolean;
  matchedCatalogItemId: string | null;
  writtenCatalogItemId: string | null;
  writeAction: string | null;
};

export type StoredCatalogImport = {
  id: string;
  businessId: string;
  sourceKind: string;
  sourceLabel: string;
  contentSha256: string;
  capturedAt: Date;
  status: string;
  rowCount: number;
  validCount: number;
  invalidCount: number;
  nameMatchCount: number;
  createdByMembershipId: string;
  confirmedAt: Date | null;
  confirmedByMembershipId: string | null;
  rows?: StoredCatalogImportRow[];
};

export type ServiceCatalogImportPreview = {
  id: string;
  businessId: string;
  sourceKind: string;
  sourceLabel: string;
  contentSha256: string;
  capturedAt: Date;
  status: string;
  rowCount: number;
  validCount: number;
  invalidCount: number;
  nameMatchCount: number;
  writtenCount: number;
  rows: StoredCatalogImportRow[];
};

function requireOwner(access: ServiceCatalogImportAccess) {
  requireBusinessRole(access, "OWNER");
}

function membershipId(access: ServiceCatalogImportAccess): string {
  const id = access.workspace.membership?.id?.trim();
  if (!id) {
    throw new ServiceCatalogImportError(OWNER_ONLY_CATALOG_IMPORT_MESSAGE);
  }
  return id;
}

function previewCountWrite(rows: Array<{ previewStatus: string }>) {
  return countCatalogPreviewStatuses(rows);
}

function toPreview(
  record: StoredCatalogImport,
  rows: StoredCatalogImportRow[],
): ServiceCatalogImportPreview {
  const counts = countCatalogPreviewStatuses(rows);
  return {
    id: record.id,
    businessId: record.businessId,
    sourceKind: record.sourceKind,
    sourceLabel: record.sourceLabel,
    contentSha256: record.contentSha256,
    capturedAt: record.capturedAt,
    status: record.status,
    rowCount: counts.rowCount,
    validCount: counts.validCount,
    invalidCount: counts.invalidCount,
    nameMatchCount: counts.nameMatchCount,
    writtenCount: rows.filter((row) => row.writtenCatalogItemId).length,
    rows,
  };
}

async function loadCatalogImportContext(db: Db, businessId: string) {
  const [activeTradeCodes, primaryTrade, existingItems] = await Promise.all([
    listActiveTradeCodes(db, businessId),
    resolvePrimaryTradeCode(db, businessId),
    db.serviceCatalogItem.findMany({
      where: { businessId },
      select: { id: true, businessId: true, name: true, tradeCode: true },
    }),
  ]);
  return { activeTradeCodes, primaryTrade, existingItems };
}

function rowWriteData(businessId: string, row: ParsedCatalogImportRow) {
  return {
    businessId,
    rowNumber: row.rowNumber,
    previewStatus: row.previewStatus,
    invalidReason: row.invalidReason,
    rowFingerprint: row.rowFingerprint,
    name: row.name,
    description: row.description || null,
    pricingMode: row.pricingMode,
    price: row.price,
    category: row.category,
    tradeCode: row.tradeCode,
    unitLabel: row.unitLabel,
    recurrenceEligible: row.recurrenceEligible,
    active: row.active,
    matchedCatalogItemId: row.matchedCatalogItemId,
  };
}

async function persistPreview(
  db: Db,
  access: ServiceCatalogImportAccess,
  input: {
    sourceLabel: string;
    bytes: Uint8Array | Buffer;
  },
): Promise<ServiceCatalogImportPreview> {
  requireOwner(access);
  const businessId = access.businessId;
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > MAX_SERVICE_CATALOG_IMPORT_BYTES) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE);
  }
  const contentSha256 = hashCatalogCsvBytes(bytes);
  const existing = await db.serviceCatalogImport.findFirst({
    where: { businessId, contentSha256 },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (existing) {
    access.assertOwned(existing);
    const rows = existing.rows ?? [];
    if (existing.status === "CONFIRMED" || existing.status === "CONFIRMING") {
      return toPreview(existing, rows);
    }
    return refreshPreviewMatches(db, access, existing, rows);
  }

  const parsed = parseServiceCatalogCsv(decodeCatalogCsvBytes(bytes));
  const context = await loadCatalogImportContext(db, businessId);
  const flagged = applyCatalogImportContext(parsed, {
    businessId,
    ...context,
  });
  const capturedAt = new Date();

  try {
    const created = await db.serviceCatalogImport.create({
      data: {
        businessId,
        sourceKind: "CSV_UPLOAD",
        sourceLabel: input.sourceLabel,
        contentSha256,
        capturedAt,
        status: "PREVIEW",
        ...previewCountWrite(flagged),
        createdByMembershipId: membershipId(access),
        rows: {
          create: flagged.map((row) => rowWriteData(businessId, row)),
        },
      },
    });
    return loadOwnedCatalogImport(db, access, created.id);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await db.serviceCatalogImport.findFirst({
        where: { businessId, contentSha256 },
        include: { rows: { orderBy: { rowNumber: "asc" } } },
      });
      if (raced) {
        access.assertOwned(raced);
        return toPreview(raced, raced.rows ?? []);
      }
    }
    throw error;
  }
}

async function refreshPreviewMatches(
  db: Db,
  access: ServiceCatalogImportAccess,
  existing: StoredCatalogImport,
  rows: StoredCatalogImportRow[],
): Promise<ServiceCatalogImportPreview> {
  const context = await loadCatalogImportContext(db, access.businessId);
  const parsed = rows.map((row) => storedCatalogRowToParsed(row));
  const flagged = applyCatalogImportContext(parsed, {
    businessId: access.businessId,
    ...context,
  });
  await db.serviceCatalogImportRow.deleteMany({
    where: { businessId: access.businessId, importId: existing.id },
  });
  await db.serviceCatalogImportRow.createMany({
    data: flagged.map((row) => ({
      ...rowWriteData(access.businessId, row),
      importId: existing.id,
    })),
  });
  await db.serviceCatalogImport.update({
    where: { id: existing.id },
    data: previewCountWrite(flagged),
  });
  return loadOwnedCatalogImport(db, access, existing.id);
}

export async function previewServiceCatalogCsvUpload(
  db: Db,
  access: ServiceCatalogImportAccess,
  input: { filename: string; bytes: Uint8Array | Buffer },
): Promise<ServiceCatalogImportPreview> {
  return persistPreview(db, access, {
    sourceLabel: sanitizeCatalogSourceFilename(input.filename),
    bytes: input.bytes,
  });
}

export async function loadOwnedCatalogImport(
  db: Db,
  access: ServiceCatalogImportAccess,
  importId: string,
): Promise<ServiceCatalogImportPreview> {
  requireOwner(access);
  const id = importId.trim();
  if (!id) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const record = await db.serviceCatalogImport.findFirst({
    where: { id, businessId: access.businessId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!record) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(record);
  return toPreview(record, record.rows ?? []);
}

async function writeCatalogRow(
  db: Db,
  access: ServiceCatalogImportAccess,
  row: StoredCatalogImportRow,
): Promise<{ catalogItemId: string; writeAction: "ADD" | "UPDATE" }> {
  const tradeCode = await authorizeCatalogTradeCode(
    db,
    access.businessId,
    row.tradeCode || null,
  );
  if (row.matchedCatalogItemId) {
    const existing = access.assertOwned(
      await db.serviceCatalogItem.findFirst({
        where: {
          id: row.matchedCatalogItemId,
          businessId: access.businessId,
          tradeCode,
        },
      }),
    );
    await db.serviceCatalogItem.update({
      where: { id: existing.id },
      data: {
        name: row.name,
        pricingMode: row.pricingMode,
        price: row.price,
        description: joinCatalogDescription(
          row.description || null,
          catalogCalculatorDefinition(existing.description) ??
            catalogDefinitionFromSnapshot(null, row.name),
        ),
        category: row.category,
        recurrenceEligible: catalogRecurrenceEligibleForTrade(
          existing.tradeCode,
          true,
          row.recurrenceEligible,
          existing.recurrenceEligible,
        ),
        unitLabel: catalogUnitLabelFromForm(
          row.pricingMode,
          row.unitLabel,
          existing.unitLabel,
        ),
        active: row.active,
      },
    });
    return { catalogItemId: existing.id, writeAction: "UPDATE" };
  }

  const websiteSlug = await allocateUnusedWebsiteSlug(db, access.businessId, row.name);
  const created = await db.serviceCatalogItem.create({
    data: {
      businessId: access.businessId,
      tradeCode,
      name: row.name,
      websiteSlug,
      pricingMode: row.pricingMode,
      price: row.price,
      description: joinCatalogDescription(
        row.description || null,
        catalogDefinitionFromSnapshot(null, row.name),
      ),
      category: row.category,
      recurrenceEligible: catalogRecurrenceEligibleForTrade(
        tradeCode,
        true,
        row.recurrenceEligible,
        false,
      ),
      unitLabel: row.unitLabel,
      active: row.active,
    },
  });
  return { catalogItemId: created.id, writeAction: "ADD" };
}

export type ConfirmCatalogImportResult = {
  preview: ServiceCatalogImportPreview;
  writtenCatalogItemIds: string[];
  addedCount: number;
  updatedCount: number;
  reused: boolean;
};

export async function confirmServiceCatalogImport(
  db: Db,
  access: ServiceCatalogImportAccess,
  input: { importId: string },
): Promise<ConfirmCatalogImportResult> {
  requireOwner(access);
  const preview = await loadOwnedCatalogImport(db, access, input.importId);
  if (preview.status === "CONFIRMED") {
    return {
      preview,
      writtenCatalogItemIds: preview.rows
        .map((row) => row.writtenCatalogItemId)
        .filter((id): id is string => Boolean(id)),
      addedCount: preview.rows.filter((row) => row.writeAction === "ADD").length,
      updatedCount: preview.rows.filter((row) => row.writeAction === "UPDATE").length,
      reused: true,
    };
  }
  if (preview.status !== "PREVIEW" && preview.status !== "CONFIRMING") {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE);
  }
  if (preview.rows.some((row) => row.previewStatus === "INVALID")) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE);
  }

  await db.serviceCatalogImport.updateMany({
    where: { id: preview.id, businessId: access.businessId, status: "PREVIEW" },
    data: { status: "CONFIRMING" },
  });

  const writtenCatalogItemIds: string[] = [];
  let addedCount = 0;
  let updatedCount = 0;

  for (const row of preview.rows) {
    if (row.writtenCatalogItemId) {
      writtenCatalogItemIds.push(row.writtenCatalogItemId);
      if (row.writeAction === "UPDATE") updatedCount += 1;
      else addedCount += 1;
      continue;
    }
    if (row.previewStatus !== "VALID" && row.previewStatus !== "NAME_MATCH") {
      continue;
    }

    const result = await writeCatalogRow(db, access, row);
    await db.serviceCatalogImportRow.updateMany({
      where: {
        id: row.id,
        businessId: access.businessId,
        importId: preview.id,
        writtenCatalogItemId: null,
      },
      data: {
        writtenCatalogItemId: result.catalogItemId,
        writeAction: result.writeAction,
      },
    });
    writtenCatalogItemIds.push(result.catalogItemId);
    if (result.writeAction === "UPDATE") updatedCount += 1;
    else addedCount += 1;
  }

  await db.serviceCatalogImport.update({
    where: { id: preview.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      confirmedByMembershipId: membershipId(access),
    },
  });

  const confirmed = await loadOwnedCatalogImport(db, access, preview.id);
  return {
    preview: confirmed,
    writtenCatalogItemIds,
    addedCount,
    updatedCount,
    reused: false,
  };
}
