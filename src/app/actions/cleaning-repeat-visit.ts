"use server";

import { createCleaningCustomerRepeatVisitRequest } from "@/lib/cleaning-repeat-visit-ops";
import { CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE } from "@/lib/cleaning-repeat-visit";
import { prisma } from "@/lib/prisma";
import { readFormStrings } from "@/lib/public-request-submit";
import { parseWorkAreaFormAnswers } from "@/lib/work-area-intake";

export type CleaningRepeatVisitActionResult = {
  error?: string;
  ok?: boolean;
};

const GENERIC_ERROR = CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE;

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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

export async function submitCleaningRepeatVisitRequest(
  slug: string,
  formData: FormData,
): Promise<CleaningRepeatVisitActionResult> {
  try {
    const token = readString(formData, "projectToken");
    const includeOtherRaw = readString(formData, "includeOther");
    const includeOther =
      includeOtherRaw === "on" || includeOtherRaw === "true" || includeOtherRaw === "1";
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

    const created = await createCleaningCustomerRepeatVisitRequest(prisma, {
      token,
      slug,
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
      requestedTradeCode: "CLEANING",
      tenantIntakeSnapshotId: readString(formData, "tenantIntakeSnapshotId") || null,
      submissionId: readString(formData, "submissionId") || null,
      smsOptIn: readString(formData, "smsOptIn") || formData.get("smsOptIn"),
    });

    if (!created.ok) {
      return { error: created.error };
    }
    return { ok: true };
  } catch {
    return { error: GENERIC_ERROR };
  }
}
