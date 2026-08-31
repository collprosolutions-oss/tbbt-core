import type { Metadata } from "next";
import { KnowledgeWorkspace } from "@/components/knowledge/knowledge-workspace";
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
import { parseKnowledgeArea } from "@/lib/knowledge";
import { loadKnowledgeSource } from "@/lib/knowledge-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Knowledge Hub",
};

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{
    area?: string;
    q?: string;
    trust?: string;
    review?: string;
    archive?: string;
    selected?: string;
  }>;
}) {
  const access = await requireManagementPageAccess();

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "knowledge" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("knowledge", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const area = parseKnowledgeArea(params.area);
  const source = await loadKnowledgeSource(prisma, access.businessId, params);

  const kpis: Array<{
    label: string;
    value: string;
    sublabel: string;
    defaultIconId: CuratedIconId;
  }> = [
    {
      label: "Knowledge Entries",
      value: String(source.counts.entries),
      sublabel: "Active owner-recorded entries",
      defaultIconId: "clipboard-list",
    },
    {
      label: "Needs Review",
      value: String(source.counts.needsReview),
      sublabel: "Needs review or conflict",
      defaultIconId: "alert-triangle",
    },
    {
      label: "Recently Updated",
      value: String(source.counts.recentlyUpdated),
      sublabel: "Updated in the last 7 days",
      defaultIconId: "clock",
    },
    {
      label: "Business Records Available",
      value: String(source.counts.businessRecordsAvailable),
      sublabel: "Operational sources that can be referenced, not automatically learned",
      defaultIconId: "briefcase",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Knowledge Hub"
        description={`Internal operational knowledge for ${access.workspace.business.name}. ${source.noAiMessage}`}
      />

      <FounderDesignRoot
        pageKey="knowledge"
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
                pageKey="knowledge"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <KnowledgeWorkspace area={area} source={source} />
      </FounderDesignRoot>
    </PageContainer>
  );
}
