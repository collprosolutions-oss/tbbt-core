/**
 * Owner/admin public-website marketing image overrides.
 *
 * Presentation only. Catalog categories, service linkage, and Recent
 * Projects stay on their own systems. MEMBER never writes these rows.
 * Browser-supplied businessId is never authorization proof.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
} from "@/lib/authorization";
import {
  HOMEPAGE_CATEGORY_LIMIT,
  PUBLIC_ABOUT_STORY_IMAGE,
  PUBLIC_HOME_HERO_IMAGE,
  PUBLIC_SERVICES_HERO_IMAGE,
  isCollProRenoSlug,
  publicAboutHeroImage,
  publicCategoryPhoto,
  publicReviewsHeroImage,
  type PublicCatalogGroup,
} from "@/lib/public-site";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import {
  deleteJobPhotoBlob,
  isManagedBlobUrl,
} from "@/lib/storage";

export const PUBLIC_SITE_HOME_PAGE = "home";
export const PUBLIC_SITE_SERVICES_PAGE = "services";
export const PUBLIC_SITE_ABOUT_PAGE = "about";
export const PUBLIC_SITE_REVIEWS_PAGE = "reviews";
export const PUBLIC_SITE_EDITABLE_PAGES = [
  PUBLIC_SITE_HOME_PAGE,
  PUBLIC_SITE_SERVICES_PAGE,
  PUBLIC_SITE_ABOUT_PAGE,
  PUBLIC_SITE_REVIEWS_PAGE,
] as const;
export const PUBLIC_SITE_HERO_SLOT = "hero";
export const PUBLIC_SITE_STORY_SLOT = "story";
export const PUBLIC_SITE_CATEGORY_SLOT_PREFIX = "category:";

export const PUBLIC_HOME_HERO_DEFAULT_POSITION = "70% 50%";
export const PUBLIC_HOME_CATEGORY_DEFAULT_POSITION = "50% 50%";
export const PUBLIC_SERVICES_HERO_DEFAULT_POSITION = "50% 40%";
export const PUBLIC_SERVICES_CATEGORY_DEFAULT_POSITION = "50% 50%";
export const PUBLIC_ABOUT_HERO_DEFAULT_POSITION = "78% 42%";
/** Crop for CollPro's wide greeting photo so the people stay visible. */
export const COLLPRO_ABOUT_HERO_DEFAULT_POSITION = "68% 40%";
export const PUBLIC_ABOUT_STORY_DEFAULT_POSITION = "50% 45%";
export const PUBLIC_REVIEWS_HERO_DEFAULT_POSITION = "50% 40%";
/** Keep the CollPro Reviews homeowners on the right, darker left for HTML text. */
export const COLLPRO_REVIEWS_HERO_DEFAULT_POSITION = "80% 46%";

/** 1 = current object-fit:cover appearance. Higher values zoom in. */
export const PUBLIC_SITE_IMAGE_DEFAULT_ZOOM = 1;
export const PUBLIC_SITE_IMAGE_MIN_ZOOM = 1;
export const PUBLIC_SITE_IMAGE_MAX_ZOOM = 3;

export function publicReviewsHeroDefaultSrc(slug?: string | null) {
  return publicReviewsHeroImage(slug);
}

export function publicReviewsHeroDefaultPosition(slug?: string | null) {
  return slug && isCollProRenoSlug(slug)
    ? COLLPRO_REVIEWS_HERO_DEFAULT_POSITION
    : PUBLIC_REVIEWS_HERO_DEFAULT_POSITION;
}

export function publicAboutHeroDefaultSrc(slug?: string | null) {
  return publicAboutHeroImage(slug);
}

export function publicAboutHeroDefaultPosition(slug?: string | null) {
  return slug && isCollProRenoSlug(slug)
    ? COLLPRO_ABOUT_HERO_DEFAULT_POSITION
    : PUBLIC_ABOUT_HERO_DEFAULT_POSITION;
}

export const PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE =
  "Image storage is not configured for this environment. Existing photos stay in place. Connect Vercel Blob (BLOB_READ_WRITE_TOKEN) before replacing website photos.";

export type PublicSiteImageRow = {
  page: string;
  slot: string;
  imageUrl: string | null;
  objectPosition: string;
  objectZoom?: number | null;
};

