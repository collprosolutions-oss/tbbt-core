import { isFakeSocialPublishingAdapterEnabled } from "@/lib/social-publishing/config";
import { createDisconnectedSocialPublishingProvider } from "@/lib/social-publishing/disconnected";
import { createFacebookSocialPublishingProvider } from "@/lib/social-publishing/facebook";
import { createFakeSocialPublishingProvider } from "@/lib/social-publishing/fake";
import type { SocialPublishingProvider } from "@/lib/social-publishing/types";

let cached: SocialPublishingProvider | null = null;

export function getSocialPublishingProvider(): SocialPublishingProvider {
  if (!cached) {
    if (isFakeSocialPublishingAdapterEnabled()) {
      cached = createFakeSocialPublishingProvider();
    } else {
      cached = createFacebookSocialPublishingProvider();
    }
  }
  return cached;
}

export function resetSocialPublishingProvider() {
  cached = null;
}

export function setSocialPublishingProvider(provider: SocialPublishingProvider | null) {
  cached = provider;
}

export function disconnectedSocialPublishingProvider() {
  return createDisconnectedSocialPublishingProvider();
}
