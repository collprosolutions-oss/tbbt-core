/**
 * Marketing Studio domain -- internal content workflow over real TBBT
 * records (completed Jobs, Job Photos, catalog services, Business).
 *
 * Photos stay PRIVATE until an explicit recorded marketing permission
 * exists. Content never implies an external publish. This module does
 * not invent impressions, clicks, followers, ROI, or connected channels.
 *
 * No next/headers dependency -- authorization/isolation check scripts
 * import these helpers directly.
 */

import { formatISODateInTimeZone, parseCivilDateInTimeZone, zonedWeekday } from "@/lib/business-timezone";
import {
  DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS,
  IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  type ImplementedSocialPublishDestination,
} from "@/lib/social-publishing/types";

export {
  DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS,
  IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
};
export type { ImplementedSocialPublishDestination } from "@/lib/social-publishing/types";
import { marketingAiAssistAvailable as providerAssistAvailable } from "@/lib/marketing-draft";
import { parseScheduleDate, startOfDay, startOfWeek } from "@/lib/schedule";

export const MARKETING_AREAS = [
  "overview",
  "grow",
  "completed-jobs",
  "create-content",
  "approval-queue",
  "calendar",
  "social-posts",
  "website-seo",
  "campaigns",
  "lead-sources",
  "performance",
  "brand-library",
] as const;
export type MarketingArea = (typeof MARKETING_AREAS)[number];

export const MARKETING_AREA_LABELS: Record<MarketingArea, string> = {
  overview: "Overview",
  grow: "Grow My Business",
  "completed-jobs": "Completed Jobs",
  "create-content": "Create Content",
  "approval-queue": "Weekly review",
  calendar: "Content Calendar",
  "social-posts": "Social Posts",
  "website-seo": "Website / SEO",
  campaigns: "Campaigns",
  "lead-sources": "Lead Sources",
  performance: "Performance",
  "brand-library": "Brand Library",
};

export const IMPLEMENTED_MARKETING_AREAS: readonly MarketingArea[] = [
  "overview",
  "grow",
  "completed-jobs",
  "create-content",
  "approval-queue",
  "calendar",
  "social-posts",
  "website-seo",
  "campaigns",
  "lead-sources",
  "performance",
  "brand-library",
];

export function isMarketingArea(value: string | undefined): value is MarketingArea {
  return (MARKETING_AREAS as readonly string[]).includes(value ?? "");
}

export function parseMarketingArea(raw: string | undefined): MarketingArea {
  return isMarketingArea(raw) ? raw : "overview";
}

export function isImplementedMarketingArea(area: MarketingArea): boolean {
  return IMPLEMENTED_MARKETING_AREAS.includes(area);
}

export const MARKETING_CONTENT_TYPES = [
  "COMPLETED_JOB",
  "SERVICE_HIGHLIGHT",
  "GENERAL_POST",
  "BLOG_SEO",
] as const;
export type MarketingContentType = (typeof MARKETING_CONTENT_TYPES)[number];

export const MARKETING_CONTENT_TYPE_LABELS: Record<MarketingContentType, string> = {
  COMPLETED_JOB: "Completed Job / Before & After",
  SERVICE_HIGHLIGHT: "Service Highlight",
  GENERAL_POST: "General Business Post",
  BLOG_SEO: "Blog / SEO draft",
};

export function isMarketingContentType(value: string): value is MarketingContentType {
  return (MARKETING_CONTENT_TYPES as readonly string[]).includes(value);
}

export const MARKETING_CHANNELS = [
  "UNASSIGNED",
  "FACEBOOK",
  "INSTAGRAM",
  "GOOGLE",
  "WEBSITE",
  "OTHER",
] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

export const MARKETING_CHANNEL_LABELS: Record<MarketingChannel, string> = {
  UNASSIGNED: "Unassigned",
  FACEBOOK: "Facebook (intent only)",
  INSTAGRAM: "Instagram (intent only)",
  GOOGLE: "Google (intent only)",
  WEBSITE: "Website (intent only)",
  OTHER: "Other (intent only)",
};

export function isMarketingChannel(value: string): value is MarketingChannel {
  return (MARKETING_CHANNELS as readonly string[]).includes(value);
}

export const MARKETING_CONTENT_STATUSES = ["DRAFT", "READY_FOR_REVIEW", "APPROVED"] as const;
export type MarketingContentStatus = (typeof MARKETING_CONTENT_STATUSES)[number];

export const MARKETING_CONTENT_STATUS_LABELS: Record<MarketingContentStatus, string> = {
  DRAFT: "Draft",
  READY_FOR_REVIEW: "Ready for review",
  APPROVED: "Approved",
};

export function isMarketingContentStatus(value: string): value is MarketingContentStatus {
  return (MARKETING_CONTENT_STATUSES as readonly string[]).includes(value);
}

export const PHOTO_PERMISSION_PRIVATE = "PRIVATE";
export const PHOTO_PERMISSION_APPROVED = "APPROVED";

export function isMarketingApprovedPhoto(status: string | null | undefined): boolean {
  return status === PHOTO_PERMISSION_APPROVED;
}

export const CHANNELS_DISCONNECTED_MESSAGE =
  "No Facebook, Instagram, or Google Business Profile account is connected. External publishing is not available.";

export const PERFORMANCE_UNAVAILABLE_MESSAGE =
  "Channel performance is not available. TBBT is not connected to any ad or social analytics provider.";

export const CALENDAR_INTERNAL_MESSAGE =
  "This is an internal planning date only. TBBT will not publish this item automatically — no social channel is connected.";

export const STUDIO_CONTENT_CALENDAR_LIMIT = 50;

export const OWNER_STUDIO_CALENDAR_MESSAGE =
  "Planning a publication day requires the OWNER role. TBBT will not approve, publish, post, send a message, or claim a provider connection.";

export const OWNER_CONTENT_DRAFT_MESSAGE =
  "Requesting an AI content draft requires the OWNER role. TBBT will not publish, post, send a customer message, or invent business facts.";

export const MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE = "Unavailable";

export const MARKETING_OWNER_DRAFT_COST_BOUNDED_MESSAGE =
  "This month's marketing draft budget is used. No draft was created.";

export const MARKETING_OWNER_DRAFT_REVIEW_MESSAGE =
  "Owner-requested draft saved for review. It was not published, posted, or sent.";

export const MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS = 2_000;
export const MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS = 400;
export const MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT = 25;
export const MARKETING_OWNER_DRAFT_MONTHLY_TOKEN_BUDGET = 8_000;
export const MARKETING_OWNER_DRAFT_BURST_LIMIT = 5;
export const MARKETING_OWNER_DRAFT_BURST_WINDOW_MS = 60_000;
export const MARKETING_OWNER_DRAFT_BURST_BOUNDED_MESSAGE =
  "Too many draft requests in a short window. No draft was created.";

