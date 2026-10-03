/**
 * Social publishing adapters. Facebook Page feed, Instagram professional
 * publish, and Google Business Profile STANDARD local posts are
 * implemented destinations. The fake adapter is local/script tests only
 * and cannot enable in Vercel production. An env string does not connect
 * an account or publish automatically.
 */
export const DISCONNECTED_SOCIAL_PUBLISHING_PROVIDER = "disconnected";
export const FAKE_SOCIAL_PUBLISHING_PROVIDER = "fake";
export const FACEBOOK_SOCIAL_PUBLISHING_PROVIDER = "facebook-graph";
export const INSTAGRAM_SOCIAL_PUBLISHING_PROVIDER = "instagram-graph";
export const GOOGLE_SOCIAL_PUBLISHING_PROVIDER = "google-business-profile";
export const OFFICIAL_SOCIAL_PUBLISHING_PROVIDER = "official-social-publishing";

export function isFakeSocialPublishingAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") {
    return false;
  }
  return process.env.TBBT_SOCIAL_PUBLISHING_ADAPTER === "fake";
}
