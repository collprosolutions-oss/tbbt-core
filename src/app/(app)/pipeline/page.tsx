import type { Metadata } from "next";
import { PipelineWorkspace } from "@/components/pipeline/pipeline-workspace";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatMoney } from "@/lib/format";
import type { CuratedIconId } from "@/lib/founder-icons";
import { loadPipelineSource } from "@/lib/pipeline-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Deals / Pipeline",
};

function kpiValue(count: number, amount: string | null) {
  return amount ? `${count} · ${formatMoney(amount)}` : String(count);
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string; activity?: string; selected?: string }>;
}) {
  const access = await requireManagementPageAccess();

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "pipeline" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("pipeline", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const source = await loadPipelineSource(prisma, access.businessId, {
    q: params.q,
    stage: params.stage,
    activity: params.activity,
    selected: params.selected,
  });

  const kpis: Array<{
    label: string;
    value: string;
    sublabel: string;
    defaultIconId: CuratedIconId;
  }> = [
    {
      label: "Open Opportunities",
      value: kpiValue(source.counts.open, source.values.open),
      sublabel: source.values.open ? "Count and estimate value on file" : "No estimate values yet",
      defaultIconId: "briefcase",
    },
    {
      label: "Needs Follow-Up",
      value: kpiValue(source.counts.needsFollowUp, source.values.needsFollowUp),
      sublabel: "Due today or overdue",
      defaultIconId: "clock",
    },
    {
      label: "Estimates Sent",
      value: kpiValue(source.counts.estimatesSent, source.values.estimatesSent),
      sublabel: "Waiting on customer response",
      defaultIconId: "send",
    },
    {
      label: "Won",
      value: kpiValue(source.counts.won, source.values.won),
      sublabel: "Approved estimate or job",
      defaultIconId: "check-circle",
    },
    {
      label: "Lost",
      value: kpiValue(source.counts.lost, source.values.lost),
      sublabel: "Historical — records kept",
      defaultIconId: "alert-triangle",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Deals / Pipeline"
        description={`Sales workspace for ${access.workspace.business.name}. Stages follow real requests, estimates, and jobs — not a second CRM.`}
      />

      <FounderDesignRoot
        pageKey="pipeline"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="summary">
          <KpiCardsLayout gridClassName="grid-cols-1 sm:grid-cols-2 xl:grid-cols-5" defaultGapPx={20}>
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                variant="workspace"
                pageKey="pipeline"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <PipelineWorkspace source={source} />
      </FounderDesignRoot>
    </PageContainer>
  );
}
