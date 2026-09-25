import { recordedVendor } from "@/lib/reports";
import { roundMoney } from "@/lib/time-cards";
import type { RecurringPatternRecord } from "@/lib/financial-intelligence/source";

export const RECURRING_PATTERN_MIN_OCCURRENCES = 3;
export const RECURRING_AMOUNT_TOLERANCE = 0.2;

export type RecurringExpenseSuggestion = {
  patternKey: string;
  description: string;
  vendor: string | null;
  category: string;
  suggestedAmount: number;
  occurrenceCount: number;
  firstOccurredOn: Date;
  lastOccurredOn: Date;
  ownerStatus: "SUGGESTED" | "CONFIRMED" | "DISMISSED";
  persistedId: string | null;
  why: string[];
  cadence: "explicit-flag" | "monthly" | "similar-amount" | null;
  href: string;
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function recurringPatternKey(input: {
  category: string;
  vendor: string | null;
  description: string;
}) {
  return `${input.category}::${normalizeText(input.vendor) || "novendor"}::${normalizeText(input.description) || "nodesc"}`;
}

function similarAmounts(amounts: number[]) {
  if (amounts.length === 0) return false;
  const avg = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
  if (avg <= 0) return false;
  return amounts.every((amount) => Math.abs(amount - avg) / avg <= RECURRING_AMOUNT_TOLERANCE);
}

function monthlyCadence(dates: Date[]) {
  if (dates.length < 3) return false;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push((sorted[index]!.getTime() - sorted[index - 1]!.getTime()) / 86_400_000);
  }
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
  return median >= 20 && median <= 45;
}

export function detectRecurringExpensePatterns(
  expenses: readonly {
    id: string;
    description: string;
    amount: number;
    category: string;
    vendor: string | null;
    recurring: boolean;
    occurredOn: Date;
  }[],
  persisted: readonly RecurringPatternRecord[] = [],
): RecurringExpenseSuggestion[] {
  const groups = new Map<
    string,
    {
      description: string;
      vendor: string | null;
      category: string;
      amounts: number[];
      dates: Date[];
      flagged: boolean;
    }
  >();

  for (const expense of expenses) {
    const vendor = recordedVendor(expense.vendor);
    const key = recurringPatternKey({
      category: expense.category,
      vendor,
      description: expense.description,
    });
    const existing = groups.get(key);
    if (existing) {
      existing.amounts.push(expense.amount);
      existing.dates.push(expense.occurredOn);
      existing.flagged = existing.flagged || expense.recurring;
    } else {
      groups.set(key, {
        description: expense.description,
        vendor,
        category: expense.category,
        amounts: [expense.amount],
        dates: [expense.occurredOn],
        flagged: expense.recurring,
      });
    }
  }

  const persistedByKey = new Map(persisted.map((row) => [row.patternKey, row]));
  const suggestions: RecurringExpenseSuggestion[] = [];

  for (const [patternKey, group] of groups) {
    const similar = similarAmounts(group.amounts);
    const monthly = monthlyCadence(group.dates);
    const enoughRepeats = group.amounts.length >= RECURRING_PATTERN_MIN_OCCURRENCES && similar && (monthly || group.amounts.length >= 4);
    if (!group.flagged && !enoughRepeats) continue;

    const why: string[] = [];
    let cadence: RecurringExpenseSuggestion["cadence"] = null;
    if (group.flagged) {
      why.push("An expense row is explicitly marked recurring.");
      cadence = "explicit-flag";
    }
    if (enoughRepeats) {
      why.push(`${group.amounts.length} matching vendor + description + category rows.`);
      if (similar) {
        why.push("Amounts are within 20% of the group average.");
        if (!cadence) cadence = "similar-amount";
      }
      if (monthly) {
        why.push("Occurrence gaps look roughly monthly (20–45 days).");
        cadence = "monthly";
      }
    }
    why.push("This is not a subscription or liability. Confirming only records the pattern.");

    const saved = persistedByKey.get(patternKey);
    const dates = [...group.dates].sort((a, b) => a.getTime() - b.getTime());
    suggestions.push({
      patternKey,
      description: group.description,
      vendor: group.vendor,
      category: group.category,
      suggestedAmount: roundMoney(group.amounts.reduce((sum, amount) => sum + amount, 0) / group.amounts.length),
      occurrenceCount: group.amounts.length,
      firstOccurredOn: dates[0]!,
      lastOccurredOn: dates[dates.length - 1]!,
      ownerStatus: (saved?.ownerStatus as RecurringExpenseSuggestion["ownerStatus"]) ?? "SUGGESTED",
      persistedId: saved?.id ?? null,
      why,
      cadence,
      href: "/expenses",
    });
  }

  for (const saved of persisted) {
    if (suggestions.some((row) => row.patternKey === saved.patternKey)) continue;
    suggestions.push({
      patternKey: saved.patternKey,
      description: saved.description,
      vendor: saved.vendor,
      category: saved.category,
      suggestedAmount: saved.suggestedAmount,
      occurrenceCount: saved.occurrenceCount,
      firstOccurredOn: saved.firstOccurredOn,
      lastOccurredOn: saved.lastOccurredOn,
      ownerStatus: saved.ownerStatus as RecurringExpenseSuggestion["ownerStatus"],
      persistedId: saved.id,
      why: ["Previously reviewed pattern. Facts are refreshed from recorded expenses when still detectable."],
      cadence: null,
      href: "/expenses",
    });
  }

  return suggestions.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}
