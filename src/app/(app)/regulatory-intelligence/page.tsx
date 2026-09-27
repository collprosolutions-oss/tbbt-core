import type { Metadata } from "next";
import { RegulatoryIntelligenceWorkspace } from "@/components/regulatory-intelligence/workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { loadRegulatoryIntelligence } from "@/lib/regulatory-intelligence-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Regulatory Intelligence",
};

export default async function RegulatoryIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ jurisdiction?: string; trade?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const source = await loadRegulatoryIntelligence(prisma, access, {
    jurisdiction: params.jurisdiction ?? "US-FL-LEE",
    trade: params.trade ?? "HANDYMAN",
  });

  return (
    <PageContainer width="default">
      <PageHeader
        title="Regulatory Intelligence"
        description="Read-only official-source notes for one researched jurisdiction and trade. This page is not in global navigation, does not certify licenses, and does not gate estimates or jobs."
      />
      <RegulatoryIntelligenceWorkspace source={source} />
    </PageContainer>
  );
}