export function canRequestOwnerMarketingContentDraft(role: string) {
  return role === "OWNER";
}

export const STUDIO_CONTENT_CALENDAR_MESSAGE =
  "This content calendar lists recorded creator packages and their planned publication day in this business timezone. TBBT will not approve, publish, post, send a message, or claim a provider connection.";

export const STUDIO_CONTENT_CALENDAR_LIMITS_MESSAGE =
  "Unplanned packages and packages planned from today in this business timezone always appear, up to 50 each. Past planned days are listed separately, also up to 50.";

export const STUDIO_PLANNED_DAY_SAVED_MESSAGE =
  "Planned publication day saved in this business timezone. The package was not approved, published, posted, or sent.";

export const STUDIO_PLANNED_DAY_INVALID_MESSAGE =
  "Enter a valid planned publication day.";

export const STUDIO_PLANNED_DAY_STALE_MESSAGE =
  "This package changed while you were planning. Refresh and try again.";

export const STUDIO_PLANNED_DAY_SNAPSHOT_REQUIRED_MESSAGE =
  "Planning requires the current package snapshot. Refresh and try again.";

export const STUDIO_PACKAGE_STALE_MESSAGE =
  "This package changed while you were editing. Refresh and try again.";

export const STUDIO_CALENDAR_PACKAGE_NOT_FOUND_MESSAGE =
  "That creator package is not in this business.";

export const STUDIO_CALENDAR_EXPORT_EXPORTED_LABEL = "Handoff exported";
export const STUDIO_CALENDAR_EXPORT_NOT_EXPORTED_LABEL = "Not exported";
export const STUDIO_CALENDAR_UNSCHEDULED_LABEL = "No planned day";
export const STUDIO_CALENDAR_PAST_LABEL = "Past planned days";

export const LEAD_SOURCE_UNTRACKED_MESSAGE =
  "No recorded lead source is on file yet. TBBT will not invent attribution.";

export const LEAD_SOURCE_TRACKED_MESSAGE =
  "Lead sources below are recorded on ServiceRequest, Estimate, Job, and Customer first-touch fields only.";

export const SOCIAL_MANUAL_COPY_MESSAGE =
  "No Facebook, Instagram, or Google account is connected. Copy approved text and post it yourself. TBBT will not mark this PUBLISHED.";

export const SOCIAL_PUBLISH_ATTEMPT_CLAIMED = "CLAIMED" as const;
export const SOCIAL_PUBLISH_ATTEMPT_PUBLISHED = "PUBLISHED" as const;
export const SOCIAL_PUBLISH_ATTEMPT_FAILED = "FAILED" as const;

export const OWNER_SOCIAL_PUBLISH_MESSAGE =
  "Publishing to Facebook requires the OWNER role. A DRAFT or planned day is not a publish. Instagram and Google stay disconnected.";

export const FACEBOOK_CONNECTED_OTHERS_DISCONNECTED_MESSAGE =
  "Facebook Page is connected for explicit OWNER publish. Instagram and Google Business Profile are not connected.";

export const SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE =
  "Only OWNER-approved creator packages can be published. A DRAFT or planned day is not a publish.";

export const SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE =
  "Facebook is not connected for this business. TBBT will not post.";

export const SOCIAL_PUBLISH_DESTINATION_NOT_IMPLEMENTED_MESSAGE =
  "Instagram and Google publishing are not connected yet.";

export const SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE =
  "This package was already published to Facebook.";

export const SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE =
  "A Facebook publish is already in progress. It is not marked PUBLISHED. TBBT will not send another post.";

export const SOCIAL_PUBLISH_FAILED_MESSAGE =
  "Facebook publish failed. It was not marked PUBLISHED.";

export const SOCIAL_PUBLISH_PUBLISHED_MESSAGE = "Published to Facebook.";

export const SOCIAL_PUBLISH_UNCONFIRMED_MS = 5 * 60 * 1000;
export const SOCIAL_PUBLISH_ERROR_MAX_CHARS = 200;
export const SOCIAL_PUBLISH_PAGE_TOKEN_PATTERN = /EAA[A-Za-z0-9]+/g;

export const SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE =
  "This Facebook publish is unconfirmed. Check your Facebook Page, then confirm.";

export const SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE =
  "This Facebook publish is unconfirmed. Check your Facebook Page, then confirm before retrying.";

export const SOCIAL_PUBLISH_RESOLVE_NOT_POSTED = "NOT_POSTED" as const;
export const SOCIAL_PUBLISH_RESOLVE_POSTED = "POSTED" as const;

export const SOCIAL_PUBLISH_RESOLVE_NOT_POSTED_MESSAGE =
  "Marked as not posted. You can retry. It was not labeled PUBLISHED.";

export const SOCIAL_PUBLISH_RESOLVE_POSTED_MESSAGE = "Marked as published on Facebook.";

export const SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE =
  "This publish is still in progress. Confirm only after it is unconfirmed.";

export const SOCIAL_PUBLISH_RESOLVE_NOT_FOUND_MESSAGE =
  "That Facebook publish attempt is not in this business.";

export function sanitizeSocialPublishProviderError(
  raw: string | null | undefined,
  accessToken?: string | null,
): string {
  let text = (raw ?? "").replace(/\s+/g, " ").trim();
  const token = accessToken?.trim();
  if (token) {
    text = text.split(token).join("[redacted]");
    const encoded = encodeURIComponent(token);
    if (encoded && encoded !== token) text = text.split(encoded).join("[redacted]");
  }
  text = text.replace(/access_token=[^&\s]+/gi, "access_token=[redacted]");
  SOCIAL_PUBLISH_PAGE_TOKEN_PATTERN.lastIndex = 0;
  text = text.replace(SOCIAL_PUBLISH_PAGE_TOKEN_PATTERN, "[redacted]");
  if (text.length > SOCIAL_PUBLISH_ERROR_MAX_CHARS) {
    text = text.slice(0, SOCIAL_PUBLISH_ERROR_MAX_CHARS);
  }
  return text;
}

export function isSocialPublishUnconfirmed(input: {
  status?: string | null;
  claimedAt?: Date | null;
  failureLabel?: string | null;
  now?: Date;
  unconfirmedAfterMs?: number;
}): boolean {
  if (input.status !== SOCIAL_PUBLISH_ATTEMPT_CLAIMED) return false;
  if (input.failureLabel === SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE) return true;
  if (!input.claimedAt) return false;
  const now = input.now ?? new Date();
  const windowMs = input.unconfirmedAfterMs ?? SOCIAL_PUBLISH_UNCONFIRMED_MS;
  return now.getTime() - input.claimedAt.getTime() >= windowMs;
}

