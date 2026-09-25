/**
 * Versioned public website snapshot.
 *
 * This is the only customer-facing payload stored on WebsitePublish.
 * Parse/validate before rendering. Do not blindly JSON.parse into UI.
 */

export const WEBSITE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const WEBSITE_SNAPSHOT_SECRET_KEYS = [
  "password",
  "passwordHash",
  "totpSecret",
  "sessionToken",
  "stripeSecret",
  "providerToken",
  "apiKey",
  "accessToken",
  "refreshToken",
] as const;

export type PublishedTradeIntakeField = {
  key: string;
  type: string;
  label: string;
  required: boolean;
  help: string | null;
  options: Array<{ value: string; label: string }>;
  visibleWhen: { field: string; value: string } | null;
};

export type PublishedTradeIntake = {
  key: string;
  version: number;
  title: string;
  fields: PublishedTradeIntakeField[];
};

export type PublishedTrade = {
  code: string;
  label: string;
  customerFacingLabel: string;
  intake: PublishedTradeIntake;
};

export type PublishedService = {
  id: string;
  slug: string;
  name: string;
  tradeCode: string;
  tradeLabel: string;
  category: string;
  description: string;
  pricingMode: string;
  priceLabel: string;
  recurrenceEligible: boolean;
  unitLabel: string;
  imageUrl: string | null;
  intakeMeasurementMode: string;
  intakeMeasurementAxes: string;
  intakeMeasurementUnit: string;
  asksWorkAreaIntake: boolean;
};

export type PublishedImage = {
  page: string;
  slot: string;
  imageUrl: string;
  assetId: string | null;
  objectPosition: string;
  objectZoom: number;
};

export type PublishedGalleryItem = {
  id: string;
  assetId: string;
  imageUrl: string;
  title: string;
  caption: string;
  catalogItemId: string | null;
};

export type PublishedReview = {
  id: string;
  rating: number | null;
  reviewText: string;
  platform: string;
  externalReviewDate: string | null;
};

export type PublishedServiceArea = {
  id: string;
  kind: string;
  label: string;
  city: string | null;
  region: string | null;
  slug: string;
};

export type PublishedLocalPage = {
  citySlug: string;
  serviceSlug: string;
  cityLabel: string;
  serviceName: string;
  serviceId: string;
  copy: string;
};

export type PublishedSeoPage = {
  title: string;
  description: string;
  robots: "index" | "noindex";
};

export type PublishedWebsiteSnapshot = {
  schemaVersion: typeof WEBSITE_SNAPSHOT_SCHEMA_VERSION;
  business: {
    id: string;
    slug: string;
    name: string;
    publicPhone: string | null;
    publicEmail: string | null;
    publicWebsite: string | null;
    publicServiceAreaLabel: string | null;
  };
  trades: PublishedTrade[];
  services: PublishedService[];
  about: { copy: string };
  home: { headline: string; supporting: string };
  images: PublishedImage[];
  gallery: PublishedGalleryItem[];
  reviews: PublishedReview[];
  serviceAreas: PublishedServiceArea[];
  localPages: PublishedLocalPage[];
  seo: {
    home: PublishedSeoPage;
    services: PublishedSeoPage;
    about: PublishedSeoPage;
    request: PublishedSeoPage;
  };
};

export class WebsiteSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsiteSnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown) {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown) {
  return value === true;
}

function rejectSecrets(value: unknown, path = "snapshot") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      WEBSITE_SNAPSHOT_SECRET_KEYS.some(
        (secret) => key.toLowerCase() === secret.toLowerCase(),
      )
    ) {
      throw new WebsiteSnapshotError(`Snapshot must not include ${key}.`);
    }
    rejectSecrets(child, `${path}.${key}`);
  }
}

function parseService(value: unknown): PublishedService | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  const slug = asString(value.slug).trim();
  const name = asString(value.name).trim();
  if (!id || !slug || !name) return null;
  return {
    id,
    slug,
    name,
    tradeCode: asString(value.tradeCode, "HANDYMAN"),
    tradeLabel: asString(value.tradeLabel, "Handyman"),
    category: asString(value.category, "Other Services"),
    description: asString(value.description),
    pricingMode: asString(value.pricingMode, "STARTING_AT"),
    priceLabel: asString(value.priceLabel),
    recurrenceEligible: asBoolean(value.recurrenceEligible),
    unitLabel: asString(value.unitLabel),
    imageUrl: asNullableString(value.imageUrl),
    intakeMeasurementMode: asString(value.intakeMeasurementMode, "NONE"),
    intakeMeasurementAxes: asString(value.intakeMeasurementAxes),
    intakeMeasurementUnit: asString(value.intakeMeasurementUnit, "IN"),
    asksWorkAreaIntake: asBoolean(value.asksWorkAreaIntake),
  };
}

function parseTradeIntake(value: unknown, fallbackTitle: string): PublishedTradeIntake {
  const row = isRecord(value) ? value : {};
  const fields = Array.isArray(row.fields)
    ? row.fields
        .filter(isRecord)
        .map((field) => ({
          key: asString(field.key),
          type: asString(field.type),
          label: asString(field.label),
          required: asBoolean(field.required),
          help: asNullableString(field.help),
          options: Array.isArray(field.options)
            ? field.options
                .filter(isRecord)
                .map((option) => ({
                  value: asString(option.value),
                  label: asString(option.label, asString(option.value)),
                }))
                .filter((option) => option.value)
            : [],
          visibleWhen:
            isRecord(field.visibleWhen) && asString(field.visibleWhen.field)
              ? {
                  field: asString(field.visibleWhen.field),
                  value: asString(field.visibleWhen.value),
                }
              : null,
        }))
        .filter((field) => field.key && field.label)
    : [];
  return {
    key: asString(row.key),
    version: asNumber(row.version, 1),
    title: asString(row.title, fallbackTitle),
    fields,
  };
}

