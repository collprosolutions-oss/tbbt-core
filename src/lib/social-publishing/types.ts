export const SOCIAL_PUBLISH_DESTINATION_FACEBOOK = "FACEBOOK" as const;
export const SOCIAL_PUBLISH_DESTINATION_INSTAGRAM = "INSTAGRAM" as const;
export const SOCIAL_PUBLISH_DESTINATION_GOOGLE = "GOOGLE" as const;

export const IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS = [SOCIAL_PUBLISH_DESTINATION_FACEBOOK] as const;
export const DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS = [
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
] as const;

export type ImplementedSocialPublishDestination =
  (typeof IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS)[number];
export type DisconnectedSocialPublishDestination =
  (typeof DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS)[number];
export type SocialPublishDestination =
  | ImplementedSocialPublishDestination
  | DisconnectedSocialPublishDestination;

export const SOCIAL_PUBLISH_ATTEMPT_STATUSES = ["CLAIMED", "PUBLISHED", "FAILED"] as const;
export type SocialPublishAttemptStatus = (typeof SOCIAL_PUBLISH_ATTEMPT_STATUSES)[number];

export type SocialPublishInput = {
  destination: ImplementedSocialPublishDestination;
  pageId: string;
  accessToken: string;
  message: string;
};

export type SocialPublishResult = {
  ok: boolean;
  status: "PUBLISHED" | "FAILED";
  providerPostId?: string;
  error?: string;
};

export type SocialPublishingProvider = {
  id: string;
  destination: ImplementedSocialPublishDestination;
  /**
   * Adapter availability only. A business still needs its own connected
   * Facebook destination record. Tests inject a fake; production uses
   * the official Graph API client.
   */
  connected: boolean;
  publish(input: SocialPublishInput): Promise<SocialPublishResult>;
};