export type ResolvedPublicSiteImage = {
  src: string;
  objectPosition: string;
  objectZoom: number;
  isOverride: boolean;
  usesCustomUpload: boolean;
};

export const PUBLIC_SITE_IMAGE_SELECT = {
  page: true,
  slot: true,
  imageUrl: true,
  objectPosition: true,
  objectZoom: true,
} as const;

export type PublicHomeImagePresentation = {
  hero: ResolvedPublicSiteImage;
  categories: Record<string, ResolvedPublicSiteImage>;
};

export type PublicServicesImagePresentation = {
  hero: ResolvedPublicSiteImage;
  categories: Record<string, ResolvedPublicSiteImage>;
};

export type PublicAboutImagePresentation = {
  hero: ResolvedPublicSiteImage;
  story: ResolvedPublicSiteImage;
};

export type PublicReviewsImagePresentation = {
  hero: ResolvedPublicSiteImage;
};

export type PublicSiteImageEditorSlot = {
  page: string;
  slot: string;
  label: string;
  kind: "hero" | "category" | "story";
  category: string | null;
  defaultSrc: string;
  defaultPosition: string;
  src: string;
  objectPosition: string;
  objectZoom: number;
  defaultZoom: number;
  isOverride: boolean;
  usesCustomUpload: boolean;
};

type Db = PrismaClient | Prisma.TransactionClient;

export function categoryImageSlot(category: string) {
  return `${PUBLIC_SITE_CATEGORY_SLOT_PREFIX}${category.trim()}`;
}

export function parseCategoryImageSlot(slot: string) {
  if (!slot.startsWith(PUBLIC_SITE_CATEGORY_SLOT_PREFIX)) return null;
  const category = slot.slice(PUBLIC_SITE_CATEGORY_SLOT_PREFIX.length).trim();
  return category || null;
}

export function isAllowedPublicSiteImageUrl(url: string) {
  return url.startsWith("/brand/") || isManagedBlobUrl(url);
}

export function splitObjectPosition(value: string): { x: number; y: number } {
  const parts = value.trim().split(/\s+/);
  return {
    x: positionTokenToPercent(parts[0] ?? "50%", 50),
    y: positionTokenToPercent(parts[1] ?? "50%", 50),
  };
}

export function formatObjectPosition(x: number, y: number) {
  return `${clampPercent(x)}% ${clampPercent(y)}%`;
}

export function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function clampObjectZoom(value: number) {
  if (!Number.isFinite(value)) return PUBLIC_SITE_IMAGE_DEFAULT_ZOOM;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(
    PUBLIC_SITE_IMAGE_MAX_ZOOM,
    Math.max(PUBLIC_SITE_IMAGE_MIN_ZOOM, rounded),
  );
}

export function publicImageObjectStyle(
  objectPosition: string,
  objectZoom: number,
): { objectPosition: string; transform?: string; transformOrigin?: string } {
  const zoom = clampObjectZoom(objectZoom);
  if (zoom === PUBLIC_SITE_IMAGE_DEFAULT_ZOOM) {
    return { objectPosition };
  }
  return {
    objectPosition,
    transform: `scale(${zoom})`,
    transformOrigin: objectPosition,
  };
}

function positionTokenToPercent(token: string, fallback: number) {
  const normalized = token.trim().toLowerCase();
  if (normalized === "left" || normalized === "top") return 0;
  if (normalized === "center") return 50;
  if (normalized === "right" || normalized === "bottom") return 100;
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (!match) return fallback;
  return clampPercent(Number(match[1]));
}

export function resolvePublicSiteImage(input: {
  defaultSrc: string;
  defaultPosition: string;
  defaultZoom?: number;
  row: PublicSiteImageRow | null | undefined;
}): ResolvedPublicSiteImage {
  const defaultZoom = clampObjectZoom(
    input.defaultZoom ?? PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  );
  if (!input.row) {
    return {
      src: input.defaultSrc,
      objectPosition: input.defaultPosition,
      objectZoom: defaultZoom,
      isOverride: false,
      usesCustomUpload: false,
    };
  }
  const candidate = input.row.imageUrl?.trim() || "";
  const src =
    candidate && isAllowedPublicSiteImageUrl(candidate)
      ? candidate
      : input.defaultSrc;
  return {
    src,
    objectPosition: input.row.objectPosition?.trim() || input.defaultPosition,
    objectZoom: clampObjectZoom(input.row.objectZoom ?? defaultZoom),
    isOverride: true,
    usesCustomUpload: Boolean(candidate) && isManagedBlobUrl(candidate),
  };
}

