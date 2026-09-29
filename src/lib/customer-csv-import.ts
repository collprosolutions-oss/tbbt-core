/**
 * OWNER-reviewed existing-customer CSV import — parse, sanitize, bound,
 * and same-business duplicate flags. Preview never creates customers.
 *
 * Manual CSV upload only. This module does not fetch owner-supplied
 * URLs, scrape directories, buy lists, send outreach, grant SMS consent,
 * or overwrite existing customers.
 */
import { createHash } from "node:crypto";
import {
  isUsableEmail,
} from "@/lib/mail";
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
  MAX_CUSTOMER_CSV_IMPORT_BYTES,
  MAX_CUSTOMER_CSV_IMPORT_FIELD,
  MAX_CUSTOMER_CSV_IMPORT_LABEL,
  MAX_CUSTOMER_CSV_IMPORT_ROWS,
  MISSING_NAME_HEADER_MESSAGE,
  NOT_CSV_MESSAGE,
  TOO_MANY_ROWS_MESSAGE,
  type CustomerCsvImportRowStatus,
} from "@/lib/customer-csv-import-copy";
import {
  hasStructuredAddressInput,
  structuredAddressKey,
  validateStructuredAddress,
  type StructuredServiceAddress,
} from "@/lib/service-address";

export {
  CUSTOMER_CSV_IMPORT_ROUTE,
  CUSTOMER_CSV_IMPORT_ROW_STATUSES,
  CUSTOMER_CSV_IMPORT_SOURCE_KINDS,
  CUSTOMER_CSV_IMPORT_STATUSES,
  EMPTY_CSV_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  IMPORT_ALREADY_CONFIRMED_MESSAGE,
  IMPORT_CONFIRM_REQUIRED_MESSAGE,
  IMPORT_CSV_REQUIRED_MESSAGE,
  IMPORT_NO_CONSENT_MESSAGE,
  IMPORT_NO_OUTREACH_MESSAGE,
  IMPORT_NO_OVERWRITE_MESSAGE,
  IMPORT_NO_SCORE_MESSAGE,
  IMPORT_NO_SCRAPE_MESSAGE,
  IMPORT_NOT_AVAILABLE_MESSAGE,
  IMPORT_RESOLVE_INVALID_MESSAGE,
  IMPORT_ROW_NOT_EDITABLE_MESSAGE,
  IMPORT_ROW_NOT_REJECTABLE_MESSAGE,
  IMPORT_ROW_REJECTED_TERMINAL_MESSAGE,
  INVALID_CSV_MESSAGE,
  MAX_CUSTOMER_CSV_IMPORT_BYTES,
  MAX_CUSTOMER_CSV_IMPORT_FIELD,
  MAX_CUSTOMER_CSV_IMPORT_LABEL,
  MAX_CUSTOMER_CSV_IMPORT_ROWS,
  MISSING_NAME_HEADER_MESSAGE,
  NOT_CSV_MESSAGE,
  OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE,
  ROW_REJECTED_BY_OWNER_MESSAGE,
  TOO_MANY_ROWS_MESSAGE,
  previewStatusLabel,
  sourceKindLabel,
  type CustomerCsvImportRowStatus,
  type CustomerCsvImportSourceKind,
  type CustomerCsvImportStatus,
} from "@/lib/customer-csv-import-copy";

export const CANONICAL_CUSTOMER_IMPORT_COLUMNS = [
  "name",
  "email",
  "phone",
  "label",
  "street",
  "unit",
  "city",
  "region",
  "postal",
] as const;
export type CanonicalCustomerImportColumn =
  (typeof CANONICAL_CUSTOMER_IMPORT_COLUMNS)[number];

const HEADER_ALIASES: Record<string, CanonicalCustomerImportColumn> = {
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
  label: "label",
  property: "label",
  property_label: "label",
  property_name: "label",
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
};

const IGNORED_CONSENT_HEADERS = new Set([
  "sms_consent",
  "sms_consent_status",
  "consent",
  "opt_in",
  "sms_opt_in",
  "smsoptin",
  "marketing_consent",
]);

export class CustomerCsvImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerCsvImportError";
  }
}

