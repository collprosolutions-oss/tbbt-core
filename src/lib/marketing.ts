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

import { formatISODateInTimeZone } from "@/lib/business-timezone";
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

export const LEAD_SOURCE_UNTRACKED_MESSAGE =
  "No recorded lead source is on file yet. TBBT will not invent attribution.";

export const LEAD_SOURCE_TRACKED_MESSAGE =
  "Lead sources below are recorded on ServiceRequest, Estimate, Job, and Customer first-touch fields only.";

export const SOCIAL_MANUAL_COPY_MESSAGE =
  "No Facebook, Instagram, or Google account is connected. Copy approved text and post it yourself. TBBT will not mark this PUBLISHED.";

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

export const STUDIO_WEEKLY_REMINDER_OPT_IN_MESSAGE =
  "OWNER can opt into one weekly reminder when creator packages await review. TBBT will not auto-approve, publish, post, or send customer messages.";

export const STUDIO_WEEKLY_REMINDER_OWNER_ONLY_MESSAGE =
  "Turning weekly review reminders on or off requires the OWNER role.";

export const STUDIO_WEEKLY_REMINDER_IN_APP_MESSAGE =
  "This reminder stays in Marketing Studio for the OWNER. TBBT will not send customer SMS, auto-approve, publish, or post.";

export const STUDIO_WEEKLY_REMINDER_OPTED_IN_MESSAGE =
  "Weekly review reminders are on. You will get one in-app reminder each business week while packages await review.";

export const STUDIO_WEEKLY_REMINDER_OPTED_OUT_MESSAGE =
  "Weekly review reminders are off. TBBT will not create another reminder until an OWNER opts in again.";

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