export function buildPublicHomeImagePresentation(
  groups: PublicCatalogGroup[],
  rows: PublicSiteImageRow[],
): PublicHomeImagePresentation {
  const bySlot = new Map(rows.map((row) => [`${row.page}:${row.slot}`, row]));
  const hero = resolvePublicSiteImage({
    defaultSrc: PUBLIC_HOME_HERO_IMAGE,
    defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
    row: bySlot.get(`${PUBLIC_SITE_HOME_PAGE}:${PUBLIC_SITE_HERO_SLOT}`),
  });
  const categories: Record<string, ResolvedPublicSiteImage> = {};
  for (const group of groups) {
    categories[group.category] = resolvePublicSiteImage({
      defaultSrc: publicCategoryPhoto(group.category),
      defaultPosition: PUBLIC_HOME_CATEGORY_DEFAULT_POSITION,
      row: bySlot.get(
        `${PUBLIC_SITE_HOME_PAGE}:${categoryImageSlot(group.category)}`,
      ),
    });
  }
  return { hero, categories };
}

export function buildPublicServicesImagePresentation(
  groups: PublicCatalogGroup[],
  rows: PublicSiteImageRow[],
): PublicServicesImagePresentation {
  const bySlot = new Map(rows.map((row) => [`${row.page}:${row.slot}`, row]));
  const hero = resolvePublicSiteImage({
    defaultSrc: PUBLIC_SERVICES_HERO_IMAGE,
    defaultPosition: PUBLIC_SERVICES_HERO_DEFAULT_POSITION,
    row: bySlot.get(`${PUBLIC_SITE_SERVICES_PAGE}:${PUBLIC_SITE_HERO_SLOT}`),
  });
  const categories: Record<string, ResolvedPublicSiteImage> = {};
  for (const group of groups) {
    categories[group.category] = resolvePublicSiteImage({
      defaultSrc: publicCategoryPhoto(group.category),
      defaultPosition: PUBLIC_SERVICES_CATEGORY_DEFAULT_POSITION,
      row: bySlot.get(
        `${PUBLIC_SITE_SERVICES_PAGE}:${categoryImageSlot(group.category)}`,
      ),
    });
  }
  return { hero, categories };
}

export async function loadPublicHomeImages(
  db: PrismaClient,
  businessId: string,
  groups: PublicCatalogGroup[],
): Promise<PublicHomeImagePresentation> {
  const rows = await db.publicSiteImage.findMany({
    where: { businessId, page: PUBLIC_SITE_HOME_PAGE },
    select: PUBLIC_SITE_IMAGE_SELECT,
  });
  return buildPublicHomeImagePresentation(groups, rows);
}

export function buildPublicAboutImagePresentation(
  rows: PublicSiteImageRow[],
  slug?: string | null,
): PublicAboutImagePresentation {
  const bySlot = new Map(rows.map((row) => [`${row.page}:${row.slot}`, row]));
  return {
    hero: resolvePublicSiteImage({
      defaultSrc: publicAboutHeroDefaultSrc(slug),
      defaultPosition: publicAboutHeroDefaultPosition(slug),
      row: bySlot.get(`${PUBLIC_SITE_ABOUT_PAGE}:${PUBLIC_SITE_HERO_SLOT}`),
    }),
    story: resolvePublicSiteImage({
      defaultSrc: PUBLIC_ABOUT_STORY_IMAGE,
      defaultPosition: PUBLIC_ABOUT_STORY_DEFAULT_POSITION,
      row: bySlot.get(`${PUBLIC_SITE_ABOUT_PAGE}:${PUBLIC_SITE_STORY_SLOT}`),
    }),
  };
}

export async function loadPublicServicesImages(
  db: PrismaClient,
  businessId: string,
  groups: PublicCatalogGroup[],
): Promise<PublicServicesImagePresentation> {
  const rows = await db.publicSiteImage.findMany({
    where: { businessId, page: PUBLIC_SITE_SERVICES_PAGE },
    select: PUBLIC_SITE_IMAGE_SELECT,
  });
  return buildPublicServicesImagePresentation(groups, rows);
}

