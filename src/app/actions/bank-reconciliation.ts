"use server";

/**
 * OWNER-only bank CSV reconciliation actions. Tenant scope comes from
 * requireBusinessAccess(), never from a client businessId. Import and
 * review never create a Payment, never change an invoice, and never
 * claim a verified bank balance.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  BANK_CSV_REQUIRED_MESSAGE,
  BANK_RECONCILIATION_ROUTE,
  BankReconciliationError,
  FILE_TOO_LARGE_MESSAGE,
  MAX_BANK_CSV_BYTES,
  OWNER_ONLY_BANK_RECONCILIATION_MESSAGE,
} from "@/lib/bank-reconciliation";
import {
  acceptBankReconciliationMatch,
  ignoreBankReconciliationRow,
  importBankCsv,
  rejectBankReconciliationMatch,
} from "@/lib/bank-reconciliation-ops";
import { prisma } from "@/lib/prisma";

export type BankReconciliationActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function requireOwnerReviewAccess() {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
  );
  if (!operating.ok) return operating;
  try {
    if (operating.access.workspace.role !== "OWNER") {
      throw new ForbiddenError(OWNER_ONLY_BANK_RECONCILIATION_MESSAGE);
    }
    return operating;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false as const, error: OWNER_ONLY_BANK_RECONCILIATION_MESSAGE };
    }
    throw error;
  }
}

function revalidateWorkspace(importId: string) {
  revalidatePath(BANK_RECONCILIATION_ROUTE);
  revalidatePath(`${BANK_RECONCILIATION_ROUTE}/${importId}`);
}

export async function importBankCsvAction(
  _prev: BankReconciliationActionState,
  formData: FormData,
): Promise<BankReconciliationActionState> {
  const operating = await requireOwnerReviewAccess();
  if (!operating.ok) return { error: operating.error };

  const file = formData.get("csv");
  const hasFile = file instanceof File && file.size > 0;
  if (!hasFile) {
    return { error: BANK_CSV_REQUIRED_MESSAGE };
  }

  try {
    const workspace = await importBankCsv(prisma, operating.access, {
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    revalidateWorkspace(workspace.id);
    redirect(`${BANK_RECONCILIATION_ROUTE}/${workspace.id}`);
  } catch (error) {
    if (error instanceof BankReconciliationError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_BANK_RECONCILIATION_MESSAGE };
    }
    if (hasFile && file.size > MAX_BANK_CSV_BYTES) {
      return { error: FILE_TOO_LARGE_MESSAGE };
    }
    throw error;
  }
}

export async function acceptBankReconciliationMatchAction(
  _prev: BankReconciliationActionState,
  formData: FormData,
): Promise<BankReconciliationActionState> {
  const operating = await requireOwnerReviewAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const workspace = await acceptBankReconciliationMatch(prisma, operating.access, {
      importId: readString(formData, "importId"),
      matchId: readString(formData, "matchId"),
    });
    revalidateWorkspace(workspace.id);
    return {};
  } catch (error) {
    if (error instanceof BankReconciliationError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_BANK_RECONCILIATION_MESSAGE };
    }
    throw error;
  }
}

export async function rejectBankReconciliationMatchAction(
  _prev: BankReconciliationActionState,
  formData: FormData,
): Promise<BankReconciliationActionState> {
  const operating = await requireOwnerReviewAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const workspace = await rejectBankReconciliationMatch(prisma, operating.access, {
      importId: readString(formData, "importId"),
      matchId: readString(formData, "matchId"),
    });
    revalidateWorkspace(workspace.id);
    return {};
  } catch (error) {
    if (error instanceof BankReconciliationError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_BANK_RECONCILIATION_MESSAGE };
    }
    throw error;
  }
}

export async function ignoreBankReconciliationRowAction(
  _prev: BankReconciliationActionState,
  formData: FormData,
): Promise<BankReconciliationActionState> {
  const operating = await requireOwnerReviewAccess();
  if (!operating.ok) return { error: operating.error };

  try {
    const workspace = await ignoreBankReconciliationRow(prisma, operating.access, {
      importId: readString(formData, "importId"),
      rowId: readString(formData, "rowId"),
    });
    revalidateWorkspace(workspace.id);
    return {};
  } catch (error) {
    if (error instanceof BankReconciliationError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: OWNER_ONLY_BANK_RECONCILIATION_MESSAGE };
    }
    throw error;
  }
}
