/** Single destination vocabulary for marketing connect and publish. */
export const SOCIAL_PUBLISH_DESTINATION_FACEBOOK = "FACEBOOK" as const;
export const SOCIAL_PUBLISH_DESTINATION_INSTAGRAM = "INSTAGRAM" as const;
export const SOCIAL_PUBLISH_DESTINATION_GOOGLE = "GOOGLE" as const;

export const IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS = [
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
] as const;
export const DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS = [] as const;

export type ImplementedSocialPublishDestination =
  (typeof IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS)[number];
export type DisconnectedSocialPublishDestination =
  (typeof DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS)[number];
export type SocialPublishDestination =
  | ImplementedSocialPublishDestination
  | DisconnectedSocialPublishDestination;

export const SOCIAL_PUBLISH_ATTEMPT_STATUSES = ["CLAIMED", "PUBLISHED", "FAILED"] as const;
export type SocialPublishAttemptStatus = (typeof SOCIAL_PUBLISH_ATTEMPT_STATUSES)[number];

export type GoogleLocalPostPayload = {
  languageCode: string;
  summary: string;
  topicType: "STANDARD";
};

export type SocialPublishInput = {
  destination: ImplementedSocialPublishDestination;
  pageId: string;
  /**
   * Google Business Profile account resource. #347 stores
   * `accounts/{id}` on externalAccountId. Bare `{id}` is also accepted.
   */
  accountId?: string;
  accessToken: string;
  message: string;
  /** STANDARD local-post body. Required for GOOGLE. Never a ranking claim. */
  localPost?: GoogleLocalPostPayload;
  /** Public HTTPS image Meta can fetch. Instagram requires it. Never a private job URL. */
  imageUrl?: string;
};

export type SocialPublishResult = {
  ok: boolean;
  /**
   * PUBLISHED: definite provider success.
   * FAILED: definite provider rejection (HTTP response with an error).
   * UNKNOWN: timeout or network error — the provider may have posted.
   */
  status: "PUBLISHED" | "FAILED" | "UNKNOWN";
  outcome?: "rejected" | "unknown";
  providerPostId?: string;
  error?: string;
};

export type SocialPublishingProvider = {
  id: string;
  destination: SocialPublishDestination;
  /**
   * Adapter availability only. A business still needs its own connected
   * destination record. Tests inject a fake; production uses the official
   * Facebook Graph, Instagram, or Google Business Profile client.
   * Instagram never receives a private job photo URL.
   */
  connected: boolean;
  publish(input: SocialPublishInput): Promise<SocialPublishResult>;
};
