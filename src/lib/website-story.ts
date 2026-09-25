/**
 * Website Story / About copy foundation.
 *
 * rawOwnerStory is owner background. It is never published automatically.
 * approvedPublicAboutCopy is the only public About story field.
 * Writing assistance may rephrase owner-supplied facts only.
 * Unknown facts stay unknown. A missing AI key stays Not Connected.
 */
import { DEFAULT_PUBLIC_ABOUT_STORY, isCollProRenoSlug } from "@/lib/public-site";

export const MAX_OWNER_STORY_LENGTH = 8000;
export const MAX_PUBLIC_ABOUT_COPY_LENGTH = 4000;

export const WEBSITE_STORY_AI_UNAVAILABLE =
  "Writing assistance may only rephrase facts the owner supplied. It must never invent years, licenses, certifications, awards, insurance, team size, customer counts, project counts, cities, specialties, guarantees, or affiliations. Without an AI API key it stays Not Connected and uses template rewrites. Suggestions stay drafts until you save."

export function normalizeAboutCopy(value: string | null | undefined, maxLength: number) {
  const text = value?.replace(/\r\n/g, "\n").trim() ?? "";
  if (text.length > maxLength) return null;
  return text;
}

export function resolvePublishedAboutCopy(
  approved: string | null | undefined,
  slug?: string | null,
) {
  const text = approved?.trim();
  if (text) return text;
  if (slug && isCollProRenoSlug(slug)) return DEFAULT_PUBLIC_ABOUT_STORY;
  return "";
}

export function splitAboutParagraphs(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}
