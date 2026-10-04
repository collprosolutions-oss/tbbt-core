/**
 * Client-safe copy for OWNER read-only Plaid bank connection.
 * Keep Node built-ins out of this file so settings forms can import it.
 */

export const PLAID_WEBHOOK_PATH = "/api/plaid/webhook";

/** Plaid forbids query parameters on redirect_uri. Keep this path query-free. */
export const PLAID_OAUTH_RETURN_PATH = "/settings/banking";

export const PLAID_LINK_TOKEN_STORAGE_KEY = "tbbt.plaid.link";

export const BANK_PLAID_ITEM_STATUSES = ["ACTIVE", "NEEDS_REAUTH", "DISCONNECTED"] as const;
export type BankPlaidItemStatus = (typeof BANK_PLAID_ITEM_STATUSES)[number];

export const OWNER_ONLY_BANK_CONNECT_MESSAGE =
  "Only the business owner can connect, sync, reconnect, or disconnect a bank feed.";

export const BANK_CONNECT_NOT_CONFIGURED_MESSAGE =
  "Plaid is not configured in this environment. The owner must supply Plaid API credentials in the host environment — never a bank login.";

export const BANK_CONNECT_ALREADY_CONNECTED_MESSAGE =
  "This business already has a bank feed. Disconnect it before connecting another institution.";

export const BANK_CONNECT_NOT_AVAILABLE_MESSAGE = "That bank connection is not available.";

export const BANK_CONNECT_NEEDS_REAUTH_MESSAGE =
  "The bank needs the owner to reconnect. TBBT cannot refresh the feed until authorization is restored.";

export const BANK_CONNECT_DISCONNECTED_MESSAGE = "The bank feed is disconnected.";

export const BANK_CONNECT_PLAID_REMOVE_FAILED_MESSAGE =
  "Removed locally; Plaid item removal failed, remove it in the Plaid dashboard.";

export const BANK_CONNECT_REVIEW_ONLY_MESSAGE =
  "A connected Plaid feed is read-only review. It never creates a Payment, never changes an invoice, never moves money, and is not a verified cash balance.";

export const BANK_FEED_NOT_A_BALANCE_MESSAGE =
  "Last verified bank balance stays Unavailable. A connected feed is not a cash-balance claim.";

export function bankPlaidStatusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "Connected (review feed)";
    case "NEEDS_REAUTH":
      return "Needs reconnect";
    case "DISCONNECTED":
      return "Disconnected";
    default:
      return "Not connected";
  }
}
