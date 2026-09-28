/**
 * Existing Cleaning customer "request another visit" from a public
 * project-token page. Creates a ServiceRequest for owner review.
 * Never a Job, charge, or customer/company message.
 */
import {
  cleaningVisitWorkflowEligible,
  resolveJobTradeCode,
} from "@/lib/cleaning-visit-workflow";

export const CLEANING_REPEAT_VISIT_ONLY_MESSAGE =
  "Another visit can only be requested from a Cleaning project.";
export const CLEANING_REPEAT_VISIT_CUSTOMER_REQUIRED_MESSAGE =
  "This project has no same-business customer to request another visit.";
export const CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE =
  "This project link is not available.";
export const CLEANING_REPEAT_VISIT_RECEIVED_MESSAGE =
  "We received your request for another visit. The team will review it before scheduling.";
export const CLEANING_REPEAT_VISIT_OWNER_REVIEW_MESSAGE =
  "Submitted by an existing Cleaning customer as a request for another visit. Review this request before creating an estimate or job.";

export const REPEAT_VISIT_LANDING_PREFIX = "/p/";
export const REPEAT_VISIT_LANDING_SUFFIX = "/request-visit";

export function cleaningRepeatVisitEligible(tradeCode: string) {
  return cleaningVisitWorkflowEligible(tradeCode);
}

export function resolveCleaningRepeatVisitTradeCode(input: {
  requestTradeCode?: string | null;
  catalogTradeCodes?: Array<string | null | undefined>;
}) {
  return resolveJobTradeCode(input);
}

export function publicRepeatVisitPath(token: string) {
  return `${REPEAT_VISIT_LANDING_PREFIX}${token.trim()}${REPEAT_VISIT_LANDING_SUFFIX}`;
}

export function isRepeatVisitLandingPath(path: string | null | undefined) {
  const raw = (path ?? "").trim();
  return (
    raw.startsWith(REPEAT_VISIT_LANDING_PREFIX) && raw.endsWith(REPEAT_VISIT_LANDING_SUFFIX)
  );
}
