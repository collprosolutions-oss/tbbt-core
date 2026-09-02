/**
 * Website Story / About copy foundation.
 *
 * rawOwnerStory is owner background. It is never published automatically.
 * approvedPublicAboutCopy is the only public About story field.
 * AI assistance is not wired — unknown facts stay unknown.
 */
import { DEFAULT_PUBLIC_ABOUT_STORY } from "@/lib/public-site";

export const MAX_OWNER_STORY_LENGTH = 8000;
export const MAX_PUBLIC_ABOUT_COPY_LENGTH = 4000;

export const WEBSITE_STORY_AI_UNAVAILABLE =
  "Improve About Copy is not available yet. When it is added, it may only rephrase facts the owner supplied. It must never invent years, licenses, certifications, awards, insurance, team size, customer counts, project counts, cities, specialties, guarantees, or affiliations.";

export function normalizeAboutCopy(value: string | null | undefined, maxLength: number) {
  const text = value?.replace(/\r\n/g, "\n").trim() ?? "";
  if (text.length > maxLength) return null;
  return text;
}

export function resolvePublishedAboutCopy(approved: string | null | undefined) {
  const text = approved?.trim();
  return text || DEFAULT_PUBLIC_ABOUT_STORY;
}

export function splitAboutParagraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}
