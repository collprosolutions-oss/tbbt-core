import type { Metadata } from "next";
import { SettingsWorkspace } from "@/components/settings/settings-workspace";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import type { CuratedIconId } from "@/lib/founder-icons";
import { prisma } from "@/lib/prisma";
import { isBlobStorageConfigured, parseSettingsSection } from "@/lib/settings";
import {
  loadSettingsSnapshot,
  settingsIntegrationCardsFromSnapshot,
  settingsReadinessFromSnapshot,
} from "@/lib/settings-data";
import { loadPublicCatalog } from "@/lib/public-site-data";
import { loadWebsitePhotoEditorSlots } from "@/lib/public-site-images";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const section = parseSettingsSection(params.section);

  const snapshot = await loadSettingsSnapshot(prisma, access.businessId);
  const readiness = settingsReadinessFromSnapshot(snapshot);
  const integrations = settingsIntegrationCardsFromSnapshot(snapshot);
  const role = access.workspace.role;
  const canEditPreferences = roleHasCapability(role, CAPABILITIES.MANAGE_SETTINGS);
  const canEditConsequential = role === "OWNER";
  let websitePhotos:
    | { storageConfigured: boolean; slots: Awaited<ReturnType<typeof loadWebsitePhotoEditorSlots>> }
    | undefined;
  if (section === "website-photos") {
    const catalog = await loadPublicCatalog({
      id: snapshot.business.id,
      name: snapshot.business.name,
      slug: snapshot.business.slug,
      tradeCode: snapshot.business.tradeCode,
    });
    websitePhotos = {
      storageConfigured: isBlobStorageConfigured(),
      slots: await loadWebsitePhotoEditorSlots(prisma, access.businessId, catalog.groups),
    };
  }

  const founder = await checkFounderAccess();
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
      sublabel: `${readiness.readyPercent}% of required checks`,
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
              {readiness.requiredReady} of {readiness.requiredTotal} required areas configured
              ({readiness.readyPercent}%). Optional connections stay Not Connected until a real
              provider exists. This is not an AI score.
            </p>
          </div>
        </FounderRegion>

        <SettingsWorkspace
          section={section}
          role={role}
          snapshot={snapshot}
          readiness={readiness}
          integrations={integrations}
          canEditConsequential={canEditConsequential}
          canEditPreferences={canEditPreferences}
          websitePhotos={websitePhotos}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}
