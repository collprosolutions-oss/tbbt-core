import { randomUUID } from "node:crypto";
import { FAKE_SOCIAL_PUBLISHING_PROVIDER } from "@/lib/social-publishing/config";
import type {
  SocialPublishInput,
  SocialPublishResult,
  SocialPublishingProvider,
} from "@/lib/social-publishing/types";
import { SOCIAL_PUBLISH_DESTINATION_FACEBOOK } from "@/lib/social-publishing/types";

export type FakeSocialPublishingProvider = SocialPublishingProvider & {
  published: SocialPublishInput[];
  failNext: boolean;
  throwNext: boolean;
  setFailNext(value: boolean): void;
  setThrowNext(value: boolean): void;
};

export function createFakeSocialPublishingProvider(): FakeSocialPublishingProvider {
  const published: SocialPublishInput[] = [];

  const provider: FakeSocialPublishingProvider = {
    id: FAKE_SOCIAL_PUBLISHING_PROVIDER,
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    connected: true,
    published,
    failNext: false,
    throwNext: false,
    setFailNext(value) {
      provider.failNext = value;
    },
    setThrowNext(value) {
      provider.throwNext = value;
    },
    async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
      if (provider.throwNext) {
        provider.throwNext = false;
        throw new Error("Fake social provider threw.");
      }
      if (provider.failNext) {
        provider.failNext = false;
        return { ok: false, status: "FAILED", error: "Fake social provider rejected the post." };
      }
      published.push(input);
      return {
        ok: true,
        status: "PUBLISHED",
        providerPostId: `fake_fb_${randomUUID()}`,
      };
    },
  };

  return provider;
}
