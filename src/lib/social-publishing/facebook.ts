/**
 * Official current Facebook Page publish client.
 *
 * Graph API v26.0 POST /{page-id}/feed
 * https://developers.facebook.com/docs/graph-api/reference/page/feed/
 * https://developers.facebook.com/documentation/pages-api/getting-started
 *
 * Requires a Page access token with pages_manage_posts. This module does
 * not schedule posts, publish to Instagram, or call Google. Tests must
 * inject a fake provider and never reach this fetch.
 */
import { sanitizeSocialPublishProviderError } from "@/lib/marketing";
import { FACEBOOK_SOCIAL_PUBLISHING_PROVIDER } from "@/lib/social-publishing/config";
import type {
  SocialPublishInput,
  SocialPublishResult,
  SocialPublishingProvider,
} from "@/lib/social-publishing/types";
import { SOCIAL_PUBLISH_DESTINATION_FACEBOOK } from "@/lib/social-publishing/types";

export const FACEBOOK_GRAPH_API_VERSION = "v26.0";
export const FACEBOOK_GRAPH_API_HOST = "https://graph.facebook.com";
export const FACEBOOK_PUBLISH_TIMEOUT_MS = 8000;

export type FacebookGraphFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type FacebookSocialPublishingProvider = SocialPublishingProvider & {
  apiVersion: typeof FACEBOOK_GRAPH_API_VERSION;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerErrorMessage(payload: unknown, fallback: string, accessToken?: string) {
  const record = asRecord(payload);
  const error = asRecord(record?.error);
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return sanitizeSocialPublishProviderError(message || fallback, accessToken);
}

export function facebookPageFeedUrl(pageId: string) {
  return `${FACEBOOK_GRAPH_API_HOST}/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/feed`;
}

export function createFacebookSocialPublishingProvider(
  fetchImpl: FacebookGraphFetch = fetch,
): FacebookSocialPublishingProvider {
  return {
    id: FACEBOOK_SOCIAL_PUBLISHING_PROVIDER,
    destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
    connected: true,
    apiVersion: FACEBOOK_GRAPH_API_VERSION,
    async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FACEBOOK_PUBLISH_TIMEOUT_MS);
      try {
        const body = new URLSearchParams();
        body.set("message", input.message);
        body.set("access_token", input.accessToken);
        const response = await fetchImpl(facebookPageFeedUrl(input.pageId), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: controller.signal,
        });
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const record = asRecord(payload);
        const providerPostId = typeof record?.id === "string" ? record.id.trim() : "";
        if (response.ok && providerPostId) {
          return { ok: true, status: "PUBLISHED", providerPostId };
        }
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: providerErrorMessage(payload, "Facebook rejected the post.", input.accessToken),
        };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        const raw = timedOut
          ? "Facebook publish timed out."
          : error instanceof Error
            ? error.message
            : "Facebook publish failed.";
        return {
          ok: false,
          status: "UNKNOWN",
          outcome: "unknown",
          error: sanitizeSocialPublishProviderError(raw, input.accessToken) || raw,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
