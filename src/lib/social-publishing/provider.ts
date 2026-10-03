import { isFakeSocialPublishingAdapterEnabled } from "@/lib/social-publishing/config";
import { createDisconnectedSocialPublishingProvider } from "@/lib/social-publishing/disconnected";
import { createFacebookSocialPublishingProvider } from "@/lib/social-publishing/facebook";
import { createFakeSocialPublishingProvider } from "@/lib/social-publishing/fake";
import { createInstagramSocialPublishingProvider } from "@/lib/social-publishing/instagram";
import type { SocialPublishDestination, SocialPublishingProvider } from "@/lib/social-publishing/types";
import {
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
} from "@/lib/social-publishing/types";

let cachedFacebook: SocialPublishingProvider | null = null;
let cachedInstagram: SocialPublishingProvider | null = null;

export function getSocialPublishingProvider(): SocialPublishingProvider {
  if (!cachedFacebook) {
    if (isFakeSocialPublishingAdapterEnabled()) {
      cachedFacebook = createFakeSocialPublishingProvider();
    } else {
      cachedFacebook = createFacebookSocialPublishingProvider();
    }
  }
  return cachedFacebook;
}

export function getInstagramSocialPublishingProvider(): SocialPublishingProvider {
  if (!cachedInstagram) {
    if (isFakeSocialPublishingAdapterEnabled()) {
      cachedInstagram = createFakeSocialPublishingProvider();
    } else {
      cachedInstagram = createInstagramSocialPublishingProvider();
    }
  }
  return cachedInstagram;
}

export function resetSocialPublishingProvider() {
  cachedFacebook = null;
  cachedInstagram = null;
}

export function setSocialPublishingProvider(provider: SocialPublishingProvider | null) {
  cachedFacebook = provider;
  cachedInstagram = provider;
}

export function disconnectedSocialPublishingProvider() {
  return createDisconnectedSocialPublishingProvider();
}

export function createUnavailableSocialPublishingProvider(
  destination: string,
): SocialPublishingProvider {
  const resolved: SocialPublishDestination =
    destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM
      ? SOCIAL_PUBLISH_DESTINATION_INSTAGRAM
      : destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE
        ? SOCIAL_PUBLISH_DESTINATION_GOOGLE
        : SOCIAL_PUBLISH_DESTINATION_FACEBOOK;
  const error =
    resolved === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM
      ? "Instagram publishing is not yet available."
      : resolved === SOCIAL_PUBLISH_DESTINATION_GOOGLE
        ? "Google Business Profile publishing is not yet available."
        : "Social publishing is not connected.";
  return {
    id: "unavailable",
    destination: resolved,
    connected: false,
    async publish() {
      return { ok: false, status: "FAILED", outcome: "rejected", error };
    },
  };
}

export function getSocialPublishingProviderForDestination(destination: string): SocialPublishingProvider {
  if (destination === SOCIAL_PUBLISH_DESTINATION_FACEBOOK) {
    return getSocialPublishingProvider();
  }
  if (destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM) {
    return getInstagramSocialPublishingProvider();
  }
  return createUnavailableSocialPublishingProvider(destination);
}
