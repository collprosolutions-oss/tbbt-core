/**
 * OWNER-reviewed bank CSV parse, cents math, date handling, duplicate /
 * reversal flags, and candidate matching against recorded TBBT Payment
 * and Expense rows.
 *
 * Invoice credits are never deposits. Matching never invents a Payment,
 * never changes an invoice, and never claims a verified bank balance.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { formatISODate } from "@/lib/schedule";
import {
  BANK_CSV_NUL_MESSAGE,
  BANK_MATCH_DATE_WINDOW_DAYS,
  BANK_REVERSAL_DATE_WINDOW_DAYS,
  EMPTY_BANK_CSV_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  INVALID_BANK_CSV_MESSAGE,
  MAX_BANK_CSV_BYTES,
  MAX_BANK_CSV_DESCRIPTION,
  MAX_BANK_CSV_ROWS,
  MAX_BANK_MATCH_CANDIDATES,
  MISSING_BANK_COLUMNS_MESSAGE,
  NOT_CSV_MESSAGE,
  TOO_MANY_BANK_ROWS_MESSAGE,
  type BankMatchKind,
  type BankRowDirection,
  type BankRowReviewStatus,
} from "@/lib/bank-reconciliation-copy";

export {
  BANK_RECONCILIATION_ROUTE,
  BANK_CREDITS_ARE_NOT_DEPOSITS_MESSAGE,
  BANK_CSV_NUL_MESSAGE,
  BANK_CSV_REQUIRED_MESSAGE,
  BANK_IMPORT_NOT_AVAILABLE_MESSAGE,
  BANK_MATCH_ALREADY_DECIDED_MESSAGE,
  BANK_MATCH_NOT_AVAILABLE_MESSAGE,
  BANK_CANDIDATE_ALREADY_ACCEPTED_MESSAGE,
  BANK_NO_LIVE_FEED_MESSAGE,
  BANK_NOT_A_BALANCE_MESSAGE,
  BANK_NOT_A_PAYMENT_MESSAGE,
  BANK_ROW_NOT_REVIEWABLE_MESSAGE,
  EMPTY_BANK_CSV_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  INVALID_BANK_CSV_MESSAGE,
  MAX_BANK_CSV_BYTES,
  MAX_BANK_CSV_ROWS,
  MISSING_BANK_COLUMNS_MESSAGE,
  NOT_CSV_MESSAGE,
  OWNER_ONLY_BANK_RECONCILIATION_MESSAGE,
  TOO_MANY_BANK_ROWS_MESSAGE,
  bankDirectionLabel,
  bankMatchKindLabel,
  bankRowStatusLabel,
  formatSignedCents,
} from "@/lib/bank-reconciliation-copy";

export class BankReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankReconciliationError";
  }
}

export type CanonicalBankColumn =
  | "date"
  | "description"
  | "amount"
  | "debit"
  | "credit"
  | "balance";

const HEADER_ALIASES: Record<string, CanonicalBankColumn> = {
  date: "date",
  posted: "date",
  posted_date: "date",
  posting_date: "date",
  transaction_date: "date",
  trans_date: "date",
  txn_date: "date",
  description: "description",
  payee: "description",
  memo: "description",
  name: "description",
  details: "description",
  narrative: "description",
  amount: "amount",
  transaction_amount: "amount",
  debit: "debit",
  withdrawal: "debit",
  withdrawals: "debit",
  debit_amount: "debit",
  credit: "credit",
  deposit: "credit",
  deposits: "credit",
  credit_amount: "credit",
  balance: "balance",
  running_balance: "balance",
  account_balance: "balance",
};

export type ParsedBankRow = {
  rowNumber: number;
  postedOn: string | null;
  description: string;
  amountCents: number;
  direction: BankRowDirection;
  rowFingerprint: string;
  rawLine: string;
  reviewStatus: BankRowReviewStatus;
  invalidReason: string | null;
  reversalOfRowNumber: number | null;
  duplicateOfRowNumber: number | null;
  externalTransactionId?: string | null;
};

export type BankMatchCandidate = {
  candidateKind: BankMatchKind;
  candidateId: string;
  score: number;
  matchReason: string;
};

export type RecordedPaymentCandidate = {
  id: string;
  amount: Prisma.Decimal | number | string;
  receivedAt: Date;
  note?: string | null;
  method?: string | null;
  purpose?: string | null;
};

export type RecordedExpenseCandidate = {
  id: string;
  amount: Prisma.Decimal | number | string;
  occurredOn: Date;
  description?: string | null;
  vendor?: string | null;
  voidedAt?: Date | null;
};

export type BankWorkspaceTotals = {
  rowCount: number;
  depositCount: number;
  withdrawalCount: number;
  unmatchedCount: number;
  candidateMatchCount: number;
  duplicateRowCount: number;
  reversedCount: number;
  invalidCount: number;
  postedDepositCents: number;
  postedWithdrawalCents: number;
  netPostedCents: number;
  acceptedDepositCents: number;
  acceptedWithdrawalCents: number;
};

export function hashCsvBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sanitizeSourceFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "upload.csv";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return cleaned.toLowerCase().endsWith(".csv") ? cleaned : `${cleaned || "upload"}.csv`;
}

export function sanitizeImportText(value: string, max: number): string {
  return value
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeImportHeader(value: string): string {
  return sanitizeImportText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Signed whole cents that fit in Postgres INTEGER / Prisma Int. */
