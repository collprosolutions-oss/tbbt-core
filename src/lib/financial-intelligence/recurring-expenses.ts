import { recordedVendor } from "@/lib/reports";
import { roundMoney } from "@/lib/time-cards";
import type { RecurringPatternRecord } from "@/lib/financial-intelligence/source";

export const RECURRING_PATTERN_MIN_OCCURRENCES = 2;

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
  href: string;
};

function normalizeKey(vendor: string | null, category: string, description: string) {
  const vendorKey = (vendor ?? "").trim().toLowerCase();
  const descKey = description.trim().toLowerCase().replace(/\s+/g, " ");
  return `${category}::${vendorKey || descKey || "unknown"}`;
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
    const key = normalizeKey(vendor, expense.category, expense.description);
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
    if (!group.flagged && group.amounts.length < RECURRING_PATTERN_MIN_OCCURRENCES) continue;
    const saved = persistedByKey.get(patternKey);
    const dates = [...group.dates].sort((a, b) => a.getTime() - b.getTime());
    suggestions.push({
      patternKey,
      description: saved?.description ?? group.description,
      vendor: saved?.vendor ?? group.vendor,
      category: saved?.category ?? group.category,
      suggestedAmount: saved?.suggestedAmount ?? roundMoney(group.amounts.reduce((sum, amount) => sum + amount, 0) / group.amounts.length),
      occurrenceCount: Math.max(saved?.occurrenceCount ?? 0, group.amounts.length),
      firstOccurredOn: saved?.firstOccurredOn ?? dates[0]!,
      lastOccurredOn: saved?.lastOccurredOn ?? dates[dates.length - 1]!,
      ownerStatus: (saved?.ownerStatus as RecurringExpenseSuggestion["ownerStatus"]) ?? "SUGGESTED",
      persistedId: saved?.id ?? null,
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
      href: "/expenses",
    });
  }

  return suggestions.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}
