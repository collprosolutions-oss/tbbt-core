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

  const communicationKeys = (...keys: string[]) => keys.filter((key) => recordedKeys.has(key));

  if (hasAny("communications-sms-consent-revoked")) {
    items.push({
      kind: "SMS_REVOKED_VS_TEXTABLE",
      recommendationKeys: communicationKeys("communications-sms-consent-revoked"),
      summary:
        "SMS consent is REVOKED. A stored phone number is not consent, and the Coach cannot text this customer or restore consent.",
    });
  }

  if (hasAny("communications-sms-consent-unknown")) {
    items.push({
      kind: "UNKNOWN_CONSENT_IS_NOT_GRANTED",
      recommendationKeys: communicationKeys("communications-sms-consent-unknown"),
      summary:
        "SMS consent is UNKNOWN. UNKNOWN is not GRANTED and is not opted in. A phone number, a prior call, or a successful delivery does not invent consent.",
    });
  }

  if (hasAny("communications-failed-delivery")) {
    items.push({
      kind: "FAILED_DELIVERY_VS_DELIVERED",
      recommendationKeys: communicationKeys("communications-failed-delivery"),
      summary:
        "A FAILED recorded delivery is not delivered, seen, or ignored. The Coach does not retry or invent a read receipt.",
    });
  }

  if (hasAny("communications-channel-unavailable")) {
    items.push({
      kind: "CHANNEL_UNAVAILABLE_VS_SEND",
      recommendationKeys: communicationKeys("communications-channel-unavailable"),
      summary:
        "A disconnected or unentitled channel cannot be treated as sent. SMS limitations do not erase recorded email.",
    });
  }

  if (hasAny("communications-appointment-different-time")) {
    items.push({
      kind: "APPOINTMENT_DIFFERENT_TIME_VS_CONFIRMED",
      recommendationKeys: communicationKeys("communications-appointment-different-time"),
      summary:
        "DIFFERENT_TIME_REQUESTED is a recorded request. It is not a confirmation and not a cancellation.",
    });
  }

  if (
    hasAny("communications-sms-consent-revoked", "communications-sms-consent-unknown") &&
    hasAny("communications-channel-unavailable")
  ) {
    items.push({
      kind: "EMAIL_AVAILABLE_VS_SMS_LIMIT",
      recommendationKeys: communicationKeys(
        "communications-sms-consent-revoked",
        "communications-sms-consent-unknown",
        "communications-channel-unavailable",
      ),
      summary:
        "SMS consent or SMS capability is limited. That SMS slice does not erase recorded email availability or email history.",
    });
  }

  const knowledgeKeys = (...keys: string[]) => keys.filter((key) => recordedKeys.has(key));

  if (hasAny("knowledge-unreviewed-entries", "approve-business-knowledge")) {
    items.push({
      kind: "UNREVIEWED_VS_APPROVED",
      recommendationKeys: knowledgeKeys("knowledge-unreviewed-entries", "approve-business-knowledge"),
      summary:
        "UNREVIEWED knowledge is not APPROVED. Missing owner approval is not treated as owner policy.",
    });
  }

  if (hasAny("knowledge-candidate-not-policy", "review-experience-learnings")) {
    items.push({
      kind: "CANDIDATE_VS_APPROVED_KNOWLEDGE",
      recommendationKeys: knowledgeKeys(
        "knowledge-candidate-not-policy",
        "review-experience-learnings",
      ),
      summary:
        "An experience learning candidate remains a candidate. It is not approved knowledge and is not promoted automatically.",
    });
  }

  if (hasAny("knowledge-conflict")) {
    items.push({
      kind: "CONFLICT_STILL_UNRESOLVED",
      recommendationKeys: knowledgeKeys("knowledge-conflict", "knowledge-needs-review"),
      summary: "CONFLICT remains conflict. The Coach does not resolve or rewrite the recorded trust state.",
    });
  }

  if (hasAny("knowledge-estimate")) {
    items.push({
      kind: "ESTIMATE_VS_KNOWN_FACT",
      recommendationKeys: knowledgeKeys("knowledge-estimate"),
      summary: "ESTIMATE is labeled as an estimate, not a known fact.",
    });
  }

  if (hasAny("knowledge-unknown")) {
    items.push({
      kind: "UNKNOWN_IS_NOT_FALSE",
      recommendationKeys: knowledgeKeys("knowledge-unknown"),
      summary: "UNKNOWN stays unknown. It is not treated as false or as a recorded fact.",
    });
  }

  if (hasAny("knowledge-supported-not-verified")) {
    items.push({
      kind: "SUPPORTED_VS_VERIFIED",
      recommendationKeys: knowledgeKeys("knowledge-supported-not-verified"),
      summary: "SUPPORTED is not VERIFIED.",
    });
  }

  if (hasAny("knowledge-external-not-verified")) {
    items.push({
      kind: "EXTERNAL_REFERENCE_VS_VERIFIED",
      recommendationKeys: knowledgeKeys("knowledge-external-not-verified"),
      summary: "An external reference is not internally verified.",
    });
  }

  if (hasAny("knowledge-system-derived-reserved")) {
    items.push({
      kind: "SYSTEM_DERIVED_RESERVED",
      recommendationKeys: knowledgeKeys("knowledge-system-derived-reserved"),
      summary:
        "SYSTEM_DERIVED is reserved and is not treated as operating knowledge in this step.",
    });
  }

  if (hasAny("launch-pending-steps", "finish-business-launch")) {
    items.push({
      kind: "PENDING_VS_COMPLETED_LAUNCH",
      recommendationKeys: knowledgeKeys("launch-pending-steps", "finish-business-launch"),
      summary: "PENDING launch steps are not COMPLETED, SKIPPED, or DEFERRED.",
    });
  }

  if (hasAny("launch-deferred-steps")) {
    items.push({
      kind: "DEFERRED_VS_COMPLETED_LAUNCH",
      recommendationKeys: knowledgeKeys("launch-deferred-steps"),
      summary: "DEFERRED launch steps are not COMPLETED and still block recorded launch completion.",
    });
  }

  if (hasAny("launch-complete-vs-website", "launch-complete-not-operating-proof")) {
    items.push({
      kind: "LAUNCH_COMPLETE_VS_WEBSITE",
      recommendationKeys: knowledgeKeys(
        "launch-complete-vs-website",
        "launch-complete-not-operating-proof",
      ),
      summary:
        "Recorded launch completion does not publish the website. Website publishing remains a separate owner action.",
    });
  }

  if (hasAny("launch-complete-vs-provider", "launch-complete-not-operating-proof")) {
    items.push({
      kind: "LAUNCH_COMPLETE_VS_PROVIDER",
      recommendationKeys: knowledgeKeys(
        "launch-complete-vs-provider",
        "launch-complete-not-operating-proof",
      ),
      summary:
        "Recorded launch completion does not imply Stripe, Resend, SMS, or R2 are connected. Provider truth comes from actual provider/config state.",
    });
  }

  if (hasAny("setup-proposal-not-applied")) {
    items.push({
      kind: "PROPOSAL_VS_APPLIED_SETUP",
      recommendationKeys: knowledgeKeys("setup-proposal-not-applied"),
      summary: "A setup proposal is not applied setup. AI setup proposals never imply a setting, service, or procedure was written unless the item is APPLIED.",
    });
    items.push({
      kind: "PENDING_VS_APPROVED_SETUP_ITEM",
      recommendationKeys: knowledgeKeys("setup-proposal-not-applied"),
      summary: "PENDING setup-proposal items are not APPROVED.",
    });
    items.push({
      kind: "APPROVED_VS_APPLIED_SETUP_ITEM",
      recommendationKeys: knowledgeKeys("setup-proposal-not-applied"),
      summary: "APPROVED setup-proposal items are not APPLIED.",
    });
    items.push({
      kind: "REJECTED_VS_APPLIED_SETUP_ITEM",
      recommendationKeys: knowledgeKeys("setup-proposal-not-applied"),
      summary: "REJECTED setup-proposal items are not APPLIED.",
    });
    items.push({
      kind: "BLOCKED_VS_APPLIED_SETUP_ITEM",
      recommendationKeys: knowledgeKeys("setup-proposal-not-applied"),
      summary: "BLOCKED setup-proposal items are not APPLIED.",
    });
    items.push({
      kind: "SETUP_PROPOSAL_VS_COMPLETED_LAUNCH",
      recommendationKeys: knowledgeKeys("setup-proposal-not-applied"),
      summary: "DRAFT, REVIEWED, and PARTIALLY_APPLIED setup proposals are not completed Launch.",
    });
  }

  const protectionKeys = (...keys: string[]) => keys.filter((key) => recordedKeys.has(key));

  if (hasAny("protection-checklist-organization")) {
    items.push({
      kind: "CHECKLIST_PRESENT_VS_COMPLIANCE",
      recommendationKeys: protectionKeys("protection-checklist-organization"),
      summary:
        "A Business Protection checklist item being met means the corresponding recorded category exists in TBBT. It is not licensed, insured, compliant, or legally protected.",
    });
  }

  if (
    hasAny(
      "protection-expired-recorded-date",
      "protection-expiring-soon",
      "protection-missing-date",
      "protection-current-recorded-date",
    )
  ) {
    items.push({
      kind: "RECORDED_EXPIRY_VS_LEGAL_STATUS",
      recommendationKeys: protectionKeys(
        "protection-expired-recorded-date",
        "protection-expiring-soon",
        "protection-missing-date",
        "protection-current-recorded-date",
      ),
      summary:
        "Expiry states are recorded-date classifiers. CURRENT is not legal validity, EXPIRING_SOON is not a regulatory determination, EXPIRED is not regulatory noncompliance, and MISSING_DATE is not expired or noncompliant.",
    });
  }

  if (
    hasAny(
      "protection-owner-review-recorded",
      "protection-owner-review-not-recorded",
      "protection-legal-warning-acknowledged",
    )
  ) {
    items.push({
      kind: "OWNER_REVIEW_VS_LEGAL_REVIEW",
      recommendationKeys: protectionKeys(
        "protection-owner-review-recorded",
        "protection-owner-review-not-recorded",
        "protection-legal-warning-acknowledged",
      ),
      summary:
        "Owner review is a recorded owner workflow fact, not attorney review. A legal-warning acknowledgment is not attorney approval or legal advice.",
    });
  }

  if (hasAny("protection-agreement-complete-not-enforceable")) {
    items.push({
      kind: "AGREEMENT_COMPLETE_VS_ENFORCEABLE",
      recommendationKeys: protectionKeys("protection-agreement-complete-not-enforceable"),
      summary:
        "SIGNED, COMPLETE, and EXTERNAL_COMPLETE are recorded workflow facts. Recorded completion does not prove legal validity or enforceability.",
    });
  }

  if (hasAny("protection-esign-not-connected")) {
    items.push({
      kind: "ESIGN_NOT_CONNECTED_VS_DIGITAL_SIGNATURE",
      recommendationKeys: protectionKeys("protection-esign-not-connected"),
      summary:
        "E-sign is NOT_CONNECTED. A signed version, completion status, uploaded file, or external signature does not connect a provider and does not invent a digital signature.",
    });
  }

  return { items, uniqueRecommendationKeys };
}
