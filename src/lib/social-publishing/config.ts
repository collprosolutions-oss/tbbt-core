/**
 * Social publishing adapters. Facebook Page feed is the only implemented
 * destination. The fake adapter is local/script tests only and cannot
 * enable in Vercel production. An env string does not connect Instagram
 * or Google.
 */
export const DISCONNECTED_SOCIAL_PUBLISHING_PROVIDER = "disconnected";
export const FAKE_SOCIAL_PUBLISHING_PROVIDER = "fake";
export const FACEBOOK_SOCIAL_PUBLISHING_PROVIDER = "facebook-graph";

export function isFakeSocialPublishingAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER === "fake";
}
