import { randomUUID } from "node:crypto";
import { FAKE_SOCIAL_PUBLISHING_PROVIDER } from "@/lib/social-publishing/config";
import type {
  SocialPublishInput,
  SocialPublishResult,
  SocialPublishingProvider,
} from "@/lib/social-publishing/types";
import { GOOGLE_RECONNECT_NEEDED_MESSAGE } from "@/lib/social-publishing/google";
import {
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
} from "@/lib/social-publishing/types";

export type FakeSocialPublishingProvider = SocialPublishingProvider & {
  published: SocialPublishInput[];
  callCount: number;
  delayMs: number;
  failNext: boolean;
  throwNext: boolean;
  unknownNext: boolean;
  leakNext: boolean;
  expiredNext: boolean;
  setFailNext(value: boolean): void;
  setThrowNext(value: boolean): void;
  setUnknownNext(value: boolean): void;
  setLeakNext(value: boolean): void;
  setExpiredNext(value: boolean): void;
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
    expiredNext: false,
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
    setExpiredNext(value) {
      provider.expiredNext = value;
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
        const leaked =
          input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE
            ? `Google said invalid token ${input.accessToken} ya29.OtherLeakedTokenABC123`
            : `Graph said invalid token ${input.accessToken} EAAOtherLeakedTokenABC123`;
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: leaked,
        };
      }
      if (provider.expiredNext) {
        provider.expiredNext = false;
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error:
            input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE
              ? GOOGLE_RECONNECT_NEEDED_MESSAGE
              : "Fake social provider rejected an expired token.",
        };
      }
      if (provider.failNext) {
        provider.failNext = false;
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error:
            input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE
              ? "Fake Google local-post provider rejected the post."
              : "Fake social provider rejected the post.",
        };
      }
      published.push(input);
      return {
        ok: true,
        status: "PUBLISHED",
        providerPostId:
          input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE
            ? `fake_gbp_${randomUUID()}`
            : input.destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM
              ? `fake_ig_${randomUUID()}`
              : `fake_fb_${randomUUID()}`,
      };
    },
  };

  return provider;
}
