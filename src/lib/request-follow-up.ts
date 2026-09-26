/**
 * Owner follow-up helpers for a recorded service request.
 *
 * Contact actions and identity-review context come from recorded fields
 * only. Missing phone/email never become a tel/mailto action.
 */
import { telHref } from "@/lib/directions";
import {
  identityReviewOwnerMessage,
  parseIntakeIdentityReview,
} from "@/lib/customer-identity";

export type RequestIdentityReviewContext = {
  reason: string;
  message: string;
};

export function requestCallHref(phone: string | null | undefined): string | null {
  return telHref(phone);
}

export function requestEmailHref(email: string | null | undefined): string | null {
  const value = email?.trim();
  return value ? `mailto:${value}` : null;
}

export function requestIdentityReviewContext(
  description: string | null | undefined,
): RequestIdentityReviewContext | null {
  const review = parseIntakeIdentityReview(description);
  if (!review) return null;
  return {
    reason: review.reason,
    message: identityReviewOwnerMessage(review.reason),
  };
}

export function recordedCustomerPhone(phone: string | null | undefined): string | null {
  const value = phone?.trim();
  return value ? value : null;
}

export function recordedCustomerEmail(email: string | null | undefined): string | null {
  const value = email?.trim();
  return value ? value : null;
}
