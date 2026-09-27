/**
 * OWNER-reviewed external lead import — parse, sanitize, bound, and
 * same-business duplicate flags. Preview never creates leads.
 *
 * Manual CSV upload only. This module does not fetch owner-supplied
 * URLs, scrape directories, buy lists, send outreach, or invent lead scores.
 */
import { createHash } from "node:crypto";
import {
  isUsableNormalizedEmail,
  isUsableNormalizedPhone,
  normalizeEmail,
  normalizePhone,
} from "@/lib/customer-identity";
import {
  EMPTY_CSV_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  INVALID_CSV_MESSAGE,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  MAX_EXTERNAL_LEAD_IMPORT_FIELD,
  MAX_EXTERNAL_LEAD_IMPORT_ROWS,
  MAX_EXTERNAL_LEAD_IMPORT_SUMMARY,
  MISSING_NAME_HEADER_MESSAGE,
  NOT_CSV_MESSAGE,
  TOO_MANY_ROWS_MESSAGE,
  type ExternalLeadImportRowStatus,
} from "@/lib/external-lead-import-copy";
import {
  OWNER_DEFAULT_LEAD_SOURCE,
  parseLeadSource,
  type LeadSource,
} from "@/lib/lead-attribution";
import { MAX_NOTES_LENGTH } from "@/lib/service-request-work";
import {
  hasStructuredAddressInput,
  validateStructuredAddress,
  type StructuredServiceAddress,
} from "@/lib/service-address";

export {
  EMPTY_CSV_MESSAGE,
  EXTERNAL_LEAD_IMPORT_ROUTE,
  EXTERNAL_LEAD_IMPORT_ROW_STATUSES,
  EXTERNAL_LEAD_IMPORT_SOURCE_KINDS,
  EXTERNAL_LEAD_IMPORT_STATUSES,
  FILE_TOO_LARGE_MESSAGE,
  IMPORT_CONFIRM_REQUIRED_MESSAGE,
  IMPORT_CSV_REQUIRED_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  INVALID_CSV_MESSAGE,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  MAX_EXTERNAL_LEAD_IMPORT_FIELD,
  MAX_EXTERNAL_LEAD_IMPORT_ROWS,
  MAX_EXTERNAL_LEAD_IMPORT_SUMMARY,
  MISSING_NAME_HEADER_MESSAGE,
  NOT_CSV_MESSAGE,
  OWNER_ONLY_IMPORT_MESSAGE,
  TOO_MANY_ROWS_MESSAGE,
  previewStatusLabel,
  sourceKindLabel,
  type ExternalLeadImportRowStatus,
  type ExternalLeadImportSourceKind,
  type ExternalLeadImportStatus,
} from "@/lib/external-lead-import-copy";

export const CANONICAL_IMPORT_COLUMNS = [
  "name",
  "email",
  "phone",
  "summary",
  "notes",
  "street",
  "unit",
  "city",
  "region",
  "postal",
  "source",
] as const;
export type CanonicalImportColumn = (typeof CANONICAL_IMPORT_COLUMNS)[number];

const HEADER_ALIASES: Record<string, CanonicalImportColumn> = {
  name: "name",
  customer: "name",
  customer_name: "name",
  full_name: "name",
  email: "email",
  e_mail: "email",
  email_address: "email",
  phone: "phone",
  telephone: "phone",
  mobile: "phone",
  phone_number: "phone",
  summary: "summary",
  scope: "summary",
  job: "summary",
  work: "summary",
  notes: "notes",
  description: "notes",
  comments: "notes",
  street: "street",
  street_address: "street",
  address: "street",
  address1: "street",
  address_line1: "street",
  unit: "unit",
  suite: "unit",
  apt: "unit",
  address2: "unit",
  address_line2: "unit",
  city: "city",
  region: "region",
  state: "region",
  postal: "postal",
  postal_code: "postal",
  zip: "postal",
  zip_code: "postal",
  source: "source",
  lead_source: "source",
};

export class ExternalLeadImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalLeadImportError";
  }
}

