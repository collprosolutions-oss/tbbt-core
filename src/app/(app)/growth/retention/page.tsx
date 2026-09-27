import type { Metadata } from "next";
import { RetentionCenter } from "@/components/growth/retention/retention-center";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  RETENTION_NO_CADENCE_MESSAGE,
  RETENTION_READ_ONLY_MESSAGE,
  loadRetentionRecoveryCenter,
} from "@/lib/growth/retention";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { hasProductCapability } from "@/lib/product-entitlements";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Customer retention",
};

export default async function RetentionRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const entitled = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.MARKETING_TOOLS,
  );
  const reporting = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
  );
  const params = await searchParams;

  if (!entitled || !reporting) {
    return (
      <PageContainer width="2xl">
        <PageHeader
          title="Customer retention"
          description="Recorded repeat-business facts for this workspace."
        />
        <p className="text-sm text-muted-foreground">
          The current TBBT plan does not include Marketing Tools and Reporting Insights. Existing
          records are retained.
        </p>
      </PageContainer>
    );
  }

  const workspace = await loadRetentionRecoveryCenter(prisma, {
    businessId: access.businessId,
    role: access.workspace.role,
    customerId: params.customerId,
  });

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Customer retention"
        description={`Evidence already on file for ${access.workspace.business.name}. ${RETENTION_READ_ONLY_MESSAGE} ${RETENTION_NO_CADENCE_MESSAGE}`}
      />
      <RetentionCenter workspace={workspace} />
    </PageContainer>
  );
}
