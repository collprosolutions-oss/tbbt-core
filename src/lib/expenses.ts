/**
 * Expenses domain -- persistent business expense records.
 *
 * Money uses Prisma Decimal (same convention as Invoice / Payroll).
 * This module never invents a bank balance, bank account, IRS mileage
 * rate, or automatic recurring charge.
 */
import { Prisma } from "@prisma/client";
import { isPaymentMethodValue, type PaymentMethodValue } from "@/lib/invoice-payment";
import { parseScheduleDate, startOfDay } from "@/lib/schedule";

export const EXPENSE_CATEGORIES = [
  "MATERIALS",
  "GAS_FUEL",
  "TOOLS_EQUIPMENT",
  "VEHICLE",
  "OFFICE_ADMIN",
  "SOFTWARE_SUBSCRIPTIONS",
  "INSURANCE",
  "MARKETING_ADVERTISING",
  "MILEAGE",
  "OTHER",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  MATERIALS: "Materials",
  GAS_FUEL: "Gas / Fuel",
  TOOLS_EQUIPMENT: "Tools / Equipment",
  VEHICLE: "Vehicle",
  OFFICE_ADMIN: "Office / Admin",
  SOFTWARE_SUBSCRIPTIONS: "Software / Subscriptions",
  INSURANCE: "Insurance",
  MARKETING_ADVERTISING: "Marketing / Advertising",
  MILEAGE: "Mileage",
  OTHER: "Other",
};

export const EXPENSE_CATEGORY_ACCENTS: Record<
  ExpenseCategory,
  "purple" | "orange" | "blue" | "green" | "gold" | "gray" | "red"
> = {
  MATERIALS: "purple",
  GAS_FUEL: "orange",
  TOOLS_EQUIPMENT: "blue",
  VEHICLE: "green",
  OFFICE_ADMIN: "gold",
  SOFTWARE_SUBSCRIPTIONS: "blue",
  INSURANCE: "green",
  MARKETING_ADVERTISING: "orange",
  MILEAGE: "green",
  OTHER: "gray",
};

export const REIMBURSEMENT_STATUSES = ["NONE", "PENDING", "REIMBURSED"] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const REIMBURSEMENT_STATUS_LABELS: Record<ReimbursementStatus, string> = {
  NONE: "Not reimbursable",
  PENDING: "Pending reimbursement",
  REIMBURSED: "Reimbursed",
};

export const EXPENSE_REVIEW_STATUSES = ["RECORDED", "APPROVED", "FLAGGED"] as const;
export type ExpenseReviewStatus = (typeof EXPENSE_REVIEW_STATUSES)[number];

export const EXPENSE_REVIEW_LABELS: Record<ExpenseReviewStatus, string> = {
  RECORDED: "Recorded",
  APPROVED: "Approved",
  FLAGGED: "Flagged",
};

export const TAX_CATEGORIES = ["DEDUCTIBLE", "NON_DEDUCTIBLE", "UNSPECIFIED"] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  DEDUCTIBLE: "Tax deductible",
  NON_DEDUCTIBLE: "Not deductible",
  UNSPECIFIED: "Unspecified",
};

export const EXPENSE_DATE_RANGES = ["week", "30d", "month", "year", "all"] as const;
export type ExpenseDateRange = (typeof EXPENSE_DATE_RANGES)[number];

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

export function isReimbursementStatus(value: string): value is ReimbursementStatus {
  return (REIMBURSEMENT_STATUSES as readonly string[]).includes(value);
}

export function isExpenseReviewStatus(value: string): value is ExpenseReviewStatus {
  return (EXPENSE_REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isTaxCategory(value: string): value is TaxCategory {
  return (TAX_CATEGORIES as readonly string[]).includes(value);
}

export function isExpenseDateRange(value: string): value is ExpenseDateRange {
  return (EXPENSE_DATE_RANGES as readonly string[]).includes(value);
}

export function expenseCategoryLabel(value: string) {
  return isExpenseCategory(value) ? EXPENSE_CATEGORY_LABELS[value] : value;
}

export function parseExpenseAmount(raw: string): Prisma.Decimal | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  try {
    const value = new Prisma.Decimal(cleaned);
    if (value.isNaN() || value.lte(0)) return null;
    return value.toDecimalPlaces(2);
  } catch {
    return null;
  }
}

export function parseMileageMiles(raw: string): Prisma.Decimal | null {
  const cleaned = raw.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  try {
    const value = new Prisma.Decimal(cleaned);
    if (value.isNaN() || value.lte(0)) return null;
    return value.toDecimalPlaces(2);
  } catch {
    return null;
  }
}

export function parseExpenseDate(raw: string): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = parseScheduleDate(raw);
  const [year, month, day] = raw.split("-").map(Number);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return startOfDay(parsed);
}

