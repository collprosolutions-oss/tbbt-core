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
  callCount: number;
  delayMs: number;
  failNext: boolean;
  throwNext: boolean;
  unknownNext: boolean;
  leakNext: boolean;
  setFailNext(value: boolean): void;
  setThrowNext(value: boolean): void;
  setUnknownNext(value: boolean): void;
  setLeakNext(value: boolean): void;
  setDelayMs(value: number): void;
};

export function createFakeSocialPublishingProvider(): FakeSocialPublishingProvider {
  const published: SocialPublishInput[] = [];

  const provider: FakeSocialPublishingProvider = {
    id: FAKE_SOCIAL_PUBLISHING_PROVIDER,
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    connected: true,
    published,
    callCount: 0,
    delayMs: 0,
    failNext: false,
    throwNext: false,
    unknownNext: false,
    leakNext: false,
    setFailNext(value) {
      provider.failNext = value;
    },
    setThrowNext(value) {
      provider.throwNext = value;
    },
    setUnknownNext(value) {
      provider.unknownNext = value;
    },
    setLeakNext(value) {
      provider.leakNext = value;
    },
    setDelayMs(value) {
      provider.delayMs = value;
    },
    async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
      provider.callCount += 1;
      if (provider.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, provider.delayMs));
      }
      if (provider.throwNext) {
        provider.throwNext = false;
        throw new Error("Fake social provider threw.");
      }
      if (provider.unknownNext) {
        provider.unknownNext = false;
        return {
          ok: false,
          status: "UNKNOWN",
          outcome: "unknown",
          error: "Fake social provider timed out.",
        };
      }
      if (provider.leakNext) {
        provider.leakNext = false;
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: `Graph said invalid token ${input.accessToken} EAAOtherLeakedTokenABC123`,
        };
      }
      if (provider.failNext) {
        provider.failNext = false;
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: "Fake social provider rejected the post.",
        };
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
