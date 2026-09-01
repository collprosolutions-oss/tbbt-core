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
  PUBLIC_HOME_HERO_IMAGE,
  publicCategoryPhoto,
  type PublicCatalogGroup,
} from "@/lib/public-site";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import {
  deleteJobPhotoBlob,
  isManagedBlobUrl,
} from "@/lib/storage";

export const PUBLIC_SITE_HOME_PAGE = "home";
export const PUBLIC_SITE_HERO_SLOT = "hero";
export const PUBLIC_SITE_CATEGORY_SLOT_PREFIX = "category:";

export const PUBLIC_HOME_HERO_DEFAULT_POSITION = "70% 50%";
export const PUBLIC_HOME_CATEGORY_DEFAULT_POSITION = "50% 50%";

export const PUBLIC_SITE_IMAGE_STORAGE_UNAVAILABLE =
  "Image storage is not configured for this environment. Existing photos stay in place. Connect Vercel Blob (BLOB_READ_WRITE_TOKEN) before replacing website photos.";

export type PublicSiteImageRow = {
  page: string;
  slot: string;
  imageUrl: string | null;
  objectPosition: string;
};

export type ResolvedPublicSiteImage = {
  src: string;
  objectPosition: string;
  isOverride: boolean;
  usesCustomUpload: boolean;
};

export type PublicHomeImagePresentation = {
  hero: ResolvedPublicSiteImage;
  categories: Record<string, ResolvedPublicSiteImage>;
};

export type PublicSiteImageEditorSlot = {
  page: string;
  slot: string;
  label: string;
  kind: "hero" | "category";
  category: string | null;
  defaultSrc: string;
  defaultPosition: string;
  src: string;
  objectPosition: string;
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

function positionTokenToPercent(token: string, fallback: number) {
  const normalized = token.trim().toLowerCase();
  if (normalized === "left" || normalized === "top") return 0;
  if (normalized === "center") return 50;
  if (normalized === "right" || normalized === "bottom") return 100;
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (!match) return fallback;
  return clampPercent(Number(match[1]));
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function resolvePublicSiteImage(input: {
  defaultSrc: string;
  defaultPosition: string;
  row: PublicSiteImageRow | null | undefined;
}): ResolvedPublicSiteImage {
  if (!input.row) {
    return {
      src: input.defaultSrc,
      objectPosition: input.defaultPosition,
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

export async function loadPublicHomeImages(
  db: PrismaClient,
  businessId: string,
  groups: PublicCatalogGroup[],
): Promise<PublicHomeImagePresentation> {
  const rows = await db.publicSiteImage.findMany({
    where: { businessId, page: PUBLIC_SITE_HOME_PAGE },
    select: {
      page: true,
      slot: true,
      imageUrl: true,
      objectPosition: true,
    },
  });
  return buildPublicHomeImagePresentation(groups, rows);
}

export async function loadWebsitePhotoEditorSlots(
  db: PrismaClient,
  businessId: string,
  groups: PublicCatalogGroup[],
): Promise<PublicSiteImageEditorSlot[]> {
  const visibleGroups = groups.slice(0, HOMEPAGE_CATEGORY_LIMIT);
  const presentation = await loadPublicHomeImages(db, businessId, visibleGroups);
  return [
    {
      page: PUBLIC_SITE_HOME_PAGE,
      slot: PUBLIC_SITE_HERO_SLOT,
      label: "Hero Image",
      kind: "hero",
      category: null,
      defaultSrc: PUBLIC_HOME_HERO_IMAGE,
      defaultPosition: PUBLIC_HOME_HERO_DEFAULT_POSITION,
      src: presentation.hero.src,
      objectPosition: presentation.hero.objectPosition,
      isOverride: presentation.hero.isOverride,
      usesCustomUpload: presentation.hero.usesCustomUpload,
    },
    ...visibleGroups.map((group) => {
      const resolved = presentation.categories[group.category]!;
      return {
        page: PUBLIC_SITE_HOME_PAGE,
        slot: categoryImageSlot(group.category),
        label: group.category,
        kind: "category" as const,
        category: group.category,
        defaultSrc: publicCategoryPhoto(group.category),
        defaultPosition: PUBLIC_HOME_CATEGORY_DEFAULT_POSITION,
        src: resolved.src,
        objectPosition: resolved.objectPosition,
        isOverride: resolved.isOverride,
        usesCustomUpload: resolved.usesCustomUpload,
      };
    }),
  ];
}

async function allowedHomeSlots(db: Db, businessId: string) {
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
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  if (input.page !== PUBLIC_SITE_HOME_PAGE) {
    throw new PublicSiteImageError("That page is not editable yet.");
  }

  const allowed = await allowedHomeSlots(db, access.businessId);
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
    (input.slot === PUBLIC_SITE_HERO_SLOT
      ? PUBLIC_HOME_HERO_DEFAULT_POSITION
      : PUBLIC_HOME_CATEGORY_DEFAULT_POSITION);

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
      updatedByMembershipId: access.workspace.membership.id,
    },
    update: {
      imageUrl: nextUrl,
      objectPosition: nextPosition,
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
      ? { imageUrl: previous.imageUrl, objectPosition: previous.objectPosition }
      : null,
    newValue: { imageUrl: saved.imageUrl, objectPosition: saved.objectPosition },
  });

  return saved;
}

export async function resetPublicSiteImageOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: { page: string; slot: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  if (input.page !== PUBLIC_SITE_HOME_PAGE) {
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
    },
    newValue: null,
  });

  return { unchanged: false as const };
}
