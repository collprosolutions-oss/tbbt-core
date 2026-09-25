/**
 * Tenant operating-write boundary. Authorization (requireBusinessAccess /
 * requireBusinessCapability) still runs separately. This only asks whether
 * the Business is entitled to create or materially change operating records.
 *
 * Do not use this helper for billing, auth, data export, profile/contact
 * recovery, webhooks, or public customer flows.
 */
import { requireBusinessAccess, type BusinessAccess } from "@/lib/access";
import type { ProductCapabilityCode } from "@/lib/product-catalog/codes";
import {
  productEntitlementErrorMessage,
  requireProductCapability,
} from "@/lib/product-entitlements";
import { prisma } from "@/lib/prisma";
import {
  requireSaasOperatingEntitlement,
  saasOperatingErrorMessage,
} from "@/lib/saas-billing/entitlement";

export async function requireOperatingBusinessAccess(): Promise<BusinessAccess> {
  const access = await requireBusinessAccess();
  await requireSaasOperatingEntitlement(prisma, access);
  return access;
}

export async function requireOperatingBusinessAccessForForm(): Promise<
  { ok: true; access: BusinessAccess } | { ok: false; error: string }
> {
  try {
    return { ok: true, access: await requireOperatingBusinessAccess() };
  } catch (error) {
    const message = saasOperatingErrorMessage(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}

export async function requireOperatingProductAccess(
  capability: ProductCapabilityCode,
): Promise<BusinessAccess> {
  const access = await requireOperatingBusinessAccess();
  await requireProductCapability(prisma, access.businessId, capability);
  return access;
}

export async function requireOperatingProductAccessForForm(
  capability: ProductCapabilityCode,
): Promise<{ ok: true; access: BusinessAccess } | { ok: false; error: string }> {
  const operating = await requireOperatingBusinessAccessForForm();
  if (!operating.ok) return operating;
  try {
    await requireProductCapability(prisma, operating.access.businessId, capability);
    return operating;
  } catch (error) {
    const message = productEntitlementErrorMessage(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
}
