/**
 * Accounts v2 + v1 merchant payment readiness.
 *
 * Official Stripe post-onboarding check (hosted return_url is not proof):
 * retrieve the Account and inspect charges_enabled plus requirements.
 * currently_due / past_due mean the merchant must provide more information.
 * pending_verification means Stripe is reviewing; no further onboarding pass.
 *
 * Sandboxes may allow charges before card_payments.status is active.
 *
 * @see https://docs.stripe.com/connect/saas/tasks/onboard
 * @see https://docs.stripe.com/connect/account-capabilities?accounts-namespace=v2
 * @see https://docs.stripe.com/api/accounts/object
 */

const PENDING_VERIFICATION_CODES = new Set([
  "requirements_pending_verification",
  "determining_status",
]);

export type PaymentReadinessBranch =
  | "v1_charges_enabled"
  | "card_payments_active"
  | "unsupported"
  | "missing_capability"
  | "user_currently_due"
  | "user_past_due"
  | "v1_submitted_no_outstanding"
  | "v2_pending_no_user_due"
  | "v2_restricted_pending_verification"
  | "v1_pending_verification_no_outstanding"
  | "restricted_requires_info"
  | "retrieve_failed"
  | "not_ready";

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
  currentlyDueKeys?: string[] | null;
  pastDueKeys?: string[] | null;
  pendingVerificationKeys?: string[] | null;
  v1ChargesEnabled?: boolean | null;
  detailsSubmitted?: boolean | null;
  v1CardPaymentsCapability?: string | null;
  disabledReason?: string | null;
  retrieveFailed?: boolean | null;
  retrieveError?: string | null;
};

export type PaymentReadinessDebug = {
  branch: PaymentReadinessBranch;
  ready: boolean;
  cardPaymentsStatus: string | null;
  cardPaymentsStatusDetails: Array<{ code: string | null; resolution: string | null }>;
  currentlyDueKeys: string[];
  pastDueKeys: string[];
  pendingVerificationKeys: string[];
  chargesEnabled: boolean | null;
  detailsSubmitted: boolean | null;
  disabledReason: string | null;
  retrieveError: string | null;
};

const USER_ONBOARDING_BRANCHES = new Set<PaymentReadinessBranch>([
  "user_currently_due",
  "user_past_due",
  "restricted_requires_info",
  "missing_capability",
]);

export function isMerchantPaymentReady(input: MerchantReadinessInput): boolean {
  return explainMerchantReadiness(input).ready;
}

export function shouldOfferStripeOnboarding(
  status: "not_connected" | "setup_required" | "connected",
  branch?: PaymentReadinessBranch | null,
): boolean {
  if (status === "not_connected") {
    return true;
  }
  if (status !== "setup_required") {
    return false;
  }
  if (!branch) {
    return true;
  }
  return USER_ONBOARDING_BRANCHES.has(branch);
}

export function formatPaymentReadinessDebug(debug: PaymentReadinessDebug): string {
  const details =
    debug.cardPaymentsStatusDetails
      .map((detail) => `${detail.code ?? "unknown"}:${detail.resolution ?? "none"}`)
      .join(",") || "none";
  const parts = [
    `branch=${debug.branch}`,
    `card_payments=${debug.cardPaymentsStatus ?? "none"}`,
    `status_details=${details}`,
    `charges_enabled=${String(debug.chargesEnabled)}`,
    `details_submitted=${String(debug.detailsSubmitted)}`,
    `disabled_reason=${debug.disabledReason ?? "none"}`,
    `currently_due=${formatRequirementKeys(debug.currentlyDueKeys)}`,
    `past_due=${formatRequirementKeys(debug.pastDueKeys)}`,
    `pending_verification=${formatRequirementKeys(debug.pendingVerificationKeys)}`,
  ];
  if (debug.retrieveError) {
    parts.push(`retrieve_error=${debug.retrieveError}`);
  }
  return parts.join("; ");
}

function formatRequirementKeys(keys: string[]) {
  if (keys.length === 0) {
    return "0";
  }
  return `${keys.length}:${keys.join(",")}`;
}

