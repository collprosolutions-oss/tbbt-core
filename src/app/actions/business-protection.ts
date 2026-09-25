"use server";

/**
 * Business Protection server actions. Tenant scope comes from the
 * session workspace. OWNER/ADMIN only. Completing agreements is OWNER.
 */
import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { isAiAttemptId } from "@/lib/ai/types";
import { runAgreementAssist, type AgreementAiAction } from "@/lib/ai/agreements";
import {
  abortVaultDocumentUpload,
  acknowledgeAgreementLegalReview,
  authorizeVaultDocumentUpload,
  businessProtectionErrorMessage,
  completeAgreementExternally,
  createAgreement,
  createVaultRecord,
  finalizeVaultDocumentUpload,
  generateAgreementDraft,
  markAgreementOwnerReviewed,
  markAgreementReady,
  markAgreementSent,
  saveAgreementAnswers,
  saveAgreementDraftContent,
  updateVaultRecord,
} from "@/lib/business-protection-ops";
import { prisma } from "@/lib/prisma";

export type ProtectionActionState = {
  error?: string;
  message?: string;
  recordId?: string;
  agreementId?: string;
  assetId?: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: "PUT";
  aiText?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateProtection() {
  revalidatePath("/business-protection");
}

export async function createVaultRecordAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const record = await createVaultRecord(prisma, access, {
      title: readString(formData, "title"),
      category: readString(formData, "category"),
      issuer: readString(formData, "issuer") || undefined,
      counterparty: readString(formData, "counterparty") || undefined,
      effectiveOn: readString(formData, "effectiveOn") || undefined,
      expiresOn: readString(formData, "expiresOn") || undefined,
      notes: readString(formData, "notes") || undefined,
      storedAssetId: readString(formData, "storedAssetId") || undefined,
    });
    revalidateProtection();
    return { message: "Vault record saved. The file was not published.", recordId: record.id };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That vault record could not be saved.") };
  }
}

export async function updateVaultRecordAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const record = await updateVaultRecord(prisma, access, {
      recordId: readString(formData, "recordId"),
      title: readString(formData, "title") || undefined,
      category: readString(formData, "category") || undefined,
      issuer: formData.has("issuer") ? readString(formData, "issuer") : undefined,
      counterparty: formData.has("counterparty") ? readString(formData, "counterparty") : undefined,
      effectiveOn: formData.has("effectiveOn") ? readString(formData, "effectiveOn") : undefined,
      expiresOn: formData.has("expiresOn") ? readString(formData, "expiresOn") : undefined,
      notes: formData.has("notes") ? readString(formData, "notes") : undefined,
      recordStatus: readString(formData, "recordStatus") || undefined,
      storedAssetId: formData.has("storedAssetId") ? readString(formData, "storedAssetId") : undefined,
    });
    revalidateProtection();
    return { message: "Vault record updated.", recordId: record.id };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That vault record could not be updated.") };
  }
}

export async function authorizeVaultDocumentUploadAction(input: {
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const authorized = await authorizeVaultDocumentUpload({ db: prisma }, access, input);
    return {
      assetId: authorized.asset.id,
      uploadUrl: authorized.upload.url,
      uploadHeaders: authorized.upload.headers,
      uploadMethod: authorized.upload.method,
    };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That vault file could not be authorized.") };
  }
}

export async function finalizeVaultDocumentUploadAction(input: {
  assetId: string;
}): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const asset = await finalizeVaultDocumentUpload({ db: prisma }, access, input.assetId);
    revalidateProtection();
    return { message: "Private vault file stored.", assetId: asset.id };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That vault file could not be saved.") };
  }
}

export async function abortVaultDocumentUploadAction(input: {
  assetId: string;
}): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await abortVaultDocumentUpload({ db: prisma }, access, input.assetId);
    return { message: "Upload cancelled." };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That upload could not be cancelled.") };
  }
}

export async function createAgreementAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const agreement = await createAgreement(prisma, access, {
      agreementType: readString(formData, "agreementType"),
      title: readString(formData, "title") || undefined,
      counterparty: readString(formData, "counterparty") || undefined,
    });
    revalidateProtection();
    return { message: "Agreement Coach started.", agreementId: agreement.id };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That agreement could not be started.") };
  }
}

