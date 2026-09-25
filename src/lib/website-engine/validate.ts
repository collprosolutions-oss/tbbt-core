import {
  parseWebsiteSnapshot,
  type PublishedWebsiteSnapshot,
} from "@/lib/website-engine/snapshot";

export type WebsitePublishValidation =
  | { ok: true; snapshot: PublishedWebsiteSnapshot }
  | { ok: false; errors: string[] };

function looksLikeUrl(value: string | null) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return value.startsWith("/");
  }
}

export function validateWebsiteSnapshot(
  snapshot: PublishedWebsiteSnapshot,
): WebsitePublishValidation {
  const errors: string[] = [];
  if (!snapshot.business.id || !snapshot.business.slug || !snapshot.business.name) {
    errors.push("Business identity is required before publishing.");
  }
  if (!looksLikeUrl(snapshot.business.publicWebsite)) {
    errors.push("Public website URL must be a valid http(s) link or blank.");
  }
  const slugs = new Set<string>();
  for (const service of snapshot.services) {
    if (!service.id || !service.slug || !service.name) {
      errors.push("Every published service needs a name and slug.");
    }
    if (slugs.has(service.slug)) {
      errors.push(`Service slug “${service.slug}” is used more than once.`);
    }
    slugs.add(service.slug);
    if (service.imageUrl && !looksLikeUrl(service.imageUrl)) {
      errors.push(`Service image for “${service.name}” is not a valid URL.`);
    }
  }
  for (const image of snapshot.images) {
    if (!looksLikeUrl(image.imageUrl)) {
      errors.push("A website image URL is not valid.");
    }
  }
  for (const item of snapshot.gallery) {
    if (!looksLikeUrl(item.imageUrl)) {
      errors.push("A gallery image URL is not valid.");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  try {
    return { ok: true, snapshot: parseWebsiteSnapshot(snapshot) };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Published snapshot is invalid."],
    };
  }
}
