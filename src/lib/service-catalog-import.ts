/**
 * OWNER-reviewed service catalog CSV — parse, sanitize, bound, and
 * same-business duplicate-name matches. Preview never writes catalog rows.
 *
 * Manual CSV upload only. This module does not fetch owner-supplied URLs,
 * publish hourly rates, or rewrite historical estimate lines.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { isHourlyUnitLabel } from "@/lib/estimate-calculators/unit-registry";
import { parsePricingMode, type PricingMode } from "@/lib/pricing-mode";
import {
  CATALOG_IMPORT_EMPTY_MESSAGE,
  CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
  CATALOG_IMPORT_INVALID_MESSAGE,
  CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  CATALOG_IMPORT_NOT_CSV_MESSAGE,
  CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE,
  CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE,
  CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE,
  SERVICE_CATALOG_IMPORT_MATCH_DECISIONS,
  catalogImportOverLengthMessage,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  MAX_SERVICE_CATALOG_IMPORT_CATEGORY,
  MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION,
  MAX_SERVICE_CATALOG_IMPORT_NAME,
  MAX_SERVICE_CATALOG_IMPORT_ROWS,
  MAX_SERVICE_CATALOG_IMPORT_UNIT,
  type ServiceCatalogImportMatchDecision,
  type ServiceCatalogImportRowStatus,
} from "@/lib/service-catalog-import-copy";
import { getTradeConfig, pricingModeAllowedForTrade } from "@/lib/trade-config";
import { isConfiguredTrade, type TradeCode } from "@/lib/trades";

export {
  CATALOG_IMPORT_ALREADY_CONFIRMED_MESSAGE,
  CATALOG_IMPORT_CONFIRM_REQUIRED_MESSAGE,
  CATALOG_IMPORT_CSV_REQUIRED_MESSAGE,
  CATALOG_IMPORT_EMPTY_MESSAGE,
  CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
  CATALOG_IMPORT_INVALID_MESSAGE,
  CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE,
  CATALOG_IMPORT_IN_PROGRESS_MESSAGE,
  CATALOG_IMPORT_NAME_MATCH_MESSAGE,
  CATALOG_IMPORT_NO_HISTORY_REWRITE_MESSAGE,
  CATALOG_IMPORT_NO_HOURLY_MESSAGE,
  CATALOG_IMPORT_NOT_AVAILABLE_MESSAGE,
  CATALOG_IMPORT_NOT_CSV_MESSAGE,
  CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE,
  CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE,
  CATALOG_IMPORT_RESOLVE_INVALID_MESSAGE,
  CATALOG_IMPORT_SLUG_CONFLICT_MESSAGE,
  CATALOG_IMPORT_STALE_MATCHES_MESSAGE,
  CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE,
  SERVICE_CATALOG_IMPORT_MATCH_DECISIONS,
  catalogImportMatchDecisionLabel,
  catalogImportOverLengthMessage,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  MAX_SERVICE_CATALOG_IMPORT_CATEGORY,
  MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION,
  MAX_SERVICE_CATALOG_IMPORT_NAME,
  MAX_SERVICE_CATALOG_IMPORT_ROWS,
  MAX_SERVICE_CATALOG_IMPORT_UNIT,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  SERVICE_CATALOG_IMPORT_ROUTE,
  SERVICE_CATALOG_IMPORT_ROW_STATUSES,
  SERVICE_CATALOG_IMPORT_SOURCE_KINDS,
  SERVICE_CATALOG_IMPORT_STATUSES,
  SERVICE_CATALOG_IMPORT_WRITE_ACTIONS,
  catalogImportPreviewStatusLabel,
  catalogImportSourceKindLabel,
  type ServiceCatalogImportMatchDecision,
  type ServiceCatalogImportRowStatus,
  type ServiceCatalogImportSourceKind,
  type ServiceCatalogImportStatus,
  type ServiceCatalogImportWriteAction,
} from "@/lib/service-catalog-import-copy";

export const CANONICAL_CATALOG_IMPORT_COLUMNS = [
  "name",
  "description",
  "pricingMode",
  "price",
  "category",
  "tradeCode",
  "unitLabel",
  "recurrenceEligible",
  "active",
] as const;
export type CanonicalCatalogImportColumn =
  (typeof CANONICAL_CATALOG_IMPORT_COLUMNS)[number];

const HEADER_ALIASES: Record<string, CanonicalCatalogImportColumn> = {
  name: "name",
  service: "name",
  service_name: "name",
  catalog_name: "name",
  description: "description",
  scope: "description",
  included_work: "description",
  pricingmode: "pricingMode",
  pricing_mode: "pricingMode",
  mode: "pricingMode",
  pricing: "pricingMode",
  price: "price",
  starting_price: "price",
  amount: "price",
  category: "category",
  group: "category",
  tradecode: "tradeCode",
  trade_code: "tradeCode",
  trade: "tradeCode",
  unitlabel: "unitLabel",
  unit_label: "unitLabel",
  unit: "unitLabel",
  recurrenceeligible: "recurrenceEligible",
  recurrence_eligible: "recurrenceEligible",
  recurring: "recurrenceEligible",
  recurrence: "recurrenceEligible",
  active: "active",
  enabled: "active",
  is_active: "active",
};

const HOURLY_PRICING_PATTERN = /\b(hour|hours|hourly|per[_\s-]?hour|\/hr|\/hour)\b/i;

export class ServiceCatalogImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceCatalogImportError";
  }
}

export type ParsedCatalogImportRow = {
  rowNumber: number;
  name: string;
  description: string | null;
  pricingMode: string;
  price: Prisma.Decimal | null;
  category: string | null;
  tradeCode: string;
  unitLabel: string | null;
  recurrenceEligible: boolean | null;
  active: boolean | null;
  previewStatus: ServiceCatalogImportRowStatus;
  invalidReason: string | null;
  rowFingerprint: string;
  matchedCatalogItemId: string | null;
  matchDecision: ServiceCatalogImportMatchDecision;
};

export type SameBusinessCatalogItem = {
  id: string;
  businessId: string;
  name: string;
  tradeCode: string;
  createdAt?: Date;
};

export function catalogNameKey(name: string, tradeCode: string) {
  return `${name.trim().toLowerCase()}|${tradeCode.trim().toUpperCase()}`;
}

export function hashCatalogCsvBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function catalogImportRowFingerprint(input: {
  name: string;
  tradeCode: string;
  pricingMode: string;
  price: Prisma.Decimal | null;
  category: string | null;
  description: string | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.name.trim().toLowerCase(),
        input.tradeCode.trim().toUpperCase(),
        input.pricingMode,
        input.price?.toString() ?? "",
        (input.category ?? "").trim().toLowerCase(),
        (input.description ?? "").trim().toLowerCase(),
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

export function sanitizeCatalogImportText(value: string): string {
  return stripMarkup(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeCatalogImportMultiline(value: string): string {
  return stripMarkup(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

export function catalogImportFieldOverLength(value: string, max: number) {
  return value.length > max;
}

export function sanitizeCatalogSourceFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "upload.csv";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned || "upload.csv";
}

export function normalizeCatalogImportHeader(value: string): string {
  return sanitizeCatalogImportText(value)
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function decodeCatalogCsvBytes(bytes: Uint8Array | Buffer): string {
  if (bytes.byteLength > MAX_SERVICE_CATALOG_IMPORT_BYTES) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/^\s*</.test(text)) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_NOT_CSV_MESSAGE);
  }
  return text;
}

export function parseCatalogCsv(text: string): string[][] {
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
    throw new ServiceCatalogImportError(CATALOG_IMPORT_INVALID_MESSAGE);
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

function mapHeaders(headerRow: string[]): Array<CanonicalCatalogImportColumn | null> {
  return headerRow.map((cell) => HEADER_ALIASES[normalizeCatalogImportHeader(cell)] ?? null);
}

function readMappedRow(
  cells: string[],
  columns: Array<CanonicalCatalogImportColumn | null>,
): Partial<Record<CanonicalCatalogImportColumn, string>> {
  const mapped: Partial<Record<CanonicalCatalogImportColumn, string>> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const key = columns[i];
    if (!key || mapped[key]) continue;
    mapped[key] = cells[i] ?? "";
  }
  return mapped;
}

export function parseCatalogPricingMode(raw: string): {
  mode: PricingMode | null;
  hourly: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { mode: null, hourly: false };
  }
  if (HOURLY_PRICING_PATTERN.test(trimmed) || isHourlyUnitLabel(trimmed)) {
    return { mode: null, hourly: true };
  }
  const compact = trimmed.toUpperCase().replace(/[\s-/]+/g, "_");
  if (compact === "FIXED") return { mode: "FIXED", hourly: false };
  if (
    compact === "STARTING_AT" ||
    compact === "STARTING" ||
    compact === "FROM"
  ) {
    return { mode: "STARTING_AT", hourly: false };
  }
  if (
    compact === "VARIABLE" ||
    compact === "UNIT" ||
    compact === "PRODUCTION" ||
    compact === "UNIT_PRODUCTION"
  ) {
    return { mode: "VARIABLE", hourly: false };
  }
  if (
    compact === "CUSTOM_QUOTE" ||
    compact === "CUSTOM" ||
    compact === "QUOTE"
  ) {
    return { mode: "CUSTOM_QUOTE", hourly: false };
  }
  return { mode: parsePricingMode(compact), hourly: false };
}

export function parseCatalogImportBoolean(
  raw: string,
): { ok: true; value: boolean | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  const key = trimmed.toLowerCase();
  if (key === "yes" || key === "true" || key === "1" || key === "on") {
    return { ok: true, value: true };
  }
  if (key === "no" || key === "false" || key === "0" || key === "off") {
    return { ok: true, value: false };
  }
  return { ok: false };
}

export function parseCatalogImportMatchDecision(
  value: string,
): ServiceCatalogImportMatchDecision | null {
  const decision = value.trim().toUpperCase();
  return SERVICE_CATALOG_IMPORT_MATCH_DECISIONS.includes(
    decision as ServiceCatalogImportMatchDecision,
  )
    ? (decision as ServiceCatalogImportMatchDecision)
    : null;
}

export function parseCatalogImportPrice(
  mode: string,
  raw: string,
): { ok: true; price: Prisma.Decimal | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (mode === "CUSTOM_QUOTE" && !trimmed) {
    return { ok: true, price: null };
  }
  if (!trimmed) {
    return { ok: false, error: CATALOG_IMPORT_PRICE_REQUIRED_MESSAGE };
  }
  try {
    const price = new Prisma.Decimal(trimmed);
    if (price.isNaN() || price.lte(0)) {
      return { ok: false, error: "Enter a valid price for this pricing mode." };
    }
    return { ok: true, price };
  } catch {
    return { ok: false, error: "Enter a valid price for this pricing mode." };
  }
}

function normalizeRequestedTrade(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (compact === "PRESSUREWASHING") return "PRESSURE_WASHING";
  return compact;
}

export function evaluateCatalogImportRow(
  rowNumber: number,
  raw: Partial<Record<CanonicalCatalogImportColumn, string>>,
): ParsedCatalogImportRow {
  const name = sanitizeCatalogImportText(raw.name ?? "");
  const description = sanitizeCatalogImportMultiline(raw.description ?? "") || null;
  const category = sanitizeCatalogImportText(raw.category ?? "") || null;
  const unitLabel = sanitizeCatalogImportText(raw.unitLabel ?? "") || null;
  const requestedTrade = normalizeRequestedTrade(
    sanitizeCatalogImportText(raw.tradeCode ?? ""),
  );
  const parsedMode = parseCatalogPricingMode(raw.pricingMode ?? "");
  const recurrence = parseCatalogImportBoolean(raw.recurrenceEligible ?? "");
  const active = parseCatalogImportBoolean(raw.active ?? "");
  const priced = parseCatalogImportPrice(parsedMode.mode ?? "", raw.price ?? "");

  let invalidReason: string | null = null;
  if (catalogImportFieldOverLength(name, MAX_SERVICE_CATALOG_IMPORT_NAME)) {
    invalidReason = catalogImportOverLengthMessage("Name", MAX_SERVICE_CATALOG_IMPORT_NAME);
  } else if (
    description &&
    catalogImportFieldOverLength(description, MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION)
  ) {
    invalidReason = catalogImportOverLengthMessage(
      "Description",
      MAX_SERVICE_CATALOG_IMPORT_DESCRIPTION,
    );
  } else if (
    category &&
    catalogImportFieldOverLength(category, MAX_SERVICE_CATALOG_IMPORT_CATEGORY)
  ) {
    invalidReason = catalogImportOverLengthMessage(
      "Category",
      MAX_SERVICE_CATALOG_IMPORT_CATEGORY,
    );
  } else if (
    unitLabel &&
    catalogImportFieldOverLength(unitLabel, MAX_SERVICE_CATALOG_IMPORT_UNIT)
  ) {
    invalidReason = catalogImportOverLengthMessage(
      "Unit label",
      MAX_SERVICE_CATALOG_IMPORT_UNIT,
    );
  } else if (!name) {
    invalidReason = "Service name is required.";
  } else if (parsedMode.hourly) {
    invalidReason = CATALOG_IMPORT_NO_HOURLY_MESSAGE;
  } else if (!parsedMode.mode) {
    invalidReason = CATALOG_IMPORT_PRICING_MODE_REQUIRED_MESSAGE;
  } else if (unitLabel && isHourlyUnitLabel(unitLabel)) {
    invalidReason = CATALOG_IMPORT_NO_HOURLY_MESSAGE;
  } else if (!priced.ok) {
    invalidReason = priced.error;
  } else if (!recurrence.ok) {
    invalidReason = "Recurrence must be yes or no.";
  } else if (!active.ok) {
    invalidReason = "Active must be yes or no.";
  } else if (requestedTrade && !isConfiguredTrade(requestedTrade)) {
    invalidReason = "That trade is not configured.";
  }

  const pricingMode = parsedMode.mode ?? "";
  const price = priced.ok ? priced.price : null;
  const tradeCode = requestedTrade;

  return {
    rowNumber,
    name,
    description,
    pricingMode,
    price,
    category,
    tradeCode,
    unitLabel,
    recurrenceEligible: recurrence.ok ? recurrence.value : null,
    active: active.ok ? active.value : null,
    previewStatus: invalidReason ? "INVALID" : "VALID",
    invalidReason,
    rowFingerprint: catalogImportRowFingerprint({
      name,
      tradeCode,
      pricingMode,
      price,
      category,
      description,
    }),
    matchedCatalogItemId: null,
    matchDecision: "SKIP",
  };
}

export function parseServiceCatalogCsv(text: string): ParsedCatalogImportRow[] {
  const table = parseCatalogCsv(text);
  if (table.length === 0) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_EMPTY_MESSAGE);
  }
  const columns = mapHeaders(table[0]);
  if (!columns.includes("name")) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_MISSING_NAME_HEADER_MESSAGE);
  }
  const dataRows = table.slice(1);
  if (dataRows.length === 0) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_EMPTY_MESSAGE);
  }
  if (dataRows.length > MAX_SERVICE_CATALOG_IMPORT_ROWS) {
    throw new ServiceCatalogImportError(CATALOG_IMPORT_TOO_MANY_ROWS_MESSAGE);
  }
  return dataRows.map((cells, index) =>
    evaluateCatalogImportRow(index + 2, readMappedRow(cells, columns)),
  );
}

export function pickDeterministicCatalogMatch(
  items: SameBusinessCatalogItem[],
): SameBusinessCatalogItem | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((left, right) => {
    const leftTime = left.createdAt?.getTime() ?? 0;
    const rightTime = right.createdAt?.getTime() ?? 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });
  return sorted[0] ?? null;
}

export function applyCatalogImportContext(
  rows: ParsedCatalogImportRow[],
  input: {
    businessId: string;
    primaryTrade: TradeCode;
    activeTradeCodes: TradeCode[];
    existingItems: SameBusinessCatalogItem[];
  },
): ParsedCatalogImportRow[] {
  const existingByKey = new Map<string, SameBusinessCatalogItem[]>();
  for (const item of input.existingItems) {
    if (item.businessId !== input.businessId) continue;
    const key = catalogNameKey(item.name, item.tradeCode || "HANDYMAN");
    const current = existingByKey.get(key) ?? [];
    current.push(item);
    existingByKey.set(key, current);
  }

  const seenInFile = new Map<string, number>();
  return rows.map((row) => {
    if (row.previewStatus === "INVALID") {
      return { ...row, matchedCatalogItemId: null };
    }

    const tradeCode = (row.tradeCode || input.primaryTrade) as TradeCode;
    let invalidReason: string | null = null;
    if (!isConfiguredTrade(tradeCode) || !input.activeTradeCodes.includes(tradeCode)) {
      invalidReason = "That trade is not active on this business.";
    } else if (!pricingModeAllowedForTrade(tradeCode, row.pricingMode)) {
      invalidReason = "That pricing mode is not allowed for this trade.";
    } else if (row.recurrenceEligible && !getTradeConfig(tradeCode).recurrenceSupport) {
      invalidReason = "Recurring services are not available for that trade.";
    }

    const key = catalogNameKey(row.name, tradeCode);
    const firstRow = seenInFile.get(key);
    if (firstRow == null) {
      seenInFile.set(key, row.rowNumber);
    } else {
      invalidReason = `This CSV has another row with the same service name and trade (row ${firstRow}).`;
    }

    const match = invalidReason
      ? null
      : pickDeterministicCatalogMatch(existingByKey.get(key) ?? []);
    const previewStatus: ServiceCatalogImportRowStatus = invalidReason
      ? "INVALID"
      : match
        ? "NAME_MATCH"
        : "VALID";

    return {
      ...row,
      tradeCode,
      previewStatus,
      invalidReason,
      matchedCatalogItemId: match?.id ?? null,
      matchDecision: previewStatus === "NAME_MATCH" ? row.matchDecision || "SKIP" : "SKIP",
      rowFingerprint: catalogImportRowFingerprint({
        name: row.name,
        tradeCode,
        pricingMode: row.pricingMode,
        price: row.price,
        category: row.category,
        description: row.description,
      }),
    };
  });
}

export function catalogRowBecameStale(
  stored: {
    previewStatus: string;
    matchedCatalogItemId: string | null;
  },
  live: {
    previewStatus: string;
    matchedCatalogItemId: string | null;
  },
) {
  if (stored.previewStatus === "INVALID") return false;
  if (stored.previewStatus === "VALID" && live.previewStatus === "NAME_MATCH") {
    return true;
  }
  if (stored.previewStatus === "NAME_MATCH") {
    if (live.previewStatus === "INVALID") return true;
    if (live.matchedCatalogItemId !== stored.matchedCatalogItemId) return true;
  }
  return false;
}

export function countCatalogPreviewStatuses(
  rows: Array<{ previewStatus: string }>,
) {
  let validCount = 0;
  let invalidCount = 0;
  let nameMatchCount = 0;
  for (const row of rows) {
    if (row.previewStatus === "INVALID") invalidCount += 1;
    else if (row.previewStatus === "NAME_MATCH") nameMatchCount += 1;
    else validCount += 1;
  }
  return {
    rowCount: rows.length,
    validCount,
    invalidCount,
    nameMatchCount,
  };
}

export function storedCatalogRowToParsed(row: {
  rowNumber: number;
  name: string;
  description: string | null;
  pricingMode: string;
  price: Prisma.Decimal | null;
  category: string | null;
  tradeCode: string;
  unitLabel: string;
  recurrenceEligible: boolean | null;
  active: boolean | null;
  previewStatus: string;
  invalidReason: string | null;
  rowFingerprint: string;
  matchedCatalogItemId: string | null;
  matchDecision?: string | null;
}): ParsedCatalogImportRow {
  return {
    rowNumber: row.rowNumber,
    name: row.name,
    description: row.description,
    pricingMode: row.pricingMode,
    price: row.price,
    category: row.category,
    tradeCode: row.tradeCode,
    unitLabel: row.unitLabel || null,
    recurrenceEligible: row.recurrenceEligible,
    active: row.active,
    previewStatus:
      row.previewStatus === "INVALID" || row.previewStatus === "NAME_MATCH"
        ? row.previewStatus
        : "VALID",
    invalidReason: row.invalidReason,
    rowFingerprint: row.rowFingerprint,
    matchedCatalogItemId: row.matchedCatalogItemId,
    matchDecision: parseCatalogImportMatchDecision(row.matchDecision ?? "") ?? "SKIP",
  };
}