export type ParsedCustomerImportRow = {
  rowNumber: number;
  name: string;
  email: string;
  phone: string;
  propertyLabel: string;
  streetAddress: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
  previewStatus: CustomerCsvImportRowStatus;
  invalidReason: string | null;
  rowFingerprint: string;
  possibleDuplicateCustomerId: string | null;
};

export type SameBusinessCustomerIdentity = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export function hashCsvBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function customerImportRowFingerprint(input: {
  name: string;
  email: string;
  phone: string;
  streetAddress: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.name.trim().toLowerCase(),
        normalizeEmail(input.email),
        normalizePhone(input.phone),
        structuredAddressKey(
          {
            streetAddress: input.streetAddress,
            unit: input.unit,
            city: input.city,
            region: input.region,
            postalCode: input.postalCode,
          },
          "US",
        ),
      ].join("|"),
    )
    .digest("hex");
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

export function isIgnoredConsentHeader(value: string): boolean {
  return IGNORED_CONSENT_HEADERS.has(normalizeImportHeader(value));
}

export function decodeCsvBytes(bytes: Uint8Array | Buffer): string {
  if (bytes.byteLength > MAX_CUSTOMER_CSV_IMPORT_BYTES) {
    throw new CustomerCsvImportError(FILE_TOO_LARGE_MESSAGE);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/^\s*</.test(text)) {
    throw new CustomerCsvImportError(NOT_CSV_MESSAGE);
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
    throw new CustomerCsvImportError(INVALID_CSV_MESSAGE);
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

function mapHeaders(headerRow: string[]): Array<CanonicalCustomerImportColumn | null> {
  return headerRow.map((cell) => HEADER_ALIASES[normalizeImportHeader(cell)] ?? null);
}

function readMappedRow(
  cells: string[],
  columns: Array<CanonicalCustomerImportColumn | null>,
): Partial<Record<CanonicalCustomerImportColumn, string>> {
  const mapped: Partial<Record<CanonicalCustomerImportColumn, string>> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const key = columns[i];
    if (!key || mapped[key]) continue;
    mapped[key] = cells[i] ?? "";
  }
  return mapped;
}

export function parseCustomerCsv(text: string): ParsedCustomerImportRow[] {
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new CustomerCsvImportError(EMPTY_CSV_MESSAGE);
  }
  const columns = mapHeaders(table[0]);
  if (!columns.includes("name")) {
    throw new CustomerCsvImportError(MISSING_NAME_HEADER_MESSAGE);
  }
  const dataRows = table.slice(1);
  if (dataRows.length === 0) {
    throw new CustomerCsvImportError(EMPTY_CSV_MESSAGE);
  }
  if (dataRows.length > MAX_CUSTOMER_CSV_IMPORT_ROWS) {
    throw new CustomerCsvImportError(TOO_MANY_ROWS_MESSAGE);
  }

  return dataRows.map((cells, index) =>
    evaluateCustomerImportRow(index + 2, readMappedRow(cells, columns)),
  );
}

export function evaluateCustomerImportRow(
  rowNumber: number,
  raw: Partial<Record<CanonicalCustomerImportColumn, string>>,
): ParsedCustomerImportRow {
  const name = sanitizeImportText(raw.name ?? "", MAX_CUSTOMER_CSV_IMPORT_FIELD);
  const email = sanitizeImportText(raw.email ?? "", MAX_CUSTOMER_CSV_IMPORT_FIELD).toLowerCase();
  const phone = sanitizeImportText(raw.phone ?? "", 40);
  const propertyLabel = sanitizeImportText(raw.label ?? "", MAX_CUSTOMER_CSV_IMPORT_LABEL);
  const streetAddress = sanitizeImportText(raw.street ?? "", MAX_CUSTOMER_CSV_IMPORT_FIELD);
  const unit = sanitizeImportText(raw.unit ?? "", 40);
  const city = sanitizeImportText(raw.city ?? "", 80);
  const region = sanitizeImportText(raw.region ?? "", 40);
  const postalCode = sanitizeImportText(raw.postal ?? "", 20);

  let invalidReason: string | null = null;
  if (!name) {
    invalidReason = "Customer name is required.";
  } else if (email && !isUsableEmail(email)) {
    invalidReason = "Enter a valid email address.";
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
    propertyLabel,
    streetAddress,
    unit,
    city,
    region,
    postalCode,
    previewStatus: invalidReason ? "INVALID" : "VALID",
    invalidReason,
    rowFingerprint: customerImportRowFingerprint({
      name,
      email,
      phone,
      streetAddress,
      unit,
      city,
      region,
      postalCode,
    }),
    possibleDuplicateCustomerId: null,
  };
}