export function canResolveSocialPublishAttempt(input: {
  role: string;
  status?: string | null;
  claimedAt?: Date | null;
  failureLabel?: string | null;
  now?: Date;
}): boolean {
  return input.role === "OWNER" && isSocialPublishUnconfirmed(input);
}

export const SOCIAL_PUBLISH_STALE_MESSAGE =
  "This package changed while you were publishing. Refresh and try again.";

export const SOCIAL_PUBLISH_SNAPSHOT_REQUIRED_MESSAGE =
  "Publishing requires the current package snapshot. Refresh and try again.";

export const SOCIAL_PUBLISH_EMPTY_MESSAGE =
  "Approved text is required before publishing to Facebook.";

export const SOCIAL_PUBLISH_SCHEMA_UNAVAILABLE_MESSAGE =
  "Facebook publish is unavailable until this workspace's schema is migrated. TBBT will not post.";

export const SOCIAL_PUBLISH_PACKAGE_NOT_FOUND_MESSAGE =
  "That creator package is not in this business.";

export function isImplementedSocialPublishDestination(
  value: string,
): value is ImplementedSocialPublishDestination {
  return (IMPLEMENTED_SOCIAL_PUBLISH_DESTINATIONS as readonly string[]).includes(value);
}

export function isDisconnectedSocialPublishDestination(value: string) {
  return (DISCONNECTED_SOCIAL_PUBLISH_DESTINATIONS as readonly string[]).includes(value);
}

export function canPublishMarketingToSocial(input: {
  role: string;
  status: string;
  destination: string;
  destinationConnected: boolean;
  photos: Array<{ marketingPermissionStatus?: string; approved?: boolean }>;
}): boolean {
  return (
    input.role === "OWNER" &&
    input.status === "APPROVED" &&
    isImplementedSocialPublishDestination(input.destination) &&
    input.destinationConnected === true &&
    studioPhotosEligible(input.photos)
  );
}

export function socialPublishAttemptLiveKey(contentId: string, destination: string) {
  return `${contentId}:${destination}`;
}

export function composeSocialPublishMessage(input: { caption: string; hashtags: string }) {
  const caption = input.caption.trim();
  const tags = formatHashtags(parseHashtags(input.hashtags));
  if (!caption) return "";
  return tags ? `${caption}\n\n${tags}` : caption;
}

export function socialPublishDisplay(
  statusOrInput:
    | string
    | null
    | undefined
    | {
        status?: string | null;
        claimedAt?: Date | null;
        failureLabel?: string | null;
        now?: Date;
      },
): {
  published: boolean;
  unconfirmed: boolean;
  inFlight: boolean;
  label: string | null;
} {
  const input =
    statusOrInput && typeof statusOrInput === "object"
      ? statusOrInput
      : { status: statusOrInput };
  if (input.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED) {
    return {
      published: true,
      unconfirmed: false,
      inFlight: false,
      label: SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
    };
  }
  if (input.status === SOCIAL_PUBLISH_ATTEMPT_FAILED) {
    const label = input.failureLabel?.trim() || SOCIAL_PUBLISH_FAILED_MESSAGE;
    return { published: false, unconfirmed: false, inFlight: false, label };
  }
  if (input.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED) {
    if (isSocialPublishUnconfirmed(input)) {
      return {
        published: false,
        unconfirmed: true,
        inFlight: false,
        label: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
      };
    }
    return {
      published: false,
      unconfirmed: false,
      inFlight: true,
      label: SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
    };
  }
  return { published: false, unconfirmed: false, inFlight: false, label: null };
}

export type MarketingSocialDestinationState = {
  destination: string;
  implemented: boolean;
  connected: boolean;
};

export function presentMarketingSocialDestinations(connectedDestinations: readonly string[]): {
  connected: boolean;
  message: string;
  manualCopy: string;
  destinations: Record<"FACEBOOK" | "INSTAGRAM" | "GOOGLE", MarketingSocialDestinationState>;
} {
  const facebookConnected = connectedDestinations.includes(SOCIAL_PUBLISH_DESTINATION_FACEBOOK);
  return {
    connected: facebookConnected,
    message: facebookConnected
      ? FACEBOOK_CONNECTED_OTHERS_DISCONNECTED_MESSAGE
      : CHANNELS_DISCONNECTED_MESSAGE,
    manualCopy: facebookConnected
      ? FACEBOOK_CONNECTED_OTHERS_DISCONNECTED_MESSAGE
      : SOCIAL_MANUAL_COPY_MESSAGE,
    destinations: {
      FACEBOOK: {
        destination: SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
        implemented: true,
        connected: facebookConnected,
      },
      INSTAGRAM: {
        destination: SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
        implemented: false,
        connected: false,
      },
      GOOGLE: {
        destination: SOCIAL_PUBLISH_DESTINATION_GOOGLE,
        implemented: false,
        connected: false,
      },
    },
  };
}

export const COMING_NEXT_MESSAGE =
  "Coming next. This area is reserved for a later Marketing step and is not fabricating data.";

export const OWNER_STUDIO_APPROVAL_MESSAGE =
  "Approving a creator package requires the OWNER role. ADMIN may draft, edit, and send it for review.";

export const STUDIO_APPROVAL_QUEUE_LIMIT = 50;
export const STUDIO_APPROVAL_QUEUE_STATUS = "READY_FOR_REVIEW" as const;

export const WEEKLY_STUDIO_APPROVAL_QUEUE_MESSAGE =
  "This weekly review queue lists creator packages waiting for OWNER approval. TBBT will not auto-approve, publish, post, or send customer messages.";

export const STUDIO_APPROVAL_QUEUE_LIMITS_MESSAGE =
  "The weekly queue shows at most 50 packages awaiting review. Remaining READY_FOR_REVIEW packages stay on file and appear as earlier items leave the queue.";

export const STUDIO_RETURN_FOR_CHANGES_MESSAGE =
  "Returning a creator package for changes requires the OWNER role. The package goes back to DRAFT. TBBT will not publish or send a customer message.";

export const STUDIO_APPROVED_INTERNAL_MESSAGE =
  "Creator package approved for internal use. It has not been published, posted, or sent to a customer.";

export const STUDIO_RETURNED_MESSAGE =
  "Creator package returned for changes. It is a DRAFT again and has not been published.";

export const STUDIO_APPROVE_NOT_READY_MESSAGE =
  "Only packages awaiting review can be approved.";

