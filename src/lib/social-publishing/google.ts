/**
 * Official current Google Business Profile local-post client.
 *
 * My Business API v4 POST accounts/{accountId}/locations/{locationId}/localPosts
 * https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create
 * https://developers.google.com/my-business/content/posts-data
 *
 * Requires OAuth with https://www.googleapis.com/auth/business.manage after
 * Google approves the Cloud project for Business Profile API access. This
 * module posts a STANDARD local post only. It does not schedule posts,
 * publish to Instagram or Facebook, or claim ranking improvements. Tests
 * must inject a fake provider and never reach this fetch.
 */
import { sanitizeSocialPublishProviderError } from "@/lib/marketing";
import { GOOGLE_SOCIAL_PUBLISHING_PROVIDER } from "@/lib/social-publishing/config";
import type {
  GoogleLocalPostPayload,
  SocialPublishInput,
  SocialPublishResult,
  SocialPublishingProvider,
} from "@/lib/social-publishing/types";
import { SOCIAL_PUBLISH_DESTINATION_GOOGLE } from "@/lib/social-publishing/types";

export const GOOGLE_MY_BUSINESS_API_VERSION = "v4";
export const GOOGLE_MY_BUSINESS_API_HOST = "https://mybusiness.googleapis.com";
export const GOOGLE_LOCAL_POST_TIMEOUT_MS = 8000;
export const GOOGLE_BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";
export const GOOGLE_LOCAL_POST_TOPIC_STANDARD = "STANDARD" as const;
export const GOOGLE_LOCAL_POST_LANGUAGE = "en";
export const GOOGLE_LOCAL_POST_SUMMARY_MAX = 1500;
export const GOOGLE_LOCATION_RESOURCE_PATTERN = /^accounts\/([^/]+)\/locations\/([^/]+)$/;
export const GOOGLE_ACCOUNT_RESOURCE_PATTERN = /^accounts\/([^/]+)$/;
export const GOOGLE_RECONNECT_NEEDED_MESSAGE =
  "Google Business Profile access expired. Reconnect needed. TBBT will not post.";

export type GoogleBusinessProfileFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type GoogleSocialPublishingProvider = SocialPublishingProvider & {
  apiVersion: typeof GOOGLE_MY_BUSINESS_API_VERSION;
};

