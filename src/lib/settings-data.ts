/**
 * Tenant-scoped Settings loader. Every query is keyed by the
 * authenticated workspace businessId passed in -- never a client-supplied
 * business id. Callers must obtain that id from requireBusinessAccess() /
 * requireManagementPageAccess().
 */
import type { PrismaClient } from "@prisma/client";
import { getBusinessLogoSrc } from "@/lib/business-branding";
import { projectedOperatingBalance } from "@/lib/expenses";
import { PAYMENT_METHODS } from "@/lib/invoice-payment";
import {
  CHANNELS_DISCONNECTED_MESSAGE,
} from "@/lib/marketing";
import { PLATFORMS_DISCONNECTED_MESSAGE } from "@/lib/reviews";
import {
  DEFAULT_SETTINGS_PREFERENCES,
  buildIntegrationCards,
  buildSettingsReadiness,
  isBlobStorageConfigured,
  isEmailDeliveryConfigured,
  type SettingsPreferenceFlags,
} from "@/lib/settings";
import { getTrade } from "@/lib/trades";

export type SettingsTeamMember = {
  id: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  active: boolean;
  name: string;
  email: string;
};

export type SettingsCustomerExportRow = {
  name: string;
  phone: string;
  email: string;
  location: string;
  jobs: number;
  totalSpentLabel: string;
  balanceLabel: string;
  lastActivityLabel: string;
};

export type SettingsSnapshot = {
  business: {
    id: string;
    name: string;
    slug: string;
    tradeCode: string;
    tradeLabel: string;
    laborMinimumEnabled: boolean;
    laborMinimumAmount: string;
    logoSrc: string | null;
  };
  preferences: SettingsPreferenceFlags;
  websiteStory: {
    rawOwnerStory: string;
    approvedPublicAboutCopy: string;
  };
  team: SettingsTeamMember[];
  catalogItemCount: number;
  distinctVendors: string[];
  emailDeliveryConfigured: boolean;
  storageConfigured: boolean;
  paymentMethods: Array<{ value: string; label: string }>;
  bank: {
    connected: false;
    lastVerifiedBalance: null;
    projectedOperatingBalance: null;
    knownInflows: number;
    knownOutflows: number;
    unavailableReason: string;
  };
  paymentProviderConnected: false;
  payrollProviderConnected: false;
  accountingConnected: false;
  marketingConnected: false;
  reviewPlatformConnected: false;
  marketingDisconnectedMessage: string;
  reviewDisconnectedMessage: string;
  customers: SettingsCustomerExportRow[];
  recentAudit: Array<{
    id: string;
    settingArea: string;
    settingKey: string;
    previousValue: string | null;
    newValue: string | null;
    changedAt: string;
    changedByName: string;
  }>;
};

