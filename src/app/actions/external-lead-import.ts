"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  EXTERNAL_LEAD_IMPORT_ROUTE,
  ExternalLeadImportError,
  FILE_TOO_LARGE_MESSAGE,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  OWNER_ONLY_IMPORT_MESSAGE,
} from "@/lib/external-lead-import";
import {
  confirmExternalLeadImport,
  previewCsvUpload,
  previewOwnerSourceUrl,
} from "@/lib/external-lead-import-ops";
import { prisma } from "@/lib/prisma";

export type ExternalLeadImportActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerImportAccess() {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
  );
  if (!operating.ok) return operating;
  try {
    if (operating.access.workspace.role !== "OWNER") {
      throw new ForbiddenError(OWNER_ONLY_IMPORT_MESSAGE);
    }
    return operating;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false as const, error: OWNER_ONLY_IMPORT_MESSAGE };
    }
    throw error;
  }
}

export async function previewExternalLeadImport(
  _prev: ExternalLeadImportActionState,
  formData: FormData,
): Promise<ExternalLeadImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  const sourceUrl = readString(formData, "sourceUrl");
  const file = formData.get("csv");
  const hasFile = file instanceof File && file.size > 0;

  try {
    const preview = hasFile
      ? await previewCsvUpload(prisma, operating.access, {
          filename: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
        })
      : await previewOwnerSourceUrl(prisma, operating.access, { sourceUrl });
    revalidatePath(EXTERNAL_LEAD_IMPORT_ROUTE);
    redirect(`${EXTERNAL_LEAD_IMPORT_ROUTE}/${preview.id}`);
  } catch (error) {
    if (error instanceof ExternalLeadImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_IMPORT_MESSAGE };
    }
    if (hasFile && file.size > MAX_EXTERNAL_LEAD_IMPORT_BYTES) {
      return { error: FILE_TOO_LARGE_MESSAGE };
    }
    throw error;
  }
}

export async function confirmExternalLeadImportAction(
  _prev: ExternalLeadImportActionState,
  formData: FormData,
): Promise<ExternalLeadImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await confirmExternalLeadImport(prisma, operating.access, {
      importId: readString(formData, "importId"),
      includePossibleDuplicates: readString(formData, "includePossibleDuplicates") === "yes",
    });
    revalidatePath("/requests");
    revalidatePath("/pipeline");
    revalidatePath("/customers");
    revalidatePath(`${EXTERNAL_LEAD_IMPORT_ROUTE}/${result.preview.id}`);
    return {};
  } catch (error) {
    if (error instanceof ExternalLeadImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_IMPORT_MESSAGE };
    }
    throw error;
  }
}
