/**
 * Accounts v2 merchant payment readiness.
 *
 * Official Stripe statuses for card_payments:
 * - active: capability is on
 * - pending: Stripe is acting; no merchant action required
 * - restricted: inspect status_details
 * - unsupported: cannot accept cards
 *
 * Hosted onboarding return_url is not proof of completion. After return,
 * retrieve the account and check requirements for currently_due / past_due
 * items awaiting the user. Sandboxes may allow charges when status is not
 * yet active.
 *
 * @see https://docs.stripe.com/connect/saas/tasks/onboard
 * @see https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v2
 * @see https://docs.stripe.com/api/v2/core/accounts/object
 */

const USER_ACTIONABLE_DEADLINES = new Set(["currently_due", "past_due"]);

const PENDING_VERIFICATION_CODES = new Set([
  "requirements_pending_verification",
  "determining_status",
]);

export type MerchantCapabilityStatusDetail = {
  code?: string | null;
  resolution?: string | null;
};

export type MerchantRequirementEntry = {
  awaiting_action_from?: string | null;
  minimum_deadline?: { status?: string | null } | null;
};

export type MerchantReadinessInput = {
  cardPaymentsStatus?: string | null;
  cardPaymentsStatusDetails?: MerchantCapabilityStatusDetail[] | null;
  requirementEntries?: MerchantRequirementEntry[] | null;
  requirementSummaryStatus?: string | null;
  v1ChargesEnabled?: boolean | null;
};

export function isMerchantPaymentReady(input: MerchantReadinessInput): boolean {
  if (input.v1ChargesEnabled === true) {
    return true;
  }

  const status = input.cardPaymentsStatus ?? "";
  if (status === "active") {
    return true;
  }
  if (!status || status === "unsupported") {
    return false;
  }

  if (hasUserActionableRequirements(input)) {
    return false;
  }

  if (status === "pending") {
    return true;
  }

  if (status === "restricted") {
    const details = input.cardPaymentsStatusDetails ?? [];
    if (details.length === 0) {
      return false;
    }
    return details.every(isPendingVerificationOnly);
  }

  return false;
}

function isPendingVerificationOnly(detail: MerchantCapabilityStatusDetail) {
  if (detail.resolution === "provide_info") {
    return false;
  }
  return PENDING_VERIFICATION_CODES.has(detail.code ?? "");
}

function hasUserActionableRequirements(input: MerchantReadinessInput) {
  const entries = input.requirementEntries ?? [];
  if (
    entries.some((entry) => {
      const deadline = entry.minimum_deadline?.status ?? "";
      return (
        entry.awaiting_action_from === "user" &&
        USER_ACTIONABLE_DEADLINES.has(deadline)
      );
    })
  ) {
    return true;
  }

  if (entries.length > 0) {
    return false;
  }

  const summary = input.requirementSummaryStatus ?? "";
  return USER_ACTIONABLE_DEADLINES.has(summary);
}
