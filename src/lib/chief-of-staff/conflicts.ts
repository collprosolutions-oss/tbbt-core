/**
 * Pure deterministic conflict / dependency resolution.
 * Uses only currently available BSOS / Workforce facts.
 */
import type { BsosFacts, BsosRecommendation } from "@/lib/bsos";
import type {
  ConflictItem,
  ConflictResolution,
  SpecialistResult,
} from "@/lib/chief-of-staff/types";

export function resolveConflicts(input: {
  results: SpecialistResult[];
  recommendations: BsosRecommendation[];
  facts: BsosFacts;
}): ConflictResolution {
  const items: ConflictItem[] = [];
  const keys = input.recommendations.map((item) => item.key);
  const resultKeys = input.results.flatMap((row) => row.recommendationKeys);
  const allKeys = [...keys, ...resultKeys];
  const uniqueRecommendationKeys = [...new Set(allKeys)];

  const seen = new Map<string, number>();
  for (const key of allKeys) {
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      items.push({
        kind: "DUPLICATE_RECOMMENDATION",
        recommendationKeys: [key],
        summary: `${key} appeared more than once and is combined into one Coach note.`,
      });
    }
  }

  if (keys.includes("workforce-overloaded-day") && keys.includes("available-schedule-capacity")) {
    items.push({
      kind: "OVERLOAD_VS_FILL_CAPACITY",
      recommendationKeys: ["workforce-overloaded-day", "available-schedule-capacity"],
      summary:
        "A scheduled day is overloaded while other days still show open capacity. Filling capacity should not add work onto an overloaded day.",
    });
  }

  if (keys.includes("workforce-staffing-shortage") && (keys.includes("schedule-unscheduled-jobs") || input.facts.unscheduledJobs.count > 0)) {
    items.push({
      kind: "STAFFING_SHORTAGE_VS_SCHEDULED_WORK",
      recommendationKeys: ["workforce-staffing-shortage", "schedule-unscheduled-jobs"].filter((key) =>
        keys.includes(key) || key === "workforce-staffing-shortage",
      ),
      summary:
        "Staffing is short for upcoming work. Scheduling more unassigned jobs does not create workers.",
    });
  }

  if (keys.includes("workforce-unassigned-job")) {
    items.push({
      kind: "UNASSIGNED_PLUS_AVAILABLE",
      recommendationKeys: ["workforce-unassigned-job"],
      summary:
        "Scheduled jobs are unassigned. The Coach can point at the existing assignment workspace; it cannot assign a worker.",
    });
  }

  const shared = uniqueRecommendationKeys.filter((key) =>
    input.results.filter((row) => row.recommendationKeys.includes(key)).length > 1,
  );
  for (const key of shared) {
    items.push({
      kind: "SHARED_RECOMMENDATION",
      recommendationKeys: [key],
      summary: `More than one finding refers to ${key}; the Coach keeps that key once.`,
    });
  }

  return { items, uniqueRecommendationKeys };
}
