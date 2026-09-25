import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import { WebsitePublishError } from "@/lib/website-engine/builder";

type Db = PrismaClient;

export async function setReviewWebsiteSelected(
  db: Db,
  access: BusinessAccess,
  input: { reviewId: string; selected: boolean },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);
  const review = access.assertOwned(
    await db.review.findFirst({
      where: { id: input.reviewId, ...access.scope },
    }),
  );
  if (!review.reviewText.trim()) {
    throw new WebsitePublishError("Only recorded reviews with customer text can appear on the website.");
  }
  return db.review.update({
    where: { id: review.id },
    data: { websiteSelected: input.selected },
  });
}

export async function addWebsiteGalleryItem(
  db: Db,
  access: BusinessAccess,
  input: {
    storedAssetId: string;
    title?: string;
    caption?: string;
    catalogItemId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);
  const asset = access.assertOwned(
    await db.storedAsset.findFirst({
      where: { id: input.storedAssetId, ...access.scope },
    }),
  );
  if (asset.visibility !== "PUBLIC" || asset.category !== "WEBSITE_IMAGE" || asset.status !== "READY") {
    throw new WebsitePublishError("Only ready PUBLIC website photos can be added to the gallery.");
  }
  if (input.catalogItemId) {
    access.assertOwned(
      await db.serviceCatalogItem.findFirst({
        where: { id: input.catalogItemId, ...access.scope },
      }),
    );
  }
  const last = await db.websiteGalleryItem.findFirst({
    where: { businessId: access.businessId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return db.websiteGalleryItem.create({
    data: {
      businessId: access.businessId,
      storedAssetId: asset.id,
      title: input.title?.trim() ?? "",
      caption: input.caption?.trim() ?? "",
      catalogItemId: input.catalogItemId ?? null,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function removeWebsiteGalleryItem(
  db: Db,
  access: BusinessAccess,
  input: { id: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);
  const item = access.assertOwned(
    await db.websiteGalleryItem.findFirst({
      where: { id: input.id, ...access.scope },
    }),
  );
  await db.websiteGalleryItem.delete({ where: { id: item.id } });
}

export async function saveWebsiteLocalPageDraft(
  db: Db,
  access: BusinessAccess,
  input: { serviceAreaId: string; catalogItemId: string; draftCopy: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);
  const area = access.assertOwned(
    await db.serviceArea.findFirst({
      where: { id: input.serviceAreaId, ...access.scope },
    }),
  );
  const service = access.assertOwned(
    await db.serviceCatalogItem.findFirst({
      where: { id: input.catalogItemId, ...access.scope },
    }),
  );
  return db.websiteLocalPageDraft.upsert({
    where: {
      businessId_serviceAreaId_catalogItemId: {
        businessId: access.businessId,
        serviceAreaId: area.id,
        catalogItemId: service.id,
      },
    },
    update: { draftCopy: input.draftCopy.trim() },
    create: {
      businessId: access.businessId,
      serviceAreaId: area.id,
      catalogItemId: service.id,
      draftCopy: input.draftCopy.trim(),
    },
  });
}

export async function saveWebsiteSeoDraft(
  db: Db,
  access: BusinessAccess,
  input: {
    seoTitleHome?: string;
    seoDescriptionHome?: string;
    seoTitleServices?: string;
    seoDescriptionServices?: string;
    seoTitleAbout?: string;
    seoDescriptionAbout?: string;
    seoTitleRequest?: string;
    seoDescriptionRequest?: string;
    websiteHeroHeadline?: string;
    websiteHeroSupporting?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  await requireSaasOperatingEntitlement(db, access);
  return db.businessSettings.upsert({
    where: { businessId: access.businessId },
    update: {
      seoTitleHome: input.seoTitleHome,
      seoDescriptionHome: input.seoDescriptionHome,
      seoTitleServices: input.seoTitleServices,
      seoDescriptionServices: input.seoDescriptionServices,
      seoTitleAbout: input.seoTitleAbout,
      seoDescriptionAbout: input.seoDescriptionAbout,
      seoTitleRequest: input.seoTitleRequest,
      seoDescriptionRequest: input.seoDescriptionRequest,
      websiteHeroHeadline: input.websiteHeroHeadline,
      websiteHeroSupporting: input.websiteHeroSupporting,
    },
    create: {
      businessId: access.businessId,
      seoTitleHome: input.seoTitleHome,
      seoDescriptionHome: input.seoDescriptionHome,
      seoTitleServices: input.seoTitleServices,
      seoDescriptionServices: input.seoDescriptionServices,
      seoTitleAbout: input.seoTitleAbout,
      seoDescriptionAbout: input.seoDescriptionAbout,
      seoTitleRequest: input.seoTitleRequest,
      seoDescriptionRequest: input.seoDescriptionRequest,
      websiteHeroHeadline: input.websiteHeroHeadline,
      websiteHeroSupporting: input.websiteHeroSupporting,
    },
  });
}
