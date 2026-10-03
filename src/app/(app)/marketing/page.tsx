import type { Metadata } from "next";
import { MarketingWorkspace } from "@/components/marketing/marketing-workspace";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import type { CuratedIconId } from "@/lib/founder-icons";
import { parseMarketingArea } from "@/lib/marketing";
import { loadMarketingSource } from "@/lib/marketing-data";
import {
  loadMarketingConnectionCards,
  loadMarketingConnectionSelection,
} from "@/lib/marketing-connections/service";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Marketing",
};

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; connectionSelection?: string; connectionError?: string }>;
}) {
  const access = await requireManagementPageAccess();

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "marketing" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("marketing", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const area = parseMarketingArea(params.area);
  const source = await loadMarketingSource(prisma, access.businessId, new Date(), access.workspace.role);
  const owner = access.workspace.role === "OWNER";
  const connectionCards = await loadMarketingConnectionCards(prisma, access.businessId, owner);
  const selectionToken = params.connectionSelection?.trim() ?? "";
  let connectionSelection: {
    token: string;
    label: string;
    candidates: Array<{ externalId: string; displayName: string }>;
  } | null = null;
  let connectionError =
    params.connectionError === "permission"
      ? "Needs more permission. Nothing was connected or published."
      : params.connectionError
        ? "That connection attempt was rejected. Nothing was published."
        : null;
  if (owner && selectionToken) {
    try {
      const row = await loadMarketingConnectionSelection(prisma, access, selectionToken);
      connectionSelection = row
        ? { token: selectionToken, label: row.label, candidates: row.candidates }
        : null;
      if (!connectionSelection && !connectionError) {
        connectionError = "That connection attempt was rejected. Nothing was published.";
      }
    } catch {
      connectionError = "That connection attempt was rejected. Nothing was published.";
    }
  }

  const kpis: Array<{
    label: string;
    value: string;
    sublabel: string;
    defaultIconId: CuratedIconId;
  }> = [
    {
      label: "Completed jobs",
      value: String(source.counts.completedJobs),
      sublabel: `${source.counts.readyOpportunities} with approved photos`,
      defaultIconId: "briefcase",
    },
    {
      label: "Drafts",
      value: String(source.counts.drafts),
      sublabel: "Internal content drafts",
      defaultIconId: "file-text",
    },
    {
      label: "Awaiting review",
      value: String(source.counts.awaitingReview),
      sublabel: "Weekly OWNER review queue",
      defaultIconId: "clock",
    },
    {
      label: "Approved content",
      value: String(source.counts.approved),
      sublabel: "Not published externally",
      defaultIconId: "check-circle",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Marketing Studio"
        description={`Internal marketing workspace for ${access.workspace.business.name}. ${source.channels.message}`}
      />

      <FounderDesignRoot
        pageKey="marketing"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="summary">
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
                pageKey="marketing"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <MarketingWorkspace
          area={area}
          source={source}
          viewerRole={access.workspace.role}
          connectionCards={connectionCards}
          connectionSelection={connectionSelection}
          connectionError={connectionError}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}
