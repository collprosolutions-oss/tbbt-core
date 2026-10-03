/**
 * Provider-neutral e-sign webhook. Dropbox Sign POSTs have no TBBT
 * session cookie; the auth proxy must not redirect them to sign-in.
 * The route verifies the official event_hash before any write.
 */
export const ESIGN_WEBHOOK_PATH = "/api/esign/webhook";

export function isEsignWebhookPath(pathname: string) {
  return pathname === ESIGN_WEBHOOK_PATH;
}