export const STUDIO_RETURN_NOT_READY_MESSAGE =
  "Only packages awaiting review can be returned for changes.";

export const STUDIO_WEEKLY_REMINDER_CHANNEL = "IN_APP" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED = "SMS not connected";
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED = "NOT_CONNECTED" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED = "CONNECTED_UNUSED" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT = "NOT_SENT" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED = "ACCEPTED" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT = "SENT" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED = "FAILED" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_ACCEPTED = "Owner SMS accepted by the provider";
export const STUDIO_WEEKLY_REMINDER_SMS_SENT = "Owner SMS sent by the provider";
export const STUDIO_WEEKLY_REMINDER_SMS_FAILED = "Owner SMS failed";
export const STUDIO_WEEKLY_REMINDER_SMS_NOT_SENT = "Owner SMS not sent";
export const STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION =
  "Owner SMS destination is not on file";
export const STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN =
  "Owner SMS is off for the OWNER destination";
export const STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT =
  "Owner SMS skipped because the OWNER opted out";
export const STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED = "BLOCKED" as const;
export const STUDIO_WEEKLY_REMINDER_SMS_STOPPED =
  "Owner SMS was stopped by the destination";
export const STUDIO_WEEKLY_REMINDER_SMS_BLOCKED =
  "Owner SMS is blocked for this destination";
export const STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT =
  "Owner SMS timed out waiting for the provider";
export const OWNER_SMS_PROVIDER_TIMEOUT_MS = 8000;
export const STUDIO_WEEKLY_REMINDER_SEND_WEEKDAY = 1;
export const OWNER_SMS_BLOCKED_PROVIDER_CODE = "21610";
export const STUDIO_WEEKLY_REMINDER_SMS_UNCONFIRMED =
  "Provider acceptance is not a delivery confirmation. TBBT has not run a live provider test on this path.";

export const STUDIO_WEEKLY_REMINDER_OPT_IN_MESSAGE =
  "OWNER can opt into one weekly reminder when creator packages await review. TBBT will not auto-approve, publish, post, or send customer messages.";

export const STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE =
  "Turning weekly review reminders on or off requires the OWNER role.";

export const STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE =
  "This reminder stays in Marketing Studio for the OWNER. Optional owner SMS uses only an OWNER-controlled destination the OWNER opted in, plus the communications provider and this business's dedicated number. The public company phone is never used. TBBT will not send customer SMS, auto-approve, publish, or post.";

export const STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE =
  "Weekly review reminders are on. You will get one in-app reminder each business week while packages await review. Owner SMS is attempted only when an OWNER destination is opted in and the provider and dedicated tenant number actually work.";

export const STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE =
  "Weekly review reminders are off. TBBT will not create another reminder until an OWNER opts in again.";

export const STUDIO_WEEKLY_REMINDER_UNAVAILABLE_MESSAGE =
  "Weekly review reminders are unavailable until this workspace's schema is migrated. TBBT will not invent a reminder or change the database from this page.";

export const STUDIO_WEEKLY_REMINDER_OWNER_SMS_OPT_IN_MESSAGE =
  "Optional OWNER SMS goes only to this OWNER-controlled number after a separate opt-in. The public company phone is never used.";

export const STUDIO_WEEKLY_REMINDER_OWNER_SMS_SAVED_MESSAGE =
  "OWNER SMS destination saved. TBBT will not use the public company phone.";

export const STUDIO_WEEKLY_REMINDER_OWNER_SMS_INVALID_MESSAGE =
  "Enter a valid E.164 OWNER SMS number before opting that number in.";

export const STUDIO_WEEKLY_REMINDER_OWNER_SMS_OWNER_ONLY_MESSAGE =
  "Setting the OWNER SMS destination requires the OWNER role.";

export const STUDIO_WEEKLY_REMINDER_CRON_SECRET_MISSING_MESSAGE =
  "The platform scheduled runner is not authenticated. Ask the operator to set CRON_SECRET in the host environment. This page does not show the secret.";

export const STUDIO_WEEKLY_REMINDER_CRON_RETRY_MESSAGE =
  "Retry the scheduled Monday reminder for this business now. It stays Monday-gated. A Monday retry can send the OWNER SMS for this workspace.";

export const STUDIO_WEEKLY_REMINDER_CRON_RETRIED_MESSAGE =
  "Scheduled reminder retry finished for this business.";

export const STUDIO_WEEKLY_REMINDER_CRON_RETRY_OWNER_ONLY_MESSAGE =
  "Retrying the scheduled reminder requires the OWNER role.";

export const PHOTO_PERMISSION_REVOKED_MESSAGE =
  "A selected job photo no longer has marketing permission. Approval and export are blocked until only approved photos remain.";

export const CREATOR_PACKAGE_NOT_APPROVED_MESSAGE =
  "Export a creator package only after OWNER approval. TBBT will not post this package.";

export const OWNER_REVIEW_PACKET_MESSAGE =
  "Downloading a review packet requires the OWNER role. TBBT will not post this packet.";

export const REVIEW_PACKET_LIMITS_MESSAGE =
  "This review packet includes only stored package text, storyboard, shot list, and permission-checked photo references. Estimate line items, customer records, unapproved media, and job-photo captions are omitted. Stored package text, storyboard, and shot list are included as written and are not scanned for private details. TBBT will not publish or post anything.";

export const REVIEW_PACKET_DRAFT_TEXT_LABEL = "Draft text — not approved";
export const REVIEW_PACKET_APPROVED_TEXT_LABEL = "Approved text";
export const REVIEW_PACKET_DRAFT_PACKAGE_LABEL = "DRAFT — not approved";
export const REVIEW_PACKET_READY_PACKAGE_LABEL = "Ready for review — not approved";
export const REVIEW_PACKET_APPROVED_PACKAGE_LABEL = "Approved";

export const FLOW_VEO_DISCONNECTED_MESSAGE =
  "Flow and Veo generation are not connected. This studio drafts a storyboard and shot list from recorded job facts only.";

export const PAID_ADS_DISCONNECTED_MESSAGE =
  "Paid ads are not connected. A creator package is an internal handoff file, not an ad campaign.";

export const CREATOR_PACKAGE_LIMITS_MESSAGE =
  "This creator package is a downloadable handoff. Flow/Veo generation, paid ads, and social publishing are not connected. TBBT will not post anything.";

export const INVALID_STORYBOARD_MESSAGE =
  "Enter a valid storyboard. Use a JSON array of beats with a heading, visual, or narration.";

export const INVALID_SHOT_LIST_MESSAGE =
  "Enter a valid shot list. Use a JSON array of shots with a shot name or purpose.";

