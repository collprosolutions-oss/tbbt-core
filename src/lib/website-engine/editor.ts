/**
 * Owner Settings data for the Website Publish panel.
 * Browser business IDs never authorize.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import { catalogItemIsPubliclyOffered } from "@/lib/public-request-trade";
import { listWebsitePublishes, websiteHasUnpublishedChanges } from "@/lib/website-engine/publish";

type Db = PrismaClient;

export async function loadWebsitePublishPanelData(db: Db, access: BusinessAccess) {
  const [history, unpublished, reviews, galleryAssets, galleryItems, settings, areas, catalog, trades] =
    await Promise.all([
      listWebsitePublishes(db, access),
      websiteHasUnpublishedChanges(db, access),
      db.review.findMany({
        where: { businessId: access.businessId },
        select: { id: true, reviewText: true, websiteSelected: true },
        orderBy: { createdAt: "desc" },
      }),
      db.storedAsset.findMany({
        where: {
          businessId: access.businessId,
          visibility: "PUBLIC",
          category: "WEBSITE_IMAGE",
          status: "READY",
          publicPath: { not: null },
        },
        select: { id: true, publicPath: true },
        orderBy: { createdAt: "desc" },
      }),
      db.websiteGalleryItem.findMany({
        where: { businessId: access.businessId },
        include: { storedAsset: { select: { publicPath: true } } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      db.businessSettings.findUnique({ where: { businessId: access.businessId } }),
      db.serviceArea.findMany({
        where: { businessId: access.businessId, enabled: true, kind: "CITY" },
        orderBy: { label: "asc" },
      }),
      db.serviceCatalogItem.findMany({
        where: { businessId: access.businessId, active: true },
        orderBy: { name: "asc" },
      }),
      listActiveBusinessTrades(db, access.businessId),
    ]);

  const activeTradeCodes = trades.map((row) => row.tradeCode);
  const offered = catalog.filter((row) => catalogItemIsPubliclyOffered(row, activeTradeCodes));
  const drafts = await db.websiteLocalPageDraft.findMany({
    where: { businessId: access.businessId },
  });
  const localPairs = [];
  for (const area of areas) {
    for (const service of offered) {
      const draft = drafts.find(
        (row) => row.serviceAreaId === area.id && row.catalogItemId === service.id,
      );
      localPairs.push({
        serviceAreaId: area.id,
        catalogItemId: service.id,
        label: `${service.name} in ${area.city || area.label}`,
        draftCopy: draft?.draftCopy ?? "",
      });
    }
  }

  return {
    hasUnpublishedChanges: unpublished,
    currentVersion: history.versions.find((row) => row.isCurrent)?.versionNumber ?? null,
    versions: history.versions.map((row) => ({
      ...row,
      publishedAt: row.publishedAt.toISOString(),
    })),
    reviews,
    galleryAssets,
    galleryItems: galleryItems.map((row) => ({
      id: row.id,
      title: row.title,
      caption: row.caption,
      imageUrl: row.storedAsset.publicPath,
    })),
    localPairs,
    seo: {
      websiteHeroHeadline: settings?.websiteHeroHeadline ?? "",
      websiteHeroSupporting: settings?.websiteHeroSupporting ?? "",
      seoTitleHome: settings?.seoTitleHome ?? "",
      seoDescriptionHome: settings?.seoDescriptionHome ?? "",
      seoTitleServices: settings?.seoTitleServices ?? "",
      seoDescriptionServices: settings?.seoDescriptionServices ?? "",
      seoTitleAbout: settings?.seoTitleAbout ?? "",
      seoDescriptionAbout: settings?.seoDescriptionAbout ?? "",
      seoTitleRequest: settings?.seoTitleRequest ?? "",
      seoDescriptionRequest: settings?.seoDescriptionRequest ?? "",
    },
  };
}
