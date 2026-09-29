/**
 * Marketing mutations -- the real write path used by server actions and
 * the focused Marketing check. Every function takes an already-authorized
 * BusinessAccess and re-checks tenant + role before writing. Never trusts
 * a browser-supplied businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  buildCreatorPackagePreview,
  buildMarketingReviewPacket,
  canSelectPhotoForMarketing,
  CREATOR_PACKAGE_NOT_APPROVED_MESSAGE,
  formatHashtags,
  isMarketingChannel,
  isMarketingContentStatus,
  isMarketingContentType,
  INVALID_SHOT_LIST_MESSAGE,
  INVALID_STORYBOARD_MESSAGE,
  marketingReviewPacketFilename,
  nextContentStatus,
  OWNER_REVIEW_PACKET_MESSAGE,
  OWNER_STUDIO_APPROVAL_MESSAGE,
  OWNER_STUDIO_CALENDAR_MESSAGE,
  STUDIO_APPROVE_NOT_READY_MESSAGE,
  STUDIO_APPROVAL_QUEUE_STATUS,
  STUDIO_CALENDAR_PACKAGE_NOT_FOUND_MESSAGE,
  STUDIO_PACKAGE_STALE_MESSAGE,
  STUDIO_PLANNED_DAY_INVALID_MESSAGE,
  STUDIO_PLANNED_DAY_SNAPSHOT_REQUIRED_MESSAGE,
  STUDIO_PLANNED_DAY_STALE_MESSAGE,
  STUDIO_RETURN_FOR_CHANGES_MESSAGE,
  STUDIO_RETURN_NOT_READY_MESSAGE,
  parseHashtags,
  parseRequiredShotList,
  parseRequiredStoryboard,
  parseShotList,
  parseStoryboard,
  parseStudioPublicationDay,
  PHOTO_PERMISSION_APPROVED,
  PHOTO_PERMISSION_PRIVATE,
  PHOTO_PERMISSION_REVOKED_MESSAGE,
  serializeShotList,
  serializeStoryboard,
  studioPhotosEligible,
  studioPublicationDayKey,
  type CreatorPackage,
  type MarketingReviewPacket,
} from "@/lib/marketing";

type Db = PrismaClient | Prisma.TransactionClient;

async function runInTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) {
    return db.$transaction(fn);
  }
  return fn(db);
}

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
  campaignId?: string;
  catalogItemId?: string;
  storyboardJson?: string;
  shotListJson?: string;
  hashtags?: string;
  requireApprovedPhoto?: boolean;
};

export type UpdateMarketingStudioInput = {
  contentId: string;
  title?: string;
  body?: string;
  storyboardJson?: string;
  shotListJson?: string;
  hashtags?: string;
  photoIds?: string[];
  channelIntent?: string;
};

async function loadOwnedPhotos(
  db: Db,
  access: BusinessAccess,
  photoIds: string[],
  jobId: string | null,
) {
  const uniqueIds = [...new Set(photoIds.filter(Boolean))];
  const photos = uniqueIds.length
    ? await db.jobPhoto.findMany({
        where: { id: { in: uniqueIds }, ...access.scope },
      })
    : [];
  if (photos.length !== uniqueIds.length) {
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
  return photos;
}

async function assertAttachedPhotosStillApproved(
  db: Db,
  access: BusinessAccess,
  contentId: string,
) {
  const attached = await db.marketingContentPhoto.findMany({
    where: { contentId, ...access.scope },
    include: {
      jobPhoto: {
        select: {
          id: true,
          url: true,
          caption: true,
          stage: true,
          businessId: true,
          marketingPermissionStatus: true,
        },
      },
    },
  });
  if (attached.length === 0 || !studioPhotosEligible(attached.map((row) => row.jobPhoto))) {
    throw new MarketingError(PHOTO_PERMISSION_REVOKED_MESSAGE);
  }
  return attached;
}

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

  const photos = await loadOwnedPhotos(db, access, input.photoIds ?? [], jobId);
  if (input.requireApprovedPhoto && photos.length === 0) {
    throw new MarketingError("Select a job photo that already has marketing permission.");
  }

  let campaignId: string | null = null;
  if (input.campaignId) {
    const campaign = access.assertOwned(
      await db.marketingCampaign.findFirst({
        where: { id: input.campaignId, ...access.scope },
        select: { id: true, businessId: true },
      }),
    );
    campaignId = campaign.id;
  }
  let catalogItemId: string | null = null;
  if (input.catalogItemId) {
    const catalog = access.assertOwned(
      await db.serviceCatalogItem.findFirst({
        where: { id: input.catalogItemId, ...access.scope },
        select: { id: true, businessId: true },
      }),
    );
    catalogItemId = catalog.id;
  }

  return db.marketingContent.create({
    data: {
      businessId: access.businessId,
      jobId,
      campaignId,
      catalogItemId,
      contentType: input.contentType,
      title,
      body,
      channelIntent,
      status: "DRAFT",
      plannedFor: null,
      storyboardJson: serializeStoryboard(parseStoryboard(input.storyboardJson ?? "[]")),
      shotListJson: serializeShotList(parseShotList(input.shotListJson ?? "[]")),
      hashtags: formatHashtags(parseHashtags(input.hashtags ?? "")),
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

export async function createMarketingStudioPackage(
  db: Db,
  access: BusinessAccess,
  input: CreateMarketingContentInput,
) {
  return createMarketingContent(db, access, {
    ...input,
    contentType: input.contentType || "COMPLETED_JOB",
    requireApprovedPhoto: true,
  });
}

export async function updateMarketingStudioPackage(
  db: Db,
  access: BusinessAccess,
  input: UpdateMarketingStudioInput,
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
    }),
  );
  if (content.status === "APPROVED") {
    throw new MarketingError("Approved creator packages are locked. Start a new draft to change the storyboard.");
  }

  const title = input.title !== undefined ? input.title.trim() : content.title;
  if (!title) throw new MarketingError("Enter an internal title.");
  const body = input.body !== undefined ? input.body.trim() : content.body;
  const channelIntent = input.channelIntent?.trim() || content.channelIntent;
  if (!isMarketingChannel(channelIntent)) {
    throw new MarketingError("Choose a channel intent.");
  }

  let storyboardJson = content.storyboardJson;
  if (input.storyboardJson !== undefined) {
    const beats = parseRequiredStoryboard(input.storyboardJson);
    if (!beats) throw new MarketingError(INVALID_STORYBOARD_MESSAGE);
    storyboardJson = serializeStoryboard(beats);
  }
  let shotListJson = content.shotListJson;
  if (input.shotListJson !== undefined) {
    const shots = parseRequiredShotList(input.shotListJson);
    if (!shots) throw new MarketingError(INVALID_SHOT_LIST_MESSAGE);
    shotListJson = serializeShotList(shots);
  }
  const hashtags =
    input.hashtags !== undefined
      ? formatHashtags(parseHashtags(input.hashtags))
      : content.hashtags;

  const photos = input.photoIds
    ? await loadOwnedPhotos(db, access, input.photoIds, content.jobId)
    : null;
  if (input.photoIds && (!photos || photos.length === 0)) {
    throw new MarketingError("Select a job photo that already has marketing permission.");
  }

  return runInTransaction(db, async (tx) => {
    const claimed = await tx.marketingContent.updateMany({
      where: {
        id: content.id,
        businessId: access.businessId,
        updatedAt: content.updatedAt,
      },
      data: {
        title,
        body,
        channelIntent,
        storyboardJson,
        shotListJson,
        hashtags,
      },
    });
    if (claimed.count !== 1) {
      throw new MarketingError(STUDIO_PACKAGE_STALE_MESSAGE);
    }
    if (photos) {
      await tx.marketingContentPhoto.deleteMany({
        where: { contentId: content.id, ...access.scope },
      });
      await tx.marketingContentPhoto.createMany({
        data: photos.map((photo) => ({
          businessId: access.businessId,
          contentId: content.id,
          jobPhotoId: photo.id,
        })),
      });
    }
    return access.assertOwned(
      await tx.marketingContent.findFirst({
        where: { id: content.id, ...access.scope },
        include: { photos: true },
      }),
    );
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
  if (next === "APPROVED" && access.workspace.role !== "OWNER") {
    throw new MarketingError(OWNER_STUDIO_APPROVAL_MESSAGE);
  }
  await assertAttachedPhotosStillApproved(db, access, content.id);
  return db.marketingContent.update({
    where: { id: content.id },
    data: {
      status: next,
      reviewedByMembershipId: next === "APPROVED" ? access.workspace.membership.id : content.reviewedByMembershipId,
      reviewedAt: next === "APPROVED" ? new Date() : content.reviewedAt,
    },
  });
}

function requireOwnerStudioApproval(access: BusinessAccess, message: string) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingError(message);
  }
  requireBusinessRole(access, "OWNER");
}

function studioApprovalQueueWriteWhere(
  access: BusinessAccess,
  contentId: string,
  updatedAt?: Date,
) {
  return {
    id: contentId,
    businessId: access.businessId,
    status: STUDIO_APPROVAL_QUEUE_STATUS,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export async function approveMarketingStudioPackage(
  db: Db,
  access: BusinessAccess,
  input: { contentId: string },
) {
  requireOwnerStudioApproval(access, OWNER_STUDIO_APPROVAL_MESSAGE);
  return runInTransaction(db, async (tx) => {
    const content = access.assertOwned(
      await tx.marketingContent.findFirst({
        where: { id: input.contentId, ...access.scope },
      }),
    );
    if (content.status !== STUDIO_APPROVAL_QUEUE_STATUS) {
      throw new MarketingError(STUDIO_APPROVE_NOT_READY_MESSAGE);
    }
    await assertAttachedPhotosStillApproved(tx, access, content.id);
    // Same business + READY_FOR_REVIEW + snapshot updatedAt at commit.
    const claimed = await tx.marketingContent.updateMany({
      where: studioApprovalQueueWriteWhere(access, content.id, content.updatedAt),
      data: {
        status: "APPROVED",
        reviewedByMembershipId: access.workspace.membership.id,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      throw new MarketingError(STUDIO_APPROVE_NOT_READY_MESSAGE);
    }
    return access.assertOwned(
      await tx.marketingContent.findFirst({
        where: { id: content.id, ...access.scope },
      }),
    );
  });
}

export async function returnMarketingStudioPackage(
  db: Db,
  access: BusinessAccess,
  input: { contentId: string },
) {
  requireOwnerStudioApproval(access, STUDIO_RETURN_FOR_CHANGES_MESSAGE);
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
    }),
  );
  if (content.status !== STUDIO_APPROVAL_QUEUE_STATUS) {
    throw new MarketingError(STUDIO_RETURN_NOT_READY_MESSAGE);
  }
  const claimed = await db.marketingContent.updateMany({
    where: studioApprovalQueueWriteWhere(access, content.id),
    data: { status: "DRAFT" },
  });
  if (claimed.count !== 1) {
    throw new MarketingError(STUDIO_RETURN_NOT_READY_MESSAGE);
  }
  return access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: content.id, ...access.scope },
    }),
  );
}

export async function exportMarketingCreatorPackage(
  db: Db,
  access: BusinessAccess,
  input: { contentId: string },
): Promise<{ filename: string; package: CreatorPackage }> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
      include: {
        photos: {
          include: {
            jobPhoto: {
              select: {
                id: true,
                url: true,
                caption: true,
                stage: true,
                marketingPermissionStatus: true,
              },
            },
          },
        },
        job: {
          select: {
            estimate: {
              select: { lineItems: { select: { description: true } } },
            },
          },
        },
      },
    }),
  );
  if (content.status !== "APPROVED") {
    throw new MarketingError(CREATOR_PACKAGE_NOT_APPROVED_MESSAGE);
  }
  const attached = await assertAttachedPhotosStillApproved(db, access, content.id);
  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { name: true, publicServiceAreaLabel: true },
  });
  const creatorPackage = buildCreatorPackagePreview({
    title: content.title,
    caption: content.body,
    hashtags: content.hashtags,
    storyboardJson: content.storyboardJson,
    shotListJson: content.shotListJson,
    photos: attached.map((row) => row.jobPhoto),
    recordedFacts: {
      businessName: business?.name ?? "Business",
      workPerformed: content.job?.estimate?.lineItems[0]?.description ?? null,
      city: business?.publicServiceAreaLabel ?? null,
    },
  });
  await db.marketingContent.update({
    where: { id: content.id },
    data: {
      exportedAt: new Date(),
      exportedByMembershipId: access.workspace.membership.id,
    },
  });
  const slug = content.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return {
    filename: `${slug || "creator-package"}-handoff.json`,
    package: creatorPackage,
  };
}

const REVIEW_PACKET_CONTENT_SELECT = {
  photos: {
    include: {
      jobPhoto: {
        select: {
          id: true,
          url: true,
          stage: true,
          marketingPermissionStatus: true,
        },
      },
    },
  },
} as const;

export async function downloadMarketingReviewPacket(
  db: Db,
  access: BusinessAccess,
  input: { contentId: string },
): Promise<{ filename: string; packet: MarketingReviewPacket }> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingError(OWNER_REVIEW_PACKET_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
      include: REVIEW_PACKET_CONTENT_SELECT,
    }),
  );
  const packet = buildMarketingReviewPacket({
    title: content.title,
    status: content.status,
    caption: content.body,
    hashtags: content.hashtags,
    storyboardJson: content.storyboardJson,
    shotListJson: content.shotListJson,
    photos: content.photos.map((row) => row.jobPhoto),
  });
  return {
    filename: marketingReviewPacketFilename(content.title, content.status),
    packet,
  };
}

function requireOwnerStudioCalendar(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingError(OWNER_STUDIO_CALENDAR_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function parseExpectedUpdatedAt(raw: string | Date | undefined): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function studioCalendarWriteWhere(
  access: BusinessAccess,
  contentId: string,
  updatedAt: Date,
) {
  return {
    id: contentId,
    businessId: access.businessId,
    updatedAt,
  };
}

export type PlanStudioPublicationDayInput = {
  contentId: string;
  plannedFor: string;
  expectedUpdatedAt: string | Date;
};

export type PlanStudioPublicationDayResult = {
  id: string;
  status: string;
  plannedFor: Date;
  plannedDay: string;
  exportedAt: Date | null;
  reviewedByMembershipId: string | null;
  updatedAt: Date;
  published: false;
  posted: false;
  customerMessageSent: false;
  providerConnectionClaimed: false;
};

export async function planStudioPublicationDay(
  db: Db,
  access: BusinessAccess,
  input: PlanStudioPublicationDayInput,
): Promise<PlanStudioPublicationDayResult> {
  requireOwnerStudioCalendar(access);
  return runInTransaction(db, async (tx) => {
    const business = await tx.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    });
    const timeZone = resolveBusinessTimeZone(business);
    const plannedFor = parseStudioPublicationDay(input.plannedFor, timeZone);
    if (!plannedFor) {
      throw new MarketingError(STUDIO_PLANNED_DAY_INVALID_MESSAGE);
    }

    const content = access.assertOwned(
      await tx.marketingContent.findFirst({
        where: { id: input.contentId, ...access.scope },
      }),
    );
    if (!isMarketingContentStatus(content.status)) {
      throw new MarketingError(STUDIO_CALENDAR_PACKAGE_NOT_FOUND_MESSAGE);
    }

    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      throw new MarketingError(STUDIO_PLANNED_DAY_SNAPSHOT_REQUIRED_MESSAGE);
    }
    if (expectedUpdatedAt.getTime() !== content.updatedAt.getTime()) {
      throw new MarketingError(STUDIO_PLANNED_DAY_STALE_MESSAGE);
    }

    const currentDay = content.plannedFor
      ? studioPublicationDayKey(content.plannedFor, timeZone)
      : null;
    if (currentDay === input.plannedFor.trim() && content.plannedFor) {
      return {
        id: content.id,
        status: content.status,
        plannedFor: content.plannedFor,
        plannedDay: currentDay,
        exportedAt: content.exportedAt,
        reviewedByMembershipId: content.reviewedByMembershipId,
        updatedAt: content.updatedAt,
        published: false,
        posted: false,
        customerMessageSent: false,
        providerConnectionClaimed: false,
      };
    }

    const claimed = await tx.marketingContent.updateMany({
      where: studioCalendarWriteWhere(access, content.id, content.updatedAt),
      data: { plannedFor },
    });
    if (claimed.count !== 1) {
      throw new MarketingError(STUDIO_PLANNED_DAY_STALE_MESSAGE);
    }

    const updated = access.assertOwned(
      await tx.marketingContent.findFirst({
        where: { id: content.id, ...access.scope },
      }),
    );
    if (!updated.plannedFor) {
      throw new MarketingError(STUDIO_PLANNED_DAY_INVALID_MESSAGE);
    }
    return {
      id: updated.id,
      status: updated.status,
      plannedFor: updated.plannedFor,
      plannedDay: studioPublicationDayKey(updated.plannedFor, timeZone),
      exportedAt: updated.exportedAt,
      reviewedByMembershipId: updated.reviewedByMembershipId,
      updatedAt: updated.updatedAt,
      published: false,
      posted: false,
      customerMessageSent: false,
      providerConnectionClaimed: false,
    };
  });
}

export async function createMarketingCampaign(
  db: Db,
  access: BusinessAccess,
  input: { name: string; sourceKey?: string; notes?: string; recordedCost?: string | null },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const name = input.name.trim();
  if (!name) throw new MarketingError("A campaign needs a name.");
  const rawCost = input.recordedCost?.trim() ?? "";
  let recordedCost: Prisma.Decimal | null = null;
  if (rawCost) {
    const amount = Number(rawCost);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new MarketingError("Enter a recorded campaign cost of zero or more, or leave it blank.");
    }
    recordedCost = new Prisma.Decimal(amount.toFixed(2));
  }
  return db.marketingCampaign.create({
    data: {
      businessId: access.businessId,
      name,
      sourceKey: input.sourceKey?.trim() || "OTHER",
      notes: input.notes?.trim() ?? "",
      recordedCost,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function setMarketingCampaignStatus(
  db: Db,
  access: BusinessAccess,
  input: { campaignId: string; status: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  const allowed = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"];
  if (!allowed.includes(input.status)) {
    throw new MarketingError("Choose a valid campaign status.");
  }
  const campaign = access.assertOwned(
    await db.marketingCampaign.findFirst({
      where: { id: input.campaignId, ...access.scope },
    }),
  );
  return db.marketingCampaign.update({
    where: { id: campaign.id },
    data: { status: input.status },
  });
}

export async function saveMarketingBrandVoice(
  db: Db,
  access: BusinessAccess,
  input: { brandVoice?: string; identityNotes?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  return db.businessSettings.upsert({
    where: { businessId: access.businessId },
    create: {
      businessId: access.businessId,
      marketingBrandVoice: input.brandVoice?.trim() || null,
      marketingIdentityNotes: input.identityNotes?.trim() || null,
    },
    update: {
      marketingBrandVoice: input.brandVoice?.trim() || null,
      marketingIdentityNotes: input.identityNotes?.trim() || null,
    },
  });
}