/** External AI is not connected. Template drafts still work. */
export function marketingAiAssistAvailable(): boolean {
  return providerAssistAvailable();
}

export function parseMarketingDate(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = parseScheduleDate(raw);
  const [year, month, day] = raw.split("-").map(Number);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return startOfDay(parsed);
}

export function nextContentStatus(current: string): MarketingContentStatus | null {
  if (current === "DRAFT") return "READY_FOR_REVIEW";
  if (current === "READY_FOR_REVIEW") return "APPROVED";
  return null;
}

export function canSelectPhotoForMarketing(photo: {
  marketingPermissionStatus: string;
}): boolean {
  return isMarketingApprovedPhoto(photo.marketingPermissionStatus);
}

export type StoryboardBeat = {
  heading: string;
  visual: string;
  narration: string;
};

export type ShotListItem = {
  order: number;
  shot: string;
  purpose: string;
  photoId?: string;
};

export function parseHashtags(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
    ),
  ].slice(0, 8);
}

export function formatHashtags(tags: string[]): string {
  return parseHashtags(tags.join(" ")).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseStoryboard(raw: string | null | undefined): StoryboardBeat[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        const record = asRecord(row);
        if (!record) return null;
        const heading = typeof record.heading === "string" ? record.heading.trim() : "";
        const visual = typeof record.visual === "string" ? record.visual.trim() : "";
        const narration = typeof record.narration === "string" ? record.narration.trim() : "";
        if (!heading && !visual && !narration) return null;
        return { heading: heading || "Beat", visual, narration };
      })
      .filter((row): row is StoryboardBeat => Boolean(row))
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function parseShotList(raw: string | null | undefined): ShotListItem[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row, index) => {
        const record = asRecord(row);
        if (!record) return null;
        const shot = typeof record.shot === "string" ? record.shot.trim() : "";
        const purpose = typeof record.purpose === "string" ? record.purpose.trim() : "";
        const photoId = typeof record.photoId === "string" ? record.photoId.trim() : "";
        const order =
          typeof record.order === "number" && Number.isFinite(record.order)
            ? record.order
            : index + 1;
        if (!shot && !purpose) return null;
        return {
          order,
          shot: shot || `Shot ${order}`,
          purpose,
          ...(photoId ? { photoId } : {}),
        };
      })
      .filter((row): row is ShotListItem => Boolean(row))
      .slice(0, 12);
  } catch {
    return [];
  }
}

export function serializeStoryboard(beats: StoryboardBeat[]): string {
  return JSON.stringify(parseStoryboard(JSON.stringify(beats)));
}

export function serializeShotList(items: ShotListItem[]): string {
  return JSON.stringify(parseShotList(JSON.stringify(items)));
}

function parseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write-path storyboard. Invalid JSON or a non-array fails closed. */
export function parseRequiredStoryboard(raw: string): StoryboardBeat[] | null {
  const items = parseJsonArray(raw);
  if (!items) return null;
  const beats = parseStoryboard(raw);
  if (items.length > 0 && beats.length === 0) return null;
  return beats;
}

/** Write-path shot list. Invalid JSON or a non-array fails closed. */
export function parseRequiredShotList(raw: string): ShotListItem[] | null {
  const items = parseJsonArray(raw);
  if (!items) return null;
  const shots = parseShotList(raw);
  if (items.length > 0 && shots.length === 0) return null;
  return shots;
}

export function studioPhotosEligible(
  photos: Array<{ marketingPermissionStatus?: string; approved?: boolean }>,
): boolean {
  if (photos.length === 0) return false;
  return photos.every((photo) =>
    photo.approved === true || isMarketingApprovedPhoto(photo.marketingPermissionStatus),
  );
}

export function canApproveStudioPackage(input: {
  status: string;
  role: string;
  photos: Array<{ marketingPermissionStatus?: string; approved?: boolean }>;
}): boolean {
  return (
    input.status === STUDIO_APPROVAL_QUEUE_STATUS &&
    input.role === "OWNER" &&
    studioPhotosEligible(input.photos)
  );
}

export function canReturnStudioPackage(input: { status: string; role: string }): boolean {
  return input.status === STUDIO_APPROVAL_QUEUE_STATUS && input.role === "OWNER";
}

export function canActOnStudioApprovalQueue(role: string): boolean {
  return role === "OWNER";
}

export function canManageStudioWeeklyReminder(role: string): boolean {
  return role === "OWNER";
}

export function studioWeeklyReminderSmsConnected(input: {
  platformConfigured: boolean;
  dedicatedNumberAssigned: boolean;
}): boolean {
  return input.platformConfigured === true && input.dedicatedNumberAssigned === true;
}

export function studioWeeklyReminderDelivery(input: {
  platformConfigured: boolean;
  dedicatedNumberAssigned: boolean;
}): {
  channel: typeof STUDIO_WEEKLY_REMINDER_CHANNEL;
  smsConnected: boolean;
  smsStatus:
    | typeof STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED
    | typeof STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED;
  smsLabel: string | null;
  customerMessageSent: false;
  published: false;
  posted: false;
} {
  const smsConnected = studioWeeklyReminderSmsConnected(input);
  return {
    channel: STUDIO_WEEKLY_REMINDER_CHANNEL,
    smsConnected,
    smsStatus: smsConnected
      ? STUDIO_WEEKLY_REMINDER_SMS_STATUS_CONNECTED_UNUSED
      : STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED,
    smsLabel: smsConnected ? null : STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED,
    customerMessageSent: false,
    published: false,
    posted: false,
  };
}

export function studioWeeklyReminderWeekKey(now: Date, timeZone: string): string {
  return formatISODateInTimeZone(startOfWeek(now, timeZone), timeZone);
}

export function studioWeeklyReminderCopy(awaitingCount: number): string {
  const noun = awaitingCount === 1 ? "package awaits" : "packages await";
  return `${awaitingCount} ${noun} OWNER review this week.`;
}

export function studioWeeklyReminderSmsBody(awaitingCount: number): string {
  return `${studioWeeklyReminderCopy(awaitingCount)} Open Marketing Studio to review. TBBT will not auto-approve or message customers.`;
}

export function parseOwnerSmsE164(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw.startsWith("+")) return null;
  const digits = raw.slice(1).replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || !/^\d+$/.test(digits)) return null;
  return `+${digits}`;
}

export function resolveOwnerStudioReminderSmsTo(input: {
  ownerSmsTo?: string | null;
}): string | null {
  return parseOwnerSmsE164(input.ownerSmsTo);
}

