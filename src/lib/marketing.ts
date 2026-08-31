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

import { parseScheduleDate, startOfDay } from "@/lib/schedule";

export const MARKETING_AREAS = [
  "overview",
  "grow",
  "completed-jobs",
  "create-content",
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
  "calendar",
  "social-posts",
  "lead-sources",
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

export const MARKETING_CONTENT_TYPES = ["COMPLETED_JOB", "SERVICE_HIGHLIGHT", "GENERAL_POST"] as const;
export type MarketingContentType = (typeof MARKETING_CONTENT_TYPES)[number];

export const MARKETING_CONTENT_TYPE_LABELS: Record<MarketingContentType, string> = {
  COMPLETED_JOB: "Completed Job / Before & After",
  SERVICE_HIGHLIGHT: "Service Highlight",
  GENERAL_POST: "General Business Post",
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
  "Lead source is not tracked on Requests yet. TBBT will not invent attribution.";

export const COMING_NEXT_MESSAGE =
  "Coming next. This area is reserved for a later Marketing step and is not fabricating data.";

/** Extension point only — no AI provider is called in this step. */
export function marketingAiAssistAvailable(): false {
  return false;
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