export function storedRowToParsed(row: {
  rowNumber: number;
  name: string;
  email: string | null;
  phone: string | null;
  propertyLabel: string | null;
  streetAddress: string | null;
  unit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  previewStatus: string;
  invalidReason: string | null;
  rowFingerprint: string;
}): ParsedCustomerImportRow {
  const rejected = row.previewStatus === "REJECTED";
  const invalid = row.previewStatus === "INVALID";
  return {
    rowNumber: row.rowNumber,
    name: row.name,
    email: row.email ?? "",
    phone: row.phone ?? "",
    propertyLabel: row.propertyLabel ?? "",
    streetAddress: row.streetAddress ?? "",
    unit: row.unit ?? "",
    city: row.city ?? "",
    region: row.region ?? "",
    postalCode: row.postalCode ?? "",
    previewStatus: rejected ? "REJECTED" : invalid ? "INVALID" : "VALID",
    invalidReason: rejected || invalid ? row.invalidReason : null,
    rowFingerprint: row.rowFingerprint,
    possibleDuplicateCustomerId: null,
  };
}

export function findSameBusinessCustomer(
  row: Pick<ParsedCustomerImportRow, "email" | "phone">,
  customers: SameBusinessCustomerIdentity[],
): SameBusinessCustomerIdentity | null {
  const emailMatches = isUsableNormalizedEmail(normalizeEmail(row.email))
    ? customers.filter((customer) => normalizeEmail(customer.email) === normalizeEmail(row.email))
    : [];
  const phoneMatches = isUsableNormalizedPhone(normalizePhone(row.phone))
    ? customers.filter((customer) => normalizePhone(customer.phone) === normalizePhone(row.phone))
    : [];
  return emailMatches[0] ?? phoneMatches[0] ?? null;
}

export function applySameBusinessDuplicates(
  rows: ParsedCustomerImportRow[],
  customers: SameBusinessCustomerIdentity[],
): ParsedCustomerImportRow[] {
  return rows.map((row) => {
    if (row.previewStatus === "INVALID" || row.previewStatus === "REJECTED") return row;
    const match = findSameBusinessCustomer(row, customers);
    if (!match) return row;
    return {
      ...row,
      previewStatus: "POSSIBLE_DUPLICATE",
      possibleDuplicateCustomerId: match.id,
    };
  });
}

export function countPreviewStatuses(rows: Array<{ previewStatus: string }>) {
  return {
    rowCount: rows.length,
    validCount: rows.filter((row) => row.previewStatus === "VALID").length,
    invalidCount: rows.filter((row) => row.previewStatus === "INVALID").length,
    possibleDuplicateCount: rows.filter((row) => row.previewStatus === "POSSIBLE_DUPLICATE")
      .length,
    rejectedCount: rows.filter((row) => row.previewStatus === "REJECTED").length,
  };
}

export function propertyAddressInput(row: {
  streetAddress: string | null;
  unit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
}): StructuredServiceAddress {
  return {
    streetAddress: row.streetAddress ?? "",
    unit: row.unit ?? "",
    city: row.city ?? "",
    region: row.region ?? "",
    postalCode: row.postalCode ?? "",
  };
}

export function matchingPropertyId(
  properties: Array<{
    id: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
  }>,
  address: StructuredServiceAddress,
): string | null {
  const key = structuredAddressKey(address, "US");
  const match = properties.find(
    (property) =>
      structuredAddressKey(
        {
          streetAddress: property.addressLine1,
          unit: property.addressLine2 ?? "",
          city: property.city ?? "",
          region: property.region ?? "",
          postalCode: property.postalCode ?? "",
        },
        "US",
      ) === key,
  );
  return match?.id ?? null;
}