export function maskOwnerSmsDestination(value: string | null | undefined): string | null {
  const parsed = parseOwnerSmsE164(value);
  if (!parsed) return null;
  return `••••${parsed.slice(-4)}`;
}

export function isStudioWeeklyReminderSendWindow(now: Date, timeZone: string): boolean {
  return zonedWeekday(now, timeZone) === STUDIO_WEEKLY_REMINDER_SEND_WEEKDAY;
}

export function isOwnerSmsBlockedProviderCode(code: string | number | null | undefined): boolean {
  return String(code ?? "").trim() === OWNER_SMS_BLOCKED_PROVIDER_CODE;
}

export function studioWeeklyReminderSafeSmsLabel(status: string, label: string | null | undefined) {
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED) return STUDIO_WEEKLY_REMINDER_SMS_ACCEPTED;
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT) return STUDIO_WEEKLY_REMINDER_SMS_SENT;
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_BLOCKED) return STUDIO_WEEKLY_REMINDER_SMS_BLOCKED;
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED) {
    if (label === STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT) return STUDIO_WEEKLY_REMINDER_SMS_TIMED_OUT;
    return STUDIO_WEEKLY_REMINDER_SMS_FAILED;
  }
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT) {
    if (label === STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT) return STUDIO_WEEKLY_REMINDER_SMS_OPTED_OUT;
    if (label === STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN) return STUDIO_WEEKLY_REMINDER_SMS_NOT_OPTED_IN;
    if (label === STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION) return STUDIO_WEEKLY_REMINDER_SMS_NO_DESTINATION;
    if (label === STUDIO_WEEKLY_REMINDER_SMS_STOPPED) return STUDIO_WEEKLY_REMINDER_SMS_STOPPED;
    if (label === STUDIO_WEEKLY_REMINDER_SMS_BLOCKED) return STUDIO_WEEKLY_REMINDER_SMS_BLOCKED;
    return STUDIO_WEEKLY_REMINDER_SMS_NOT_SENT;
  }
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED) {
    return STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;
  }
  return STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;
}

export function studioWeeklyReminderSmsOutcomeLabel(status: string, failureReason?: string | null) {
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_ACCEPTED) {
    return STUDIO_WEEKLY_REMINDER_SMS_ACCEPTED;
  }
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_SENT) {
    return STUDIO_WEEKLY_REMINDER_SMS_SENT;
  }
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_FAILED) {
    const detail = failureReason?.trim();
    return detail ? `${STUDIO_WEEKLY_REMINDER_SMS_FAILED}: ${detail}` : STUDIO_WEEKLY_REMINDER_SMS_FAILED;
  }
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_SENT) {
    const detail = failureReason?.trim();
    return detail || STUDIO_WEEKLY_REMINDER_SMS_NOT_SENT;
  }
  if (status === STUDIO_WEEKLY_REMINDER_SMS_STATUS_NOT_CONNECTED) {
    return STUDIO_WEEKLY_REMINDER_SMS_NOT_CONNECTED;
  }
  return failureReason?.trim() || null;
}

export function isStudioApprovalQueueStatus(status: string): boolean {
  return status === STUDIO_APPROVAL_QUEUE_STATUS;
}

export function studioApprovalQueueMeta(total: number): {
  limit: number;
  total: number;
  truncated: boolean;
} {
  return {
    limit: STUDIO_APPROVAL_QUEUE_LIMIT,
    total,
    truncated: total > STUDIO_APPROVAL_QUEUE_LIMIT,
  };
}

export function boundStudioApprovalQueue<T>(rows: readonly T[]): {
  items: T[];
  truncated: boolean;
  limit: number;
} {
  return {
    items: rows.slice(0, STUDIO_APPROVAL_QUEUE_LIMIT),
    truncated: rows.length > STUDIO_APPROVAL_QUEUE_LIMIT,
    limit: STUDIO_APPROVAL_QUEUE_LIMIT,
  };
}

export function canPlanStudioPublicationDay(role: string): boolean {
  return role === "OWNER";
}

export function parseStudioPublicationDay(
  raw: string | null | undefined,
  timeZone: string,
): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  return parseCivilDateInTimeZone(year, month, day, timeZone);
}

export function isLegacyUtcMidnightPlannedFor(value: Date): boolean {
  return (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

export function studioPublicationDayKey(date: Date, timeZone: string): string {
  if (isLegacyUtcMidnightPlannedFor(date)) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return formatISODateInTimeZone(date, timeZone);
}

/** Inclusive lower bound for "from today" so legacy UTC-midnight rows keep today's civil date. */
export function studioCalendarActiveCutoff(now: Date, timeZone: string): Date {
  const todayKey = formatISODateInTimeZone(now, timeZone);
  const [year, month, day] = todayKey.split("-").map(Number);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day));
  const zonedStart = parseCivilDateInTimeZone(year, month, day, timeZone);
  if (!zonedStart) return utcMidnight;
  return utcMidnight.getTime() <= zonedStart.getTime() ? utcMidnight : zonedStart;
}

export function studioCalendarApprovalLabel(status: string): string {
  if (isMarketingContentStatus(status)) return MARKETING_CONTENT_STATUS_LABELS[status];
  return status;
}

export function studioCalendarExportLabel(exportedAt: Date | null | undefined): string {
  return exportedAt ? STUDIO_CALENDAR_EXPORT_EXPORTED_LABEL : STUDIO_CALENDAR_EXPORT_NOT_EXPORTED_LABEL;
}

export function studioContentCalendarMeta(total: number): {
  limit: number;
  total: number;
  truncated: boolean;
} {
  return {
    limit: STUDIO_CONTENT_CALENDAR_LIMIT,
    total,
    truncated: total > STUDIO_CONTENT_CALENDAR_LIMIT,
  };
}

export function boundStudioContentCalendar<T>(rows: readonly T[]): {
  items: T[];
  truncated: boolean;
  limit: number;
} {
  return {
    items: rows.slice(0, STUDIO_CONTENT_CALENDAR_LIMIT),
    truncated: rows.length > STUDIO_CONTENT_CALENDAR_LIMIT,
    limit: STUDIO_CONTENT_CALENDAR_LIMIT,
  };
}

export type StudioContentCalendarLimits = {
  published: false;
  posted: false;
  approvedByPlanning: false;
  customerMessageSent: false;
  providerConnectionClaimed: false;
  socialPublishingConnected: false;
  message: string;
};

export function studioContentCalendarLimits(): StudioContentCalendarLimits {
  return {
    published: false,
    posted: false,
    approvedByPlanning: false,
    customerMessageSent: false,
    providerConnectionClaimed: false,
    socialPublishingConnected: false,
    message: STUDIO_CONTENT_CALENDAR_MESSAGE,
  };
}

