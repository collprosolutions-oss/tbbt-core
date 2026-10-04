"use server";

/**
 * OWNER marketing destination actions. Tenant scope comes from the
 * session workspace. These actions never publish.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";
import { prisma } from "@/lib/prisma";
import {
  checkMarketingConnectionStatus,
  confirmMarketingConnectionSelection,
  disconnectMarketingConnection,
  reconnectMarketingConnection,
  startMarketingConnection,
} from "@/lib/marketing-connections/service";
import { connectionErrorMessage } from "@/lib/marketing-connections/errors";
import { readRequestOrigin } from "@/lib/request-host";

export type MarketingConnectionActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateConnections() {
  revalidatePath("/marketing");
  revalidatePath("/settings");
}

function isNextRedirect(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "digest" in error &&
      typeof (error as { digest?: string }).digest === "string" &&
      (error as { digest: string }).digest.startsWith("NEXT_REDIRECT"),
  );
}

async function ownerAccess() {
  return requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
}

export async function startMarketingConnectionAction(
  _prev: MarketingConnectionActionState,
  formData: FormData,
): Promise<MarketingConnectionActionState> {
  try {
    const access = await ownerAccess();
    const result = await startMarketingConnection(prisma, access, readString(formData, "destination"), {
      requestOrigin: await readRequestOrigin(),
    });
    revalidateConnections();
    redirect(result.authorizeUrl);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    return { error: connectionErrorMessage(error, "That destination could not be connected.") };
  }
}

export async function reconnectMarketingConnectionAction(
  _prev: MarketingConnectionActionState,
  formData: FormData,
): Promise<MarketingConnectionActionState> {
  try {
    const access = await ownerAccess();
    const result = await reconnectMarketingConnection(prisma, access, readString(formData, "destination"), {
      requestOrigin: await readRequestOrigin(),
    });
    revalidateConnections();
    redirect(result.authorizeUrl);
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    return { error: connectionErrorMessage(error, "That destination could not be reconnected.") };
  }
}

export async function confirmMarketingConnectionSelectionAction(
  _prev: MarketingConnectionActionState,
  formData: FormData,
): Promise<MarketingConnectionActionState> {
  try {
    const access = await ownerAccess();
    const result = await confirmMarketingConnectionSelection(prisma, access, {
      selectionToken: readString(formData, "selectionToken"),
      externalId: readString(formData, "externalId"),
    });
    revalidateConnections();
    return { message: result.message };
  } catch (error) {
    return { error: connectionErrorMessage(error, "That destination could not be confirmed.") };
  }
}

export async function checkMarketingConnectionStatusAction(
  _prev: MarketingConnectionActionState,
  formData: FormData,
): Promise<MarketingConnectionActionState> {
  try {
    const access = await ownerAccess();
    const result = await checkMarketingConnectionStatus(prisma, access, readString(formData, "destination"));
    revalidateConnections();
    return { message: result.message };
  } catch (error) {
    return { error: connectionErrorMessage(error, "That destination status could not be checked.") };
  }
}

export async function disconnectMarketingConnectionAction(
  _prev: MarketingConnectionActionState,
  formData: FormData,
): Promise<MarketingConnectionActionState> {
  try {
    const access = await ownerAccess();
    const result = await disconnectMarketingConnection(prisma, access, readString(formData, "destination"));
    revalidateConnections();
    return { message: result.message };
  } catch (error) {
    return { error: connectionErrorMessage(error, "That destination could not be disconnected.") };
  }
}
