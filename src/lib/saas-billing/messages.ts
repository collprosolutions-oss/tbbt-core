/**
 * User-facing SaaS operating-block copy. Kept free of Prisma/server
 * imports so client UI can reuse the same strings as the server gate.
 */
export const SAAS_SUBSCRIPTION_REQUIRED_OWNER_MESSAGE =
  "The Founder Plan trial has ended. Subscribe from TBBT Billing to keep creating and changing business records.";

export const SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE =
  "This business needs an active TBBT subscription before operating records can be changed. Only the business owner can start or manage billing.";

export const SAAS_PAYMENT_PROBLEM_OWNER_MESSAGE =
  "There is a payment problem with the TBBT subscription. Operating access continues. Use Manage billing to update payment details. TBBT does not invent a grace-period length.";

export const SAAS_PAYMENT_PROBLEM_TEAM_MESSAGE =
  "This TBBT account has a billing payment problem. Operating access continues. Only the business owner can manage billing.";

export const SAAS_CANCELLATION_SCHEDULED_OWNER_MESSAGE =
  "Cancellation is scheduled. TBBT stays operational until the paid period ends. You can manage or reverse cancellation in Billing Portal.";

export const SAAS_CANCELLATION_SCHEDULED_TEAM_MESSAGE =
  "Cancellation is scheduled for this TBBT subscription. Access continues until the paid period ends. Only the business owner can manage billing.";

export const SAAS_BILLING_NOT_READY_OWNER_MESSAGE =
  "TBBT subscription billing is not configured correctly on this environment. Checkout and billing portal stay unavailable until live Stripe subscription billing is ready.";

export const SAAS_BILLING_APP_URL_OWNER_MESSAGE =
  "Checkout needs NEXT_PUBLIC_APP_URL so Stripe can return to TBBT.";