export type StudioContentCalendarRecord = {
  id: string;
  contentType: string;
  title: string;
  channelIntent: string;
  status: string;
  plannedFor: Date | null;
  exportedAt: Date | null;
  updatedAt: Date;
};

export type StudioContentCalendarItem = {
  id: string;
  contentType: string;
  title: string;
  channelIntent: string;
  status: string;
  approvalLabel: string;
  exported: boolean;
  exportLabel: string;
  plannedFor: Date | null;
  plannedDay: string | null;
  updatedAt: Date;
};

export type StudioContentCalendarDay = {
  day: string | null;
  label: string;
  items: StudioContentCalendarItem[];
};

export function presentStudioContentCalendarItem(
  row: StudioContentCalendarRecord,
  timeZone: string,
): StudioContentCalendarItem {
  return {
    id: row.id,
    contentType: row.contentType,
    title: row.title,
    channelIntent: row.channelIntent,
    status: row.status,
    approvalLabel: studioCalendarApprovalLabel(row.status),
    exported: Boolean(row.exportedAt),
    exportLabel: studioCalendarExportLabel(row.exportedAt),
    plannedFor: row.plannedFor,
    plannedDay: row.plannedFor ? studioPublicationDayKey(row.plannedFor, timeZone) : null,
    updatedAt: row.updatedAt,
  };
}

export function groupStudioContentCalendarDays(
  items: readonly StudioContentCalendarItem[],
): StudioContentCalendarDay[] {
  const byDay = new Map<string, StudioContentCalendarItem[]>();
  for (const item of items) {
    if (!item.plannedDay) continue;
    const list = byDay.get(item.plannedDay) ?? [];
    list.push(item);
    byDay.set(item.plannedDay, list);
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, dayItems]) => ({
      day,
      label: day,
      items: dayItems,
    }));
}

export function presentStudioContentCalendar(input: {
  fromToday: readonly StudioContentCalendarRecord[];
  unplanned: readonly StudioContentCalendarRecord[];
  past: readonly StudioContentCalendarRecord[];
  fromTodayTotal: number;
  unplannedTotal: number;
  pastTotal: number;
  timeZone: string;
}): {
  timeZone: string;
  limit: number;
  total: number;
  truncated: boolean;
  fromTodayTruncated: boolean;
  unplannedTruncated: boolean;
  pastTruncated: boolean;
  message: string;
  limitsMessage: string;
  limits: StudioContentCalendarLimits;
  items: StudioContentCalendarItem[];
  pastItems: StudioContentCalendarItem[];
  days: StudioContentCalendarDay[];
  unscheduled: StudioContentCalendarDay | null;
  pastDays: StudioContentCalendarDay[];
} {
  const fromTodayBounded = boundStudioContentCalendar(input.fromToday);
  const unplannedBounded = boundStudioContentCalendar(input.unplanned);
  const pastBounded = boundStudioContentCalendar(input.past);
  const fromTodayItems = fromTodayBounded.items.map((row) =>
    presentStudioContentCalendarItem(row, input.timeZone),
  );
  const unplannedItems = unplannedBounded.items.map((row) =>
    presentStudioContentCalendarItem(row, input.timeZone),
  );
  const pastItems = pastBounded.items.map((row) =>
    presentStudioContentCalendarItem(row, input.timeZone),
  );
  const fromTodayTruncated = fromTodayBounded.truncated || input.fromTodayTotal > STUDIO_CONTENT_CALENDAR_LIMIT;
  const unplannedTruncated = unplannedBounded.truncated || input.unplannedTotal > STUDIO_CONTENT_CALENDAR_LIMIT;
  const pastTruncated = pastBounded.truncated || input.pastTotal > STUDIO_CONTENT_CALENDAR_LIMIT;
  const total = input.fromTodayTotal + input.unplannedTotal + input.pastTotal;
  return {
    timeZone: input.timeZone,
    limit: STUDIO_CONTENT_CALENDAR_LIMIT,
    total,
    truncated: fromTodayTruncated || unplannedTruncated || pastTruncated,
    fromTodayTruncated,
    unplannedTruncated,
    pastTruncated,
    message: STUDIO_CONTENT_CALENDAR_MESSAGE,
    limitsMessage: STUDIO_CONTENT_CALENDAR_LIMITS_MESSAGE,
    limits: studioContentCalendarLimits(),
    items: [...fromTodayItems, ...unplannedItems],
    pastItems,
    days: groupStudioContentCalendarDays(fromTodayItems),
    unscheduled:
      unplannedItems.length > 0
        ? {
            day: null,
            label: STUDIO_CALENDAR_UNSCHEDULED_LABEL,
            items: unplannedItems,
          }
        : null,
    pastDays: groupStudioContentCalendarDays(pastItems),
  };
}

export function canExportCreatorPackage(input: {
  status: string;
  photos: Array<{ marketingPermissionStatus?: string; approved?: boolean }>;
}): boolean {
  return input.status === "APPROVED" && studioPhotosEligible(input.photos);
}

export function canDownloadMarketingReviewPacket(input: { role: string }): boolean {
  return input.role === "OWNER";
}

export function isMarketingReviewPacketDraft(status: string): boolean {
  return status !== "APPROVED";
}

export function marketingReviewPacketDraftLabel(status: string): string {
  if (status === "APPROVED") return REVIEW_PACKET_APPROVED_PACKAGE_LABEL;
  if (status === "READY_FOR_REVIEW") return REVIEW_PACKET_READY_PACKAGE_LABEL;
  return REVIEW_PACKET_DRAFT_PACKAGE_LABEL;
}

export function marketingReviewPacketTextLabel(status: string): string {
  return status === "APPROVED" ? REVIEW_PACKET_APPROVED_TEXT_LABEL : REVIEW_PACKET_DRAFT_TEXT_LABEL;
}

export type ReviewPacketPhoto = {
  id: string;
  url: string;
  stage: string;
  marketingPermissionStatus?: string;
  approved?: boolean;
};

export type ReviewPacketPhotoReference = {
  id: string;
  url: string;
  stage: string;
};

export function permittedReviewPacketPhotos(
  photos: readonly ReviewPacketPhoto[],
): ReviewPacketPhotoReference[] {
  return photos
    .filter(
      (photo) =>
        photo.approved === true || isMarketingApprovedPhoto(photo.marketingPermissionStatus),
    )
    .map((photo) => ({
      id: photo.id,
      url: photo.url,
      stage: photo.stage,
    }));
}

