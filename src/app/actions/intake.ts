"use server";

import { createPublicServiceRequest } from "@/lib/public-intake";
import { prisma } from "@/lib/prisma";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";
import {
  isStorageConfigured,
  isSupportedImageMimeType,
  MAX_JOB_PHOTO_UPLOAD_BYTES,
  uploadRequestPhoto,
} from "@/lib/storage";

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
  });

  if (!created.ok) {
    return { error: created.error };
  }

  const files = readPhotoFiles(formData).slice(0, MAX_INTAKE_PHOTOS);
  if (files.length === 0 || !isStorageConfigured()) {
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

  const uploadedUrls: string[] = [];
  for (const file of files) {
    if (!isSupportedImageMimeType(file.type)) continue;
    if (file.size > MAX_JOB_PHOTO_UPLOAD_BYTES) continue;
    try {
      const uploaded = await uploadRequestPhoto({
        businessId: business.id,
        requestId: request.id,
        file,
      });
      uploadedUrls.push(uploaded.url);
    } catch {
      // Request already exists. A failed photo must not roll it back.
    }
  }

  if (uploadedUrls.length > 0) {
    await prisma.serviceRequestPhoto.createMany({
      data: uploadedUrls.map((url) => ({
        businessId: business.id,
        serviceRequestId: request.id,
        url,
      })),
    });
  }

  return { ok: true };
}
