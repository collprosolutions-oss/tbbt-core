"use server";

import { createPublicServiceRequest } from "@/lib/public-intake";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import { putPublicRequestPhotoFromBytes } from "@/lib/business-storage/request-photos";
import { privateAssetPath } from "@/lib/business-storage/keys";
import { prisma } from "@/lib/prisma";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";
import { resolveSupportedImageMimeType } from "@/lib/storage";

export type IntakeResult = {
  error?: string;
  ok?: boolean;
};

const GENERIC_ERROR = "This request could not be submitted.";

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readAllStrings(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readPhotoFiles(formData: FormData) {
  return formData
    .getAll("photos")
    .filter((value): value is File => value instanceof File && value.size > 0);
}

export async function submitServiceRequest(
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
    ...readAllStrings(formData, "serviceCatalogItemId"),
    ...readAllStrings(formData, "serviceCatalogItemIds"),
  ];
  const quantityValues = readAllStrings(formData, "quantity");
  const catalogQuantities: Record<string, string> = {};
  catalogItemIds.forEach((id, index) => {
    const paired = quantityValues[index];
    const named = readString(formData, `quantity:${id}`);
    if (named) catalogQuantities[id] = named;
    else if (paired) catalogQuantities[id] = paired;
  });

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
    photoAssetIds: readAllStrings(formData, "photoAssetId"),
    measurements: readAllStrings(formData, "measurement").flatMap((raw) => {
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
    }),
  });

  if (!created.ok) {
    return { error: created.error };
  }

  const files = readPhotoFiles(formData).slice(0, MAX_INTAKE_PHOTOS);
  if (files.length === 0 || !isBusinessStorageConfigured()) {
    return { ok: true };
  }

  const business = await prisma.business.findUnique({
    where: { slug: safeSlug },
    select: { id: true },
  });
  if (!business) {
    return { ok: true };
  }

  const request = await prisma.serviceRequest.findFirst({
    where: { id: created.requestId, businessId: business.id },
    select: { id: true },
  });
  if (!request) {
    return { ok: true };
  }

  const attached: Array<{ url: string; storedAssetId: string }> = [];
  for (const file of files) {
    const mimeType = resolveSupportedImageMimeType(file);
    if (!mimeType) continue;
    try {
      const asset = await putPublicRequestPhotoFromBytes(
        { db: prisma },
        safeSlug,
        {
          originalFilename: file.name,
          mimeType,
          body: new Uint8Array(await file.arrayBuffer()),
        },
      );
      attached.push({
        url: privateAssetPath(asset.id),
        storedAssetId: asset.id,
      });
    } catch {
      // Request already exists. A failed photo must not roll it back.
    }
  }

  if (attached.length > 0) {
    await prisma.serviceRequestPhoto.createMany({
      data: attached.map((photo) => ({
        businessId: business.id,
        serviceRequestId: request.id,
        url: photo.url,
        storedAssetId: photo.storedAssetId,
      })),
    });
  }

  return { ok: true };
}
