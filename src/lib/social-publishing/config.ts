/**
 * Social publishing adapters. Facebook Page feed and Instagram media
 * publish are implemented. The fake adapter is local/script tests only
 * and cannot enable in Vercel production. An env string does not connect
 * Google.
 */
export const DISCONNECTED_SOCIAL_PUBLISHING_PROVIDER = "disconnected";
export const FAKE_SOCIAL_PUBLISHING_PROVIDER = "fake";
export const FACEBOOK_SOCIAL_PUBLISHING_PROVIDER = "facebook-graph";
export const INSTAGRAM_SOCIAL_PUBLISHING_PROVIDER = "instagram-graph";

export function isFakeSocialPublishingAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER === "fake";
}
