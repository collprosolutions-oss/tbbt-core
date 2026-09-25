/**
 * Public website view: snapshot when published, live compatibility otherwise.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  loadPublicAboutCopy,
  loadPublicSite,
  type PublicSitePayload,
} from "@/lib/public-site-data";
import { groupPublicCatalog, type PublicBusiness, type PublicCatalogItem } from "@/lib/public-site";
import { resolvePublishedAboutCopy } from "@/lib/website-story";
import {
  parseWebsiteSnapshot,
  type PublishedTrade,
  type PublishedWebsiteSnapshot,
} from "@/lib/website-engine/snapshot";
import type { PublicSiteImageRow } from "@/lib/public-site-images";
import {
  currentIntakeSchema,
  intakeSchemaFromPublicProjection,
  INTAKE_FIELD_TYPES,
  publicIntakeSchemaProjection,
  type IntakeFieldType,
  type PublicIntakeSchemaProjection,
} from "@/lib/intake-schema";
import { DEFAULT_TRADE, isConfiguredTrade } from "@/lib/trades";

type Db = PrismaClient | Prisma.TransactionClient;

export type PublicWebsiteView = {
  source: "snapshot" | "compatibility";
  versionNumber: number | null;
  publishedAt: Date | null;
  snapshot: PublishedWebsiteSnapshot | null;
  site: PublicSitePayload;
  about: string;
};

function asIntakeFieldType(value: string): IntakeFieldType {
  return (INTAKE_FIELD_TYPES as readonly string[]).includes(value)
    ? (value as IntakeFieldType)
    : "TEXT";
}

function snapshotTradeProjection(trade: PublishedTrade): PublicIntakeSchemaProjection {
  if (trade.intake?.key && trade.intake.fields.length > 0) {
    return {
      key: trade.intake.key,
      version: trade.intake.version,
      tradeCode: isConfiguredTrade(trade.code) ? trade.code : DEFAULT_TRADE,
      title: trade.intake.title,
      fields: trade.intake.fields.map((field) => ({
        ...field,
        type: asIntakeFieldType(field.type),
      })),
    };
  }
  return publicIntakeSchemaProjection(currentIntakeSchema(trade.code));
}

export function snapshotIntakeSchemasByTrade(
  snapshot: PublishedWebsiteSnapshot,
): Record<string, PublicIntakeSchemaProjection> {
  return Object.fromEntries(
    snapshot.trades
      .filter((trade) => isConfiguredTrade(trade.code))
      .map((trade) => [trade.code, snapshotTradeProjection(trade)]),
  );
}

export function snapshotIntakeSchemaForTrade(
  snapshot: PublishedWebsiteSnapshot,
  tradeCode: string,
) {
  const projection =
    snapshotIntakeSchemasByTrade(snapshot)[tradeCode] ??
    publicIntakeSchemaProjection(currentIntakeSchema(tradeCode));
  return intakeSchemaFromPublicProjection(projection);
}

function snapshotToSite(snapshot: PublishedWebsiteSnapshot): PublicSitePayload {
  const items: PublicCatalogItem[] = snapshot.services.map((service) => ({
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category,
    pricingMode: service.pricingMode,
    priceLabel: service.priceLabel,
    unitAmount: null,
    intakeMeasurementMode: service.intakeMeasurementMode,
    intakeMeasurementAxes: service.intakeMeasurementAxes,
    intakeMeasurementUnit: service.intakeMeasurementUnit,
    asksWorkAreaIntake: service.asksWorkAreaIntake,
    tradeCode: service.tradeCode,
    recurrenceEligible: service.recurrenceEligible,
    unitLabel: service.unitLabel,
  }));
  const business: PublicBusiness = {
    id: snapshot.business.id,
    name: snapshot.business.name,
    slug: snapshot.business.slug,
    tradeCode: snapshot.trades[0]?.code ?? "HANDYMAN",
    publicPhone: snapshot.business.publicPhone,
    publicEmail: snapshot.business.publicEmail,
    publicWebsite: snapshot.business.publicWebsite,
    publicServiceAreaLabel: snapshot.business.publicServiceAreaLabel,
    activeTrades: snapshot.trades.map((trade) => ({
      code: trade.code as "HANDYMAN" | "CLEANING",
      label: trade.customerFacingLabel,
      requestTitle: `Request ${trade.customerFacingLabel}`,
      requestDescription: `Request ${trade.customerFacingLabel.toLowerCase()} from ${snapshot.business.name}.`,
      requestCta: "Request a Quote",
      serviceNoun: "services",
    })),
  };
  return {
    business,
    items,
    groups: groupPublicCatalog(
      items,
      snapshot.trades.map((trade) => trade.code),
    ),
  };
}

export function missingWebsiteEngineSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /publishedWebsiteId|WebsitePublish|does not exist/i.test(message)
  );
}

async function loadCompatibilityView(slug: string, db: Db): Promise<PublicWebsiteView | null> {
  const site = await loadPublicSite(slug, db);
  if (!site) return null;
  return {
    source: "compatibility",
    versionNumber: null,
    publishedAt: null,
    snapshot: null,
    site,
    about: resolvePublishedAboutCopy(await loadPublicAboutCopy(site.business.id, db), site.business.slug),
  };
}

export async function loadPublicWebsiteView(
  slug: string,
  db: Db = prisma,
): Promise<PublicWebsiteView | null> {
  const safeSlug = slug.trim().toLowerCase();
  if (!safeSlug) return null;
  try {
    const business = await db.business.findUnique({
      where: { slug: safeSlug },
      select: { id: true, slug: true, publishedWebsiteId: true },
    });
    if (!business) return null;

    if (business.publishedWebsiteId) {
      const publish = await db.websitePublish.findFirst({
        where: { id: business.publishedWebsiteId, businessId: business.id },
      });
      if (publish) {
        const snapshot = parseWebsiteSnapshot(publish.snapshotJson);
        if (snapshot.business.id !== business.id || snapshot.business.slug !== business.slug) {
          return null;
        }
        return {
          source: "snapshot",
          versionNumber: publish.versionNumber,
          publishedAt: publish.publishedAt,
          snapshot,
          site: snapshotToSite(snapshot),
          about: snapshot.about.copy,
        };
      }
    }
  } catch (error) {
    if (!missingWebsiteEngineSchema(error)) throw error;
  }

  return loadCompatibilityView(safeSlug, db);
}

export function publicServiceFromView(view: PublicWebsiteView, serviceSlug: string) {
  if (view.snapshot) {
    return view.snapshot.services.find((row) => row.slug === serviceSlug) ?? null;
  }
  const item = view.site.items.find(
    (row) => row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") === serviceSlug,
  );
  if (!item) return null;
  return {
    id: item.id,
    slug: serviceSlug,
    name: item.name,
    tradeCode: item.tradeCode,
    tradeLabel: item.tradeCode === "CLEANING" ? "Cleaning" : "Handyman",
    category: item.category,
    description: item.description ?? "",
    pricingMode: item.pricingMode,
    priceLabel: item.priceLabel,
    recurrenceEligible: Boolean(item.recurrenceEligible),
    unitLabel: item.unitLabel ?? "",
    imageUrl: null,
    intakeMeasurementMode: item.intakeMeasurementMode,
    intakeMeasurementAxes: item.intakeMeasurementAxes,
    intakeMeasurementUnit: item.intakeMeasurementUnit,
    asksWorkAreaIntake: item.asksWorkAreaIntake,
  };
}

export function snapshotToImageRows(snapshot: PublishedWebsiteSnapshot): PublicSiteImageRow[] {
  return snapshot.images.map((row) => ({
    page: row.page,
    slot: row.slot,
    imageUrl: row.imageUrl,
    objectPosition: row.objectPosition,
    objectZoom: row.objectZoom,
    storedAssetId: row.assetId,
  }));
}

export function publicLocalPageFromView(
  view: PublicWebsiteView,
  citySlug: string,
  serviceSlug: string,
) {
  if (view.snapshot) {
    return (
      view.snapshot.localPages.find(
        (row) => row.citySlug === citySlug && row.serviceSlug === serviceSlug,
      ) ?? null
    );
  }
  return null;
}
