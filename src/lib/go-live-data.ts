/**
 * Tenant-scoped Go-live Health Center loader.
 *
 * Reads existing configuration only. Callers must pass the authenticated
 * workspace businessId — never a browser-supplied id. OWNER/ADMIN use
 * MANAGE_SETTINGS; MEMBER is denied.
 *
 * Settings pages must call loadGoLiveCenter only when section === "go-live".
 * Overview and other Settings sections must not run these provider reads.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
} from "@/lib/authorization";
import { isAiProviderConnected } from "@/lib/ai/config";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import { isTwilioCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import { getBusinessPaymentStatus } from "@/lib/payments";
import { loadSaasBillingSnapshot } from "@/lib/saas-billing";
import { isEmailDeliveryConfigured } from "@/lib/settings";
import {
  assertGoLiveProjectionSafe,
  buildGoLiveCenter,
  type GoLiveCenter,
  type GoLiveDomainInput,
  type GoLiveInput,
} from "@/lib/go-live";

type Db = PrismaClient | Prisma.TransactionClient;

export type GoLiveAccess = {
  businessId: string;
  workspace: {
    role: "OWNER" | "ADMIN" | "MEMBER";
    business?: { id?: string };
  };
};

export function requireGoLiveAccess(access: GoLiveAccess) {
  requireBusinessCapability(access as BusinessAccess, CAPABILITIES.MANAGE_SETTINGS);
  if (access.workspace.business?.id && access.workspace.business.id !== access.businessId) {
    throw new ForbiddenError();
  }
}

export async function loadGoLiveDomainState(
  db: Db,
  businessId: string,
): Promise<GoLiveDomainInput> {
  const bindings = await db.websiteHostBinding.findMany({
    where: { businessId },
    select: { hostname: true, status: true },
    orderBy: { updatedAt: "desc" },
  });
  return {
    verifiedHostname: bindings.find((row) => row.status === "VERIFIED")?.hostname ?? null,
    unverifiedHostname: bindings.find((row) => row.status === "UNVERIFIED")?.hostname ?? null,
    failedHostname: bindings.find((row) => row.status === "FAILED")?.hostname ?? null,
  };
}

export async function loadGoLiveInput(db: Db, businessId: string): Promise<GoLiveInput> {
  const [business, saas, payment, domain] = await Promise.all([
    db.business.findFirst({
      where: { id: businessId },
      select: { id: true, operationalSmsNumber: true },
    }),
    loadSaasBillingSnapshot(db as PrismaClient, businessId),
    getBusinessPaymentStatus(db, businessId),
    loadGoLiveDomainState(db, businessId),
  ]);
  if (!business || business.id !== businessId) {
    throw new Error("Business was not found.");
  }

  return {
    saas: {
      configured: saas.configured,
      checkoutPossible: saas.checkoutPossible,
      entitlementState: saas.entitlement.state,
      canOperate: saas.entitlement.canOperate,
      statusLabel: saas.entitlement.label,
    },
    connect: {
      platformConfigured: payment.platformConfigured,
      appUrlConfigured: payment.appUrlConfigured,
      paymentReady: payment.paymentReady,
      status: payment.status,
      onlineCheckoutPossible: payment.onlineCheckoutPossible,
    },
    emailConfigured: isEmailDeliveryConfigured(),
    r2Configured: isBusinessStorageConfigured(),
    twilio: {
      platformConfigured: isTwilioCustomerMessagingConfigured(),
      dedicatedNumberAssigned: Boolean(business.operationalSmsNumber?.trim()),
    },
    aiConnected: isAiProviderConnected(),
    domain,
  };
}

export async function loadGoLiveCenter(db: Db, access: GoLiveAccess): Promise<GoLiveCenter> {
  requireGoLiveAccess(access);
  const input = await loadGoLiveInput(db, access.businessId);
  const center = buildGoLiveCenter(input);
  assertGoLiveProjectionSafe(center);
  return center;
}
