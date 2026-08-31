import type { Metadata } from "next";
import { ReviewsWorkspace } from "@/components/reviews/reviews-workspace";
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
import { parseReviewArea } from "@/lib/reviews";
import { loadReviewsSource } from "@/lib/reviews-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Reviews",
};

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const access = await requireManagementPageAccess();

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "reviews" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("reviews", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const area = parseReviewArea(params.area);
  const source = await loadReviewsSource(prisma, access.businessId);

  const kpis: Array<{
    label: string;
    value: string;
    sublabel: string;
    defaultIconId: CuratedIconId;
  }> = [
    {
      label: "Review opportunities",
      value: String(source.counts.opportunities),
      sublabel: "Completed jobs without an active request",
      defaultIconId: "briefcase",
    },
    {
      label: "Requests awaiting action",
      value: String(source.counts.awaitingAction),
      sublabel: "Draft or ready — not sent",
      defaultIconId: "clock",
    },
    {
      label: "Requests sent",
      value: String(source.counts.sent),
      sublabel: "Owner-recorded, not auto-sent",
      defaultIconId: "send",
    },
    {
      label: "Reviews recorded",
      value: String(source.counts.received),
      sublabel: "Received externally and entered here",
      defaultIconId: "check-circle",
    },
    {
      label: "Responses needing attention",
      value: String(source.counts.responsesNeedingAttention),
      sublabel: "Low ratings flagged for recovery",
      defaultIconId: "alert-triangle",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Reviews"
        description={`Internal review workspace for ${access.workspace.business.name}. ${source.platforms.message}`}
      />

      <FounderDesignRoot
        pageKey="reviews"
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
                pageKey="reviews"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <ReviewsWorkspace area={area} source={source} />
      </FounderDesignRoot>
    </PageContainer>
  );
}