export function parseWebsiteSnapshot(raw: string | unknown): PublishedWebsiteSnapshot {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!isRecord(parsed)) {
    throw new WebsiteSnapshotError("Published snapshot is not an object.");
  }
  if (parsed.schemaVersion !== WEBSITE_SNAPSHOT_SCHEMA_VERSION) {
    throw new WebsiteSnapshotError("Unsupported website snapshot schema version.");
  }
  rejectSecrets(parsed);
  const business = isRecord(parsed.business) ? parsed.business : {};
  const id = asString(business.id).trim();
  const slug = asString(business.slug).trim();
  const name = asString(business.name).trim();
  if (!id || !slug || !name) {
    throw new WebsiteSnapshotError("Published snapshot is missing business identity.");
  }

  const services = Array.isArray(parsed.services)
    ? parsed.services.map(parseService).filter((row): row is PublishedService => row != null)
    : [];
  const slugs = new Set<string>();
  for (const service of services) {
    if (slugs.has(service.slug)) {
      throw new WebsiteSnapshotError("Published service slugs must be unique.");
    }
    slugs.add(service.slug);
  }

  const trades = Array.isArray(parsed.trades)
    ? parsed.trades
        .filter(isRecord)
        .map((row) => {
          const code = asString(row.code);
          const label = asString(row.label);
          return {
            code,
            label,
            customerFacingLabel: asString(row.customerFacingLabel, label),
            intake: parseTradeIntake(row.intake, label),
          };
        })
        .filter((row) => row.code && row.label)
    : [];

  const images = Array.isArray(parsed.images)
    ? parsed.images
        .filter(isRecord)
        .map((row) => ({
          page: asString(row.page),
          slot: asString(row.slot),
          imageUrl: asString(row.imageUrl),
          assetId: asNullableString(row.assetId),
          objectPosition: asString(row.objectPosition, "50% 50%"),
          objectZoom: asNumber(row.objectZoom, 1),
        }))
        .filter((row) => row.page && row.slot && row.imageUrl)
    : [];

  const gallery = Array.isArray(parsed.gallery)
    ? parsed.gallery
        .filter(isRecord)
        .map((row) => ({
          id: asString(row.id),
          assetId: asString(row.assetId),
          imageUrl: asString(row.imageUrl),
          title: asString(row.title),
          caption: asString(row.caption),
          catalogItemId: asNullableString(row.catalogItemId),
        }))
        .filter((row) => row.id && row.assetId && row.imageUrl)
    : [];

  const reviews = Array.isArray(parsed.reviews)
    ? parsed.reviews
        .filter(isRecord)
        .map((row) => ({
          id: asString(row.id),
          rating:
            typeof row.rating === "number" && Number.isFinite(row.rating)
              ? row.rating
              : null,
          reviewText: asString(row.reviewText),
          platform: asString(row.platform),
          externalReviewDate: asNullableString(row.externalReviewDate),
        }))
        .filter((row) => row.id && row.reviewText)
    : [];

  const serviceAreas = Array.isArray(parsed.serviceAreas)
    ? parsed.serviceAreas
        .filter(isRecord)
        .map((row) => ({
          id: asString(row.id),
          kind: asString(row.kind),
          label: asString(row.label),
          city: asNullableString(row.city),
          region: asNullableString(row.region),
          slug: asString(row.slug),
        }))
        .filter((row) => row.id && row.label && row.slug)
    : [];

  const localPages = Array.isArray(parsed.localPages)
    ? parsed.localPages
        .filter(isRecord)
        .map((row) => ({
          citySlug: asString(row.citySlug),
          serviceSlug: asString(row.serviceSlug),
          cityLabel: asString(row.cityLabel),
          serviceName: asString(row.serviceName),
          serviceId: asString(row.serviceId),
          copy: asString(row.copy),
        }))
        .filter((row) => row.citySlug && row.serviceSlug && row.serviceId)
    : [];

  const seoRecord = isRecord(parsed.seo) ? parsed.seo : {};
  const seoPage = (value: unknown, fallbackTitle: string): PublishedSeoPage => {
    const row = isRecord(value) ? value : {};
    return {
      title: asString(row.title, fallbackTitle),
      description: asString(row.description),
      robots: row.robots === "noindex" ? "noindex" : "index",
    };
  };

  const about = isRecord(parsed.about) ? parsed.about : {};
  const home = isRecord(parsed.home) ? parsed.home : {};

  return {
    schemaVersion: WEBSITE_SNAPSHOT_SCHEMA_VERSION,
    business: {
      id,
      slug,
      name,
      publicPhone: asNullableString(business.publicPhone),
      publicEmail: asNullableString(business.publicEmail),
      publicWebsite: asNullableString(business.publicWebsite),
      publicServiceAreaLabel: asNullableString(business.publicServiceAreaLabel),
    },
    trades,
    services,
    about: { copy: asString(about.copy) },
    home: {
      headline: asString(home.headline, name),
      supporting: asString(home.supporting),
    },
    images,
    gallery,
    reviews,
    serviceAreas,
    localPages,
    seo: {
      home: seoPage(seoRecord.home, name),
      services: seoPage(seoRecord.services, `Services | ${name}`),
      about: seoPage(seoRecord.about, `About | ${name}`),
      request: seoPage(seoRecord.request, `Request | ${name}`),
    },
  };
}

export function serializeWebsiteSnapshot(snapshot: PublishedWebsiteSnapshot) {
  return JSON.stringify(snapshot);
}
