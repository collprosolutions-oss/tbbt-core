"use server";

/**
 * OWNER actions for intake-condition drafts and reviewed publishes.
 * Tenant scope comes from requireOperatingBusinessAccess() — never from
 * a client businessId. Public hire forms read published snapshots only.
 */
import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import {
  intakeConditionErrorMessage,
  parseIntakeConditionDocument,
} from "@/lib/intake-conditionals";
import {
  publishIntakeConditionDraft,
  saveIntakeConditionDraft,
  validateOwnedIntakeConditionDraft,
} from "@/lib/intake-conditionals-ops";
import { prisma } from "@/lib/prisma";

export type IntakeConditionActionState = {
  error?: string;
  message?: string;
  errors?: string[];
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readDocument(formData: FormData) {
  const raw = readString(formData, "documentJson");
  const parsed = parseIntakeConditionDocument(raw);
  return parsed.ok ? parsed.document : raw;
}

export async function saveIntakeConditionDraftAction(
  _prev: IntakeConditionActionState,
  formData: FormData,
): Promise<IntakeConditionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await saveIntakeConditionDraft(prisma, access, {
      tradeCode: readString(formData, "tradeCode"),
      document: readDocument(formData),
    });
    revalidatePath("/intake-conditionals");
    return { message: "Draft saved. It is not published to the public hire form." };
  } catch (error) {
    return { error: intakeConditionErrorMessage(error, "That draft could not be saved.") };
  }
}

export async function validateIntakeConditionDraftAction(
  _prev: IntakeConditionActionState,
  formData: FormData,
): Promise<IntakeConditionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await validateOwnedIntakeConditionDraft(prisma, access, {
      tradeCode: readString(formData, "tradeCode"),
      document: readDocument(formData),
    });
    return { message: "Draft is valid. Review it, then publish a new immutable tenant snapshot." };
  } catch (error) {
    return { error: intakeConditionErrorMessage(error, "That draft could not be validated.") };
  }
}

export async function publishIntakeConditionDraftAction(
  _prev: IntakeConditionActionState,
  formData: FormData,
): Promise<IntakeConditionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const reviewed = readString(formData, "reviewed");
    const published = await publishIntakeConditionDraft(prisma, access, {
      tradeCode: readString(formData, "tradeCode"),
      reviewed: reviewed === "1" || reviewed === "on" || reviewed === "true",
      idempotencyKey: readString(formData, "idempotencyKey") || null,
    });
    revalidatePath("/intake-conditionals");
    return {
      message: `Published tenant intake snapshot version ${published.versionNumber}. New public requests will freeze this version.`,
    };
  } catch (error) {
    return { error: intakeConditionErrorMessage(error, "That draft could not be published.") };
  }
}
