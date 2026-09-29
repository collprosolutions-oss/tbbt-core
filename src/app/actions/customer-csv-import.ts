"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  CUSTOMER_CSV_IMPORT_ROUTE,
  CustomerCsvImportError,
  FILE_TOO_LARGE_MESSAGE,
  IMPORT_CSV_REQUIRED_MESSAGE,
  MAX_CUSTOMER_CSV_IMPORT_BYTES,
  OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE,
} from "@/lib/customer-csv-import";
import {
  confirmCustomerCsvImport,
  correctCustomerCsvImportRow,
  previewCustomerCsvUpload,
  rejectCustomerCsvImportRow,
} from "@/lib/customer-csv-import-ops";
import { prisma } from "@/lib/prisma";

export type CustomerCsvImportActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerImportAccess() {
  const operating = await requireOperatingProductAccessForForm(PRODUCT_CAPABILITIES.CRM);
  if (!operating.ok) return operating;
  try {
    if (operating.access.workspace.role !== "OWNER") {
      throw new ForbiddenError(OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE);
    }
    return operating;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false as const, error: OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE };
    }
    throw error;
  }
}

export async function previewCustomerCsvImport(
  _prev: CustomerCsvImportActionState,
  formData: FormData,
): Promise<CustomerCsvImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  const file = formData.get("csv");
  const hasFile = file instanceof File && file.size > 0;
  if (!hasFile) {
    return { error: IMPORT_CSV_REQUIRED_MESSAGE };
  }

  try {
    const preview = await previewCustomerCsvUpload(prisma, operating.access, {
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    revalidatePath(CUSTOMER_CSV_IMPORT_ROUTE);
    redirect(`${CUSTOMER_CSV_IMPORT_ROUTE}/${preview.id}`);
  } catch (error) {
    if (error instanceof CustomerCsvImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE };
    }
    if (hasFile && file.size > MAX_CUSTOMER_CSV_IMPORT_BYTES) {
      return { error: FILE_TOO_LARGE_MESSAGE };
    }
    throw error;
  }
}

export async function correctCustomerCsvImportRowAction(
  _prev: CustomerCsvImportActionState,
  formData: FormData,
): Promise<CustomerCsvImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const preview = await correctCustomerCsvImportRow(prisma, operating.access, {
      importId: readString(formData, "importId"),
      rowId: readString(formData, "rowId"),
      name: readString(formData, "name"),
      email: readString(formData, "email"),
      phone: readString(formData, "phone"),
      label: readString(formData, "label"),
      street: readString(formData, "street"),
      unit: readString(formData, "unit"),
      city: readString(formData, "city"),
      region: readString(formData, "region"),
      postal: readString(formData, "postal"),
    });
    revalidatePath(`${CUSTOMER_CSV_IMPORT_ROUTE}/${preview.id}`);
    return {};
  } catch (error) {
    if (error instanceof CustomerCsvImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE };
    }
    throw error;
  }
}

export async function rejectCustomerCsvImportRowAction(
  _prev: CustomerCsvImportActionState,
  formData: FormData,
): Promise<CustomerCsvImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await rejectCustomerCsvImportRow(prisma, operating.access, {
      importId: readString(formData, "importId"),
      rowId: readString(formData, "rowId"),
    });
    revalidatePath(`${CUSTOMER_CSV_IMPORT_ROUTE}/${result.preview.id}`);
    return {};
  } catch (error) {
    if (error instanceof CustomerCsvImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE };
    }
    throw error;
  }
}

export async function confirmCustomerCsvImportAction(
  _prev: CustomerCsvImportActionState,
  formData: FormData,
): Promise<CustomerCsvImportActionState> {
  const operating = await requireOwnerImportAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const result = await confirmCustomerCsvImport(prisma, operating.access, {
      importId: readString(formData, "importId"),
      includePossibleDuplicates: readString(formData, "includePossibleDuplicates") === "yes",
    });
    revalidatePath("/customers");
    revalidatePath(`${CUSTOMER_CSV_IMPORT_ROUTE}/${result.preview.id}`);
    return {};
  } catch (error) {
    if (error instanceof CustomerCsvImportError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_CUSTOMER_IMPORT_MESSAGE };
    }
    throw error;
  }
}
