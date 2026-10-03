import type { Prisma, PrismaClient } from "@prisma/client";
import { ensureDefaultAutomationRules } from "@/lib/automation/rules";
import {
  emailDestinationFingerprintOrNull,
  evaluateComposeChannelEligibility,
} from "@/lib/communications/consent";
import type { CommunicationAccess } from "@/lib/communications/engine";
import { listFailedSmsDeliveries } from "@/lib/communications/failed-delivery";
import { listEmailFailedDestinationsByFingerprints } from "@/lib/mail-failed-destination";
import { getReceptionistReadiness } from "@/lib/communications/receptionist";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { loadCustomerCommunicationHistory } from "@/lib/communications/timeline";
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
  await ensureDefaultAutomationRules(db, access.businessId);

  const [customers, inbox, failedDeliveries, phoneLogs, rules, smsEntitled, business] = await Promise.all([
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
    listFailedSmsDeliveries(db, access),
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
    db.business.findFirst({
      where: { id: access.businessId },
      select: { timezone: true },
    }),
  ]);

  const timeZone = resolveBusinessTimeZone(business);
  const selected =
    customers.find((row) => row.id === input?.customerId) ?? customers[0] ?? null;
  const history = selected
    ? await loadCustomerCommunicationHistory(db, access, { customerId: selected.id })
    : null;
  const timeline = history?.items ?? [];

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

  const preferences = settings ?? DEFAULT_SETTINGS_PREFERENCES;
  const failedDestinations = await listEmailFailedDestinationsByFingerprints(db, {
    businessId: access.businessId,
    fingerprints: customers.flatMap((row) => {
      const fingerprint = emailDestinationFingerprintOrNull(access.businessId, row.email);
      return fingerprint ? [fingerprint] : [];
    }),
  });
  const composeCustomers = customers.map((row) => {
    const fingerprint = emailDestinationFingerprintOrNull(access.businessId, row.email);
    const email = evaluateComposeChannelEligibility({
      businessId: access.businessId,
      channel: "EMAIL",
      email: row.email,
      phone: row.phone,
      smsConsentStatus: row.smsConsentStatus,
      purpose: purposeForComposeTemplate("general"),
      preferences,
      smsEntitled,
      failedDestinationReason: fingerprint ? failedDestinations.get(fingerprint) ?? null : null,
    });
    const sms = evaluateComposeChannelEligibility({
      businessId: access.businessId,
      channel: "SMS",
      email: row.email,
      phone: row.phone,
      smsConsentStatus: row.smsConsentStatus,
      purpose: purposeForComposeTemplate("general"),
      preferences,
      smsEntitled,
    });
    return {
      id: row.id,
      name: row.name,
      emailPermitted: Boolean(email.permitted && email.available),
      smsPermitted: Boolean(sms.permitted && sms.available),
      emailReason: email.ownerReason,
      smsReason: sms.ownerReason,
    };
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
          preferences,
          smsEntitled,
          failedDestinationReason: (() => {
            const fingerprint = emailDestinationFingerprintOrNull(
              access.businessId,
              selected.email,
            );
            return fingerprint ? failedDestinations.get(fingerprint) ?? null : null;
          })(),
        }),
        sms: evaluateComposeChannelEligibility({
          businessId: access.businessId,
          channel: "SMS",
          email: selected.email,
          phone: selected.phone,
          smsConsentStatus: selected.smsConsentStatus,
          purpose: purposeForComposeTemplate("general"),
          preferences,
          smsEntitled,
        }),
        phone: evaluateComposeChannelEligibility({
          businessId: access.businessId,
          channel: "PHONE",
          email: selected.email,
          phone: selected.phone,
          smsConsentStatus: selected.smsConsentStatus,
          purpose: purposeForComposeTemplate("general"),
          preferences,
          smsEntitled,
        }),
      }
    : null;

  return {
    businessId: access.businessId,
    customers,
    composeCustomers,
    selectedCustomerId: selected?.id ?? null,
    inbox,
    failedDeliveries,
    phoneLogs,
    rules,
    timeline,
    timelineSummary: history?.summary ?? null,
    timeZone,
    channelEligibility,
    receptionist: getReceptionistReadiness(),
    smsEntitled,
  };
}
