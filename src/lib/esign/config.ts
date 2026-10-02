/**
 * E-sign adapter configuration.
 *
 * Dropbox Sign is the connected provider. The fake adapter is local/script
 * tests only and cannot enable in Vercel production. A missing key stays
 * NOT_CONNECTED — TBBT never invents a digital signature.
 */

export const ESIGN_PROVIDER_DROPBOX_SIGN = "dropbox_sign" as const;
export const ESIGN_PROVIDER_FAKE = "fake" as const;

export function getDropboxSignApiKey(): string | null {
  const value = process.env.DROPBOX_SIGN_API_KEY?.trim();
  return value || null;
}

export function getDropboxSignClientId(): string | null {
  const value = process.env.DROPBOX_SIGN_CLIENT_ID?.trim();
  return value || null;
}

/**
 * Official Dropbox Sign callbacks HMAC against the API key
 * (event_time + event_type). See:
 * https://developers.hellosign.com/docs/guides/events-and-callbacks/walkthrough/
 */
export function getDropboxSignWebhookKey(): string | null {
  return getDropboxSignApiKey();
}

export function getFakeEsignWebhookKey(): string {
  return (
    process.env.TBBT_ESIGN_WEBHOOK_SECRET?.trim() ||
    process.env.TBBT_ESIGN_FAKE_API_KEY?.trim() ||
    "tbbt-esign-fake-key"
  );
}

export function isFakeEsignAdapterEnabled(): boolean {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_ESIGN_ADAPTER === "fake";
}

export function isEsignProviderConfigured(): boolean {
  return isFakeEsignAdapterEnabled() || Boolean(getDropboxSignApiKey());
}

export function resolveEsignWebhookKey(): string | null {
  if (isFakeEsignAdapterEnabled()) {
    return getFakeEsignWebhookKey();
  }
  return getDropboxSignWebhookKey();
}
