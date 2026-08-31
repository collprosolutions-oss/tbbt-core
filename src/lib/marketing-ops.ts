/**
 * Marketing mutations -- the real write path used by server actions and
 * the focused Marketing check. Every function takes an already-authorized
 * BusinessAccess and re-checks tenant + role before writing. Never trusts
 * a browser-supplied businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  canSelectPhotoForMarketing,
  isMarketingChannel,
  isMarketingContentStatus,
  isMarketingContentType,
  nextContentStatus,
  parseMarketingDate,
  PHOTO_PERMISSION_APPROVED,
  PHOTO_PERMISSION_PRIVATE,
} from "@/lib/marketing";

type Db = PrismaClient | Prisma.TransactionClient;

export class MarketingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingError";
  }
}

export function marketingErrorMessage(error: unknown, fallback: string) {
  if (error instanceof MarketingError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export type CreateMarketingContentInput = {
  contentType: string;
  title: string;
  body?: string;
  channelIntent?: string;
  jobId?: string;
  photoIds?: string[];
  plannedFor?: string;
};

export async function grantJobPhotoMarketingPermission(
  db: Db,
  access: BusinessAccess,
  input: { photoId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const photo = access.assertOwned(
    await db.jobPhoto.findFirst({
      where: { id: input.photoId, ...access.scope },
    }),
  );
  return db.jobPhoto.update({
    where: { id: photo.id },
    data: {
      marketingPermissionStatus: PHOTO_PERMISSION_APPROVED,
      marketingPermissionGrantedAt: new Date(),
      marketingPermissionGrantedByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function revokeJobPhotoMarketingPermission(
  db: Db,
  access: BusinessAccess,
  input: { photoId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const photo = access.assertOwned(
    await db.jobPhoto.findFirst({
      where: { id: input.photoId, ...access.scope },
    }),
  );
  const attached = await db.marketingContentPhoto.count({
    where: { jobPhotoId: photo.id, ...access.scope },
  });
  if (attached > 0) {
    throw new MarketingError("Remove this photo from marketing content before revoking permission.");
  }
  return db.jobPhoto.update({
    where: { id: photo.id },
    data: {
      marketingPermissionStatus: PHOTO_PERMISSION_PRIVATE,
      marketingPermissionGrantedAt: null,
      marketingPermissionGrantedByMembershipId: null,
    },
  });
}

export async function createMarketingContent(
  db: Db,
  access: BusinessAccess,
  input: CreateMarketingContentInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);

  if (!isMarketingContentType(input.contentType)) {
    throw new MarketingError("Choose a content type.");
  }
  const title = input.title.trim();
  if (!title) {
    throw new MarketingError("Enter an internal title.");
  }
  const body = (input.body ?? "").trim();
  const channelIntent = input.channelIntent?.trim() || "UNASSIGNED";
  if (!isMarketingChannel(channelIntent)) {
    throw new MarketingError("Choose a channel intent.");
  }

  let jobId: string | null = null;
  if (input.jobId) {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: input.jobId, ...access.scope },
        select: { id: true, businessId: true, status: true },
      }),
    );
    jobId = job.id;
  }

  const photoIds = [...new Set((input.photoIds ?? []).filter(Boolean))];
  const photos = photoIds.length
    ? await db.jobPhoto.findMany({
        where: { id: { in: photoIds }, ...access.scope },
      })
    : [];
  if (photos.length !== photoIds.length) {
    throw new MarketingError("One of those photos is not in this business.");
  }
  for (const photo of photos) {
    if (!canSelectPhotoForMarketing(photo)) {
      throw new MarketingError("Private job photos cannot be used in marketing content.");
    }
    if (jobId && photo.jobId !== jobId) {
      throw new MarketingError("Selected photos must belong to the source job.");
    }
  }

  const plannedFor = input.plannedFor ? parseMarketingDate(input.plannedFor) : null;

  return db.marketingContent.create({
    data: {
      businessId: access.businessId,
      jobId,
      contentType: input.contentType,
      title,
      body,
      channelIntent,
      status: "DRAFT",
      plannedFor,
      createdByMembershipId: access.workspace.membership.id,
      photos: {
        create: photos.map((photo) => ({
          businessId: access.businessId,
          jobPhotoId: photo.id,
        })),
      },
    },
    include: { photos: true },
  });
}

export async function advanceMarketingContentStatus(
  db: Db,
  access: BusinessAccess,
  input: { contentId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
    }),
  );
  const next = nextContentStatus(content.status);
  if (!next) {
    throw new MarketingError("This content is already approved. External publishing is not available.");
  }
  if (!isMarketingContentStatus(next)) {
    throw new MarketingError("Invalid content status.");
  }
  return db.marketingContent.update({
    where: { id: content.id },
    data: {
      status: next,
      reviewedByMembershipId: next === "APPROVED" ? access.workspace.membership.id : content.reviewedByMembershipId,
      reviewedAt: next === "APPROVED" ? new Date() : content.reviewedAt,
    },
  });
}

export async function setMarketingContentPlannedFor(
  db: Db,
  access: BusinessAccess,
  input: { contentId: string; plannedFor: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
    }),
  );
  const plannedFor = parseMarketingDate(input.plannedFor);
  if (!plannedFor) {
    throw new MarketingError("Enter a valid internal planning date.");
  }
  return db.marketingContent.update({
    where: { id: content.id },
    data: { plannedFor },
  });
}
