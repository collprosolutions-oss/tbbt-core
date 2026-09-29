"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError } from "@/lib/authorization";
import { requireOperatingBusinessAccessForForm } from "@/lib/saas-billing/enforce";
import {
  CATALOG_IMPORT_CSV_REQUIRED_MESSAGE,
  CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE,
  MAX_SERVICE_CATALOG_IMPORT_BYTES,
  OWNER_ONLY_CATALOG_IMPORT_MESSAGE,
  SERVICE_CATALOG_IMPORT_ROUTE,
  ServiceCatalogImportError,
} from "@/lib/service-catalog-import";
import {
  confirmServiceCatalogImport,
  previewServiceCatalogCsvUpload,
  setCatalogImportMatchDecision,
} from "@/lib/service-catalog-import-ops";
import { prisma } from "@/lib/prisma";

export type ServiceCatalogImportActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerCatalogImportAccess() {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  try {
    if (operating.access.workspace.role !== "OWNER") {
      throw new ForbiddenError(OWNER_ONLY_CATALOG_IMPORT_MESSAGE);
    }
    return operating;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false as const, error: OWNER_ONLY_CATALOG_IMPORT_MESSAGE };
    }
    throw error;
  }
}

export async function previewServiceCatalogImport(
  _prev: ServiceCatalogImportActionState,
  formData: FormData,
): Promise<ServiceCatalogImportActionState> {
  const operating = await requireOwnerCatalogImportAccess();
  if (!operating.ok) return { error: operating.error };

  const file = formData.get("csv");
  const hasFile = file instanceof File && file.size > 0;
  if (!hasFile) {
    return { error: CATALOG_IMPORT_CSV_REQUIRED_MESSAGE };
  }

  try {
    const preview = await previewServiceCatalogCsvUpload(prisma, operating.access, {
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    revalidatePath("/services");
    revalidatePath(SERVICE_CATALOG_IMPORT_ROUTE);
    redirect(`${SERVICE_CATALOG_IMPORT_ROUTE}/${preview.id}`);
  } catch (error) {
    if (error instanceof ServiceCatalogImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CATALOG_IMPORT_MESSAGE };
    }
    if (hasFile && file.size > MAX_SERVICE_CATALOG_IMPORT_BYTES) {
      return { error: CATALOG_IMPORT_FILE_TOO_LARGE_MESSAGE };
    }
    throw error;
  }
}

export async function setServiceCatalogImportMatchDecisionAction(
  _prev: ServiceCatalogImportActionState,
  formData: FormData,
): Promise<ServiceCatalogImportActionState> {
  const operating = await requireOwnerCatalogImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const preview = await setCatalogImportMatchDecision(prisma, operating.access, {
      importId: readString(formData, "importId"),
      rowId: readString(formData, "rowId"),
      decision: readString(formData, "matchDecision"),
    });
    revalidatePath(`${SERVICE_CATALOG_IMPORT_ROUTE}/${preview.id}`);
    return {};
  } catch (error) {
    if (error instanceof ServiceCatalogImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CATALOG_IMPORT_MESSAGE };
    }
    throw error;
  }
}

export async function confirmServiceCatalogImportAction(
  _prev: ServiceCatalogImportActionState,
  formData: FormData,
): Promise<ServiceCatalogImportActionState> {
  const operating = await requireOwnerCatalogImportAccess();
  if (!operating.ok) return { error: operating.error };

  const matchDecisions: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("matchDecision:") || typeof value !== "string") continue;
    const rowId = key.slice("matchDecision:".length).trim();
    if (rowId) matchDecisions[rowId] = value.trim();
  }

  try {
    const result = await confirmServiceCatalogImport(prisma, operating.access, {
      importId: readString(formData, "importId"),
      matchDecisions,
    });
    revalidatePath("/services");
    revalidatePath(`${SERVICE_CATALOG_IMPORT_ROUTE}/${result.preview.id}`);
    return {};
  } catch (error) {
    if (error instanceof ServiceCatalogImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CATALOG_IMPORT_MESSAGE };
    }
    throw error;
  }
}