export type ParsedGoogleLocationResource = {
  accountId: string;
  locationId: string;
  parent: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function googleErrorObject(payload: unknown) {
  return asRecord(asRecord(payload)?.error);
}

function providerErrorMessage(payload: unknown, fallback: string, accessToken?: string) {
  const error = googleErrorObject(payload);
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return sanitizeSocialPublishProviderError(message || fallback, accessToken);
}

function isDefiniteGoogleRejection(
  response: { ok: boolean; status: number },
  payload: unknown,
) {
  return !response.ok && response.status < 500 && googleErrorObject(payload) != null;
}

function unknownPublishResult(raw: string, accessToken?: string): SocialPublishResult {
  return {
    ok: false,
    status: "UNKNOWN",
    outcome: "unknown",
    error: sanitizeSocialPublishProviderError(raw, accessToken) || raw,
  };
}

export function parseGoogleLocationResource(pageId: string): ParsedGoogleLocationResource | null {
  const match = pageId.trim().match(GOOGLE_LOCATION_RESOURCE_PATTERN);
  if (!match) return null;
  return {
    accountId: match[1],
    locationId: match[2],
    parent: `accounts/${match[1]}/locations/${match[2]}`,
  };
}

export function googleLocalPostsUrl(parent: string) {
  const location = parseGoogleLocationResource(parent);
  if (!location) {
    throw new Error("Google location is not a bound accounts/{accountId}/locations/{locationId} resource.");
  }
  return `${GOOGLE_MY_BUSINESS_API_HOST}/${GOOGLE_MY_BUSINESS_API_VERSION}/${location.parent}/localPosts`;
}

export function normalizeGoogleAccountId(account: string) {
  const trimmed = account.trim();
  if (!trimmed) return "";
  const resource = trimmed.match(GOOGLE_ACCOUNT_RESOURCE_PATTERN);
  if (resource) return resource[1];
  return trimmed.includes("/") ? "" : trimmed;
}

export function isGoogleAccountBoundToLocation(accountId: string, pageId: string) {
  const location = parseGoogleLocationResource(pageId);
  const account = normalizeGoogleAccountId(accountId);
  return Boolean(location && account && location.accountId === account);
}

export function isGoogleReconnectNeededStatus(
  response: { status: number },
  payload: unknown,
) {
  if (response.status === 401) return true;
  const error = googleErrorObject(payload);
  return error?.status === "UNAUTHENTICATED";
}

export function composeGoogleLocalPostPayload(input: {
  summary: string;
  languageCode?: string;
}): GoogleLocalPostPayload | null {
  const summary = input.summary.trim();
  if (!summary) return null;
  return {
    languageCode: input.languageCode?.trim() || GOOGLE_LOCAL_POST_LANGUAGE,
    summary,
    topicType: GOOGLE_LOCAL_POST_TOPIC_STANDARD,
  };
}

export function createGoogleSocialPublishingProvider(
  fetchImpl: GoogleBusinessProfileFetch = fetch,
): GoogleSocialPublishingProvider {
  return {
    id: GOOGLE_SOCIAL_PUBLISHING_PROVIDER,
    destination: SOCIAL_PUBLISH_DESTINATION_GOOGLE,
    connected: true,
    apiVersion: GOOGLE_MY_BUSINESS_API_VERSION,
    async publish(input: SocialPublishInput): Promise<SocialPublishResult> {
      if (input.destination !== SOCIAL_PUBLISH_DESTINATION_GOOGLE) {
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: "Google local-post publish was called for a different destination.",
        };
      }
      const location = parseGoogleLocationResource(input.pageId);
      const accountId = input.accountId?.trim() || "";
      if (!location || !isGoogleAccountBoundToLocation(accountId, input.pageId)) {
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: "Google Business Profile location is not bound to this business account.",
        };
      }
      const localPost =
        input.localPost ??
        composeGoogleLocalPostPayload({
          summary: input.message,
        });
      if (!localPost || localPost.topicType !== GOOGLE_LOCAL_POST_TOPIC_STANDARD || !localPost.summary.trim()) {
        return {
          ok: false,
          status: "FAILED",
          outcome: "rejected",
          error: "A STANDARD Google local post requires approved text.",
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GOOGLE_LOCAL_POST_TIMEOUT_MS);
      try {
        const response = await fetchImpl(googleLocalPostsUrl(location.parent), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            languageCode: localPost.languageCode,
            summary: localPost.summary,
            topicType: localPost.topicType,
          }),
          signal: controller.signal,
        });
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          return unknownPublishResult(
            "Google Business Profile returned an unreadable response.",
            input.accessToken,
          );
        }
        const record = asRecord(payload);
        const providerPostId = typeof record?.name === "string" ? record.name.trim() : "";
        if (response.ok && providerPostId) {
          return { ok: true, status: "PUBLISHED", providerPostId };
        }
        if (isGoogleReconnectNeededStatus(response, payload)) {
          return {
            ok: false,
            status: "FAILED",
            outcome: "rejected",
            error: GOOGLE_RECONNECT_NEEDED_MESSAGE,
          };
        }
        if (isDefiniteGoogleRejection(response, payload)) {
          return {
            ok: false,
            status: "FAILED",
            outcome: "rejected",
            error: providerErrorMessage(
              payload,
              "Google Business Profile rejected the local post.",
              input.accessToken,
            ),
          };
        }
        return unknownPublishResult(
          providerErrorMessage(
            payload,
            "Google Business Profile publish outcome is unconfirmed.",
            input.accessToken,
          ),
          input.accessToken,
        );
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        const raw = timedOut
          ? "Google Business Profile publish timed out."
          : error instanceof Error
            ? error.message
            : "Google Business Profile publish failed.";
        return unknownPublishResult(raw, input.accessToken);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
