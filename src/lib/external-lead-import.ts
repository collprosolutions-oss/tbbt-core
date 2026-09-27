/**
 * OWNER-reviewed external lead import — parse, sanitize, bound, and
 * same-business duplicate flags. Preview never creates leads.
 *
 * Owner-supplied CSV bytes or a direct CSV URL the owner controls.
 * This module does not scrape directories, buy lists, send outreach,
 * or invent lead scores.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  isUsableNormalizedEmail,
  isUsableNormalizedPhone,
  normalizeEmail,
  normalizePhone,
} from "@/lib/customer-identity";
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

export const EXTERNAL_LEAD_IMPORT_ROUTE = "/requests/import-leads";

export const MAX_EXTERNAL_LEAD_IMPORT_BYTES = 256 * 1024;
export const MAX_EXTERNAL_LEAD_IMPORT_ROWS = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_FIELD = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_SUMMARY = 200;
export const MAX_EXTERNAL_LEAD_IMPORT_URL = 2048;
export const EXTERNAL_LEAD_IMPORT_FETCH_TIMEOUT_MS = 8_000;

export const EXTERNAL_LEAD_IMPORT_SOURCE_KINDS = ["CSV_UPLOAD", "SOURCE_URL"] as const;
export type ExternalLeadImportSourceKind =
  (typeof EXTERNAL_LEAD_IMPORT_SOURCE_KINDS)[number];

export const EXTERNAL_LEAD_IMPORT_STATUSES = ["PREVIEW", "CONFIRMING", "CONFIRMED"] as const;
export type ExternalLeadImportStatus = (typeof EXTERNAL_LEAD_IMPORT_STATUSES)[number];

export const EXTERNAL_LEAD_IMPORT_ROW_STATUSES = [
  "VALID",
  "INVALID",
  "POSSIBLE_DUPLICATE",
] as const;
export type ExternalLeadImportRowStatus =
  (typeof EXTERNAL_LEAD_IMPORT_ROW_STATUSES)[number];

export const OWNER_ONLY_IMPORT_MESSAGE =
  "Only the business owner can import external leads.";

export const IMPORT_NOT_AVAILABLE_MESSAGE = "That import is not available.";

export const IMPORT_CONFIRM_REQUIRED_MESSAGE =
  "Leads are created only after the owner confirms this preview.";

export const IMPORT_NO_SCRAPE_MESSAGE =
  "TBBT does not scrape directories, crawl websites, or buy lead lists. Supply a CSV you already have, or a direct CSV URL you control.";

export const IMPORT_NO_SCORE_MESSAGE =
  "TBBT does not invent a lead score. Possible duplicates are same-business email or phone matches only.";

export const IMPORT_NO_OUTREACH_MESSAGE =
  "Import does not send email, SMS, or any other outreach.";

export const FILE_TOO_LARGE_MESSAGE = `CSV must be ${MAX_EXTERNAL_LEAD_IMPORT_BYTES / 1024} KB or smaller.`;
export const TOO_MANY_ROWS_MESSAGE = `CSV may include at most ${MAX_EXTERNAL_LEAD_IMPORT_ROWS} data rows.`;
export const MISSING_NAME_HEADER_MESSAGE =
  "CSV must include a name column (name, customer, or customer_name).";
export const EMPTY_CSV_MESSAGE = "CSV has no data rows.";
export const INVALID_CSV_MESSAGE = "That CSV could not be read.";
export const BLOCKED_SOURCE_URL_MESSAGE =
  "That source URL is not allowed. Use a public http(s) URL that points at a CSV you control.";
export const SOURCE_URL_NOT_CSV_MESSAGE =
  "The source URL must return a CSV. HTML pages and directory listings are rejected.";
export const SOURCE_URL_FETCH_MESSAGE =
  "That source URL could not be read as a CSV.";

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

const BLOCKED_SOURCE_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "metadata.google.com",
  "169.254.169.254",
]);

const ALLOWED_CSV_CONTENT_TYPES = [
  "text/csv",
  "text/plain",
  "application/csv",
  "application/vnd.ms-excel",
];

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

export function sanitizeImportText(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeImportMultiline(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^>]*>/g, "")
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
    throw new ExternalLeadImportError(SOURCE_URL_NOT_CSV_MESSAGE);
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

export function isPrivateIpv4(host: string): boolean {
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function isBlockedSourceHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_SOURCE_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("[") || host.includes(":")) {
    return host === "::1" || host === "[::1]";
  }
  return isPrivateIpv4(host);
}

export function validateOwnerSourceUrl(
  raw: string,
): { ok: true; href: string } | { ok: false; error: string } {
  const trimmed = sanitizeImportText(raw, MAX_EXTERNAL_LEAD_IMPORT_URL);
  if (!trimmed || trimmed.length > MAX_EXTERNAL_LEAD_IMPORT_URL) {
    return { ok: false, error: BLOCKED_SOURCE_URL_MESSAGE };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: BLOCKED_SOURCE_URL_MESSAGE };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: BLOCKED_SOURCE_URL_MESSAGE };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: BLOCKED_SOURCE_URL_MESSAGE };
  }
  if (isBlockedSourceHost(parsed.hostname)) {
    return { ok: false, error: BLOCKED_SOURCE_URL_MESSAGE };
  }
  return { ok: true, href: parsed.href };
}

export type SourceLookup = (hostname: string) => Promise<string[]>;

export async function defaultSourceLookup(hostname: string): Promise<string[]> {
  const result = await dnsLookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => entry.address);
}

function looksLikeCsvContentType(value: string | null): boolean {
  if (!value) return true;
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_CSV_CONTENT_TYPES.includes(type)) return true;
  return type.endsWith("+csv");
}

export async function fetchOwnerSuppliedCsv(
  rawUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    lookup?: SourceLookup;
  } = {},
): Promise<{ bytes: Buffer; sourceLabel: string }> {
  const validated = validateOwnerSourceUrl(rawUrl);
  if (!validated.ok) {
    throw new ExternalLeadImportError(validated.error);
  }
  const parsed = new URL(validated.href);
  const lookup = options.lookup ?? defaultSourceLookup;
  const addresses = await lookup(parsed.hostname);
  if (addresses.length === 0 || addresses.some((address) => isBlockedSourceHost(address))) {
    throw new ExternalLeadImportError(BLOCKED_SOURCE_URL_MESSAGE);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(validated.href, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "text/csv, text/plain;q=0.9" },
      signal: AbortSignal.timeout(EXTERNAL_LEAD_IMPORT_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof ExternalLeadImportError) throw error;
    throw new ExternalLeadImportError(SOURCE_URL_FETCH_MESSAGE);
  }

  if (!response.ok) {
    throw new ExternalLeadImportError(SOURCE_URL_FETCH_MESSAGE);
  }
  if (!looksLikeCsvContentType(response.headers.get("content-type"))) {
    throw new ExternalLeadImportError(SOURCE_URL_NOT_CSV_MESSAGE);
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_EXTERNAL_LEAD_IMPORT_BYTES) {
    throw new ExternalLeadImportError(FILE_TOO_LARGE_MESSAGE);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_EXTERNAL_LEAD_IMPORT_BYTES) {
    throw new ExternalLeadImportError(FILE_TOO_LARGE_MESSAGE);
  }
  decodeCsvBytes(buffer);
  return { bytes: buffer, sourceLabel: validated.href };
}

export function sourceKindLabel(kind: string): string {
  if (kind === "SOURCE_URL") return "Owner-supplied source URL";
  return "Manual CSV";
}

export function previewStatusLabel(status: string): string {
  if (status === "INVALID") return "Invalid";
  if (status === "POSSIBLE_DUPLICATE") return "Possible same-business duplicate";
  return "Ready";
}