export function asMoneyNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value == null) return 0;
  return Number(value.toString());
}

export type ExpenseRange = { start: Date; end: Date } | null;

/**
 * Inclusive start / exclusive end for the selected preset. `all` returns
 * null so the query does not invent a window.
 */
export function expenseRangeBounds(preset: ExpenseDateRange, now = new Date()): ExpenseRange {
  const today = startOfDay(now);
  if (preset === "all") return null;
  if (preset === "week") {
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }
  if (preset === "30d") {
    const start = new Date(today);
    start.setDate(today.getDate() - 29);
    const end = new Date(today);
    end.setDate(today.getDate() + 1);
    return { start, end };
  }
  if (preset === "month") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    return { start, end };
  }
  const start = new Date(today.getFullYear(), 0, 1);
  const end = new Date(today.getFullYear() + 1, 0, 1);
  return { start, end };
}

export type CategoryTotal = {
  category: ExpenseCategory;
  amount: number;
  count: number;
  percent: number;
};

export function categoryTotals(
  rows: readonly { category: string; amount: Prisma.Decimal | number }[],
): CategoryTotal[] {
  const byCategory = new Map<ExpenseCategory, { amount: number; count: number }>();
  let total = 0;
  for (const row of rows) {
    if (!isExpenseCategory(row.category)) continue;
    const amount = asMoneyNumber(row.amount);
    total += amount;
    const current = byCategory.get(row.category) ?? { amount: 0, count: 0 };
    current.amount += amount;
    current.count += 1;
    byCategory.set(row.category, current);
  }
  return EXPENSE_CATEGORIES.map((category) => {
    const current = byCategory.get(category) ?? { amount: 0, count: 0 };
    return {
      category,
      amount: current.amount,
      count: current.count,
      percent: total > 0 ? Math.round((current.amount / total) * 100) : 0,
    };
  });
}

export function expenseSummary(rows: readonly { amount: Prisma.Decimal | number; reimbursable: boolean }[]) {
  let total = 0;
  let reimbursable = 0;
  let reimbursableCount = 0;
  for (const row of rows) {
    const amount = asMoneyNumber(row.amount);
    total += amount;
    if (row.reimbursable) {
      reimbursable += amount;
      reimbursableCount += 1;
    }
  }
  return {
    total,
    count: rows.length,
    reimbursable,
    reimbursableCount,
    nonReimbursable: total - reimbursable,
    nonReimbursableCount: rows.length - reimbursableCount,
  };
}

/**
 * Projected operating balance is ONLY computable when a verified bank
 * balance exists. This step has no bank integration, so the result is
 * always unavailable. Known inflows/outflows may still be reported from
 * real TBBT records.
 */
export type ProjectedOperatingBalance = {
  bankConnected: false;
  verifiedBalance: null;
  verifiedAt: null;
  verifiedSource: null;
  knownInflows: number;
  knownOutflows: number;
  projectedBalance: null;
  unavailableReason: "Bank account is not connected. TBBT does not invent a bank balance.";
};

export function projectedOperatingBalance(input: {
  knownInflows: number;
  knownOutflows: number;
}): ProjectedOperatingBalance {
  return {
    bankConnected: false,
    verifiedBalance: null,
    verifiedAt: null,
    verifiedSource: null,
    knownInflows: input.knownInflows,
    knownOutflows: input.knownOutflows,
    projectedBalance: null,
    unavailableReason: "Bank account is not connected. TBBT does not invent a bank balance.",
  };
}

export function defaultReimbursementStatus(reimbursable: boolean): ReimbursementStatus {
  return reimbursable ? "PENDING" : "NONE";
}

export function normalizePaymentMethod(raw: string): PaymentMethodValue | null {
  if (!raw) return null;
  return isPaymentMethodValue(raw) ? raw : null;
}

export function normalizeTaxCategory(raw: string): TaxCategory | null {
  if (!raw) return null;
  return isTaxCategory(raw) ? raw : null;
}
