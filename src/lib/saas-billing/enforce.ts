/**
 * Tenant operating-write boundary. Authorization (requireBusinessAccess /
 * requireBusinessCapability) still runs separately. This only asks whether
 * the Business is entitled to create or materially change operating records.
 *
 * Do not use this helper for billing, auth, data export, profile/contact
 * recovery, webhooks, or public customer flows.
 */
import { requireBusinessAccess, type BusinessAccess } from "@/lib/access";
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
