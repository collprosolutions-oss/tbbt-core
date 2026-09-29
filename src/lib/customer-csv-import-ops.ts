/**
 * OWNER-reviewed existing-customer CSV import write path.
 *
 * Preview stores sanitized rows. Confirm creates Customer / Property rows
 * only after an explicit OWNER action. Retries reuse the same batch
 * (businessId + content hash, then createdCustomerId / createdPropertyId).
 *
 * Existing customers and SMS consent are never overwritten. Browser-supplied
 * businessId is never authorization.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { requireBusinessRole } from "@/lib/authorization";
import {
  applySameBusinessDuplicates,
  countPreviewStatuses,
  CustomerCsvImportError,
  CUSTOMER_CSV_IMPORT_ROUTE,
  decodeCsvBytes,
  evaluateCustomerImportRow,
  FILE_TOO_LARGE_MESSAGE,
  findSameBusinessCustomer,
  hashCsvBytes,
  IMPORT_ALREADY_CONFIRMED_MESSAGE,
  IMPORT_CONFIRM_REQUIRED_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  IMPORT_RESOLVE_INVALID_MESSAGE,
  IMPORT_ROW_NOT_EDITABLE_MESSAGE,
  IMPORT_ROW_NOT_REJECTABLE_MESSAGE,
  IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
  matchingPropertyId,
  MAX_CUSTOMER_CSV_IMPORT_BYTES,
  OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE,
  parseCustomerCsv,
  propertyAddressInput,
  ROW_REJECTED_BY_OWNER_MESSAGE,
  sanitizeSourceFilename,
  storedRowToParsed,
  type CanonicalCustomerImportColumn,
  type ParsedCustomerImportRow,
  type SameBusinessCustomerIdentity,
} from "@/lib/customer-csv-import";
import { hasStructuredAddressInput } from "@/lib/service-address";

export { OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE, CUSTOMER_CSV_IMPORT_ROUTE };

type Db = PrismaClient;
export type CustomerCsvImportAccess = BusinessAccess;

export type StoredCustomerImportRow = {
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
  propertyLabel: string | null;
  streetAddress: string | null;
  unit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  possibleDuplicateCustomerId: string | null;
  createdCustomerId: string | null;
  createdPropertyId: string | null;
  reusedExistingCustomer: boolean;
};

export type StoredCustomerImport = {
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
  rows?: StoredCustomerImportRow[];
};

export type CustomerCsvImportPreview = {
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
  reusedCount: number;
  rows: StoredCustomerImportRow[];
};

function requireOwner(access: CustomerCsvImportAccess) {
  requireBusinessRole(access, "OWNER");
}

function membershipId(access: CustomerCsvImportAccess): string {
  const id = access.workspace.membership?.id?.trim();
  if (!id) {
    throw new CustomerCsvImportError(OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE);
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

function toPreview(
  record: StoredCustomerImport,
  rows: StoredCustomerImportRow[],
): CustomerCsvImportPreview {
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
    createdCount: rows.filter((row) => row.createdCustomerId && !row.reusedExistingCustomer)
      .length,
    reusedCount: rows.filter((row) => row.reusedExistingCustomer).length,
    rows,
  };
}

async function loadSameBusinessCustomers(
  db: Db,
  businessId: string,
): Promise<SameBusinessCustomerIdentity[]> {
  return db.customer.findMany({
    where: { businessId },
    select: { id: true, name: true, email: true, phone: true },
  });
}

function rowWriteData(businessId: string, row: ParsedCustomerImportRow) {
  return {
    businessId,
    rowNumber: row.rowNumber,
    previewStatus: row.previewStatus,
    invalidReason: row.invalidReason,
    rowFingerprint: row.rowFingerprint,
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    propertyLabel: row.propertyLabel || null,
    streetAddress: row.streetAddress || null,
    unit: row.unit || null,
    city: row.city || null,
    region: row.region || null,
    postalCode: row.postalCode || null,
    possibleDuplicateCustomerId: row.possibleDuplicateCustomerId,
  };
}

async function persistPreview(
  db: Db,
  access: CustomerCsvImportAccess,
  input: {
    sourceLabel: string;
    bytes: Uint8Array | Buffer;
  },
): Promise<CustomerCsvImportPreview> {
  requireOwner(access);
  const businessId = access.businessId;
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength > MAX_CUSTOMER_CSV_IMPORT_BYTES) {
    throw new CustomerCsvImportError(FILE_TOO_LARGE_MESSAGE);
  }
  const contentSha256 = hashCsvBytes(bytes);
  const existing = await db.customerCsvImport.findFirst({
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

  const parsed = parseCustomerCsv(decodeCsvBytes(bytes));
  const customers = await loadSameBusinessCustomers(db, businessId);
  const flagged = applySameBusinessDuplicates(parsed, customers);
  const capturedAt = new Date();

  try {
    const created = await db.customerCsvImport.create({
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
      const raced = await db.customerCsvImport.findFirst({
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
  access: CustomerCsvImportAccess,
  existing: StoredCustomerImport,
  rows: StoredCustomerImportRow[],
): Promise<CustomerCsvImportPreview> {
  const customers = await loadSameBusinessCustomers(db, access.businessId);
  const parsed = rows.map((row) => storedRowToParsed(row));
  const flagged = applySameBusinessDuplicates(parsed, customers);
  await db.customerCsvImportRow.deleteMany({
    where: { businessId: access.businessId, importId: existing.id },
  });
  await db.customerCsvImportRow.createMany({
    data: flagged.map((row) => ({
      ...rowWriteData(access.businessId, row),
      importId: existing.id,
    })),
  });
  await db.customerCsvImport.update({
    where: { id: existing.id },
    data: previewCountWrite(flagged),
  });
  return loadOwnedImport(db, access, existing.id);
}

export async function previewCustomerCsvUpload(
  db: Db,
  access: CustomerCsvImportAccess,
  input: { filename: string; bytes: Uint8Array | Buffer },
): Promise<CustomerCsvImportPreview> {
  return persistPreview(db, access, {
    sourceLabel: sanitizeSourceFilename(input.filename),
    bytes: input.bytes,
  });
}

export async function loadOwnedImport(
  db: Db,
  access: CustomerCsvImportAccess,
  importId: string,
): Promise<CustomerCsvImportPreview> {
  requireOwner(access);
  const id = importId.trim();
  if (!id) {
    throw new CustomerCsvImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const record = await db.customerCsvImport.findFirst({
    where: { id, businessId: access.businessId },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!record) {
    throw new CustomerCsvImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(record);
  return toPreview(record, record.rows ?? []);
}

function requireMutablePreview(preview: CustomerCsvImportPreview) {
  if (preview.status === "CONFIRMED") {
    throw new CustomerCsvImportError(IMPORT_ALREADY_CONFIRMED_MESSAGE);
  }
  if (preview.status !== "PREVIEW") {
    throw new CustomerCsvImportError(IMPORT_CONFIRM_REQUIRED_MESSAGE);
  }
}

function findOwnedRow(
  access: CustomerCsvImportAccess,
  preview: CustomerCsvImportPreview,
  rowId: string,
): StoredCustomerImportRow {
  const id = rowId.trim();
  if (!id) {
    throw new CustomerCsvImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const row = preview.rows.find((candidate) => candidate.id === id) ?? null;
  if (!row || row.businessId !== access.businessId || row.importId !== preview.id) {
    throw new CustomerCsvImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(row);
  return row;
}

async function persistReviewedRow(
  db: Db,
  access: CustomerCsvImportAccess,
  preview: CustomerCsvImportPreview,
  row: StoredCustomerImportRow,
  parsed: ParsedCustomerImportRow,
): Promise<{ preview: CustomerCsvImportPreview; wrote: boolean }> {
  const updated = await db.customerCsvImportRow.updateMany({
    where: {
      id: row.id,
      businessId: access.businessId,
      importId: preview.id,
      previewStatus: "INVALID",
      createdCustomerId: null,
    },
    data: {
      previewStatus: parsed.previewStatus,
      invalidReason: parsed.invalidReason,
      rowFingerprint: parsed.rowFingerprint,
      name: parsed.name,
      email: parsed.email || null,
      phone: parsed.phone || null,
      propertyLabel: parsed.propertyLabel || null,
      streetAddress: parsed.streetAddress || null,
      unit: parsed.unit || null,
      city: parsed.city || null,
      region: parsed.region || null,
      postalCode: parsed.postalCode || null,
      possibleDuplicateCustomerId: parsed.possibleDuplicateCustomerId,
    },
  });
  if (updated.count !== 1) {
    return { preview: await loadOwnedImport(db, access, preview.id), wrote: false };
  }
  const rows = await db.customerCsvImportRow.findMany({
    where: { importId: preview.id, businessId: access.businessId },
    orderBy: { rowNumber: "asc" },
  });
  await db.customerCsvImport.updateMany({
    where: { id: preview.id, businessId: access.businessId },
    data: previewCountWrite(rows),
  });
  return { preview: await loadOwnedImport(db, access, preview.id), wrote: true };
}

function currentReviewedRow(preview: CustomerCsvImportPreview, rowId: string) {
  return preview.rows.find((candidate) => candidate.id === rowId) ?? null;
}

export type CustomerImportRowCorrectionInput = {
  importId: string;
  rowId: string;
} & Partial<Record<CanonicalCustomerImportColumn, string>>;

export async function correctCustomerCsvImportRow(
  db: Db,
  access: CustomerCsvImportAccess,
  input: CustomerImportRowCorrectionInput,
): Promise<CustomerCsvImportPreview> {
  requireOwner(access);
  const preview = await loadOwnedImport(db, access, input.importId);
  requireMutablePreview(preview);
  const row = findOwnedRow(access, preview, input.rowId);
  if (row.createdCustomerId) {
    throw new CustomerCsvImportError(IMPORT_ROW_NOT_EDITABLE_MESSAGE);
  }
  if (row.previewStatus === "REJECTED") {
    throw new CustomerCsvImportError(IMPORT_ROW_REJECTED_TERMINAL_MESSAGE);
  }
  if (row.previewStatus !== "INVALID") {
    throw new CustomerCsvImportError(IMPORT_ROW_NOT_EDITABLE_MESSAGE);
  }

  const parsed = evaluateCustomerImportRow(row.rowNumber, {
    name: input.name ?? "",
    email: input.email ?? "",
    phone: input.phone ?? "",
    label: input.label ?? "",
    street: input.street ?? "",
    unit: input.unit ?? "",
    city: input.city ?? "",
    region: input.region ?? "",
    postal: input.postal ?? "",
  });
  const customers = await loadSameBusinessCustomers(db, access.businessId);
  const [flagged] = applySameBusinessDuplicates([parsed], customers);
  const result = await persistReviewedRow(db, access, preview, row, flagged);
  if (!result.wrote) {
    const current = currentReviewedRow(result.preview, row.id);
    if (current?.previewStatus === "REJECTED") {
      throw new CustomerCsvImportError(IMPORT_ROW_REJECTED_TERMINAL_MESSAGE);
    }
    throw new CustomerCsvImportError(IMPORT_ROW_NOT_EDITABLE_MESSAGE);
  }
  return result.preview;
}

export type RejectCustomerImportRowResult = {
  preview: CustomerCsvImportPreview;
  reused: boolean;
};

export async function rejectCustomerCsvImportRow(
  db: Db,
  access: CustomerCsvImportAccess,
  input: { importId: string; rowId: string },
): Promise<RejectCustomerImportRowResult> {
  requireOwner(access);
  const preview = await loadOwnedImport(db, access, input.importId);
  requireMutablePreview(preview);
  const row = findOwnedRow(access, preview, input.rowId);
  if (row.createdCustomerId) {
    throw new CustomerCsvImportError(IMPORT_ROW_NOT_REJECTABLE_MESSAGE);
  }
  if (row.previewStatus === "REJECTED") {
    return { preview, reused: true };
  }
  if (row.previewStatus !== "INVALID") {
    throw new CustomerCsvImportError(IMPORT_ROW_NOT_REJECTABLE_MESSAGE);
  }

  const parsed = storedRowToParsed({
    ...row,
    previewStatus: "REJECTED",
    invalidReason: ROW_REJECTED_BY_OWNER_MESSAGE,
  });
  const result = await persistReviewedRow(db, access, preview, row, parsed);
  if (!result.wrote) {
    const current = currentReviewedRow(result.preview, row.id);
    if (current?.previewStatus === "REJECTED") {
      return { preview: result.preview, reused: true };
    }
    throw new CustomerCsvImportError(IMPORT_ROW_NOT_REJECTABLE_MESSAGE);
  }
  return { preview: result.preview, reused: false };
}

async function applyConfirmedRow(
  db: Db,
  access: CustomerCsvImportAccess,
  row: StoredCustomerImportRow,
): Promise<{ customerId: string; propertyId: string | null; reusedExisting: boolean }> {
  if (row.createdCustomerId) {
    return {
      customerId: row.createdCustomerId,
      propertyId: row.createdPropertyId,
      reusedExisting: row.reusedExistingCustomer,
    };
  }

  return db.$transaction(async (tx) => {
    // READ COMMITTED: lock this staged row before inspecting createdCustomerId
    // so two confirms cannot both create a customer for the same row.
    const locked = await tx.$queryRaw<
      Array<{
        id: string;
        businessId: string;
        importId: string;
        createdCustomerId: string | null;
        createdPropertyId: string | null;
        reusedExistingCustomer: boolean;
        name: string;
        email: string | null;
        phone: string | null;
        propertyLabel: string | null;
        streetAddress: string | null;
        unit: string | null;
        city: string | null;
        region: string | null;
        postalCode: string | null;
      }>
    >`
      SELECT
        id,
        "businessId",
        "importId",
        "createdCustomerId",
        "createdPropertyId",
        "reusedExistingCustomer",
        name,
        email,
        phone,
        "propertyLabel",
        "streetAddress",
        unit,
        city,
        region,
        "postalCode"
      FROM "CustomerCsvImportRow"
      WHERE id = ${row.id}
        AND "businessId" = ${access.businessId}
      FOR UPDATE
    `;
    const current = locked[0];
    if (
      !current ||
      current.businessId !== access.businessId ||
      current.importId !== row.importId
    ) {
      throw new CustomerCsvImportError(IMPORT_NOT_AVAILABLE_MESSAGE);
    }
    if (current.createdCustomerId) {
      return {
        customerId: current.createdCustomerId,
        propertyId: current.createdPropertyId,
        reusedExisting: current.reusedExistingCustomer,
      };
    }

    const identities = await tx.customer.findMany({
      where: { businessId: access.businessId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
      },
    });
    const existing = findSameBusinessCustomer(
      { email: current.email ?? "", phone: current.phone ?? "" },
      identities,
    );

    let customerId: string;
    let reusedExisting = false;
    if (existing) {
      const owned = access.assertOwned(
        await tx.customer.findFirst({
          where: { id: existing.id, businessId: access.businessId },
          select: { id: true, businessId: true },
        }),
      );
      customerId = owned.id;
      reusedExisting = true;
    } else {
      const created = await tx.customer.create({
        data: {
          businessId: access.businessId,
          name: current.name,
          email: current.email || null,
          phone: current.phone || null,
        },
      });
      customerId = created.id;
    }

    const address = propertyAddressInput(current);
    let propertyId: string | null = null;
    if (hasStructuredAddressInput(address)) {
      const properties = await tx.property.findMany({
        where: { businessId: access.businessId, customerId },
        select: {
          id: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      });
      propertyId = matchingPropertyId(properties, address);
      if (!propertyId) {
        const createdProperty = await tx.property.create({
          data: {
            businessId: access.businessId,
            customerId,
            label: current.propertyLabel || null,
            addressLine1: address.streetAddress,
            addressLine2: address.unit || null,
            city: address.city || null,
            region: address.region || null,
            postalCode: address.postalCode || null,
          },
        });
        propertyId = createdProperty.id;
      }
    }

    await tx.customerCsvImportRow.update({
      where: { id: current.id },
      data: {
        createdCustomerId: customerId,
        createdPropertyId: propertyId,
        reusedExistingCustomer: reusedExisting,
      },
    });

    return { customerId, propertyId, reusedExisting };
  });
}

export type ConfirmCustomerImportResult = {
  preview: CustomerCsvImportPreview;
  createdCustomerIds: string[];
  reused: boolean;
};

export async function confirmCustomerCsvImport(
  db: Db,
  access: CustomerCsvImportAccess,
  input: { importId: string; includePossibleDuplicates?: boolean },
): Promise<ConfirmCustomerImportResult> {
  requireOwner(access);
  const preview = await loadOwnedImport(db, access, input.importId);
  if (preview.status === "CONFIRMED") {
    return {
      preview,
      createdCustomerIds: preview.rows
        .map((row) => row.createdCustomerId)
        .filter((id): id is string => Boolean(id)),
      reused: true,
    };
  }
  if (preview.status !== "PREVIEW" && preview.status !== "CONFIRMING") {
    throw new CustomerCsvImportError(IMPORT_CONFIRM_REQUIRED_MESSAGE);
  }
  if (preview.rows.some((row) => row.previewStatus === "INVALID")) {
    throw new CustomerCsvImportError(IMPORT_RESOLVE_INVALID_MESSAGE);
  }

  await db.customerCsvImport.updateMany({
    where: { id: preview.id, businessId: access.businessId, status: "PREVIEW" },
    data: { status: "CONFIRMING" },
  });

  const includeDuplicates = Boolean(input.includePossibleDuplicates);
  const createdCustomerIds: string[] = [];

  for (const row of preview.rows) {
    if (row.createdCustomerId) {
      createdCustomerIds.push(row.createdCustomerId);
      continue;
    }
    const eligible =
      row.previewStatus === "VALID" ||
      (includeDuplicates && row.previewStatus === "POSSIBLE_DUPLICATE");
    if (!eligible) continue;

    const result = await applyConfirmedRow(db, access, row);
    createdCustomerIds.push(result.customerId);
  }

  await db.customerCsvImport.update({
    where: { id: preview.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      confirmedByMembershipId: membershipId(access),
    },
  });

  const confirmed = await loadOwnedImport(db, access, preview.id);
  return { preview: confirmed, createdCustomerIds, reused: false };
}
