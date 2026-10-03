/**
 * Official current Instagram professional-account publish client.
 *
 * Graph API v26.0:
 *   POST /{ig-user-id}/media        image_url + caption
 *   POST /{ig-user-id}/media_publish creation_id
 * https://developers.facebook.com/docs/instagram-api/guides/content-publishing
 *
 * image_url must be a public marketing asset Meta can fetch. This module
 * refuses private job or customer photo URLs and does not call Graph
 * without a public image. Tests must inject a fake provider or fake
 * fetch and never reach a live post.
 */
import { isPublicMarketingAssetUrl, sanitizeSocialPublishProviderError } from "@/lib/marketing";
import { INSTAGRAM_SOCIAL_PUBLISHING_PROVIDER } from "@/lib/social-publishing/config";
import { FACEBOOK_GRAPH_API_HOST, FACEBOOK_GRAPH_API_VERSION } from "@/lib/social-publishing/facebook";
import type {
  SocialPublishInput,
  SocialPublishResult,
  SocialPublishingProvider,
} from "@/lib/social-publishing/types";
import { SOCIAL_PUBLISH_DESTINATION_INSTAGRAM } from "@/lib/social-publishing/types";

export const INSTAGRAM_PUBLISH_TIMEOUT_MS = 8000;
export const INSTAGRAM_PUBLIC_IMAGE_REQUIRED_MESSAGE =
  "Instagram publish needs an approved public marketing image. Private job or customer photos are not sent.";

export type InstagramGraphFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type InstagramSocialPublishingProvider = SocialPublishingProvider & {
  apiVersion: typeof FACEBOOK_GRAPH_API_VERSION;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function graphErrorObject(payload: unknown) {
  return asRecord(asRecord(payload)?.error);
}

function providerErrorMessage(payload: unknown, fallback: string, accessToken?: string) {
  const error = graphErrorObject(payload);
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return sanitizeSocialPublishProviderError(message || fallback, accessToken);
}

function isDefiniteGraphRejection(
  response: { ok: boolean; status: number },
  payload: unknown,
) {
  return !response.ok && response.status < 500 && graphErrorObject(payload) != null;
}

function unknownPublishResult(raw: string, accessToken?: string): SocialPublishResult {
  return {
    ok: false,
    status: "UNKNOWN",
    outcome: "unknown",
    error: sanitizeSocialPublishProviderError(raw, accessToken) || raw,
  };
}

export function instagramMediaContainerUrl(igUserId: string) {
  return `${FACEBOOK_GRAPH_API_HOST}/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(igUserId)}/media`;
}

export function instagramMediaPublishUrl(igUserId: string) {
  return `${FACEBOOK_GRAPH_API_HOST}/${FACEBOOK_GRAPH_API_VERSION}/${encodeURIComponent(igUserId)}/media_publish`;
}

export function createInstagramSocialPublishingProvider(
  fetchImpl: InstagramGraphFetch = fetch,
): InstagramSocialPublishingProvider {
  return {
    id: INSTAGRAM_SOCIAL_PUBLISHING_PROVIDER,
    destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
    connected: true,
    apiVersion: FACEBOOK_GRAPH_API_VERSION,
    async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
      const imageUrl = input.imageUrl?.trim() ?? "";
      if (!imageUrl || !isPublicMarketingAssetUrl(imageUrl)) {
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: INSTAGRAM_PUBLIC_IMAGE_REQUIRED_MESSAGE,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), INSTAGRAM_PUBLISH_TIMEOUT_MS);
      try {
        const containerBody = new URLSearchParams();
        containerBody.set("image_url", imageUrl);
        containerBody.set("caption", input.message);
        containerBody.set("access_token", input.accessToken);
        const containerResponse = await fetchImpl(instagramMediaContainerUrl(input.pageId), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: containerBody.toString(),
          signal: controller.signal,
        });
        let containerPayload: unknown = null;
        try {
          containerPayload = await containerResponse.json();
        } catch {
          return unknownPublishResult("Instagram returned an unreadable container response.", input.accessToken);
        }
        const creationId = typeof asRecord(containerPayload)?.id === "string"
          ? String(asRecord(containerPayload)?.id).trim()
          : "";
        if (!containerResponse.ok || !creationId) {
          if (isDefiniteGraphRejection(containerResponse, containerPayload)) {
            return {
              ok: false,
              status: "FAILED",
              outcome: "rejected",
              error: providerErrorMessage(containerPayload, "Instagram rejected the media container.", input.accessToken),
            };
          }
          return unknownPublishResult(
            providerErrorMessage(containerPayload, "Instagram container outcome is unconfirmed.", input.accessToken),
            input.accessToken,
          );
        }

        const publishBody = new URLSearchParams();
        publishBody.set("creation_id", creationId);
        publishBody.set("access_token", input.accessToken);
        const publishResponse = await fetchImpl(instagramMediaPublishUrl(input.pageId), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: publishBody.toString(),
          signal: controller.signal,
        });
        let publishPayload: unknown = null;
        try {
          publishPayload = await publishResponse.json();
        } catch {
          return unknownPublishResult("Instagram returned an unreadable publish response.", input.accessToken);
        }
        const providerPostId = typeof asRecord(publishPayload)?.id === "string"
          ? String(asRecord(publishPayload)?.id).trim()
          : "";
        if (publishResponse.ok && providerPostId) {
          return { ok: true, status: "PUBLISHED", providerPostId };
        }
        if (isDefiniteGraphRejection(publishResponse, publishPayload)) {
          return {
            ok: false,
            status: "FAILED",
            outcome: "rejected",
            error: providerErrorMessage(publishPayload, "Instagram rejected the post.", input.accessToken),
          };
        }
        return unknownPublishResult(
          providerErrorMessage(publishPayload, "Instagram publish outcome is unconfirmed.", input.accessToken),
          input.accessToken,
        );
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        const raw = timedOut
          ? "Instagram publish timed out."
          : error instanceof Error
            ? error.message
            : "Instagram publish failed.";
        return unknownPublishResult(raw, input.accessToken);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
