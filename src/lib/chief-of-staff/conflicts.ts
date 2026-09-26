/**
 * Pure deterministic conflict / dependency resolution.
 * Uses only currently available BSOS / Workforce facts.
 */
import type { BsosFacts, BsosRecommendation } from "@/lib/bsos";
import { jobIdsFromFinancialFindings } from "@/lib/chief-of-staff/specialists/financial";
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

  const marginPricingKeys = [
    "review-low-margin-jobs",
    "service-margin-below-target",
    "high-value-customer-concentration",
  ];
  const hasMarginOrPricing =
    uniqueRecommendationKeys.some((key) => marginPricingKeys.includes(key)) ||
    input.results.some((row) =>
      row.findings.some((finding) => finding.key.startsWith("financial-pricing:")),
    );
  if (uniqueRecommendationKeys.includes("missing-wage-data") && hasMarginOrPricing) {
    items.push({
      kind: "MISSING_WAGE_VS_MARGIN_PRICING",
      recommendationKeys: ["missing-wage-data", ...marginPricingKeys.filter((key) => uniqueRecommendationKeys.includes(key))],
      summary:
        "Wage data is incomplete. Margin and pricing stay unknown until recorded labor cost is complete. Missing burden or target margin is unconfigured, not 0%.",
    });
  }

  const financial = input.results.find((row) => row.specialistId === "FINANCIAL" && row.status === "OK");
  const financialJobIds = new Set(jobIdsFromFinancialFindings(financial?.findings ?? []));
  const otherJobIds = new Set(
    input.results
      .filter((row) => row.specialistId !== "FINANCIAL")
      .flatMap((row) => row.findings.flatMap((finding) => finding.entityIds ?? [])),
  );
  const sharedJobs = [...financialJobIds].filter((id) => otherJobIds.has(id));
  if (sharedJobs.length > 0) {
    items.push({
      kind: "SHARED_JOB_REFERENCE",
      recommendationKeys: uniqueRecommendationKeys.filter((key) =>
        key.includes("job") || key.startsWith("workforce-") || key.startsWith("review-low-margin"),
      ),
      summary: "More than one recorded view refers to the same job. The Coach keeps that job once and does not assign anyone.",
    });
  }

  const recordedKeys = new Set<string>(uniqueRecommendationKeys);
  for (const row of input.results) {
    for (const finding of row.findings) recordedKeys.add(finding.key);
  }
  const specialistOk = (id: SpecialistResult["specialistId"]) =>
    input.results.some((row) => row.specialistId === id && row.status === "OK");
  const hasAny = (...keys: string[]) => keys.some((key) => recordedKeys.has(key));
  const materialKeys = (...keys: string[]) => keys.filter((key) => recordedKeys.has(key));

  if (hasAny("materials-stale-price", "materials-missing-price")) {
    items.push({
      kind: "STALE_PRICE_VS_CURRENT",
      recommendationKeys: materialKeys("materials-stale-price", "materials-missing-price"),
      summary:
        "A stale or missing recorded price cannot be treated as current. Missing price is unknown, not a live quote.",
    });
  }

  if (hasAny("materials-cheaper-recorded-supplier")) {
    items.push({
      kind: "PREFERRED_SUPPLIER_VS_RECORDED_PRICE",
      recommendationKeys: ["materials-cheaper-recorded-supplier"],
      summary:
        "Preferred supplier is not the cheapest recorded supplier, and cheaper is not available, confirmed, or live stock.",
    });
  }

  if (hasAny("materials-open-purchase-list", "materials-draft-po")) {
    items.push({
      kind: "PURCHASE_LIST_VS_PO",
      recommendationKeys: materialKeys("materials-open-purchase-list", "materials-draft-po"),
      summary: "A purchase list is not a purchase order. The Coach does not convert or send either one.",
    });
  }

  if (hasAny("materials-draft-po")) {
    items.push({
      kind: "PO_VS_SUPPLIER_CONFIRMATION",
      recommendationKeys: materialKeys("materials-draft-po", "materials-adapter-disconnected"),
      summary:
        "ORDERED_EXTERNALLY and a disconnected adapter are owner tracking only. They are not supplier confirmation.",
    });
  }

  if (hasAny("materials-variance-hurting-margin") && specialistOk("FINANCIAL")) {
    items.push({
      kind: "MATERIAL_VARIANCE_VS_JOB_MARGIN",
      recommendationKeys: materialKeys("materials-variance-hurting-margin"),
      summary:
        "Expense-linked material variance is a recorded cost input. Financial owns job margin math; operational purchase cost is not a financial actual unless Expense-linked.",
    });
  }

  if (
    hasAny("materials-incomplete-prep", "materials-pickup-not-ready") &&
    specialistOk("WORKFORCE")
  ) {
    items.push({
      kind: "MATERIAL_UNREADY_VS_SCHEDULE",
      recommendationKeys: materialKeys("materials-incomplete-prep", "materials-pickup-not-ready"),
      summary:
        "Unready recorded materials do not create staff or capacity. Workforce owns scheduling; Materials only reports recorded pickup readiness.",
    });
  }

  if (
    hasAny("materials-needed-for-upcoming-jobs", "materials-incomplete-prep") &&
    specialistOk("GROWTH")
  ) {
    items.push({
      kind: "MATERIAL_UNREADY_VS_GROWTH",
      recommendationKeys: materialKeys("materials-needed-for-upcoming-jobs", "materials-incomplete-prep"),
      summary:
        "Unready or still-needed materials remain a fulfillment constraint. Growth owns demand and does not invent capacity from Materials.",
    });
  }

  if (hasAny("materials-needed-for-upcoming-jobs", "materials-incomplete-prep")) {
    items.push({
      kind: "MATERIAL_DELAY_VS_CUSTOMER_UPDATE",
      recommendationKeys: materialKeys("materials-needed-for-upcoming-jobs", "materials-incomplete-prep"),
      summary:
        "A customer update may be needed for delayed materials. Communications owns contact; Materials does not send a message.",
    });
  }

  if (hasAny("materials-inventory-unknown")) {
    items.push({
      kind: "NO_INVENTORY_RECORDED",
      recommendationKeys: materialKeys("materials-inventory-unknown"),
      summary:
        "No inventory quantities are recorded. Inventory quantity stays unknown, never zero, and is not live commerce.",
    });
  }

  return { items, uniqueRecommendationKeys };
}