export function explainMerchantReadiness(
  input: MerchantReadinessInput,
): PaymentReadinessDebug {
  const currentlyDueKeys = input.currentlyDueKeys ?? [];
  const pastDueKeys = input.pastDueKeys ?? [];
  const pendingVerificationKeys = input.pendingVerificationKeys ?? [];
  const cardPaymentsStatus = input.cardPaymentsStatus ?? null;
  const cardPaymentsStatusDetails = (input.cardPaymentsStatusDetails ?? []).map(
    (detail) => ({
      code: detail.code ?? null,
      resolution: detail.resolution ?? null,
    }),
  );
  const v1Capability = input.v1CardPaymentsCapability ?? null;

  const base = {
    cardPaymentsStatus,
    cardPaymentsStatusDetails,
    currentlyDueKeys,
    pastDueKeys,
    pendingVerificationKeys,
    chargesEnabled: input.v1ChargesEnabled ?? null,
    detailsSubmitted: input.detailsSubmitted ?? null,
    disabledReason: input.disabledReason ?? null,
    retrieveError: input.retrieveError ?? null,
  };

  if (input.retrieveFailed) {
    return { ...base, ready: false, branch: "retrieve_failed" };
  }

  if (input.v1ChargesEnabled === true) {
    return { ...base, ready: true, branch: "v1_charges_enabled" };
  }

  if (cardPaymentsStatus === "active" || v1Capability === "active") {
    return { ...base, ready: true, branch: "card_payments_active" };
  }

  if (cardPaymentsStatus === "unsupported" || v1Capability === "unsupported") {
    return { ...base, ready: false, branch: "unsupported" };
  }

  const userCurrentlyDue =
    currentlyDueKeys.length > 0 ||
    hasV2UserActionableRequirements(input, "currently_due");
  if (userCurrentlyDue) {
    return { ...base, ready: false, branch: "user_currently_due" };
  }

  const userPastDue =
    pastDueKeys.length > 0 || hasV2UserActionableRequirements(input, "past_due");
  if (userPastDue) {
    return { ...base, ready: false, branch: "user_past_due" };
  }

  const knownV1Requirements = input.currentlyDueKeys != null && input.pastDueKeys != null;
  if (input.detailsSubmitted === true && knownV1Requirements) {
    return { ...base, ready: true, branch: "v1_submitted_no_outstanding" };
  }

  if (input.disabledReason === "requirements.pending_verification") {
    return { ...base, ready: true, branch: "v1_pending_verification_no_outstanding" };
  }

  if (cardPaymentsStatus === "pending" || v1Capability === "pending") {
    return { ...base, ready: true, branch: "v2_pending_no_user_due" };
  }

  if (cardPaymentsStatus === "restricted") {
    if (
      isRestrictedPendingVerification(input) ||
      pendingVerificationKeys.length > 0
    ) {
      return { ...base, ready: true, branch: "v2_restricted_pending_verification" };
    }
    return { ...base, ready: false, branch: "restricted_requires_info" };
  }

  if (pendingVerificationKeys.length > 0) {
    return { ...base, ready: true, branch: "v1_pending_verification_no_outstanding" };
  }

  if (!cardPaymentsStatus && !v1Capability) {
    return { ...base, ready: false, branch: "missing_capability" };
  }

  return { ...base, ready: false, branch: "not_ready" };
}

function isRestrictedPendingVerification(input: MerchantReadinessInput) {
  const details = input.cardPaymentsStatusDetails ?? [];
  if (details.length === 0) {
    return false;
  }
  return details.every((detail) =>
    PENDING_VERIFICATION_CODES.has(detail.code ?? ""),
  );
}

function hasV2UserActionableRequirements(
  input: MerchantReadinessInput,
  deadline: "currently_due" | "past_due",
) {
  return (input.requirementEntries ?? []).some((entry) => {
    return (
      entry.awaiting_action_from === "user" &&
      entry.minimum_deadline?.status === deadline
    );
  });
}

export function safeRetrieveErrorName(error: unknown) {
  if (error && typeof error === "object" && "type" in error) {
    const type = (error as { type?: unknown }).type;
    if (typeof type === "string" && type.length > 0 && type.length < 80) {
      return type;
    }
  }
  if (error instanceof Error && error.name && error.name.length < 80) {
    return error.name;
  }
  return "retrieve_failed";
}
