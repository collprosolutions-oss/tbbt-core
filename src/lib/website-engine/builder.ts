/**
 * Server-side publication builder.
 *
 * UI never constructs publish JSON. Browser business IDs never authorize.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import { catalogScopeText } from "@/lib/estimate-line-scope";
import { formatCatalogPriceLabel } from "@/lib/pricing-mode";
import { catalogItemIsPubliclyOffered } from "@/lib/public-request-trade";
import { publicDisplayName } from "@/lib/public-site";
import { slugifyLocalPagePart } from "@/lib/service-areas";
import { publicTradeProjection } from "@/lib/trade-config";
import { tradeLabel } from "@/lib/trades";
import { resolvePublishedAboutCopy } from "@/lib/website-story";
import { allocateUniqueServiceSlugs } from "@/lib/website-engine/slugs";
import {
  WEBSITE_SNAPSHOT_SCHEMA_VERSION,
  type PublishedWebsiteSnapshot,
} from "@/lib/website-engine/snapshot";

type Db = PrismaClient | Prisma.TransactionClient;

export class WebsitePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsitePublishError";
  }
}

function safeHttpUrl(value: string | null | undefined) {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return raw.startsWith("/") ? raw : null;
  }
}

function clip(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trimEnd()}...`;
}

export async function buildWebsiteSnapshot(
  db: Db,
  access: BusinessAccess,
): Promise<PublishedWebsiteSnapshot> {
  const business = access.assertOwned(
    await db.business.findFirst({
      where: { id: access.businessId, ...access.scope },
      select: {
        id: true,
        name: true,
        slug: true,
        publicPhone: true,
        publicEmail: true,
        publicWebsite: true,
        publicServiceAreaLabel: true,
      },
    }),
  );

  const trades = await listActiveBusinessTrades(db, access.businessId);
  const activeTradeCodes = trades.map((row) => row.tradeCode);
  const publicTrades = trades.map((row) => publicTradeProjection(row.config));

  const catalog = await db.serviceCatalogItem.findMany({
    where: { businessId: access.businessId, active: true },
    orderBy: { name: "asc" },
  });
  const offered = catalog.filter((row) =>
    catalogItemIsPubliclyOffered(row, activeTradeCodes),
  );
  const slugs = allocateUniqueServiceSlugs(offered.map((row) => row.name));

  const galleryRows = await db.websiteGalleryItem.findMany({
    where: { businessId: access.businessId },
    include: { storedAsset: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const gallery = [];
  for (const row of galleryRows) {
    access.assertOwned(row);
    const asset = row.storedAsset;
    if (
      !asset ||
      asset.businessId !== access.businessId ||
      asset.visibility !== "PUBLIC" ||
      asset.category !== "WEBSITE_IMAGE" ||
      asset.status !== "READY" ||
      !asset.publicPath
    ) {
      throw new WebsitePublishError(
        "Gallery images must be ready PUBLIC website photos owned by this business.",
      );
    }
    if (row.catalogItemId && !offered.some((item) => item.id === row.catalogItemId)) {
      continue;
    }
    gallery.push({
      id: row.id,
      assetId: asset.id,
      imageUrl: asset.publicPath,
      title: row.title,
      caption: row.caption,
      catalogItemId: row.catalogItemId,
    });
  }

  const siteImages = await db.publicSiteImage.findMany({
    where: { businessId: access.businessId },
    include: { storedAsset: true },
  });
  const images = [];
  for (const row of siteImages) {
    access.assertOwned(row);
    if (!row.imageUrl) continue;
    if (row.storedAssetId) {
      const asset = row.storedAsset;
      if (
        !asset ||
        asset.businessId !== access.businessId ||
        asset.visibility !== "PUBLIC" ||
        asset.category !== "WEBSITE_IMAGE"
      ) {
        throw new WebsitePublishError(
          "Website images must be PUBLIC website assets owned by this business.",
        );
      }
    }
    images.push({
      page: row.page,
      slot: row.slot,
      imageUrl: row.imageUrl,
      assetId: row.storedAssetId,
      objectPosition: row.objectPosition,
      objectZoom: row.objectZoom,
    });
  }

  const reviews = (
    await db.review.findMany({
      where: { businessId: access.businessId, websiteSelected: true },
      orderBy: { createdAt: "desc" },
    })
  ).map((row) => {
    access.assertOwned(row);
    return {
      id: row.id,
      rating: row.rating,
      reviewText: row.reviewText,
      platform: row.platform,
      externalReviewDate: row.externalReviewDate?.toISOString() ?? null,
    };
  });

  const areas = (
    await db.serviceArea.findMany({
      where: { businessId: access.businessId, enabled: true },
      orderBy: { label: "asc" },
    })
  ).map((row) => {
    access.assertOwned(row);
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      city: row.city,
      region: row.region,
      slug: slugifyLocalPagePart(row.city || row.label),
    };
  });

  const localDrafts = await db.websiteLocalPageDraft.findMany({
    where: { businessId: access.businessId },
  });

  const services = offered.map((row, index) => {
    const image =
      gallery.find((item) => item.catalogItemId === row.id)?.imageUrl ??
      images.find((item) => item.page === "services" && item.slot === row.id)?.imageUrl ??
      null;
    return {
      id: row.id,
      slug: slugs[index]!,
      name: row.name,
      tradeCode: row.tradeCode,
      tradeLabel: tradeLabel(row.tradeCode),
      category: row.category,
      description: catalogScopeText(row.description) ?? row.description ?? "",
      pricingMode: row.pricingMode,
      priceLabel: formatCatalogPriceLabel(row.pricingMode, row.price, row.unitLabel),
      recurrenceEligible: row.recurrenceEligible,
      unitLabel: row.unitLabel,
      imageUrl: image,
    };
  });

  const localPages = [];
  for (const area of areas.filter((row) => row.kind === "CITY" && row.slug)) {
    for (const service of services) {
      const draft = localDrafts.find(
        (row) => row.serviceAreaId === area.id && row.catalogItemId === service.id,
      );
      localPages.push({
        citySlug: area.slug,
        serviceSlug: service.slug,
        cityLabel: area.city || area.label,
        serviceName: service.name,
        serviceId: service.id,
        copy:
          draft?.draftCopy.trim() ||
          `${service.name} in ${area.city || area.label} from ${publicDisplayName(business)}.`,
      });
    }
  }

  const settings = await db.businessSettings.findUnique({
    where: { businessId: access.businessId },
  });
  const displayName = publicDisplayName(business);
  const aboutCopy = resolvePublishedAboutCopy(
    settings?.approvedPublicAboutCopy,
    business.slug,
  );
  const tradeNames = publicTrades.map((row) => row.label).join(" and ");
  const areaLabel = business.publicServiceAreaLabel?.trim() || "";
  const defaultHome = clip(
    areaLabel
      ? `${tradeNames || "Home services"} from ${displayName} in ${areaLabel}.`
      : `${tradeNames || "Home services"} from ${displayName}.`,
    160,
  );

  return {
    schemaVersion: WEBSITE_SNAPSHOT_SCHEMA_VERSION,
    business: {
      id: business.id,
      slug: business.slug,
      name: business.name,
      publicPhone: business.publicPhone,
      publicEmail: business.publicEmail,
      publicWebsite: safeHttpUrl(business.publicWebsite),
      publicServiceAreaLabel: business.publicServiceAreaLabel,
    },
    trades: publicTrades.map((row) => ({
      code: row.code,
      label: row.label,
      customerFacingLabel: row.label,
    })),
    services,
    about: { copy: aboutCopy },
    home: {
      headline: settings?.websiteHeroHeadline?.trim() || displayName,
      supporting: settings?.websiteHeroSupporting?.trim() || defaultHome,
    },
    images,
    gallery,
    reviews,
    serviceAreas: areas,
    localPages,
    seo: {
      home: {
        title: settings?.seoTitleHome?.trim() || `${displayName} | ${tradeNames || "Services"}`,
        description: clip(settings?.seoDescriptionHome?.trim() || aboutCopy || defaultHome, 160),
        robots: "index",
      },
      services: {
        title: settings?.seoTitleServices?.trim() || `Services | ${displayName}`,
        description: clip(
          settings?.seoDescriptionServices?.trim() ||
            `Services from ${displayName}${areaLabel ? ` in ${areaLabel}` : ""}.`,
          160,
        ),
        robots: "index",
      },
      about: {
        title: settings?.seoTitleAbout?.trim() || `About | ${displayName}`,
        description: clip(settings?.seoDescriptionAbout?.trim() || aboutCopy || defaultHome, 160),
        robots: "index",
      },
      request: {
        title: settings?.seoTitleRequest?.trim() || `Request | ${displayName}`,
        description: clip(
          settings?.seoDescriptionRequest?.trim() ||
            `Request service from ${displayName}${areaLabel ? ` in ${areaLabel}` : ""}.`,
          160,
        ),
        robots: "index",
      },
    },
  };
}
