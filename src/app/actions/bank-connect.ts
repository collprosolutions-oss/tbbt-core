"use server";

/**
 * OWNER-only Plaid connect / sync / reconnect / disconnect.
 * Tenant scope comes from requireBusinessAccess(), never from a client
 * businessId. These actions never create a Payment, never change an
 * invoice, never move money, and never claim a verified cash balance.
 */
import { revalidatePath } from "next/cache";
import { ForbiddenError } from "@/lib/authorization";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";
import {
  BANK_CONNECT_NOT_AVAILABLE_MESSAGE,
  OWNER_ONLY_BANK_CONNECT_MESSAGE,
} from "@/lib/bank-connect-copy";
import {
  BankConnectError,
  createOwnedBankLinkToken,
  disconnectOwnedBankPlaidItem,
  exchangeOwnedBankPublicToken,
  syncOwnedBankPlaidItem,
} from "@/lib/bank-connect";
import { BANK_RECONCILIATION_ROUTE } from "@/lib/bank-reconciliation-copy";
import { prisma } from "@/lib/prisma";
import { readRequestOrigin } from "@/lib/request-host";

export type BankConnectActionState = {
  error?: string;
  warning?: string;
  linkToken?: string;
  updateMode?: boolean;
};

async function requireOwnerConnectAccess() {
  const operating = await requireOperatingProductAccessForForm(
    PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
  );
  if (!operating.ok) return operating;
  try {
    if (operating.access.workspace.role !== "OWNER") {
      throw new ForbiddenError(OWNER_ONLY_BANK_CONNECT_MESSAGE);
    }
    return operating;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false as const, error: OWNER_ONLY_BANK_CONNECT_MESSAGE };
    }
    throw error;
  }
}

function revalidateBankSurfaces(importId?: string | null) {
  revalidatePath("/settings");
  revalidatePath(BANK_RECONCILIATION_ROUTE);
  if (importId) revalidatePath(`${BANK_RECONCILIATION_ROUTE}/${importId}`);
}

function mapError(error: unknown): BankConnectActionState {
  if (error instanceof BankConnectError) return { error: error.message };
  throw error;
}

export async function createBankLinkTokenAction(
  _prev: BankConnectActionState,
  formData: FormData,
): Promise<BankConnectActionState> {
  const operating = await requireOwnerConnectAccess();
  if (!operating.ok) return { error: operating.error };
  const updateMode = String(formData.get("updateMode") ?? "") === "1";
  try {
    const result = await createOwnedBankLinkToken(prisma, operating.access, {
      updateMode,
      requestOrigin: await readRequestOrigin(),
    });
    return { linkToken: result.linkToken, updateMode: result.updateMode };
  } catch (error) {
    return mapError(error);
  }
}

export async function exchangeBankPublicTokenAction(
  _prev: BankConnectActionState,
  formData: FormData,
): Promise<BankConnectActionState> {
  const operating = await requireOwnerConnectAccess();
  if (!operating.ok) return { error: operating.error };
  const publicToken = String(formData.get("publicToken") ?? "").trim();
  const updateMode = String(formData.get("updateMode") ?? "") === "1";
  if (!publicToken) return { error: BANK_CONNECT_NOT_AVAILABLE_MESSAGE };
  try {
    const status = await exchangeOwnedBankPublicToken(prisma, operating.access, {
      publicToken,
      updateMode,
    });
    revalidateBankSurfaces(status.importId);
    return {};
  } catch (error) {
    return mapError(error);
  }
}

export async function syncBankConnectionAction(): Promise<BankConnectActionState> {
  const operating = await requireOwnerConnectAccess();
  if (!operating.ok) return { error: operating.error };
  try {
    const status = await syncOwnedBankPlaidItem(prisma, operating.access);
    revalidateBankSurfaces(status.importId);
    return {};
  } catch (error) {
    return mapError(error);
  }
}

export async function disconnectBankConnectionAction(): Promise<BankConnectActionState> {
  const operating = await requireOwnerConnectAccess();
  if (!operating.ok) return { error: operating.error };
  try {
    const status = await disconnectOwnedBankPlaidItem(prisma, operating.access);
    revalidateBankSurfaces(status.importId);
    return status.disconnectWarning ? { warning: status.disconnectWarning } : {};
  } catch (error) {
    return mapError(error);
  }
}