export type ParsedImportRow = {
  rowNumber: number;
  name: string;
  email: string;
  phone: string;
  summary: string;
  notes: string;
  streetAddress: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
  leadSource: LeadSource;
  previewStatus: ExternalLeadImportRowStatus;
  invalidReason: string | null;
  rowFingerprint: string;
  possibleDuplicateCustomerId: string | null;
  possibleDuplicateRequestId: string | null;
};

export type SameBusinessIdentity = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type SameBusinessRequest = {
  id: string;
  customerId: string | null;
  customer: { email: string | null; phone: string | null } | null;
};

export function hashCsvBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function importRowFingerprint(input: {
  name: string;
  email: string;
  phone: string;
  summary: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.name.trim().toLowerCase(),
        normalizeEmail(input.email),
        normalizePhone(input.phone),
        input.summary.trim().toLowerCase(),
      ].join("|"),
    )
    .digest("hex");
}

export function importRowSubmissionId(importId: string, fingerprint: string): string {
  const raw = `eli${importId}${fingerprint}`.replace(/[^A-Za-z0-9]/g, "");
  return raw.slice(0, 80);
}

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "");
}

export function sanitizeImportText(value: string, max: number): string {
  return stripMarkup(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeImportMultiline(value: string, max: number): string {
  return stripMarkup(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

export function sanitizeSourceFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "upload.csv";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "upload.csv";
}

export function normalizeImportHeader(value: string): string {
  return sanitizeImportText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function decodeCsvBytes(bytes: Uint8Array | Buffer): string {
  if (bytes.byteLength > MAX_EXTERNAL_LEAD_IMPORT_BYTES) {
    throw new ExternalLeadImportError(FILE_TOO_LARGE_MESSAGE);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/^\s*</.test(text)) {
    throw new ExternalLeadImportError(NOT_CSV_MESSAGE);
  }
  return text;
}

export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }

  if (inQuotes) {
    throw new ExternalLeadImportError(INVALID_CSV_MESSAGE);
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

function mapHeaders(headerRow: string[]): Array<CanonicalImportColumn | null> {
  return headerRow.map((cell) => HEADER_ALIASES[normalizeImportHeader(cell)] ?? null);
}

function readMappedRow(
  cells: string[],
  columns: Array<CanonicalImportColumn | null>,
): Partial<Record<CanonicalImportColumn, string>> {
  const mapped: Partial<Record<CanonicalImportColumn, string>> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const key = columns[i];
    if (!key || mapped[key]) continue;
    mapped[key] = cells[i] ?? "";
  }
  return mapped;
}

export function parseExternalLeadCsv(text: string): ParsedImportRow[] {
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new ExternalLeadImportError(EMPTY_CSV_MESSAGE);
  }
  const columns = mapHeaders(table[0]);
  if (!columns.includes("name")) {
    throw new ExternalLeadImportError(MISSING_NAME_HEADER_MESSAGE);
  }
  const dataRows = table.slice(1);
  if (dataRows.length === 0) {
    throw new ExternalLeadImportError(EMPTY_CSV_MESSAGE);
  }
  if (dataRows.length > MAX_EXTERNAL_LEAD_IMPORT_ROWS) {
    throw new ExternalLeadImportError(TOO_MANY_ROWS_MESSAGE);
  }

  return dataRows.map((cells, index) => evaluateImportRow(index + 2, readMappedRow(cells, columns)));
}

export function evaluateImportRow(
  rowNumber: number,
  raw: Partial<Record<CanonicalImportColumn, string>>,
): ParsedImportRow {
  const name = sanitizeImportText(raw.name ?? "", MAX_EXTERNAL_LEAD_IMPORT_FIELD);
  const email = sanitizeImportText(raw.email ?? "", MAX_EXTERNAL_LEAD_IMPORT_FIELD);
  const phone = sanitizeImportText(raw.phone ?? "", 40);
  const notes = sanitizeImportMultiline(raw.notes ?? "", MAX_NOTES_LENGTH);
  const summary = sanitizeImportText(
    raw.summary ?? "",
    MAX_EXTERNAL_LEAD_IMPORT_SUMMARY,
  ) || sanitizeImportText(notes, MAX_EXTERNAL_LEAD_IMPORT_SUMMARY);
  const streetAddress = sanitizeImportText(raw.street ?? "", MAX_EXTERNAL_LEAD_IMPORT_FIELD);
  const unit = sanitizeImportText(raw.unit ?? "", 40);
  const city = sanitizeImportText(raw.city ?? "", 80);
  const region = sanitizeImportText(raw.region ?? "", 40);
  const postalCode = sanitizeImportText(raw.postal ?? "", 20);
  const leadSource =
    parseLeadSource(raw.source, OWNER_DEFAULT_LEAD_SOURCE) ?? OWNER_DEFAULT_LEAD_SOURCE;

  let invalidReason: string | null = null;
  if (!name) {
    invalidReason = "Customer name is required.";
  } else if (email && !email.includes("@")) {
    invalidReason = "Enter a valid email address.";
  } else if (!summary) {
    invalidReason = "Enter a short scope or summary.";
  } else if (notes.length > MAX_NOTES_LENGTH) {
    invalidReason = "Please shorten the notes.";
  } else {
    const addressInput: StructuredServiceAddress = {
      streetAddress,
      unit,
      city,
      region,
      postalCode,
    };
    if (hasStructuredAddressInput(addressInput)) {
      const validated = validateStructuredAddress(addressInput, { country: "US" });
      if (!validated.ok) {
        invalidReason = validated.error;
      }
    }
  }

  return {
    rowNumber,
    name,
    email,
    phone,
    summary,
    notes,
    streetAddress,
    unit,
    city,
    region,
    postalCode,
    leadSource,
    previewStatus: invalidReason ? "INVALID" : "VALID",
    invalidReason,
    rowFingerprint: importRowFingerprint({ name, email, phone, summary }),
    possibleDuplicateCustomerId: null,
    possibleDuplicateRequestId: null,
  };
}

export function applySameBusinessDuplicates(
  rows: ParsedImportRow[],
  customers: SameBusinessIdentity[],
  requests: SameBusinessRequest[],
): ParsedImportRow[] {
  return rows.map((row) => {
    if (row.previewStatus === "INVALID") return row;
    const match = findSameBusinessDuplicate(row, customers, requests);
    if (!match.customerId && !match.requestId) return row;
    return {
      ...row,
      previewStatus: "POSSIBLE_DUPLICATE",
      possibleDuplicateCustomerId: match.customerId,
      possibleDuplicateRequestId: match.requestId,
    };
  });
}

export function findSameBusinessDuplicate(
  row: Pick<ParsedImportRow, "email" | "phone">,
  customers: SameBusinessIdentity[],
  requests: SameBusinessRequest[],
): { customerId: string | null; requestId: string | null } {
  const emailMatches = isUsableNormalizedEmail(normalizeEmail(row.email))
    ? customers.filter((customer) => normalizeEmail(customer.email) === normalizeEmail(row.email))
    : [];
  const phoneMatches = isUsableNormalizedPhone(normalizePhone(row.phone))
    ? customers.filter((customer) => normalizePhone(customer.phone) === normalizePhone(row.phone))
    : [];
  const customer = emailMatches[0] ?? phoneMatches[0] ?? null;
  if (!customer) {
    const request = requests.find((candidate) => {
      const email =
        isUsableNormalizedEmail(normalizeEmail(row.email)) &&
        normalizeEmail(candidate.customer?.email) === normalizeEmail(row.email);
      const phone =
        isUsableNormalizedPhone(normalizePhone(row.phone)) &&
        normalizePhone(candidate.customer?.phone) === normalizePhone(row.phone);
      return email || phone;
    });
    return { customerId: request?.customerId ?? null, requestId: request?.id ?? null };
  }
  const request = requests.find((candidate) => candidate.customerId === customer.id) ?? null;
  return { customerId: customer.id, requestId: request?.id ?? null };
}

export function countPreviewStatuses(rows: ParsedImportRow[]) {
  return {
    rowCount: rows.length,
    validCount: rows.filter((row) => row.previewStatus === "VALID").length,
    invalidCount: rows.filter((row) => row.previewStatus === "INVALID").length,
    possibleDuplicateCount: rows.filter((row) => row.previewStatus === "POSSIBLE_DUPLICATE")
      .length,
  };
}
