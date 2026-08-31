"use server";

/**
 * Knowledge Hub server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_KNOWLEDGE).
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  createKnowledgeEntry,
  knowledgeErrorMessage,
  markKnowledgeReviewed,
  setKnowledgeArchived,
  updateKnowledgeEntry,
} from "@/lib/knowledge-ops";
import { prisma } from "@/lib/prisma";

export type KnowledgeActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateKnowledge() {
  revalidatePath("/knowledge");
}

export async function createKnowledgeEntryAction(
  _prev: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  try {
    const access = await requireBusinessAccess();
    await createKnowledgeEntry(prisma, access, {
      title: readString(formData, "title"),
      body: readString(formData, "body"),
      category: readString(formData, "category"),
      sourceType: readString(formData, "sourceType"),
      sourceKind: readString(formData, "sourceKind") || undefined,
      sourceReferenceId: readString(formData, "sourceReferenceId") || undefined,
      sourceLabel: readString(formData, "sourceLabel") || undefined,
      trustState: readString(formData, "trustState") || undefined,
    });
    revalidateKnowledge();
    return { message: "Knowledge entry saved. TBBT did not generate this automatically." };
  } catch (error) {
    return { error: knowledgeErrorMessage(error, "That knowledge entry could not be saved.") };
  }
}

export async function updateKnowledgeEntryAction(
  _prev: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  try {
    const access = await requireBusinessAccess();
    await updateKnowledgeEntry(prisma, access, {
      entryId: readString(formData, "entryId"),
      title: formData.has("title") ? readString(formData, "title") : undefined,
      body: formData.has("body") ? readString(formData, "body") : undefined,
      category: formData.has("category") ? readString(formData, "category") : undefined,
      trustState: formData.has("trustState") ? readString(formData, "trustState") : undefined,
      sourceType: formData.has("sourceType") ? readString(formData, "sourceType") : undefined,
      sourceKind: formData.has("sourceKind") ? readString(formData, "sourceKind") : undefined,
      sourceReferenceId: formData.has("sourceReferenceId")
        ? readString(formData, "sourceReferenceId")
        : undefined,
      sourceLabel: formData.has("sourceLabel") ? readString(formData, "sourceLabel") : undefined,
    });
    revalidateKnowledge();
    return { message: "Knowledge entry updated. Provenance was not silently overwritten." };
  } catch (error) {
    return { error: knowledgeErrorMessage(error, "That knowledge entry could not be updated.") };
  }
}

export async function markKnowledgeReviewedAction(
  _prev: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  try {
    const access = await requireBusinessAccess();
    await markKnowledgeReviewed(prisma, access, {
      entryId: readString(formData, "entryId"),
    });
    revalidateKnowledge();
    return { message: "Marked reviewed. Age alone does not make knowledge outdated." };
  } catch (error) {
    return { error: knowledgeErrorMessage(error, "That knowledge entry could not be marked reviewed.") };
  }
}

export async function setKnowledgeArchivedAction(
  _prev: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  try {
    const access = await requireBusinessAccess();
    await setKnowledgeArchived(prisma, access, {
      entryId: readString(formData, "entryId"),
      archived: readString(formData, "archived") === "1",
    });
    revalidateKnowledge();
    return {
      message:
        readString(formData, "archived") === "1"
          ? "Knowledge entry archived."
          : "Knowledge entry reactivated.",
    };
  } catch (error) {
    return { error: knowledgeErrorMessage(error, "That knowledge entry could not be archived.") };
  }
}
