/**
 * Marketing destination OAuth configuration.
 *
 * TBBT_SOCIAL_OAUTH_ADAPTER=fake is local/script tests only and is refused
 * when VERCEL_ENV=production. It is separate from
 * TBBT_SOCIAL_PUBLISHING_ADAPTER. An env string does not connect an account
 * and does not publish.
 */
import { isConnectionTokenKeyConfigured } from "@/lib/connection-token-crypto";
import {
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  type SocialPublishDestination,
} from "@/lib/social-publishing/types";

export const MARKETING_CONNECTION_DESTINATIONS = [
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
] as const;

export type MarketingConnectionDestination = (typeof MARKETING_CONNECTION_DESTINATIONS)[number];

export const MARKETING_CONNECTION_STATUSES = [
  "CONNECTED",
  "NEEDS_RECONNECT",
  "EXPIRED",
  "DISCONNECTED",
  "NOT_CONFIGURED",
] as const;

export type MarketingConnectionStatus = (typeof MARKETING_CONNECTION_STATUSES)[number];

export const MARKETING_OAUTH_STATE_CONSENT = "CONSENT" as const;
export const MARKETING_OAUTH_STATE_SELECTION = "SELECTION" as const;
export const MARKETING_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

export const FACEBOOK_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
] as const;

export const INSTAGRAM_REQUIRED_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
] as const;

export const GOOGLE_BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";

export const REQUIRED_SCOPES_BY_DESTINATION: Record<MarketingConnectionDestination, readonly string[]> = {
  FACEBOOK: FACEBOOK_REQUIRED_SCOPES,
  INSTAGRAM: INSTAGRAM_REQUIRED_SCOPES,
  GOOGLE: [GOOGLE_BUSINESS_MANAGE_SCOPE],
};

export const MARKETING_CONNECTION_LABELS: Record<MarketingConnectionDestination, string> = {
  FACEBOOK: "Facebook Page",
  INSTAGRAM: "Instagram",
  GOOGLE: "Google Business Profile",
};

export function marketingTokenPurpose(destination: string) {
  return `marketing-${destination.trim().toLowerCase()}`;
}

export function isMarketingConnectionDestination(
  value: string,
): value is MarketingConnectionDestination {
  return (MARKETING_CONNECTION_DESTINATIONS as readonly string[]).includes(value);
}

export function isFakeSocialOAuthAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") return false;
  return process.env.TBBT_SOCIAL_OAUTH_ADAPTER === "fake";
}

export function metaOAuthEnv() {
  return {
    appId: process.env.META_APP_ID?.trim() ?? "",
    appSecret: process.env.META_APP_SECRET?.trim() ?? "",
    redirectUri: process.env.META_OAUTH_REDIRECT_URI?.trim() ?? "",
  };
}

export function googleOAuthEnv() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "",
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ?? "",
  };
}

export function missingScopes(destination: MarketingConnectionDestination, granted: readonly string[]) {
  const have = new Set(granted);
  return REQUIRED_SCOPES_BY_DESTINATION[destination].filter((scope) => !have.has(scope));
}

export type MarketingDestinationAvailability = {
  available: boolean;
  message: string;
};

export function marketingDestinationAvailability(
  destination: SocialPublishDestination,
): MarketingDestinationAvailability {
  if (!isMarketingConnectionDestination(destination)) {
    return { available: false, message: "That marketing destination is not supported." };
  }
  if (isFakeSocialOAuthAdapterEnabled()) {
    if (!isConnectionTokenKeyConfigured()) {
      return {
        available: false,
        message: "Not available: needs CONNECTION_TOKEN_ENCRYPTION_KEY.",
      };
    }
    return { available: true, message: "" };
  }
  if (!isConnectionTokenKeyConfigured()) {
    return {
      available: false,
      message: "Not available: needs CONNECTION_TOKEN_ENCRYPTION_KEY.",
    };
  }
  if (destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE) {
    const google = googleOAuthEnv();
    if (!google.clientId || !google.clientSecret || !google.redirectUri) {
      return {
        available: false,
        message:
          "Not available: needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI. Google Business Profile API access approval is also required.",
      };
    }
    return { available: true, message: "" };
  }
  const meta = metaOAuthEnv();
  if (!meta.appId || !meta.appSecret || !meta.redirectUri) {
    return {
      available: false,
      message: "Not available: needs META_APP_ID, META_APP_SECRET, and META_OAUTH_REDIRECT_URI.",
    };
  }
  return { available: true, message: "" };
}