export const MAX_BANK_AMOUNT_CENTS = 2_147_483_647;
export const MIN_BANK_AMOUNT_CENTS = -2_147_483_648;

export function decodeCsvBytes(bytes: Uint8Array | Buffer): string {
  if (bytes.byteLength > MAX_BANK_CSV_BYTES) {
    throw new BankReconciliationError(FILE_TOO_LARGE_MESSAGE);
  }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.includes(0)) {
    throw new BankReconciliationError(BANK_CSV_NUL_MESSAGE);
  }
  if (
    view.byteLength >= 2 &&
    ((view[0] === 0xff && view[1] === 0xfe) || (view[0] === 0xfe && view[1] === 0xff))
  ) {
    throw new BankReconciliationError(BANK_CSV_NUL_MESSAGE);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.includes("\u0000")) {
    throw new BankReconciliationError(BANK_CSV_NUL_MESSAGE);
  }
  if (/^\s*</.test(text)) {
    throw new BankReconciliationError(NOT_CSV_MESSAGE);
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
    throw new BankReconciliationError(INVALID_BANK_CSV_MESSAGE);
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function validYmd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Calendar YYYY-MM-DD from common bank CSV dates. Never uses process local TZ. */
export function parseBankPostedOn(raw: string): string | null {
  const text = sanitizeImportText(raw, 32);
  if (!text) return null;

  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    return validYmd(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) {
    return validYmd(Number(match[3]), Number(match[1]), Number(match[2]));
  }

  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/.exec(text);
  if (match) {
    const yy = Number(match[3]);
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    return validYmd(year, Number(match[1]), Number(match[2]));
  }

  return null;
}

export function daysBetweenPostedOn(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms = Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd);
  return Math.round(ms / 86_400_000);
}

/**
 * Commas are thousands separators only, in \d{1,3}(,\d{3})+ form.
 * "12,50", "1,5", and "1,2,3" are invalid.
 */
function normalizeBankMoneyDigits(text: string): string | null {
  const parts = text.split(".");
  if (parts.length > 2) return null;
  const [wholeRaw, fracRaw] = parts;
  if (!wholeRaw) return null;
  if (wholeRaw.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+$/.test(wholeRaw)) return null;
  } else if (!/^\d+$/.test(wholeRaw)) {
    return null;
  }
  if (fracRaw != null && !/^\d{1,2}$/.test(fracRaw)) return null;
  const whole = wholeRaw.replace(/,/g, "");
  return fracRaw != null ? `${whole}.${fracRaw}` : whole;
}

/**
 * Parse a bank money cell into signed whole cents. Rejects more than two
 * decimal places, Int32 overflow, and commas that are not US thousands
 * separators. Parentheses, leading minus, and DR/DEBIT mean outflow.
 */
export function parseBankMoneyToCents(raw: string): number | null {
  let text = sanitizeImportText(raw, 40);
  if (!text) return null;

  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) {
    negative = true;
    text = paren[1].trim();
  }

  if (/\b(DR|DEBIT)\b/i.test(text)) {
    negative = true;
    text = text.replace(/\b(DR|DEBIT)\b/gi, "").trim();
  }
  if (/\b(CR|CREDIT)\b/i.test(text)) {
    text = text.replace(/\b(CR|CREDIT)\b/gi, "").trim();
  }

  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }

  text = text.replace(/[$\s]/g, "");
  const normalized = normalizeBankMoneyDigits(text);
  if (!normalized || !/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

  const [whole, frac = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_BANK_AMOUNT_CENTS) return null;
  const signed = negative ? -cents : cents;
  if (signed < MIN_BANK_AMOUNT_CENTS || signed > MAX_BANK_AMOUNT_CENTS) return null;
  return signed;
}

