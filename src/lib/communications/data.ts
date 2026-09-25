import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureDefaultAutomationRules } from "@/lib/automation/rules";
import { evaluateComposeChannelEligibility } from "@/lib/communications/consent";
import type { CommunicationAccess } from "@/lib/communications/engine";
import { getReceptionistReadiness } from "@/lib/communications/receptionist";
import { ensureCommunicationsSchema } from "@/lib/communications/schema";
import { loadCustomerCommunicationTimeline } from "@/lib/communications/timeline";
import { purposeForComposeTemplate } from "@/lib/communications/entitlements";
import { hasProductCapability } from "@/lib/product-entitlements/enforce";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { DEFAULT_SETTINGS_PREFERENCES } from "@/lib/settings";

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadCommunicationsWorkspace(
  db: Db,
  access: CommunicationAccess,
  input?: { customerId?: string | null },
) {
  await ensureCommunicationsSchema(db);
  await ensureDefaultAutomationRules(db, access.businessId);

  const [customers, inbox, phoneLogs, rules, smsEntitled] = await Promise.all([
    db.customer.findMany({
      where: { businessId: access.businessId },
      orderBy: { name: "asc" },
      take: 80,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        smsConsentStatus: true,
      },
    }),
    db.customerCommunication.findMany({
      where: { businessId: access.businessId },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { customer: { select: { id: true, name: true } } },
    }),
    db.phoneInteraction.findMany({
      where: { businessId: access.businessId },
      orderBy: { occurredAt: "desc" },
      take: 30,
      include: { customer: { select: { id: true, name: true } } },
    }),
    db.automationRule.findMany({
      where: {
        businessId: access.businessId,
        kind: "COMMUNICATION",
      },
      orderBy: { eventType: "asc" },
    }),
    hasProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.SMS_MESSAGING),
  ]);

  const selected =
    customers.find((row) => row.id === input?.customerId) ?? customers[0] ?? null;
  const timeline = selected
    ? await loadCustomerCommunicationTimeline(db, access, { customerId: selected.id })
    : [];

  const settings = await db.businessSettings.findFirst({
    where: { businessId: access.businessId },
    select: {
      estimateCommunicationEnabled: true,
      scheduleNotificationEnabled: true,
      invoiceCommunicationEnabled: true,
      reviewRequestPreferenceEnabled: true,
      marketingCommunicationEnabled: true,
    },
  });

  const channelEligibility = selected
    ? {
        email: evaluateComposeChannelEligibility({
          businessId: access.businessId,
          channel: "EMAIL",
          email: selected.email,
          phone: selected.phone,
          smsConsentStatus: selected.smsConsentStatus,
          purpose: purposeForComposeTemplate("general"),
          preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
          smsEntitled,
        }),
        sms: evaluateComposeChannelEligibility({
          businessId: access.businessId,
          channel: "SMS",
          email: selected.email,
          phone: selected.phone,
          smsConsentStatus: selected.smsConsentStatus,
          purpose: purposeForComposeTemplate("general"),
          preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
          smsEntitled,
        }),
        phone: evaluateComposeChannelEligibility({
          businessId: access.businessId,
          channel: "PHONE",
          email: selected.email,
          phone: selected.phone,
          smsConsentStatus: selected.smsConsentStatus,
          purpose: purposeForComposeTemplate("general"),
          preferences: settings ?? DEFAULT_SETTINGS_PREFERENCES,
          smsEntitled,
        }),
      }
    : null;

  return {
    customers,
    selectedCustomerId: selected?.id ?? null,
    inbox,
    phoneLogs,
    rules,
    timeline,
    channelEligibility,
    receptionist: getReceptionistReadiness(),
    smsEntitled,
  };
}
