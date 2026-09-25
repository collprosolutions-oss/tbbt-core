import type { Metadata } from "next";
import { BusinessProtectionWorkspace } from "@/components/business-protection/workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { loadProtectionWorkspace } from "@/lib/business-protection-data";
import { LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE, parseProtectionArea } from "@/lib/business-protection";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Business Protection",
};

export default async function BusinessProtectionPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; selected?: string; q?: string }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_BUSINESS_PROTECTION);
  const params = await searchParams;
  const area = parseProtectionArea(params.area);
  const source = await loadProtectionWorkspace(prisma, access.businessId, {
    area,
    selected: params.selected,
    q: params.q,
  });

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Business Protection"
        description={`${LEGAL_NO_COMPLIANCE_GUARANTEE_MESSAGE} Private vault files are never published just because they exist.`}
      />
      <BusinessProtectionWorkspace
        source={source}
        canFinalize={access.workspace.role === "OWNER"}
        canRecordOwnerReview={access.workspace.role === "OWNER"}
      />
    </PageContainer>
  );
}
