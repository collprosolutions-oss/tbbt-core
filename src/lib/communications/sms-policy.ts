/**
 * SMS commercial boundary for Communications Department (PR #104).
 *
 * Central policy so later #111 can transition paid SMS without hunting modules.
 *
 * - Ordinary email compose never requires SMS_MESSAGING.
 * - Manual Communications Department SMS compose requires SMS_MESSAGING.
 * - Existing operational SMS workflows (attemptCustomerSms, appointment,
 *   invoice, review adapters) remain compatibility-ungated for this PR.
 *
 * SMS_MESSAGING is not a publicly purchasable/live add-on. Do not present it
 * as a storefront product or claim Twilio SMS is connected when it is not.
 */
export const SMS_COMMERCIAL_BOUNDARY = {
  ordinaryEmailRequiresSmsAddon: false,
  departmentSmsComposeRequiresSmsAddon: true,
  operationalSmsRequiresSmsAddon: false,
  publicPurchasable: false,
  liveProduct: false,
  laterTransition: "#111",
} as const;

export function departmentSmsComposeRequiresAddon() {
  return SMS_COMMERCIAL_BOUNDARY.departmentSmsComposeRequiresSmsAddon;
}

export function ordinaryEmailRequiresSmsAddon() {
  return SMS_COMMERCIAL_BOUNDARY.ordinaryEmailRequiresSmsAddon;
}

export function operationalSmsRequiresSmsAddon() {
  return SMS_COMMERCIAL_BOUNDARY.operationalSmsRequiresSmsAddon;
}