export function sanitizeReviewPacketShotList(
  shots: readonly ShotListItem[],
  permittedPhotoIds: ReadonlySet<string>,
): ShotListItem[] {
  return shots.map((shot) => {
    if (shot.photoId && !permittedPhotoIds.has(shot.photoId)) {
      return { order: shot.order, shot: shot.shot, purpose: shot.purpose };
    }
    return { ...shot };
  });
}

export type MarketingReviewPacketLimits = {
  published: false;
  posted: false;
  socialPublishingConnected: false;
  includesEstimateLineItems: false;
  includesCustomerRecords: false;
  includesUnapprovedMedia: false;
  includesPhotoCaptions: false;
  message: string;
};

export function marketingReviewPacketLimits(): MarketingReviewPacketLimits {
  return {
    published: false,
    posted: false,
    socialPublishingConnected: false,
    includesEstimateLineItems: false,
    includesCustomerRecords: false,
    includesUnapprovedMedia: false,
    includesPhotoCaptions: false,
    message: REVIEW_PACKET_LIMITS_MESSAGE,
  };
}

export type MarketingReviewPacket = {
  kind: "TBBT_MARKETING_REVIEW_PACKET";
  version: 1;
  title: string;
  status: MarketingContentStatus;
  draft: boolean;
  draftLabel: string;
  approvedText: {
    label: string;
    draft: boolean;
    caption: string;
    hashtags: string[];
  };
  storyboard: StoryboardBeat[];
  shotList: ShotListItem[];
  photoReferences: ReviewPacketPhotoReference[];
  omitted: {
    estimateLineItems: true;
    customerRecords: true;
    unapprovedMedia: true;
    photoCaptions: true;
  };
  limits: MarketingReviewPacketLimits;
};

export function buildMarketingReviewPacket(input: {
  title: string;
  status: string;
  caption: string;
  hashtags: string;
  storyboardJson: string;
  shotListJson: string;
  photos: readonly ReviewPacketPhoto[];
}): MarketingReviewPacket {
  const status = isMarketingContentStatus(input.status) ? input.status : "DRAFT";
  const draft = isMarketingReviewPacketDraft(status);
  const photoReferences = permittedReviewPacketPhotos(input.photos);
  const permittedIds = new Set(photoReferences.map((photo) => photo.id));
  return {
    kind: "TBBT_MARKETING_REVIEW_PACKET",
    version: 1,
    title: input.title.trim(),
    status,
    draft,
    draftLabel: marketingReviewPacketDraftLabel(status),
    approvedText: {
      label: marketingReviewPacketTextLabel(status),
      draft,
      caption: input.caption.trim(),
      hashtags: parseHashtags(input.hashtags),
    },
    storyboard: parseStoryboard(input.storyboardJson),
    shotList: sanitizeReviewPacketShotList(parseShotList(input.shotListJson), permittedIds),
    photoReferences,
    omitted: {
      estimateLineItems: true,
      customerRecords: true,
      unapprovedMedia: true,
      photoCaptions: true,
    },
    limits: marketingReviewPacketLimits(),
  };
}

export type MarketingReviewPacketDownloadState = {
  packetJson?: string;
  filename?: string;
  downloadNonce?: string;
};

export function nextReviewPacketDownload(
  previousNonce: string | null,
  state: MarketingReviewPacketDownloadState,
): { shouldDownload: true; nonce: string; packetJson: string; filename: string } | { shouldDownload: false; nonce: string | null } {
  if (!state.packetJson || !state.filename || !state.downloadNonce) {
    return { shouldDownload: false, nonce: previousNonce };
  }
  if (state.downloadNonce === previousNonce) {
    return { shouldDownload: false, nonce: previousNonce };
  }
  return {
    shouldDownload: true,
    nonce: state.downloadNonce,
    packetJson: state.packetJson,
    filename: state.filename,
  };
}

export function marketingReviewPacketFilename(title: string, status: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const draftTag = isMarketingReviewPacketDraft(status) ? "-draft" : "";
  return `${slug || "creator-package"}-review-packet${draftTag}.json`;
}

export type CreatorPackageLimits = {
  published: false;
  posted: false;
  flowVeoConnected: false;
  paidAdsConnected: false;
  socialPublishingConnected: false;
  message: string;
};

export function creatorPackageLimits(): CreatorPackageLimits {
  return {
    published: false,
    posted: false,
    flowVeoConnected: false,
    paidAdsConnected: false,
    socialPublishingConnected: false,
    message: CREATOR_PACKAGE_LIMITS_MESSAGE,
  };
}

export type CreatorPackage = {
  kind: "TBBT_CREATOR_PACKAGE";
  version: 1;
  title: string;
  caption: string;
  hashtags: string[];
  storyboard: StoryboardBeat[];
  shotList: ShotListItem[];
  photos: Array<{ id: string; url: string; stage: string; caption: string | null }>;
  recordedFacts: {
    businessName: string;
    workPerformed: string | null;
    city: string | null;
    photoCount: number;
  };
  limits: CreatorPackageLimits;
};

export function buildCreatorPackagePreview(input: {
  title: string;
  caption: string;
  hashtags: string;
  storyboardJson: string;
  shotListJson: string;
  photos: Array<{ id: string; url: string; stage: string; caption?: string | null }>;
  recordedFacts: {
    businessName: string;
    workPerformed?: string | null;
    city?: string | null;
  };
}): CreatorPackage {
  const hashtags = parseHashtags(input.hashtags);
  const photos = input.photos.map((photo) => ({
    id: photo.id,
    url: photo.url,
    stage: photo.stage,
    caption: photo.caption ?? null,
  }));
  return {
    kind: "TBBT_CREATOR_PACKAGE",
    version: 1,
    title: input.title.trim(),
    caption: input.caption.trim(),
    hashtags,
    storyboard: parseStoryboard(input.storyboardJson),
    shotList: parseShotList(input.shotListJson),
    photos,
    recordedFacts: {
      businessName: input.recordedFacts.businessName,
      workPerformed: input.recordedFacts.workPerformed ?? null,
      city: input.recordedFacts.city ?? null,
      photoCount: photos.length,
    },
    limits: creatorPackageLimits(),
  };
}

export type MarketingReadiness = "ready" | "needs_permission" | "no_photos";

export function jobMarketingReadiness(input: {
  photoCount: number;
  approvedPhotoCount: number;
}): MarketingReadiness {
  if (input.photoCount === 0) return "no_photos";
  if (input.approvedPhotoCount === 0) return "needs_permission";
  return "ready";
}

export const MARKETING_READINESS_LABELS: Record<MarketingReadiness, string> = {
  ready: "Has marketing-approved photos",
  needs_permission: "Photos need marketing permission",
  no_photos: "No job photos on file",
};
