import { DISCONNECTED_SOCIAL_PUBLISHING_PROVIDER } from "@/lib/social-publishing/config";
import type { SocialPublishResult, SocialPublishingProvider } from "@/lib/social-publishing/types";
import { SOCIAL_PUBLISH_DESTINATION_FACEBOOK } from "@/lib/social-publishing/types";

export function createDisconnectedSocialPublishingProvider(): SocialPublishingProvider {
  return {
    id: DISCONNECTED_SOCIAL_PUBLISHING_PROVIDER,
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    connected: false,
    async publish(): Promise<SocialPublishResult> {
      return {
        ok: false,
        status: "FAILED",
        error: "Social publishing is not connected.",
      };
    },
  };
}
