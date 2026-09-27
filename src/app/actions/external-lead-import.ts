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
  IMPORT_CSV_REQUIRED_MESSAGE,
  MAX_EXTERNAL_LEAD_IMPORT_BYTES,
  OWNER_ONLY_IMPORT_MESSAGE,
} from "@/lib/external-lead-import";
import {
  confirmExternalLeadImport,
  correctExternalLeadImportRow,
  previewCsvUpload,
  rejectExternalLeadImportRow,
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

  const file = formData.get("csv");
  const hasFile = file instanceof File && file.size > 0;
  if (!hasFile) {
    return { error: IMPORT_CSV_REQUIRED_MESSAGE };
  }

  try {
    const preview = await previewCsvUpload(prisma, operating.access, {
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
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

export async function correctExternalLeadImportRowAction(
  _prev: ExternalLeadImportActionState,
  formData: FormData,
): Promise<ExternalLeadImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const preview = await correctExternalLeadImportRow(prisma, operating.access, {
      importId: readString(formData, "importId"),
      rowId: readString(formData, "rowId"),
      name: readString(formData, "name"),
      email: readString(formData, "email"),
      phone: readString(formData, "phone"),
      summary: readString(formData, "summary"),
      notes: readString(formData, "notes"),
      street: readString(formData, "street"),
      unit: readString(formData, "unit"),
      city: readString(formData, "city"),
      region: readString(formData, "region"),
      postal: readString(formData, "postal"),
      source: readString(formData, "source"),
    });
    revalidatePath(`${EXTERNAL_LEAD_IMPORT_ROUTE}/${preview.id}`);
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

export async function rejectExternalLeadImportRowAction(
  _prev: ExternalLeadImportActionState,
  formData: FormData,
): Promise<ExternalLeadImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await rejectExternalLeadImportRow(prisma, operating.access, {
      importId: readString(formData, "importId"),
      rowId: readString(formData, "rowId"),
    });
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
