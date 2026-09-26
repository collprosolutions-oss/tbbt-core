/**
 * Tenant-scoped Business Launch loader. Never accepts a client businessId
 * as authority — callers pass the workspace business id.
 */

import type { PrismaClient } from "@prisma/client";
import {
  LAUNCH_STEP_KEYS,
  LAUNCH_STEP_LABELS,
  LAUNCH_STEP_SUMMARIES,
  buildLaunchProgressSummary,
  type LaunchProgressSummary,
} from "@/lib/business-launch";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import { getBusinessPaymentStatus } from "@/lib/payments";
import { publicTradeProjection } from "@/lib/trade-config";

export type LaunchWorkspace = {
  progress: LaunchProgressSummary;
  business: {
    name: string;
    publicPhone: string;
    publicEmail: string;
    publicWebsite: string;
    publicServiceAreaLabel: string;
    laborMinimumEnabled: boolean;
    laborMinimumAmount: string | null;
    publishedWebsiteId: string | null;
    websiteSetupCompletedAt: Date | null;
  };
  settings: {
    workStartMinutes: number;
    workEndMinutes: number;
    workingWeekdays: number[];
    schedulingBufferMinutes: number;
    estimateCommunicationEnabled: boolean;
    scheduleNotificationEnabled: boolean;
    invoiceCommunicationEnabled: boolean;
    marketingBrandVoice: string;
    marketingIdentityNotes: string;
    approvedPublicAboutCopy: string;
    businessStage: string | null;
    pricingApproach: string | null;
    teamStructureNotes: string | null;
    paymentPreferenceNotes: string | null;
    schedulingPreferenceNotes: string | null;
  };
  trades: Array<{ tradeCode: string; label: string }>;
  services: Array<{ id: string; name: string; pricingMode: string; price: string | null }>;
  goals: Array<{ id: string; title: string; status: string }>;
  paymentStatus: string;
  websitePublished: boolean;
  stepMeta: Array<{
    key: (typeof LAUNCH_STEP_KEYS)[number];
    label: string;
    summary: string;
  }>;
};

export async function loadLaunchWorkspace(
  prisma: PrismaClient,
  businessId: string,
): Promise<LaunchWorkspace> {
  const scope = { businessId } as const;
  const [business, settings, progress, trades, services, goals] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: {
        name: true,
        publicPhone: true,
        publicEmail: true,
        publicWebsite: true,
        publicServiceAreaLabel: true,
        laborMinimumEnabled: true,
        laborMinimumAmount: true,
        publishedWebsiteId: true,
        websiteSetupCompletedAt: true,
      },
    }),
    prisma.businessSettings.findUnique({ where: { businessId } }),
    prisma.businessLaunchProgress.findFirst({
      where: scope,
      include: { steps: true },
    }),
    listActiveBusinessTrades(prisma, businessId),
    prisma.serviceCatalogItem.findMany({
      where: { ...scope, active: true },
      select: { id: true, name: true, pricingMode: true, price: true },
      orderBy: { name: "asc" },
      take: 40,
    }),
    prisma.businessGoal.findMany({
      where: scope,
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: 12,
    }),
  ]);

  const payment = await getBusinessPaymentStatus(prisma, businessId);

  return {
    progress: buildLaunchProgressSummary({
      ...(progress ?? {}),
      hasRecordedProgress: Boolean(progress),
    }),
    business: {
      name: business?.name ?? "",
      publicPhone: business?.publicPhone ?? "",
      publicEmail: business?.publicEmail ?? "",
      publicWebsite: business?.publicWebsite ?? "",
      publicServiceAreaLabel: business?.publicServiceAreaLabel ?? "",
      laborMinimumEnabled: business?.laborMinimumEnabled ?? false,
      laborMinimumAmount: business?.laborMinimumAmount?.toString() ?? null,
      publishedWebsiteId: business?.publishedWebsiteId ?? null,
      websiteSetupCompletedAt: business?.websiteSetupCompletedAt ?? null,
    },
    settings: {
      workStartMinutes: settings?.workStartMinutes ?? 480,
      workEndMinutes: settings?.workEndMinutes ?? 1020,
      workingWeekdays: (settings?.workingWeekdays ?? "1,2,3,4,5")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value)),
      schedulingBufferMinutes: settings?.schedulingBufferMinutes ?? 30,
      estimateCommunicationEnabled: settings?.estimateCommunicationEnabled ?? true,
      scheduleNotificationEnabled: settings?.scheduleNotificationEnabled ?? true,
      invoiceCommunicationEnabled: settings?.invoiceCommunicationEnabled ?? true,
      marketingBrandVoice: settings?.marketingBrandVoice ?? "",
      marketingIdentityNotes: settings?.marketingIdentityNotes ?? "",
      approvedPublicAboutCopy: settings?.approvedPublicAboutCopy ?? "",
      businessStage: settings?.businessStage ?? null,
      pricingApproach: settings?.pricingApproach ?? null,
      teamStructureNotes: settings?.teamStructureNotes ?? null,
      paymentPreferenceNotes: settings?.paymentPreferenceNotes ?? null,
      schedulingPreferenceNotes: settings?.schedulingPreferenceNotes ?? null,
    },
    trades: trades.map((row) => ({
      tradeCode: row.tradeCode,
      label: publicTradeProjection(row.config).label,
    })),
    services: services.map((row) => ({
      id: row.id,
      name: row.name,
      pricingMode: row.pricingMode,
      price: row.price?.toString() ?? null,
    })),
    goals,
    paymentStatus: payment.status,
    websitePublished: Boolean(business?.publishedWebsiteId),
    stepMeta: LAUNCH_STEP_KEYS.map((key) => ({
      key,
      label: LAUNCH_STEP_LABELS[key],
      summary: LAUNCH_STEP_SUMMARIES[key],
    })),
  };
}