export async function loadPublicAboutImages(
  db: PrismaClient,
  businessId: string,
  slug?: string | null,
): Promise<PublicAboutImagePresentation> {
  const [rows, business] = await Promise.all([
    db.publicSiteImage.findMany({
      where: { businessId, page: PUBLIC_SITE_ABOUT_PAGE },
      select: PUBLIC_SITE_IMAGE_SELECT,
    }),
    slug
      ? Promise.resolve(null)
      : db.business.findUnique({
          where: { id: businessId },
          select: { slug: true },
        }),
  ]);
  return buildPublicAboutImagePresentation(rows, slug ?? business?.slug);
}

export function buildPublicReviewsImagePresentation(
  rows: PublicSiteImageRow[],
  slug?: string | null,
): PublicReviewsImagePresentation {
  const bySlot = new Map(rows.map((row) => [`${row.page}:${row.slot}`, row]));
  return {
    hero: resolvePublicSiteImage({
      defaultSrc: publicReviewsHeroDefaultSrc(slug),
      defaultPosition: publicReviewsHeroDefaultPosition(slug),
      row: bySlot.get(`${PUBLIC_SITE_REVIEWS_PAGE}:${PUBLIC_SITE_HERO_SLOT}`),
    }),
  };
}

export async function loadPublicReviewsImages(
  db: PrismaClient,
  businessId: string,
  slug?: string | null,
): Promise<PublicReviewsImagePresentation> {
  const [rows, business] = await Promise.all([
    db.publicSiteImage.findMany({
      where: { businessId, page: PUBLIC_SITE_REVIEWS_PAGE },
      select: PUBLIC_SITE_IMAGE_SELECT,
    }),
    slug
      ? Promise.resolve(null)
      : db.business.findUnique({
          where: { id: businessId },
          select: { slug: true },
        }),
  ]);
  return buildPublicReviewsImagePresentation(rows, slug ?? business?.slug);
}