export function moneyToCents(value: Prisma.Decimal | number | string): number | null {
  try {
    const amount = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    if (!amount.isFinite() || amount.isNaN()) return null;
    const cents = amount.mul(100);
    if (!cents.isInteger()) return null;
    const n = cents.toNumber();
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

export function centsToDecimal(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).div(100).toDecimalPlaces(2);
}

export function directionFromCents(cents: number): BankRowDirection {
  if (cents > 0) return "DEPOSIT";
  if (cents < 0) return "WITHDRAWAL";
  return "ZERO";
}

export function normalizeBankDescription(value: string): string {
  return sanitizeImportText(value, MAX_BANK_CSV_DESCRIPTION)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function bankRowFingerprint(input: {
  postedOn: string | null;
  amountCents: number;
  description: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.postedOn ?? ""}|${input.amountCents}|${normalizeBankDescription(input.description)}`,
    )
    .digest("hex");
}

export function descriptionTokenOverlap(a: string, b: string): number {
  const left = new Set(
    normalizeBankDescription(a)
      .split(" ")
      .filter((token) => token.length > 2),
  );
  const right = new Set(
    normalizeBankDescription(b)
      .split(" ")
      .filter((token) => token.length > 2),
  );
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const token of left) {
    if (right.has(token)) hit += 1;
  }
  return hit / Math.min(left.size, right.size);
}

function mapHeaders(headerRow: string[]): Array<CanonicalBankColumn | null> {
  return headerRow.map((cell) => HEADER_ALIASES[normalizeImportHeader(cell)] ?? null);
}

function readMappedRow(
  cells: string[],
  columns: Array<CanonicalBankColumn | null>,
): Partial<Record<CanonicalBankColumn, string>> {
  const mapped: Partial<Record<CanonicalBankColumn, string>> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const key = columns[i];
    if (!key || mapped[key]) continue;
    mapped[key] = cells[i] ?? "";
  }
  return mapped;
}

function resolveAmountCents(
  raw: Partial<Record<CanonicalBankColumn, string>>,
): { cents: number | null; reason: string | null } {
  const debitRaw = raw.debit?.trim() ?? "";
  const creditRaw = raw.credit?.trim() ?? "";
  const amountRaw = raw.amount?.trim() ?? "";

  if (debitRaw && creditRaw) {
    return { cents: null, reason: "A row cannot have both a debit and a credit." };
  }
  if (debitRaw) {
    const debit = parseBankMoneyToCents(debitRaw);
    if (debit == null) return { cents: null, reason: "Enter a debit amount with at most two decimal places." };
    return { cents: debit === 0 ? 0 : -Math.abs(debit), reason: null };
  }
  if (creditRaw) {
    const credit = parseBankMoneyToCents(creditRaw);
    if (credit == null) return { cents: null, reason: "Enter a credit amount with at most two decimal places." };
    return { cents: Math.abs(credit), reason: null };
  }
  if (amountRaw) {
    const amount = parseBankMoneyToCents(amountRaw);
    if (amount == null) {
      return { cents: null, reason: "Enter an amount with at most two decimal places." };
    }
    return { cents: amount, reason: null };
  }
  return { cents: null, reason: "Amount is required." };
}

export function evaluateBankRow(
  rowNumber: number,
  raw: Partial<Record<CanonicalBankColumn, string>>,
  cells: string[],
): ParsedBankRow {
  const postedOn = parseBankPostedOn(raw.date ?? "");
  const description = sanitizeImportText(raw.description ?? "", MAX_BANK_CSV_DESCRIPTION);
  const amount = resolveAmountCents(raw);
  let invalidReason: string | null = null;
  if (!postedOn) invalidReason = "Enter a valid posted date.";
  else if (amount.reason) invalidReason = amount.reason;

  const amountCents = amount.cents ?? 0;
  return {
    rowNumber,
    postedOn,
    description,
    amountCents,
    direction: directionFromCents(amountCents),
    rowFingerprint: bankRowFingerprint({
      postedOn,
      amountCents,
      description,
    }),
    rawLine: cells.join(","),
    reviewStatus: invalidReason ? "INVALID" : "UNMATCHED",
    invalidReason,
    reversalOfRowNumber: null,
    duplicateOfRowNumber: null,
  };
}

export function parseBankCsv(text: string): ParsedBankRow[] {
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new BankReconciliationError(EMPTY_BANK_CSV_MESSAGE);
  }
  const columns = mapHeaders(table[0]);
  const hasDate = columns.includes("date");
  const hasAmount = columns.includes("amount") || columns.includes("debit") || columns.includes("credit");
  if (!hasDate || !hasAmount) {
    throw new BankReconciliationError(MISSING_BANK_COLUMNS_MESSAGE);
  }
  const dataRows = table.slice(1);
  if (dataRows.length === 0) {
    throw new BankReconciliationError(EMPTY_BANK_CSV_MESSAGE);
  }
  if (dataRows.length > MAX_BANK_CSV_ROWS) {
    throw new BankReconciliationError(TOO_MANY_BANK_ROWS_MESSAGE);
  }

  const parsed = dataRows.map((cells, index) =>
    evaluateBankRow(index + 2, readMappedRow(cells, columns), cells),
  );
  return flagDuplicateAndReversedRows(parsed);
}

export function flagDuplicateAndReversedRows(rows: ParsedBankRow[]): ParsedBankRow[] {
  const next = rows.map((row) => ({ ...row }));
  const seen = new Map<string, number>();

  for (const row of next) {
    if (row.reviewStatus === "INVALID") continue;
    const first = seen.get(row.rowFingerprint);
    if (first != null) {
      row.reviewStatus = "DUPLICATE";
      row.duplicateOfRowNumber = first;
      continue;
    }
    seen.set(row.rowFingerprint, row.rowNumber);
  }

  const used = new Set<number>();
  for (let i = 0; i < next.length; i += 1) {
    const left = next[i];
    if (left.reviewStatus !== "UNMATCHED" || !left.postedOn || used.has(left.rowNumber)) {
      continue;
    }
    for (let j = i + 1; j < next.length; j += 1) {
      const right = next[j];
      if (right.reviewStatus !== "UNMATCHED" || !right.postedOn || used.has(right.rowNumber)) {
        continue;
      }
      if (left.amountCents === 0 || left.amountCents !== -right.amountCents) continue;
      if (Math.abs(daysBetweenPostedOn(left.postedOn, right.postedOn)) > BANK_REVERSAL_DATE_WINDOW_DAYS) {
        continue;
      }
      const overlap = descriptionTokenOverlap(left.description, right.description);
      const sameText =
        normalizeBankDescription(left.description) === normalizeBankDescription(right.description);
      if (!sameText && overlap < 0.5) continue;

      left.reviewStatus = "REVERSED";
      right.reviewStatus = "REVERSED";
      right.reversalOfRowNumber = left.rowNumber;
      used.add(left.rowNumber);
      used.add(right.rowNumber);
      break;
    }
  }

  return next;
}

export function markAlreadySeenBankRows(
  rows: ParsedBankRow[],
  priorFingerprints: Iterable<string>,
): ParsedBankRow[] {
  const seen = priorFingerprints instanceof Set ? priorFingerprints : new Set(priorFingerprints);
  if (seen.size === 0) return rows;
  for (const row of rows) {
    if (row.reviewStatus === "INVALID" || row.reviewStatus === "DUPLICATE") continue;
    if (seen.has(row.rowFingerprint)) {
      row.reviewStatus = "ALREADY_SEEN";
    }
  }
  return rows;
}

function candidateDate(value: Date, timeZone: string): string {
  return formatISODate(value, timeZone);
}

function scoreCandidate(input: {
  postedOn: string;
  description: string;
  candidateDate: string;
  candidateText: string;
}): { score: number; matchReason: string } {
  const dateDiff = Math.abs(daysBetweenPostedOn(input.postedOn, input.candidateDate));
  if (dateDiff > BANK_MATCH_DATE_WINDOW_DAYS) {
    return { score: 0, matchReason: "" };
  }
  const overlap = descriptionTokenOverlap(input.description, input.candidateText);
  const score = 100 - dateDiff * 20 + Math.round(overlap * 20);
  const datePart =
    dateDiff === 0 ? "same calendar date" : `${dateDiff} day${dateDiff === 1 ? "" : "s"} apart`;
  const textPart = overlap >= 0.5 ? "description overlap" : "amount and date only";
  return { score, matchReason: `Exact cents, ${datePart}, ${textPart}` };
}

export function suggestBankMatches(
  rows: ParsedBankRow[],
  input: {
    payments: RecordedPaymentCandidate[];
    expenses: RecordedExpenseCandidate[];
    timeZone: string;
  },
): Map<number, BankMatchCandidate[]> {
  const suggestions = new Map<number, BankMatchCandidate[]>();
  const payments = input.payments
    .map((payment) => {
      const cents = moneyToCents(payment.amount);
      if (cents == null || cents <= 0) return null;
      return {
        ...payment,
        cents,
        date: candidateDate(payment.receivedAt, input.timeZone),
        text: [payment.note, payment.method, payment.purpose].filter(Boolean).join(" "),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  const expenses = input.expenses
    .filter((expense) => !expense.voidedAt)
    .map((expense) => {
      const cents = moneyToCents(expense.amount);
      if (cents == null || cents <= 0) return null;
      return {
        ...expense,
        cents,
        date: candidateDate(expense.occurredOn, input.timeZone),
        text: [expense.description, expense.vendor].filter(Boolean).join(" "),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  for (const row of rows) {
    if (row.reviewStatus !== "UNMATCHED" || !row.postedOn || row.amountCents === 0) continue;
    const pool =
      row.direction === "DEPOSIT"
        ? payments.map((payment) => ({
            candidateKind: "PAYMENT" as const,
            candidateId: payment.id,
            cents: payment.cents,
            date: payment.date,
            text: payment.text,
          }))
        : row.direction === "WITHDRAWAL"
          ? expenses.map((expense) => ({
              candidateKind: "EXPENSE" as const,
              candidateId: expense.id,
              cents: expense.cents,
              date: expense.date,
              text: expense.text,
            }))
          : [];

    const matches = pool
      .filter((candidate) => candidate.cents === Math.abs(row.amountCents))
      .map((candidate) => {
        const scored = scoreCandidate({
          postedOn: row.postedOn!,
          description: row.description,
          candidateDate: candidate.date,
          candidateText: candidate.text,
        });
        return {
          candidateKind: candidate.candidateKind,
          candidateId: candidate.candidateId,
          score: scored.score,
          matchReason: scored.matchReason,
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
      .slice(0, MAX_BANK_MATCH_CANDIDATES);

    if (matches.length > 0) {
      row.reviewStatus = "CANDIDATE";
      suggestions.set(row.rowNumber, matches);
    }
  }

  return suggestions;
}

export function summarizeBankWorkspace(
  rows: Array<{
    reviewStatus: string;
    direction: string;
    amountCents: number;
  }>,
  matches: Array<{ status: string; candidateKind?: string }> = [],
): BankWorkspaceTotals {
  const uniquePosted = rows.filter(
    (row) =>
      row.reviewStatus !== "INVALID" &&
      row.reviewStatus !== "DUPLICATE" &&
      row.reviewStatus !== "REVERSED" &&
      row.reviewStatus !== "ALREADY_SEEN",
  );
  const postedDepositCents = uniquePosted
    .filter((row) => row.direction === "DEPOSIT")
    .reduce((sum, row) => sum + row.amountCents, 0);
  const postedWithdrawalCents = uniquePosted
    .filter((row) => row.direction === "WITHDRAWAL")
    .reduce((sum, row) => sum + Math.abs(row.amountCents), 0);
  const acceptedRows = rows.filter((row) => row.reviewStatus === "ACCEPTED");

  return {
    rowCount: rows.length,
    depositCount: uniquePosted.filter((row) => row.direction === "DEPOSIT").length,
    withdrawalCount: uniquePosted.filter((row) => row.direction === "WITHDRAWAL").length,
    unmatchedCount: rows.filter((row) => row.reviewStatus === "UNMATCHED").length,
    candidateMatchCount: matches.filter((match) => match.status === "SUGGESTED").length,
    duplicateRowCount: rows.filter((row) => row.reviewStatus === "DUPLICATE").length,
    reversedCount: rows.filter((row) => row.reviewStatus === "REVERSED").length,
    invalidCount: rows.filter((row) => row.reviewStatus === "INVALID").length,
    postedDepositCents,
    postedWithdrawalCents,
    netPostedCents: postedDepositCents - postedWithdrawalCents,
    acceptedDepositCents: acceptedRows
      .filter((row) => row.direction === "DEPOSIT")
      .reduce((sum, row) => sum + row.amountCents, 0),
    acceptedWithdrawalCents: acceptedRows
      .filter((row) => row.direction === "WITHDRAWAL")
      .reduce((sum, row) => sum + Math.abs(row.amountCents), 0),
  };
}

export function workspaceCountsWrite(totals: BankWorkspaceTotals) {
  return {
    rowCount: totals.rowCount,
    depositCount: totals.depositCount,
    withdrawalCount: totals.withdrawalCount,
    unmatchedCount: totals.unmatchedCount,
    candidateMatchCount: totals.candidateMatchCount,
    duplicateRowCount: totals.duplicateRowCount,
    reversedCount: totals.reversedCount,
    invalidCount: totals.invalidCount,
  };
}
