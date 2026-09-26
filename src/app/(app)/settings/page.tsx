import type { Metadata } from "next";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess, type BusinessAccess } from "@/lib/access";
import { listUserSessions } from "@/lib/account-security";
import { isOffboardingBillingRetryAvailable } from "@/lib/offboarding";
import { getSessionUser } from "@/lib/auth";
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import type { CuratedIconId } from "@/lib/founder-icons";
import { prisma } from "@/lib/prisma";
import { isBusinessStorageConfigured } from "@/lib/business-storage";
import { loadWebsitePhotoStorageSummary } from "@/lib/business-storage/website-photos";
import { loadSaasEntitlement, saasOperatingUiState } from "@/lib/saas-billing";
import { parseSettingsSection } from "@/lib/settings";
import {
  loadSettingsSnapshot,
  settingsIntegrationCardsFromSnapshot,
  settingsReadinessFromSnapshot,
} from "@/lib/settings-data";
import { loadGoLiveCenter } from "@/lib/go-live-data";
import { previewOperationalTestData } from "@/lib/test-data-cleanup";
import { loadPublicCatalog } from "@/lib/public-site-data";
import { loadWebsitePhotoEditorSlots } from "@/lib/public-site-images";
import { loadSupplierPricingContextPayload } from "@/lib/material-pricing/db";
import { loadWebsitePublishPanelData } from "@/lib/website-engine";
import { getFinanceConnectionProvider } from "@/lib/finance-connections";
import { asNumberOrNull } from "@/lib/reports";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; checkout?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const section = parseSettingsSection(params.section);
  const checkoutStatus =
    params.checkout === "success" || params.checkout === "canceled"
      ? params.checkout
      : null;

  const snapshot = await loadSettingsSnapshot(prisma, access.businessId);
  const goLive =
    section === "go-live"
      ? await loadGoLiveCenter(prisma, access)
      : undefined;
  const burdenRow = await prisma.businessLaborBurdenSetting.findUnique({
    where: { businessId: access.businessId },
    select: { burdenRate: true, targetGrossMarginRate: true, notes: true },
  });
  const financeStatus = getFinanceConnectionProvider().status();
  const readiness = settingsReadinessFromSnapshot(snapshot);
  const integrations = settingsIntegrationCardsFromSnapshot(snapshot);
  const role = access.workspace.role;
  const canEditPreferences = roleHasCapability(role, CAPABILITIES.MANAGE_SETTINGS);
  const canEditConsequential = role === "OWNER";
  const entitlement = await loadSaasEntitlement(prisma, access.workspace.business);
  const operating = saasOperatingUiState(entitlement, role);
  let websitePhotos:
    | {
        storageConfigured: boolean;
        storageUsage?: { usedBytes: number; limitBytes: number } | null;
        slots: Awaited<ReturnType<typeof loadWebsitePhotoEditorSlots>>;
      }
    | undefined;
  if (section === "website-photos") {
    const catalog = await loadPublicCatalog({
      id: snapshot.business.id,
      name: snapshot.business.name,
      slug: snapshot.business.slug,
      tradeCode: snapshot.business.tradeCode,
    });
    websitePhotos = {
      storageConfigured: isBusinessStorageConfigured(),
      storageUsage: await loadWebsitePhotoStorageSummary(prisma, access.businessId),
      slots: await loadWebsitePhotoEditorSlots(prisma, access.businessId, catalog.groups),
    };
  }

  const websitePublish =
    section === "website-publish" && canEditPreferences
      ? await loadWebsitePublishPanelData(prisma, access)
      : undefined;

  const supplierPricing =
    section === "vendors"
      ? await loadSupplierPricingContextPayload(prisma, {
          businessId: access.businessId,
          businessSlug: snapshot.business.slug,
        })
      : null;

  const founder = await checkFounderAccess();
  const canClearTestData = Boolean(founder) && role === "OWNER";
  const testDataCleanupPreview =
    canClearTestData && section === "data-export"
      ? await previewOperationalTestData(prisma, access.businessId)
      : null;
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "settings" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("settings", founderOverride?.tokens ?? {});

  const kpis: Array<{
    label: string;
    value: string;
    sublabel: string;
    defaultIconId: CuratedIconId;
  }> = [
    {
      label: "Required ready",
      value: `${readiness.requiredReady}/${readiness.requiredTotal}`,
      sublabel: "Baseline settings checks, not Go-live status",
      defaultIconId: "check-circle",
    },
    {
      label: "Team",
      value: String(snapshot.team.filter((member) => member.active).length),
      sublabel: "Active memberships",
      defaultIconId: "users",
    },
    {
      label: "Pricing rules",
      value: snapshot.business.laborMinimumEnabled ? "On" : "Off",
      sublabel: snapshot.business.laborMinimumEnabled
        ? "Labor minimum enabled"
        : "Labor minimum optional",
      defaultIconId: "wrench",
    },
    {
      label: "Connections",
      value: String(integrations.filter((card) => card.status === "connected").length),
      sublabel: "Configured integrations only",
      defaultIconId: "sparkles",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Settings"
        description={`Business configuration for ${snapshot.business.name}. Settings change future behavior. Historical estimates, jobs, invoices, and payroll records keep the values they already stored.`}
      />

      <FounderDesignRoot
        pageKey="settings"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="overview">
          <KpiCardsLayout gridClassName="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" defaultGapPx={20}>
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                variant="workspace"
                pageKey="settings"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <FounderRegion id="readiness">
          <div className="rounded-xl border bg-card px-4 py-3 text-sm">
            <p className="font-medium">Business Health / Settings Overview</p>
            <p className="text-muted-foreground">
              {readiness.requiredReady} of {readiness.requiredTotal} baseline settings checks
              configured. This is Settings completeness, not production Go-live status.
              Optional connections stay Not Connected until a real provider exists.
            </p>
          </div>
        </FounderRegion>

        <SettingsWorkspace
          section={section}
          role={role}
          snapshot={snapshot}
          readiness={readiness}
          goLive={goLive}
          integrations={integrations}
          canEditConsequential={canEditConsequential}
          canEditPreferences={canEditPreferences}
          canOperate={operating.canOperate}
          operatingBlockedMessage={operating.blockedMessage}
          websitePhotos={websitePhotos}
          websitePublish={websitePublish}
          supplierPricing={supplierPricing}
          canClearTestData={canClearTestData}
          testDataCleanupPreview={testDataCleanupPreview}
          checkoutStatus={checkoutStatus}
          security={await loadSettingsSecurity(access)}
          laborBurden={{
            burdenRate: asNumberOrNull(burdenRow?.burdenRate),
            targetGrossMarginRate: asNumberOrNull(burdenRow?.targetGrossMarginRate),
            notes: burdenRow?.notes ?? null,
          }}
          financeStatus={{
            accountingConnected: financeStatus.accounting.connected,
            bankingConnected: financeStatus.banking.connected,
            accountingMessage: financeStatus.accounting.message,
            bankingMessage: financeStatus.banking.message,
          }}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}

async function loadSettingsSecurity(access: BusinessAccess) {
  const session = await getSessionUser();
  const user = session
    ? await prisma.user.findUnique({
        where: { id: session.id },
        select: { totpEnabledAt: true },
      })
    : null;
  const sessions = session
    ? await listUserSessions(prisma, {
        userId: session.id,
        currentSessionId: session.sessionId,
      })
    : [];
  const saasSubscription = await prisma.businessSaasSubscription.findUnique({
    where: { businessId: access.businessId },
    select: { stripeSubscriptionId: true, cancelAtPeriodEnd: true },
  });
  const team = await prisma.membership.findMany({
    where: {
      businessId: access.businessId,
      active: true,
      role: { in: ["OWNER", "ADMIN"] },
      id: { not: access.workspace.membership.id },
    },
    select: {
      id: true,
      role: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    totpEnabled: Boolean(user?.totpEnabledAt),
    totpEnabledAt: user?.totpEnabledAt?.toISOString() ?? null,
    sessions: sessions.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      userAgent: row.userAgent,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      current: row.current,
      active: row.active,
    })),
    ownershipCandidates: team.map((member) => ({
      id: member.id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
    })),
    offboardingRequestedAt: access.workspace.business.offboardingRequestedAt?.toISOString() ?? null,
    billingRetryAvailable: isOffboardingBillingRetryAvailable({
      offboardingRequestedAt: access.workspace.business.offboardingRequestedAt,
      stripeSubscriptionId: saasSubscription?.stripeSubscriptionId,
      cancelAtPeriodEnd: saasSubscription?.cancelAtPeriodEnd,
    }),
    billingCancellationConfirmed: saasSubscription?.cancelAtPeriodEnd === true,
    canTransferOwnership: roleHasCapability(access.workspace.role, CAPABILITIES.TRANSFER_OWNERSHIP),
    canRequestOffboarding: roleHasCapability(access.workspace.role, CAPABILITIES.REQUEST_OFFBOARDING),
  };
}