export async function loadWebsitePhotoEditorSlots(
  db: PrismaClient,
  businessId: string,
  groups: PublicCatalogGroup[],
): Promise<PublicSiteImageEditorSlot[]> {
  const visibleHomeGroups = groups.slice(0, HOMEPAGE_CATEGORY_LIMIT);
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { slug: true },
  });
  const home = await loadPublicHomeImages(db, businessId, visibleHomeGroups);
  const services = await loadPublicServicesImages(db, businessId, groups);
  const about = await loadPublicAboutImages(db, businessId, business?.slug);
  const reviews = await loadPublicReviewsImages(db, businessId, business?.slug);
  return [
    {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      label: "Home hero",
      kind: "hero",
      category: null,
      defaultSrc: PUBLIC_HOME_HERO_IMAGE,
      defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
      src: home.hero.src,
      objectPosition: home.hero.objectPosition,
      objectZoom: home.hero.objectZoom,
      defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
      isOverride: home.hero.isOverride,
      usesCustomUpload: home.hero.usesCustomUpload,
    },
    ...visibleHomeGroups.map((group) => {
      const resolved = home.categories[group.category]!;
      return {
        page: PUBLIC_SITE_HOME_PAGE,
        slot: categoryImageSlot(group.category),
        label: `Home · ${group.category}`,
        kind: "category" as const,
        category: group.category,
        defaultSrc: publicCategoryPhoto(group.category),
        defaultPosition: PUBLIC_HOME_CATEGORY_DEFAULT_POSITION,
        src: resolved.src,
        objectPosition: resolved.objectPosition,
        objectZoom: resolved.objectZoom,
        defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
        isOverride: resolved.isOverride,
        usesCustomUpload: resolved.usesCustomUpload,
      };
    }),
    {
      page: PUBLIC_SITE_SERVICES_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      label: "Services hero",
      kind: "hero",
      category: null,
      defaultSrc: PUBLIC_SERVICES_HERO_IMAGE,
      defaultPosition: PUBLIC_SERVICES_HERO_DEFAULT_POSITION,
      src: services.hero.src,
      objectPosition: services.hero.objectPosition,
      objectZoom: services.hero.objectZoom,
      defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
      isOverride: services.hero.isOverride,
      usesCustomUpload: services.hero.usesCustomUpload,
    },
    ...groups.map((group) => {
      const resolved = services.categories[group.category]!;
      return {
        page: PUBLIC_SITE_SERVICES_PAGE,
        slot: categoryImageSlot(group.category),
        label: `Services · ${group.category}`,
        kind: "category" as const,
        category: group.category,
        defaultSrc: publicCategoryPhoto(group.category),
        defaultPosition: PUBLIC_SERVICES_CATEGORY_DEFAULT_POSITION,
        src: resolved.src,
        objectPosition: resolved.objectPosition,
        objectZoom: resolved.objectZoom,
        defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
        isOverride: resolved.isOverride,
        usesCustomUpload: resolved.usesCustomUpload,
      };
    }),
    {
      page: PUBLIC_SITE_ABOUT_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      label: "About hero",
      kind: "hero",
      category: null,
      defaultSrc: publicAboutHeroDefaultSrc(business?.slug),
      defaultPosition: publicAboutHeroDefaultPosition(business?.slug),
      src: about.hero.src,
      objectPosition: about.hero.objectPosition,
      objectZoom: about.hero.objectZoom,
      defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
      isOverride: about.hero.isOverride,
      usesCustomUpload: about.hero.usesCustomUpload,
    },
    {
      page: PUBLIC_SITE_ABOUT_PAGE,
      slot: PUBLIC_SITE_STORY_SLOT,
      label: "About · Our Story",
      kind: "story",
      category: null,
      defaultSrc: PUBLIC_ABOUT_STORY_IMAGE,
      defaultPosition: PUBLIC_ABOUT_STORY_DEFAULT_POSITION,
      src: about.story.src,
      objectPosition: about.story.objectPosition,
      objectZoom: about.story.objectZoom,
      defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
      isOverride: about.story.isOverride,
      usesCustomUpload: about.story.usesCustomUpload,
    },
    {
      page: PUBLIC_SITE_REVIEWS_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      label: "Reviews hero",
      kind: "hero",
      category: null,
      defaultSrc: publicReviewsHeroDefaultSrc(business?.slug),
      defaultPosition: publicReviewsHeroDefaultPosition(business?.slug),
      src: reviews.hero.src,
      objectPosition: reviews.hero.objectPosition,
      objectZoom: reviews.hero.objectZoom,
      defaultZoom: PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
      isOverride: reviews.hero.isOverride,
      usesCustomUpload: reviews.hero.usesCustomUpload,
    },
  ];
}

function isEditablePublicSitePage(page: string) {
  return (PUBLIC_SITE_EDITABLE_PAGES as readonly string[]).includes(page);
}

async function allowedSlotsForPage(db: Db, businessId: string, page: string) {
  if (!isEditablePublicSitePage(page)) return new Set<string>();
  if (page === PUBLIC_SITE_ABOUT_PAGE) {
    return new Set([PUBLIC_SITE_HERO_SLOT, PUBLIC_SITE_STORY_SLOT]);
  }
  if (page === PUBLIC_SITE_REVIEWS_PAGE) {
    return new Set([PUBLIC_SITE_HERO_SLOT]);
  }
  const categories = await db.serviceCatalogItem.findMany({
    where: { businessId, active: true },
    select: { category: true },
    distinct: ["category"],
  });
  const slots = new Set<string>([PUBLIC_SITE_HERO_SLOT]);
  for (const row of categories) {
    slots.add(categoryImageSlot(row.category));
  }
  return slots;
}

function defaultPositionFor(page: string, slot: string) {
  if (page === PUBLIC_SITE_REVIEWS_PAGE) {
    return PUBLIC_REVIEWS_HERO_DEFAULT_POSITION;
  }
  if (page === PUBLIC_SITE_ABOUT_PAGE) {
    return slot === PUBLIC_SITE_STORY_SLOT
      ? PUBLIC_ABOUT_STORY_DEFAULT_POSITION
      : PUBLIC_ABOUT_HERO_DEFAULT_POSITION;
  }
  if (slot === PUBLIC_SITE_HERO_SLOT) {
    return page === PUBLIC_SITE_SERVICES_PAGE
      ? PUBLIC_SERVICES_HERO_DEFAULT_POSITION
      : PUBLIC_HOME_HERO_DEFAULT_POSITION;
  }
  return page === PUBLIC_SITE_SERVICES_PAGE
    ? PUBLIC_SERVICES_CATEGORY_DEFAULT_POSITION
    : PUBLIC_HOME_CATEGORY_DEFAULT_POSITION;
}

