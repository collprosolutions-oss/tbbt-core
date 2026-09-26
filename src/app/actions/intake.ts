"use server";

import { createPublicServiceRequest } from "@/lib/public-intake";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import { attachRemainingPublicRequestFallbackPhotos } from "@/lib/business-storage/request-photos";
import { prisma } from "@/lib/prisma";
import { readFormStrings } from "@/lib/public-request-submit";
import { notifyBusinessNewPublicRequest } from "@/lib/request-notify";
import { parseWorkAreaFormAnswers } from "@/lib/work-area-intake";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";

export type IntakeResult = {
  error?: string;
  ok?: boolean;
};

const GENERIC_ERROR = "This request could not be submitted.";

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readPhotoFiles(formData: FormData) {
  return formData
    .getAll("photos")
    .filter((value): value is File => value instanceof File && value.size > 0);
}

function parseIntakeAnswersField(formData: FormData) {
  const raw = readString(formData, "intakeAnswers");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseMeasurementFields(formData: FormData) {
  return readFormStrings(formData, "measurement").flatMap((raw) => {
    try {
      const parsed = JSON.parse(raw) as {
        catalogItemId?: string;
        width?: string;
        height?: string;
        length?: string;
        quantity?: number | null;
        unit?: string;
      };
      if (!parsed.catalogItemId) return [];
      return [
        {
          catalogItemId: parsed.catalogItemId,
          width: parsed.width,
          height: parsed.height,
          length: parsed.length,
          quantity: parsed.quantity,
          unit: parsed.unit,
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function submitServiceRequest(
  slug: string,
  formData: FormData,
): Promise<IntakeResult> {
  try {
    return await submitServiceRequestInner(slug, formData);
  } catch {
    return { error: GENERIC_ERROR };
  }
}

async function submitServiceRequestInner(
  slug: string,
  formData: FormData,
): Promise<IntakeResult> {
  const safeSlug = slug.trim().toLowerCase();
  if (!safeSlug) {
    return { error: GENERIC_ERROR };
  }

  const includeOtherRaw = readString(formData, "includeOther");
  const includeOther =
    includeOtherRaw === "on" ||
    includeOtherRaw === "true" ||
    includeOtherRaw === "1";

  const catalogItemIds = [
    ...readFormStrings(formData, "serviceCatalogItemId"),
    ...readFormStrings(formData, "serviceCatalogItemIds"),
  ];
  const quantityValues = readFormStrings(formData, "quantity");
  const catalogQuantities: Record<string, string> = {};
  catalogItemIds.forEach((id, index) => {
    const paired = quantityValues[index];
    const named = readString(formData, `quantity:${id}`);
    if (named) catalogQuantities[id] = named;
    else if (paired) catalogQuantities[id] = paired;
  });

  const notifyBusiness = await prisma.business.findUnique({
    where: { slug: safeSlug },
    select: { id: true },
  });
  const configuredAreas = notifyBusiness
    ? (await prisma.serviceArea.findMany({ where: { businessId: notifyBusiness.id } })).map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        city: row.city,
        region: row.region,
        postalCode: row.postalCode,
        enabled: row.enabled,
        travelAdjustment: row.travelAdjustment ? Number(row.travelAdjustment) : null,
        minimumAdjustment: row.minimumAdjustment ? Number(row.minimumAdjustment) : null,
        notes: row.notes,
      }))
    : [];

  const created = await createPublicServiceRequest(prisma, {
    slug: safeSlug,
    businessId: readString(formData, "businessId") || null,
    name: readString(formData, "name"),
    email: readString(formData, "email"),
    phone: readString(formData, "phone"),
    address: readString(formData, "address"),
    streetAddress: readString(formData, "streetAddress"),
    unit: readString(formData, "unit"),
    city: readString(formData, "city"),
    region: readString(formData, "region"),
    postalCode: readString(formData, "postalCode"),
    notes: readString(formData, "description") || readString(formData, "notes"),
    catalogItemIds,
    catalogQuantities,
    includeOther,
    otherDescription: readString(formData, "otherDescription"),
    otherQuantity: readString(formData, "otherQuantity") || undefined,
    photoAssetIds: readFormStrings(formData, "photoAssetId"),
    workAreaAnswers: parseWorkAreaFormAnswers(readFormStrings(formData, "workArea")),
    measurements: parseMeasurementFields(formData),
    intakeAnswers: parseIntakeAnswersField(formData),
    requestedTradeCode: readString(formData, "requestedTradeCode") || null,
    submissionId: readString(formData, "submissionId") || null,
    smsOptIn: readString(formData, "smsOptIn") || formData.get("smsOptIn"),
    leadSource: readString(formData, "leadSource") || "WEBSITE",
    campaignId: readString(formData, "campaignId") || null,
    landingPagePath: readString(formData, "landingPagePath") || null,
    localPageSlug: readString(formData, "localPageSlug") || null,
    configuredAreas,
  });

  if (!created.ok) {
    return { error: created.error };
  }

  if (notifyBusiness) {
    await emitAndProcessBusinessEvent(prisma, {
      businessId: notifyBusiness.id,
      type: "REQUEST_CREATED",
      subjectType: "SERVICE_REQUEST",
      subjectId: created.requestId,
      idempotencyKey: `REQUEST_CREATED:${created.requestId}`,
    });
    try {
      await notifyBusinessNewPublicRequest(prisma, {
        businessId: notifyBusiness.id,
        requestId: created.requestId,
      });
    } catch {
      // Request already persisted. Company email must not fail submit.
    }
  }

  const files = readPhotoFiles(formData);
  if (files.length === 0 || !isBusinessStorageConfigured()) {
    return { ok: true };
  }

  await attachRemainingPublicRequestFallbackPhotos({ db: prisma }, safeSlug, {
    requestId: created.requestId,
    files,
  });

  return { ok: true };
}
