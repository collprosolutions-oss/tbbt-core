export const PLAID_WEBHOOK_PATH = "/api/plaid/webhook";

export function isPlaidWebhookPath(pathname: string) {
  return pathname === PLAID_WEBHOOK_PATH;
}