export class PublicSiteImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicSiteImageError";
  }
}

export function publicSiteImageErrorMessage(error: unknown, fallback: string) {
  if (error instanceof PublicSiteImageError || error instanceof ForbiddenError) {
    return error.message;
  }
  return fallback;
}

export async function upsertPublicSiteImageOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    page: string;
    slot: string;
    imageUrl?: string | null;
    objectPosition?: string;
    objectZoom?: number;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  if (!isEditablePublicSitePage(input.page)) {
    throw new PublicSiteImageError("That page is not editable yet.");
  }

  const allowed = await allowedSlotsForPage(db, access.businessId, input.page);
  if (!allowed.has(input.slot)) {
    throw new PublicSiteImageError(
      "That image slot is not available for this catalog.",
    );
  }

  if (
    input.imageUrl != null &&
    input.imageUrl !== "" &&
    !isAllowedPublicSiteImageUrl(input.imageUrl)
  ) {
    throw new PublicSiteImageError("That image source is not allowed.");
  }

  const previous = await db.publicSiteImage.findUnique({
    where: {
      businessId_page_slot: {
        businessId: access.businessId,
        page: input.page,
        slot: input.slot,
      },
    },
  });

  const nextUrl =
    input.imageUrl === undefined
      ? previous?.imageUrl ?? null
      : input.imageUrl || null;
  const nextPosition =
    input.objectPosition?.trim() ||
    previous?.objectPosition ||
    defaultPositionFor(input.page, input.slot);
  const nextZoom = clampObjectZoom(
    input.objectZoom ?? previous?.objectZoom ?? PUBLIC_SITE_IMAGE_DEFAULT_ZOOM,
  );

  const saved = await db.publicSiteImage.upsert({
    where: {
      businessId_page_slot: {
        businessId: access.businessId,
        page: input.page,
        slot: input.slot,
      },
    },
    create: {
      businessId: access.businessId,
      page: input.page,
      slot: input.slot,
      imageUrl: nextUrl,
      objectPosition: nextPosition,
      objectZoom: nextZoom,
      updatedByMembershipId: access.workspace.membership.id,
    },
    update: {
      imageUrl: nextUrl,
      objectPosition: nextPosition,
      objectZoom: nextZoom,
      updatedByMembershipId: access.workspace.membership.id,
    },
  });

  if (
    previous?.imageUrl &&
    previous.imageUrl !== nextUrl &&
    isManagedBlobUrl(previous.imageUrl)
  ) {
    await deleteJobPhotoBlob(previous.imageUrl);
  }

  await writeSettingsAuditLog(db, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: "website-photos",
    settingKey: `${input.page}:${input.slot}`,
    previousValue: previous
      ? {
          imageUrl: previous.imageUrl,
          objectPosition: previous.objectPosition,
          objectZoom: previous.objectZoom,
        }
      : null,
    newValue: {
      imageUrl: saved.imageUrl,
      objectPosition: saved.objectPosition,
      objectZoom: saved.objectZoom,
    },
  });

  return saved;
}

export async function resetPublicSiteImageOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: { page: string; slot: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  if (!isEditablePublicSitePage(input.page)) {
    throw new PublicSiteImageError("That page is not editable yet.");
  }

  const existing = await db.publicSiteImage.findFirst({
    where: {
      businessId: access.businessId,
      page: input.page,
      slot: input.slot,
    },
  });
  if (!existing) {
    return { unchanged: true as const };
  }

  await db.publicSiteImage.delete({ where: { id: existing.id } });
  if (existing.imageUrl && isManagedBlobUrl(existing.imageUrl)) {
    await deleteJobPhotoBlob(existing.imageUrl);
  }

  await writeSettingsAuditLog(db, {
    businessId: access.businessId,
    changedByMembershipId: access.workspace.membership.id,
    settingArea: "website-photos",
    settingKey: `${input.page}:${input.slot}`,
    previousValue: {
      imageUrl: existing.imageUrl,
      objectPosition: existing.objectPosition,
      objectZoom: existing.objectZoom,
    },
    newValue: null,
  });

  return { unchanged: false as const };
}
