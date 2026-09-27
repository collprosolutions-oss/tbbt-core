/**
 * OWNER-reviewed external lead import write path.
 *
 * Preview stores sanitized rows. Confirm creates ServiceRequest rows
 * only after an explicit OWNER action. Retries reuse the same batch
 * (businessId + content hash, then createdRequestId / submissionId).
 *
 * Browser-supplied businessId is never authorization.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import {
  applySameBusinessDuplicates,
  countPreviewStatuses,
  decodeCsvBytes,
  evaluateImportRow,
  EXTERNAL_LEAD_IMPORT_ROUTE,
  ExternalLeadImportError,
  FILE_TOO_LARGE_MESSAGE,
  hashCsvBytes,
  IMPORT_ALREADY_CONFIRMED_MESSAGE,
  IMPORT_CONFIRM_REQUIRED_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  IMPORT_RESOLVE_INVALID_MESSAGE,
  IMPORT_ROW_NOT_EDITABLE_MESSAGE,
  IMPORT_ROW_NOT_REJECTABLE_MESSAGE,
  IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
  importRowSubmissionId,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  OWNER_ONLY_IMPORT_MESSAGE,
  parseExternalLeadCsv,
  ROW_REJECTED_BY_OWNER_MESSAGE,
  sanitizeSourceFilename,
  storedRowToParsed,
  type CanonicalImportColumn,
  type ParsedImportRow,
  type SameBusinessIdentity,
  type SameBusinessRequest,
} from "@/lib/external-lead-import";
import { createOwnerLoggedLead } from "@/lib/owner-log-lead";
import { hasStructuredAddressInput } from "@/lib/service-address";

export { OWNER_ONLY_IMPORT_MESSAGE, EXTERNAL_LEAD_IMPORT_ROUTE };

type Db = PrismaClient;
export type ExternalLeadImportAccess = BusinessAccess;

export type StoredImportRow = {
  id: string;
  businessId: string;
  importId: string;
  rowNumber: number;
  previewStatus: string;
  invalidReason: string | null;
  rowFingerprint: string;
  name: string;
  email: string | null;
  phone: string | null;
  summary: string | null;
  notes: string | null;
  streetAddress: string | null;
  unit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  leadSource: string;
  possibleDuplicateCustomerId: string | null;
  possibleDuplicateRequestId: string | null;
  createdRequestId: string | null;
};

export type StoredImport = {
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
  possibleDuplicateCount: number;
  createdByMembershipId: string;
  confirmedAt: Date | null;
  confirmedByMembershipId: string | null;
  rows?: StoredImportRow[];
};

export type ExternalLeadImportPreview = {
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
  possibleDuplicateCount: number;
  rejectedCount: number;
  createdCount: number;
  rows: StoredImportRow[];
};

function requireOwner(access: ExternalLeadImportAccess) {
  requireBusinessRole(access, "OWNER");
}

function membershipId(access: ExternalLeadImportAccess): string {
  const id = access.workspace.membership?.id?.trim();
  if (!id) {
    throw new ExternalLeadImportError(OWNER_ONLY_IMPORT_MESSAGE);
  }
  return id;
}

function previewCountWrite(rows: Array<{ previewStatus: string }>) {
  const counts = countPreviewStatuses(rows);
  return {
    rowCount: counts.rowCount,
    validCount: counts.validCount,
    invalidCount: counts.invalidCount,
    possibleDuplicateCount: counts.possibleDuplicateCount,
  };
}

function toPreview(record: StoredImport, rows: StoredImportRow[]): ExternalLeadImportPreview {
  const counts = countPreviewStatuses(rows);
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
    possibleDuplicateCount: counts.possibleDuplicateCount,
    rejectedCount: counts.rejectedCount,
    createdCount: rows.filter((row) => row.createdRequestId).length,
    rows,
  };
}

async function loadSameBusinessIdentities(
  db: Db,
  businessId: string,
): Promise<{ customers: SameBusinessIdentity[]; requests: SameBusinessRequest[] }> {
  const [customers, requests] = await Promise.all([
    db.customer.findMany({
      where: { businessId },
      select: { id: true, name: true, email: true, phone: true },
    }),
    db.serviceRequest.findMany({
      where: { businessId },
      select: {
        id: true,
        customerId: true,
        customer: { select: { email: true, phone: true } },
      },
    }),
  ]);
  return { customers, requests };
}

function rowWriteData(businessId: string, row: ParsedImportRow) {
  return {
    businessId,
    rowNumber: row.rowNumber,
    previewStatus: row.previewStatus,
    invalidReason: row.invalidReason,
    rowFingerprint: row.rowFingerprint,
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    summary: row.summary || null,
    notes: row.notes || null,
    streetAddress: row.streetAddress || null,
    unit: row.unit || null,
    city: row.city || null,
    region: row.region || null,
    postalCode: row.postalCode || null,
    leadSource: row.leadSource,
    possibleDuplicateCustomerId: row.possibleDuplicateCustomerId,
    possibleDuplicateRequestId: row.possibleDuplicateRequestId,
  };
}

async function persistPreview(
  db: Db,
  access: ExternalLeadImportAccess,
  input: {
    sourceLabel: string;
    bytes: Uint8Array | Buffer;
  },
): Promise<ExternalLeadImportPreview> {
  requireOwner(access);
  const businessId = access.businessId;
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > MAX_EXTERNAL_LEAD_IMPORT_BYTES) {
    throw new ExternalLeadImportError(FILE_TOO_LARGE_MESSAGE);
  }
  const contentSha256 = hashCsvBytes(bytes);
  const existing = await db.externalLeadImport.findFirst({
    where: { businessId, contentSha256 },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (existing) {
    access.assertOwned(existing);
    const rows = existing.rows ?? [];
    if (existing.status === "CONFIRMED" || existing.status === "CONFIRMING") {
      return toPreview(existing, rows);
    }
    return refreshPreviewDuplicates(db, access, existing, rows);
  }

  const parsed = parseExternalLeadCsv(decodeCsvBytes(bytes));
  const identities = await loadSameBusinessIdentities(db, businessId);
  const flagged = applySameBusinessDuplicates(parsed, identities.customers, identities.requests);
  const capturedAt = new Date();

  try {
    const created = await db.externalLeadImport.create({
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
    return loadOwnedImport(db, access, created.id);
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await db.externalLeadImport.findFirst({
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

async function refreshPreviewDuplicates(
  db: Db,
  access: ExternalLeadImportAccess,
  existing: StoredImport,
  rows: StoredImportRow[],
): Promise<ExternalLeadImportPreview> {
  const identities = await loadSameBusinessIdentities(db, access.businessId);
  const parsed = rows.map((row) => storedRowToParsed(row));
  const flagged = applySameBusinessDuplicates(parsed, identities.customers, identities.requests);
  await db.externalLeadImportRow.deleteMany({
    where: { businessId: access.businessId, importId: existing.id },
  });
  await db.externalLeadImportRow.createMany({
    data: flagged.map((row) => ({
      ...rowWriteData(access.businessId, row),
      importId: existing.id,
    })),
  });
  await db.externalLeadImport.update({
    where: { id: existing.id },
    data: previewCountWrite(flagged),
  });
  return loadOwnedImport(db, access, existing.id);
}

export async function previewCsvUpload(
  db: Db,
  access: ExternalLeadImportAccess,
  input: { filename: string; bytes: Uint8Array | Buffer },
): Promise<ExternalLeadImportPreview> {
  return persistPreview(db, access, {
    sourceLabel: sanitizeSourceFilename(input.filename),
    bytes: input.bytes,
  });
}

export async function loadOwnedImport(
  db: Db,
  access: ExternalLeadImportAccess,
  importId: string,
): Promise<ExternalLeadImportPreview> {
  requireOwner(access);
  const id = importId.trim();
  if (!id) {
    throw new ExternalLeadImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const record = await db.externalLeadImport.findFirst({
    where: { id, businessId: access.businessId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!record) {
    throw new ExternalLeadImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(record);
  return toPreview(record, record.rows ?? []);
}

function requireMutablePreview(preview: ExternalLeadImportPreview) {
  if (preview.status === "CONFIRMED") {
    throw new ExternalLeadImportError(IMPORT_ALREADY_CONFIRMED_MESSAGE);
  }
  if (preview.status !== "PREVIEW") {
    throw new ExternalLeadImportError(IMPORT_CONFIRM_REQUIRED_MESSAGE);
  }
}

function findOwnedRow(
  access: ExternalLeadImportAccess,
  preview: ExternalLeadImportPreview,
  rowId: string,
): StoredImportRow {
  const id = rowId.trim();
  if (!id) {
    throw new ExternalLeadImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const row = preview.rows.find((candidate) => candidate.id === id) ?? null;
  if (!row || row.businessId !== access.businessId || row.importId !== preview.id) {
    throw new ExternalLeadImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(row);
  return row;
}

async function persistReviewedRow(
  db: Db,
  access: ExternalLeadImportAccess,
  preview: ExternalLeadImportPreview,
  row: StoredImportRow,
  parsed: ParsedImportRow,
): Promise<ExternalLeadImportPreview> {
  const updated = await db.externalLeadImportRow.updateMany({
    where: {
      id: row.id,
      businessId: access.businessId,
      importId: preview.id,
    },
    data: {
      previewStatus: parsed.previewStatus,
      invalidReason: parsed.invalidReason,
      rowFingerprint: parsed.rowFingerprint,
      name: parsed.name,
      email: parsed.email || null,
      phone: parsed.phone || null,
      summary: parsed.summary || null,
      notes: parsed.notes || null,
      streetAddress: parsed.streetAddress || null,
      unit: parsed.unit || null,
      city: parsed.city || null,
      region: parsed.region || null,
      postalCode: parsed.postalCode || null,
      leadSource: parsed.leadSource,
      possibleDuplicateCustomerId: parsed.possibleDuplicateCustomerId,
      possibleDuplicateRequestId: parsed.possibleDuplicateRequestId,
    },
  });
  if (updated.count !== 1) {
    throw new ExternalLeadImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const rows = await db.externalLeadImportRow.findMany({
    where: { importId: preview.id, businessId: access.businessId },
    orderBy: { rowNumber: "asc" },
  });
  await db.externalLeadImport.updateMany({
    where: { id: preview.id, businessId: access.businessId },
    data: previewCountWrite(rows),
  });
  return loadOwnedImport(db, access, preview.id);
}

export type ImportRowCorrectionInput = {
  importId: string;
  rowId: string;
} & Partial<Record<CanonicalImportColumn, string>>;

export async function correctExternalLeadImportRow(
  db: Db,
  access: ExternalLeadImportAccess,
  input: ImportRowCorrectionInput,
): Promise<ExternalLeadImportPreview> {
  requireOwner(access);
  const preview = await loadOwnedImport(db, access, input.importId);
  requireMutablePreview(preview);
  const row = findOwnedRow(access, preview, input.rowId);
  if (row.createdRequestId) {
    throw new ExternalLeadImportError(IMPORT_ROW_NOT_EDITABLE_MESSAGE);
  }
  if (row.previewStatus === "REJECTED") {
    throw new ExternalLeadImportError(IMPORT_ROW_REJECTED_TERMINAL_MESSAGE);
  }
  if (row.previewStatus !== "INVALID") {
    throw new ExternalLeadImportError(IMPORT_ROW_NOT_EDITABLE_MESSAGE);
  }

  const parsed = evaluateImportRow(row.rowNumber, {
    name: input.name ?? "",
    email: input.email ?? "",
    phone: input.phone ?? "",
    summary: input.summary ?? "",
    notes: input.notes ?? "",
    street: input.street ?? "",
    unit: input.unit ?? "",
    city: input.city ?? "",
    region: input.region ?? "",
    postal: input.postal ?? "",
    source: input.source ?? "",
  });
  const identities = await loadSameBusinessIdentities(db, access.businessId);
  const [flagged] = applySameBusinessDuplicates(
    [parsed],
    identities.customers,
    identities.requests,
  );
  return persistReviewedRow(db, access, preview, row, flagged);
}

export type RejectImportRowResult = {
  preview: ExternalLeadImportPreview;
  reused: boolean;
};

export async function rejectExternalLeadImportRow(
  db: Db,
  access: ExternalLeadImportAccess,
  input: { importId: string; rowId: string },
): Promise<RejectImportRowResult> {
  requireOwner(access);
  const preview = await loadOwnedImport(db, access, input.importId);
  requireMutablePreview(preview);
  const row = findOwnedRow(access, preview, input.rowId);
  if (row.createdRequestId) {
    throw new ExternalLeadImportError(IMPORT_ROW_NOT_REJECTABLE_MESSAGE);
  }
  if (row.previewStatus === "REJECTED") {
    return { preview, reused: true };
  }
  if (row.previewStatus !== "INVALID") {
    throw new ExternalLeadImportError(IMPORT_ROW_NOT_REJECTABLE_MESSAGE);
  }

  const parsed = storedRowToParsed({
    ...row,
    previewStatus: "REJECTED",
    invalidReason: ROW_REJECTED_BY_OWNER_MESSAGE,
  });
  return {
    preview: await persistReviewedRow(db, access, preview, row, parsed),
    reused: false,
  };
}

export type ConfirmImportResult = {
  preview: ExternalLeadImportPreview;
  createdRequestIds: string[];
  reused: boolean;
};

export async function confirmExternalLeadImport(
  db: Db,
  access: ExternalLeadImportAccess,
  input: { importId: string; includePossibleDuplicates?: boolean },
): Promise<ConfirmImportResult> {
  requireOwner(access);
  const preview = await loadOwnedImport(db, access, input.importId);
  if (preview.status === "CONFIRMED") {
    return {
      preview,
      createdRequestIds: preview.rows
        .map((row) => row.createdRequestId)
        .filter((id): id is string => Boolean(id)),
      reused: true,
    };
  }
  if (preview.status !== "PREVIEW" && preview.status !== "CONFIRMING") {
    throw new ExternalLeadImportError(IMPORT_CONFIRM_REQUIRED_MESSAGE);
  }
  if (preview.rows.some((row) => row.previewStatus === "INVALID")) {
    throw new ExternalLeadImportError(IMPORT_RESOLVE_INVALID_MESSAGE);
  }

  await db.externalLeadImport.updateMany({
    where: { id: preview.id, businessId: access.businessId, status: "PREVIEW" },
    data: { status: "CONFIRMING" },
  });

  const includeDuplicates = Boolean(input.includePossibleDuplicates);
  const createdRequestIds: string[] = [];

  for (const row of preview.rows) {
    if (row.createdRequestId) {
      createdRequestIds.push(row.createdRequestId);
      continue;
    }
    const eligible =
      row.previewStatus === "VALID" ||
      (includeDuplicates && row.previewStatus === "POSSIBLE_DUPLICATE");
    if (!eligible) continue;

    const address = {
      streetAddress: row.streetAddress ?? "",
      unit: row.unit ?? "",
      city: row.city ?? "",
      region: row.region ?? "",
      postalCode: row.postalCode ?? "",
    };
    const hasAddress = hasStructuredAddressInput(address);
    const importNote = [
      "Imported from owner-reviewed external source.",
      `Captured: ${preview.capturedAt.toISOString()}`,
      `Source: ${preview.sourceLabel}`,
      row.notes,
    ]
      .filter(Boolean)
      .join("\n");

    const result = await createOwnerLoggedLead(db, access, {
      mode: "new",
      name: row.name,
      email: row.email,
      phone: row.phone,
      summary: row.summary,
      notes: importNote,
      streetAddress: address.streetAddress,
      unit: address.unit,
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      propertyChoice: hasAddress ? "new" : "none",
      channel: row.leadSource === "REFERRAL" ? "REFERRAL" : "MANUAL",
      submissionId: importRowSubmissionId(preview.id, row.rowFingerprint),
    });
    if (!result.ok) {
      throw new ExternalLeadImportError(result.error);
    }
    if (row.leadSource && row.leadSource !== "MANUAL") {
      await db.serviceRequest.updateMany({
        where: { id: result.requestId, businessId: access.businessId },
        data: { leadSource: row.leadSource, originalLeadSource: row.leadSource },
      });
    }
    await db.externalLeadImportRow.update({
      where: { id: row.id },
      data: { createdRequestId: result.requestId },
    });
    createdRequestIds.push(result.requestId);
  }

  await db.externalLeadImport.update({
    where: { id: preview.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      confirmedByMembershipId: membershipId(access),
    },
  });

  const confirmed = await loadOwnedImport(db, access, preview.id);
  return { preview: confirmed, createdRequestIds, reused: false };
}
