/**
 * Map Gusto demo/production payroll JSON into stored facts.
 * Dollar strings are converted to integer cents. Missing amounts stay
 * null. net_pay is ignored and never derived.
 *
 * List: GET /v1/companies/{company_id}/payrolls
 * Detail: GET /v1/companies/{company_id}/payrolls/{payroll_id}
 * https://docs.gusto.com/app-integrations/reference/get-v1-companies-company_id-payrolls
 */
import { createHash } from "node:crypto";
import type { GustoPayrollFactDraft, GustoPayrollFactLineDraft } from "@/lib/payroll-connect/types";

const DOLLAR = /^-?\d+(\.\d{1,2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function hashRawPayload(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

export function reportedDollarsToCents(value: unknown): number | null {
  if (typeof value !== "string" || !DOLLAR.test(value)) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

export function reportedIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function reportedEmployeeName(row: Record<string, unknown>) {
  const first = typeof row.first_name === "string" ? row.first_name.trim() : "";
  const last = typeof row.last_name === "string" ? row.last_name.trim() : "";
  const combined = [first, last].filter(Boolean).join(" ");
  return combined ? combined.slice(0, 200) : null;
}

function parseLine(value: unknown): GustoPayrollFactLineDraft | null {
  const row = asRecord(value);
  if (!row) return null;
  const employeeId = typeof row.employee_uuid === "string" ? row.employee_uuid.trim() : "";
  return {
    providerEmployeeId: employeeId || null,
    employeeName: reportedEmployeeName(row),
    grossCents: reportedDollarsToCents(row.gross_pay),
  };
}

export function parseGustoPayrollPayload(payload: unknown, raw: string): GustoPayrollFactDraft | null {
  const row = asRecord(payload);
  if (!row || row.processed !== true) return null;
  const payrollId =
    (typeof row.payroll_uuid === "string" && row.payroll_uuid.trim()) ||
    (typeof row.uuid === "string" && row.uuid.trim()) ||
    "";
  if (!payrollId) return null;
  const period = asRecord(row.pay_period);
  const totals = asRecord(row.totals);
  const lines = Array.isArray(row.employee_compensations)
    ? row.employee_compensations.map(parseLine).filter((line): line is GustoPayrollFactLineDraft => line !== null)
    : [];
  return {
    providerPayrollId: payrollId,
    payPeriodStart: period ? reportedIsoDate(period.start_date) : null,
    payPeriodEnd: period ? reportedIsoDate(period.end_date) : null,
    checkDate: reportedIsoDate(row.check_date),
    processed: true,
    grossTotalCents: totals ? reportedDollarsToCents(totals.gross_pay) : null,
    employerTaxesCents: totals ? reportedDollarsToCents(totals.employer_taxes) : null,
    employerBenefitsCents: totals ? reportedDollarsToCents(totals.benefits) : null,
    rawPayloadHash: hashRawPayload(raw),
    lines,
  };
}

export function parseGustoPayrollList(payload: unknown, rawItems: string[]) {
  if (!Array.isArray(payload)) return [];
  const drafts: GustoPayrollFactDraft[] = [];
  payload.forEach((item, index) => {
    const raw = rawItems[index] ?? JSON.stringify(item);
    const draft = parseGustoPayrollPayload(item, raw);
    if (draft) drafts.push(draft);
  });
  return drafts;
}
