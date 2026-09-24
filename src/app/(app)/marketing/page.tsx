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
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Marketing",
};

export default async function MarketingPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
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
  const source = await loadMarketingSource(prisma, access.businessId);

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
      sublabel: "Owner/admin approval",
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

        <MarketingWorkspace area={area} source={source} />
      </FounderDesignRoot>
    </PageContainer>
  );
}