export async function loadSettingsSnapshot(
  prisma: PrismaClient,
  businessId: string,
): Promise<SettingsSnapshot> {
  const scope = { businessId } as const;

  const [
    business,
    preferencesRow,
    members,
    catalogItemCount,
    vendorRows,
    customers,
    paidInvoices,
    expenses,
    auditRows,
  ] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        slug: true,
        tradeCode: true,
        laborMinimumEnabled: true,
        laborMinimumAmount: true,
      },
    }),
    prisma.businessSettings.findUnique({
      where: { businessId },
    }),
    prisma.membership.findMany({
      where: scope,
      select: {
        id: true,
        role: true,
        active: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    }),
    prisma.serviceCatalogItem.count({ where: scope }),
    prisma.expense.findMany({
      where: { ...scope, vendor: { not: null } },
      select: { vendor: true },
      distinct: ["vendor"],
      orderBy: { vendor: "asc" },
      take: 25,
    }),
    prisma.customer.findMany({
      where: scope,
      select: {
        name: true,
        phone: true,
        email: true,
        createdAt: true,
        properties: {
          select: { city: true, region: true },
          take: 1,
          orderBy: { createdAt: "asc" },
        },
        jobs: { select: { id: true } },
        invoices: {
          select: { status: true, total: true, paidAt: true, updatedAt: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.invoice.aggregate({
      where: { ...scope, status: "PAID" },
      _sum: { total: true },
    }),
    prisma.expense.aggregate({
      where: scope,
      _sum: { amount: true },
    }),
    prisma.settingsAuditLog.findMany({
      where: scope,
      select: {
        id: true,
        settingArea: true,
        settingKey: true,
        previousValue: true,
        newValue: true,
        changedAt: true,
        changedBy: { select: { user: { select: { name: true } } } },
      },
      orderBy: { changedAt: "desc" },
      take: 8,
    }),
  ]);

  if (!business) {
    throw new Error("Business was not found.");
  }

  const knownInflows = Number(paidInvoices._sum.total ?? 0);
  const knownOutflows = Number(expenses._sum.amount ?? 0);
  const projection = projectedOperatingBalance({ knownInflows, knownOutflows });
  const emailDeliveryConfigured = isEmailDeliveryConfigured();
  const trade = getTrade(business.tradeCode);

  const preferences: SettingsPreferenceFlags = preferencesRow
    ? {
        estimateCommunicationEnabled: preferencesRow.estimateCommunicationEnabled,
        scheduleNotificationEnabled: preferencesRow.scheduleNotificationEnabled,
        invoiceCommunicationEnabled: preferencesRow.invoiceCommunicationEnabled,
        reviewRequestPreferenceEnabled: preferencesRow.reviewRequestPreferenceEnabled,
        marketingCommunicationEnabled: preferencesRow.marketingCommunicationEnabled,
        notifyEstimateEvents: preferencesRow.notifyEstimateEvents,
        notifyScheduleEvents: preferencesRow.notifyScheduleEvents,
        notifyInvoiceEvents: preferencesRow.notifyInvoiceEvents,
        notifyPayrollEvents: preferencesRow.notifyPayrollEvents,
        notifyTeamEvents: preferencesRow.notifyTeamEvents,
      }
    : DEFAULT_SETTINGS_PREFERENCES;

  const websiteStory = {
    rawOwnerStory: preferencesRow?.rawOwnerStory ?? "",
    approvedPublicAboutCopy: preferencesRow?.approvedPublicAboutCopy ?? "",
  };

  return {
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      tradeCode: business.tradeCode,
      tradeLabel: trade?.name ?? business.tradeCode,
      laborMinimumEnabled: business.laborMinimumEnabled,
      laborMinimumAmount: business.laborMinimumAmount?.toString() ?? "",
      logoSrc: getBusinessLogoSrc(business.slug),
    },
    preferences,
    websiteStory,
    team: members.map((member) => ({
      id: member.id,
      role: member.role,
      active: member.active,
      name: member.user.name,
      email: member.user.email,
    })),
    catalogItemCount,
    distinctVendors: vendorRows
      .map((row) => row.vendor)
      .filter((vendor): vendor is string => Boolean(vendor)),
    emailDeliveryConfigured,
    storageConfigured: isBlobStorageConfigured(),
    paymentMethods: PAYMENT_METHODS.map((method) => ({
      value: method.value,
      label: method.label,
    })),
    bank: {
      connected: false,
      lastVerifiedBalance: null,
      projectedOperatingBalance: null,
      knownInflows,
      knownOutflows,
      unavailableReason: projection.unavailableReason,
    },
    paymentProviderConnected: false,
    payrollProviderConnected: false,
    accountingConnected: false,
    marketingConnected: false,
    reviewPlatformConnected: false,
    marketingDisconnectedMessage: CHANNELS_DISCONNECTED_MESSAGE,
    reviewDisconnectedMessage: PLATFORMS_DISCONNECTED_MESSAGE,
    customers: customers.map((customer) => {
      const paid = customer.invoices
        .filter((invoice) => invoice.status === "PAID")
        .reduce((sum, invoice) => sum + Number(invoice.total), 0);
      const outstanding = customer.invoices
        .filter((invoice) => invoice.status === "SENT")
        .reduce((sum, invoice) => sum + Number(invoice.total), 0);
      const location = customer.properties[0]
        ? [customer.properties[0].city, customer.properties[0].region].filter(Boolean).join(", ")
        : "";
      return {
        name: customer.name,
        phone: customer.phone ?? "",
        email: customer.email ?? "",
        location,
        jobs: customer.jobs.length,
        totalSpentLabel: paid.toFixed(2),
        balanceLabel: outstanding.toFixed(2),
        lastActivityLabel: customer.createdAt.toISOString().slice(0, 10),
      };
    }),
    recentAudit: auditRows.map((row) => ({
      id: row.id,
      settingArea: row.settingArea,
      settingKey: row.settingKey,
      previousValue: row.previousValue,
      newValue: row.newValue,
      changedAt: row.changedAt.toISOString(),
      changedByName: row.changedBy.user.name,
    })),
  };
}

export function settingsReadinessFromSnapshot(snapshot: SettingsSnapshot) {
  return buildSettingsReadiness({
    businessName: snapshot.business.name,
    laborMinimumEnabled: snapshot.business.laborMinimumEnabled,
    laborMinimumAmount: snapshot.business.laborMinimumAmount || null,
    activeMemberCount: snapshot.team.filter((member) => member.active).length,
    catalogItemCount: snapshot.catalogItemCount,
    emailDeliveryConfigured: snapshot.emailDeliveryConfigured,
    paymentProviderConnected: snapshot.paymentProviderConnected,
    payrollProviderConnected: snapshot.payrollProviderConnected,
    bankConnected: snapshot.bank.connected,
    marketingConnected: snapshot.marketingConnected,
    reviewPlatformConnected: snapshot.reviewPlatformConnected,
  });
}

export function settingsIntegrationCardsFromSnapshot(snapshot: SettingsSnapshot) {
  return buildIntegrationCards({
    emailDeliveryConfigured: snapshot.emailDeliveryConfigured,
    paymentProviderConnected: snapshot.paymentProviderConnected,
    payrollProviderConnected: snapshot.payrollProviderConnected,
    bankConnected: snapshot.bank.connected,
    accountingConnected: snapshot.accountingConnected,
    marketingConnected: snapshot.marketingConnected,
    storageConfigured: snapshot.storageConfigured,
  });
}