export async function saveAgreementAnswersAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const answers: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (key.startsWith("answer_") && typeof value === "string") {
        answers[key.slice("answer_".length)] = value;
      }
    }
    await saveAgreementAnswers(prisma, access, {
      agreementId: readString(formData, "agreementId"),
      answers,
      title: readString(formData, "title") || undefined,
      counterparty: answers.counterparty,
    });
    revalidateProtection();
    return { message: "Answers saved. TBBT did not invent legal terms.", agreementId: readString(formData, "agreementId") };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "Those answers could not be saved.") };
  }
}

export async function generateAgreementDraftAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const agreement = await generateAgreementDraft(prisma, access, {
      agreementId: readString(formData, "agreementId"),
      businessName: access.workspace.business.name,
    });
    revalidateProtection();
    return {
      message: "Draft prepared from your answers. This is not a legally sufficient agreement.",
      agreementId: agreement.id,
    };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That draft could not be generated.") };
  }
}

export async function saveAgreementDraftContentAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await saveAgreementDraftContent(prisma, access, {
      agreementId: readString(formData, "agreementId"),
      draftContent: readString(formData, "draftContent"),
    });
    revalidateProtection();
    return { message: "Draft updated. Later sent or signed copies stay on their own versions.", agreementId: readString(formData, "agreementId") };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That draft could not be updated.") };
  }
}

export async function markAgreementOwnerReviewedAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await markAgreementOwnerReviewed(prisma, access, {
      agreementId: readString(formData, "agreementId"),
    });
    revalidateProtection();
    return { message: "Owner review recorded. This is not legal approval.", agreementId: readString(formData, "agreementId") };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "Owner review could not be recorded.") };
  }
}

export async function acknowledgeAgreementLegalReviewAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await acknowledgeAgreementLegalReview(prisma, access, {
      agreementId: readString(formData, "agreementId"),
      acknowledged: readString(formData, "acknowledged") === "1",
    });
    revalidateProtection();
    return { message: "Attorney-review recommendation acknowledged.", agreementId: readString(formData, "agreementId") };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That acknowledgment could not be saved.") };
  }
}

export async function markAgreementReadyAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await markAgreementReady(prisma, access, {
      agreementId: readString(formData, "agreementId"),
    });
    revalidateProtection();
    return { message: "Marked ready. TBBT did not certify this agreement.", agreementId: readString(formData, "agreementId") };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That agreement could not be marked ready.") };
  }
}

export async function markAgreementSentAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await markAgreementSent(prisma, access, {
      agreementId: readString(formData, "agreementId"),
    });
    revalidateProtection();
    return { message: "Sent version locked. Later edits create a new version.", agreementId: readString(formData, "agreementId") };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That sent state could not be recorded.") };
  }
}

export async function completeAgreementAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const result = await completeAgreementExternally(prisma, access, {
      agreementId: readString(formData, "agreementId"),
      mode: readString(formData, "mode"),
      notes: readString(formData, "notes") || undefined,
      storedAssetId: readString(formData, "storedAssetId") || undefined,
    });
    revalidateProtection();
    return {
      message: "Completion recorded with who marked it and when. No digital signature was invented.",
      agreementId: result.agreement.id,
      recordId: result.vault.id,
    };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "That agreement could not be completed.") };
  }
}

export async function agreementAssistAction(
  _prev: ProtectionActionState,
  formData: FormData,
): Promise<ProtectionActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const action = readString(formData, "aiAction") as AgreementAiAction;
    if (!["EXPLAIN", "SUMMARIZE", "MISSING", "REWRITE"].includes(action)) {
      return { error: "Choose an assistance action." };
    }
    const attemptId = readString(formData, "attemptId");
    if (!isAiAttemptId(attemptId)) {
      return { error: "Refresh and try the assistance request again." };
    }
    let answers: Record<string, string> | undefined;
    const rawAnswers = readString(formData, "answersJson");
    if (rawAnswers) {
      try {
        answers = JSON.parse(rawAnswers) as Record<string, string>;
      } catch {
        answers = undefined;
      }
    }
    const result = await runAgreementAssist(prisma, access, {
      action,
      text: readString(formData, "text"),
      agreementType: readString(formData, "agreementType") || undefined,
      answers,
      idempotencyKey: attemptId,
    });
    revalidateProtection();
    return {
      message: result.message,
      aiText: result.output?.text,
      agreementId: readString(formData, "agreementId") || undefined,
    };
  } catch (error) {
    return { error: businessProtectionErrorMessage(error, "AI could not assist with that draft.") };
  }
}
