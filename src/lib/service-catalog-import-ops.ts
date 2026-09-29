/**
 * OWNER-reviewed service catalog CSV write path.
 *
 * Preview stores sanitized rows. Confirm adds new VALID rows and writes
 * NAME_MATCH rows only after an explicit per-row update / add-as-new
 * choice (skip is the default). Retries reuse businessId + content hash.
 *
 * Browser-supplied businessId is never authorization. Confirm never writes
 * LineItem or EstimateVersionLineItem snapshots and never publishes hourly
 * rates. Confirm is single-flight and all-or-nothing: rematch and writes
 * share one transaction, a businessId advisory lock, and a confirmingAt
 * lease. Re-upload resets CONFIRMING only after the lease is stale.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import {
  authorizeCatalogTradeCode,
  listActiveTradeCodes,
  resolvePrimaryTradeCode,
} from "@/lib/business-trades";
import { catalogRecurrenceEligibleForTrade } from "@/lib/catalog-item-fields";
import { catalogDefinitionFromSnapshot } from "@/lib/estimate-calculators";
import {
  catalogCalculatorDefinition,
  joinCatalogDescription,
} from "@/lib/estimate-line-scope";
import { DEFAULT_SERVICE_CATEGORY, normalizeServiceCategory } from "@/lib/service-catalog-category";
import {
  applyCatalogImportContext,
  CATALOG_IMPORT_ALREADY_CONFIRMED_MESSAGE,
  CATALOG_IMPORT_CONFIRM_FAILED_MESSAGE,
  CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE,
  CATALOG_IMPORT_CONFIRMING_LEASE_MS,
  CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
  CATALOG_IMPORT_IN_PROGRESS_MESSAGE,
  CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  CATALOG_IMPORT_SLUG_CONFLICT_MESSAGE,
  CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  catalogRowBecameStale,
  countCatalogPreviewStatuses,
  decodeCatalogCsvBytes,
  hashCatalogCsvBytes,
  isCatalogImportConfirmingLeaseStale,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  parseCatalogImportMatchDecision,
  parseServiceCatalogCsv,
  sanitizeCatalogSourceFilename,
  SERVICE_CATALOG_IMPORT_ROUTE,
  ServiceCatalogImportError,
  storedCatalogRowToParsed,
  type ParsedCatalogImportRow,
  type ServiceCatalogImportMatchDecision,
} from "@/lib/service-catalog-import";
import { allocateUnusedWebsiteSlug } from "@/lib/website-engine/slugs";

export { OWNER_ONLY_CATALOG_IMPORT_MESSAGE, SERVICE_CATALOG_IMPORT_ROUTE };

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Client = Db | Tx;
export type ServiceCatalogImportAccess = BusinessAccess;

const CONFIRM_TRANSACTION_MS = 60_000;

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
  category: string | null;
  tradeCode: string;
  unitLabel: string;
  recurrenceEligible: boolean | null;
  active: boolean | null;
  matchedCatalogItemId: string | null;
  writtenCatalogItemId: string | null;
  writeAction: string | null;
  matchDecision: string;
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
  confirmingAt: Date | null;
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
  confirmingAt: Date | null;
  confirmingRecoverable: boolean;
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
    confirmingAt: record.confirmingAt,
    confirmingRecoverable:
      record.status === "CONFIRMING" &&
      isCatalogImportConfirmingLeaseStale(record.confirmingAt),
    rows,
  };
}

function confirmedResult(
  preview: ServiceCatalogImportPreview,
  reused: boolean,
  writtenCatalogItemIds?: string[],
  addedCount?: number,
  updatedCount?: number,
): ConfirmCatalogImportResult {
  return {
    preview,
    writtenCatalogItemIds:
      writtenCatalogItemIds ??
      preview.rows
        .map((row) => row.writtenCatalogItemId)
        .filter((id): id is string => Boolean(id)),
    addedCount:
      addedCount ?? preview.rows.filter((row) => row.writeAction === "ADD").length,
    updatedCount:
      updatedCount ?? preview.rows.filter((row) => row.writeAction === "UPDATE").length,
    reused,
  };
}

async function lockCatalogImportBusiness(tx: Tx, businessId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tbbt.service-catalog-import:${businessId}`}))`;
}

async function loadCatalogImportContext(db: Client, businessId: string) {
  const [activeTradeCodes, primaryTrade, existingItems] = await Promise.all([
    listActiveTradeCodes(db, businessId),
    resolvePrimaryTradeCode(db, businessId),
    db.serviceCatalogItem.findMany({
      where: { businessId },
      select: {
        id: true,
        businessId: true,
        name: true,
        tradeCode: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
    description: row.description,
    pricingMode: row.pricingMode,
    price: row.price,
    category: row.category,
    tradeCode: row.tradeCode,
    unitLabel: row.unitLabel ?? "",
    recurrenceEligible: row.recurrenceEligible,
    active: row.active,
    matchedCatalogItemId: row.matchedCatalogItemId,
    matchDecision: row.previewStatus === "NAME_MATCH" ? row.matchDecision : "SKIP",
  };
}

function plannedWriteAction(
  row: StoredCatalogImportRow,
): "ADD" | "UPDATE" | null {
  if (row.writtenCatalogItemId) return null;
  if (row.previewStatus === "VALID") return "ADD";
  if (row.previewStatus === "NAME_MATCH") {
    if (row.matchDecision === "UPDATE") return "UPDATE";
    if (row.matchDecision === "ADD_NEW") return "ADD";
  }
  return null;
}

function rowsBecameStale(rows: StoredCatalogImportRow[], live: ParsedCatalogImportRow[]) {
  const liveByNumber = new Map(live.map((row) => [row.rowNumber, row]));
  return rows.some((row) => {
    if (row.writtenCatalogItemId) return false;
    const current = liveByNumber.get(row.rowNumber);
    return current ? catalogRowBecameStale(row, current) : false;
  });
}

async function refreshPreviewMatchesTx(
  tx: Tx,
  access: ServiceCatalogImportAccess,
  existing: { id: string },
  rows: StoredCatalogImportRow[],
): Promise<ServiceCatalogImportPreview> {
  const context = await loadCatalogImportContext(tx, access.businessId);
  const written = rows.filter((row) => row.writtenCatalogItemId);
  const unwritten = rows.filter((row) => !row.writtenCatalogItemId);
  const parsed = unwritten.map((row) => storedCatalogRowToParsed(row));
  const flagged = applyCatalogImportContext(parsed, {
    businessId: access.businessId,
    ...context,
  });
  const decisions = new Map(
    unwritten.map((row) => [
      row.rowNumber,
      parseCatalogImportMatchDecision(row.matchDecision) ?? "SKIP",
    ]),
  );

  await tx.serviceCatalogImportRow.deleteMany({
    where: {
      businessId: access.businessId,
      importId: existing.id,
      writtenCatalogItemId: null,
    },
  });
  if (flagged.length > 0) {
    await tx.serviceCatalogImportRow.createMany({
      data: flagged.map((row) => ({
        ...rowWriteData(access.businessId, {
          ...row,
          matchDecision:
            row.previewStatus === "NAME_MATCH"
              ? (decisions.get(row.rowNumber) ?? "SKIP")
              : "SKIP",
        }),
        importId: existing.id,
      })),
    });
  }
  const nextRows = [
    ...written.map((row) => ({ previewStatus: row.previewStatus })),
    ...flagged,
  ];
  await tx.serviceCatalogImport.update({
    where: { id: existing.id },
    data: {
      status: "PREVIEW",
      confirmingAt: null,
      ...previewCountWrite(nextRows),
    },
  });
  return loadOwnedCatalogImportFrom(tx, access, existing.id);
}

async function persistMatchDecisions(
  db: Client,
  access: ServiceCatalogImportAccess,
  preview: ServiceCatalogImportPreview,
  decisions: Record<string, string> | undefined,
): Promise<ServiceCatalogImportPreview> {
  if (!decisions || Object.keys(decisions).length === 0) return preview;
  for (const [key, raw] of Object.entries(decisions)) {
    const decision = parseCatalogImportMatchDecision(raw);
    const rowNumber = Number.parseInt(key, 10);
    const row = preview.rows.find(
      (candidate) =>
        candidate.rowNumber === rowNumber && candidate.previewStatus === "NAME_MATCH",
    );
    if (!decision || !Number.isInteger(rowNumber) || !row) {
      throw new ServiceCatalogImportError(CATALOG_IMPORT_STALE_MATCHES_MESSAGE);
    }
    await db.serviceCatalogImportRow.updateMany({
      where: {
        id: row.id,
        businessId: access.businessId,
        importId: preview.id,
        rowNumber,
        previewStatus: "NAME_MATCH",
        writtenCatalogItemId: null,
        import: { status: { in: ["PREVIEW", "CONFIRMING"] } },
      },
      data: { matchDecision: decision },
    });
  }
  return loadOwnedCatalogImportFrom(db, access, preview.id);
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

  return db.$transaction(
    async (tx) => {
      await lockCatalogImportBusiness(tx, businessId);
      const existing = await tx.serviceCatalogImport.findFirst({
        where: { businessId, contentSha256 },
        include: { rows: { orderBy: { rowNumber: "asc" } } },
      });
      if (existing) {
        access.assertOwned(existing);
        const rows = existing.rows ?? [];
        if (existing.status === "CONFIRMED") {
          return toPreview(existing, rows);
        }
        if (existing.status === "CONFIRMING") {
          if (!isCatalogImportConfirmingLeaseStale(existing.confirmingAt)) {
            throw new ServiceCatalogImportError(CATALOG_IMPORT_IN_PROGRESS_MESSAGE);
          }
          await tx.serviceCatalogImport.updateMany({
            where: { id: existing.id, businessId, status: "CONFIRMING" },
            data: { status: "PREVIEW", confirmingAt: null },
          });
        }
        return refreshPreviewMatchesTx(tx, access, existing, rows);
      }

      const parsed = parseServiceCatalogCsv(decodeCatalogCsvBytes(bytes));
      const context = await loadCatalogImportContext(tx, businessId);
      const flagged = applyCatalogImportContext(parsed, {
        businessId,
        ...context,
      });
      const capturedAt = new Date();
      try {
        const created = await tx.serviceCatalogImport.create({
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
        return loadOwnedCatalogImportFrom(tx, access, created.id);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const raced = await tx.serviceCatalogImport.findFirst({
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
    },
    { maxWait: 10_000, timeout: CONFIRM_TRANSACTION_MS },
  );
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

async function loadOwnedCatalogImportFrom(
  db: Client,
  access: ServiceCatalogImportAccess,
  importId: string,
): Promise<ServiceCatalogImportPreview> {
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

export async function loadOwnedCatalogImport(
  db: Db,
  access: ServiceCatalogImportAccess,
  importId: string,
): Promise<ServiceCatalogImportPreview> {
  requireOwner(access);
  return loadOwnedCatalogImportFrom(db, access, importId);
}

export async function setCatalogImportMatchDecision(
  db: Db,
  access: ServiceCatalogImportAccess,
  input: {
    importId: string;
    rowId: string;
    decision: string;
  },
): Promise<ServiceCatalogImportPreview> {
  requireOwner(access);
  const decision = parseCatalogImportMatchDecision(input.decision);
  if (!decision) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const preview = await loadOwnedCatalogImport(db, access, input.importId);
  if (preview.status !== "PREVIEW") {
    throw new ServiceCatalogImportError(
      preview.status === "CONFIRMED"
        ? CATALOG_IMPORT_ALREADY_CONFIRMED_MESSAGE
        : CATALOG_IMPORT_IN_PROGRESS_MESSAGE,
    );
  }
  const row = preview.rows.find((candidate) => candidate.id === input.rowId.trim());
  if (!row || row.businessId !== access.businessId || row.previewStatus !== "NAME_MATCH") {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(row);
  await db.serviceCatalogImportRow.updateMany({
    where: {
      id: row.id,
      businessId: access.businessId,
      importId: preview.id,
      previewStatus: "NAME_MATCH",
      writtenCatalogItemId: null,
      import: { status: "PREVIEW" },
    },
    data: { matchDecision: decision },
  });
  return loadOwnedCatalogImport(db, access, preview.id);
}

function keepExistingText(incoming: string | null | undefined, existing: string | null) {
  const value = incoming?.trim() ?? "";
  return value ? value : existing;
}

async function applyCatalogUpdate(
  tx: Tx,
  access: ServiceCatalogImportAccess,
  row: StoredCatalogImportRow,
): Promise<string> {
  const tradeCode = await authorizeCatalogTradeCode(
    tx,
    access.businessId,
    row.tradeCode || null,
  );
  const existing = access.assertOwned(
    await tx.serviceCatalogItem.findFirst({
      where: {
        id: row.matchedCatalogItemId ?? "",
        businessId: access.businessId,
        tradeCode,
      },
    }),
  );
  const nextDescription = row.description?.trim()
    ? joinCatalogDescription(
        row.description,
        catalogCalculatorDefinition(existing.description) ??
          catalogDefinitionFromSnapshot(null, row.name),
      )
    : existing.description;
  await tx.serviceCatalogItem.update({
    where: { id: existing.id },
    data: {
      name: row.name,
      pricingMode: row.pricingMode,
      price: row.price,
      description: nextDescription,
      category: row.category?.trim()
        ? normalizeServiceCategory(row.category)
        : existing.category,
      recurrenceEligible: catalogRecurrenceEligibleForTrade(
        existing.tradeCode,
        row.recurrenceEligible != null,
        row.recurrenceEligible === true,
        existing.recurrenceEligible,
      ),
      unitLabel: keepExistingText(row.unitLabel, existing.unitLabel) ?? existing.unitLabel,
      active: row.active == null ? existing.active : row.active,
    },
  });
  return existing.id;
}

async function applyCatalogAdd(
  tx: Tx,
  access: ServiceCatalogImportAccess,
  row: StoredCatalogImportRow,
): Promise<string> {
  const tradeCode = await authorizeCatalogTradeCode(
    tx,
    access.businessId,
    row.tradeCode || null,
  );
  const websiteSlug = await allocateUnusedWebsiteSlug(tx, access.businessId, row.name);
  try {
    const created = await tx.serviceCatalogItem.create({
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
        category: normalizeServiceCategory(row.category) || DEFAULT_SERVICE_CATEGORY,
        recurrenceEligible: catalogRecurrenceEligibleForTrade(
          tradeCode,
          true,
          row.recurrenceEligible === true,
          false,
        ),
        unitLabel: row.unitLabel ?? "",
        active: row.active == null ? true : row.active,
      },
    });
    return created.id;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ServiceCatalogImportError(CATALOG_IMPORT_SLUG_CONFLICT_MESSAGE);
    }
    throw error;
  }
}

async function writeEligibleRow(
  tx: Tx,
  access: ServiceCatalogImportAccess,
  row: StoredCatalogImportRow,
  writeAction: "ADD" | "UPDATE",
): Promise<{ catalogItemId: string; writeAction: "ADD" | "UPDATE" } | null> {
  const claimed = await tx.serviceCatalogImportRow.updateMany({
    where: {
      id: row.id,
      businessId: access.businessId,
      importId: row.importId,
      writtenCatalogItemId: null,
      writeAction: null,
    },
    data: { writeAction },
  });
  if (claimed.count !== 1) {
    return null;
  }
  const catalogItemId =
    writeAction === "UPDATE"
      ? await applyCatalogUpdate(tx, access, row)
      : await applyCatalogAdd(tx, access, row);
  await tx.serviceCatalogImportRow.update({
    where: { id: row.id },
    data: { writtenCatalogItemId: catalogItemId },
  });
  return { catalogItemId, writeAction };
}

export type ConfirmCatalogImportResult = {
  preview: ServiceCatalogImportPreview;
  writtenCatalogItemIds: string[];
  addedCount: number;
  updatedCount: number;
  reused: boolean;
};

type ConfirmTxOutcome =
  | { kind: "ok"; result: ConfirmCatalogImportResult }
  | { kind: "stale" };

function claimableConfirmingWhere(businessId: string, importId: string, now: Date) {
  const staleBefore = new Date(now.getTime() - CATALOG_IMPORT_CONFIRMING_LEASE_MS);
  return {
    id: importId,
    businessId,
    OR: [
      { status: "PREVIEW" },
      { status: "CONFIRMING", confirmingAt: { lt: staleBefore } },
      { status: "CONFIRMING", confirmingAt: null },
    ],
  };
}

export async function confirmServiceCatalogImport(
  db: Db,
  access: ServiceCatalogImportAccess,
  input: {
    importId: string;
    matchDecisions?: Record<string, string>;
  },
): Promise<ConfirmCatalogImportResult> {
  requireOwner(access);
  const preview = await loadOwnedCatalogImport(db, access, input.importId);
  if (preview.status === "CONFIRMED") {
    return confirmedResult(preview, true);
  }
  if (preview.rows.some((row) => row.previewStatus === "INVALID")) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE);
  }
  if (
    preview.status === "CONFIRMING" &&
    !isCatalogImportConfirmingLeaseStale(preview.confirmingAt)
  ) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_IN_PROGRESS_MESSAGE);
  }
  if (preview.status !== "PREVIEW" && preview.status !== "CONFIRMING") {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE);
  }

  const outcome = await db.$transaction(
    async (tx): Promise<ConfirmTxOutcome> => {
      await lockCatalogImportBusiness(tx, access.businessId);
      let current = await loadOwnedCatalogImportFrom(tx, access, input.importId);
      if (current.status === "CONFIRMED") {
        return { kind: "ok", result: confirmedResult(current, true) };
      }
      if (
        current.status === "CONFIRMING" &&
        !isCatalogImportConfirmingLeaseStale(current.confirmingAt)
      ) {
        throw new ServiceCatalogImportError(CATALOG_IMPORT_IN_PROGRESS_MESSAGE);
      }
      if (current.status !== "PREVIEW" && current.status !== "CONFIRMING") {
        throw new ServiceCatalogImportError(CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE);
      }
      if (current.rows.some((row) => row.previewStatus === "INVALID")) {
        throw new ServiceCatalogImportError(CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE);
      }

      try {
        current = await persistMatchDecisions(tx, access, current, input.matchDecisions);
      } catch (error) {
        if (
          error instanceof ServiceCatalogImportError &&
          error.message === CATALOG_IMPORT_STALE_MATCHES_MESSAGE
        ) {
          await refreshPreviewMatchesTx(tx, access, current, current.rows);
          return { kind: "stale" };
        }
        throw error;
      }

      const context = await loadCatalogImportContext(tx, access.businessId);
      const live = applyCatalogImportContext(
        current.rows.map((row) => storedCatalogRowToParsed(row)),
        { businessId: access.businessId, ...context },
      );
      if (rowsBecameStale(current.rows, live)) {
        await refreshPreviewMatchesTx(tx, access, current, current.rows);
        return { kind: "stale" };
      }

      const leaseStartedAt = new Date();
      const claimed = await tx.serviceCatalogImport.updateMany({
        where: claimableConfirmingWhere(access.businessId, current.id, leaseStartedAt),
        data: { status: "CONFIRMING", confirmingAt: leaseStartedAt },
      });
      if (claimed.count !== 1) {
        const raced = await loadOwnedCatalogImportFrom(tx, access, current.id);
        if (raced.status === "CONFIRMED") {
          return { kind: "ok", result: confirmedResult(raced, true) };
        }
        throw new ServiceCatalogImportError(CATALOG_IMPORT_IN_PROGRESS_MESSAGE);
      }

      const writtenCatalogItemIds: string[] = [];
      let addedCount = 0;
      let updatedCount = 0;
      try {
        for (const row of current.rows) {
          if (row.writtenCatalogItemId) {
            writtenCatalogItemIds.push(row.writtenCatalogItemId);
            if (row.writeAction === "UPDATE") updatedCount += 1;
            else addedCount += 1;
            continue;
          }
          const action = plannedWriteAction(row);
          if (!action) continue;
          const result = await writeEligibleRow(tx, access, row, action);
          if (!result) continue;
          writtenCatalogItemIds.push(result.catalogItemId);
          if (result.writeAction === "UPDATE") updatedCount += 1;
          else addedCount += 1;
        }
      } catch (error) {
        if (error instanceof ServiceCatalogImportError) {
          throw error;
        }
        throw new ServiceCatalogImportError(CATALOG_IMPORT_CONFIRM_FAILED_MESSAGE);
      }

      const finished = await tx.serviceCatalogImport.updateMany({
        where: {
          id: current.id,
          businessId: access.businessId,
          status: "CONFIRMING",
          confirmingAt: leaseStartedAt,
        },
        data: {
          status: "CONFIRMED",
          confirmedAt: new Date(),
          confirmedByMembershipId: membershipId(access),
          confirmingAt: null,
        },
      });
      if (finished.count !== 1) {
        throw new ServiceCatalogImportError(CATALOG_IMPORT_IN_PROGRESS_MESSAGE);
      }

      const confirmed = await loadOwnedCatalogImportFrom(tx, access, current.id);
      return {
        kind: "ok",
        result: confirmedResult(
          confirmed,
          false,
          writtenCatalogItemIds,
          addedCount,
          updatedCount,
        ),
      };
    },
    { maxWait: 10_000, timeout: CONFIRM_TRANSACTION_MS },
  );

  if (outcome.kind === "stale") {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_STALE_MATCHES_MESSAGE);
  }
  return outcome.result;
}

export type { ServiceCatalogImportMatchDecision };
