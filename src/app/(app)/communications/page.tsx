import type { Metadata } from "next";
import { CommunicationsWorkspace } from "@/components/communications/communications-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { loadCommunicationsWorkspace } from "@/lib/communications/data";
import { parseCommunicationArea } from "@/lib/communications/types";
import { loadMaintenanceFollowUpComposeContext } from "@/lib/handyman-maintenance-follow-up-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Communications",
};

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    area?: string;
    customerId?: string;
    relatedType?: string;
    relatedId?: string;
  }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
  const params = await searchParams;
  const source = await loadCommunicationsWorkspace(prisma, access, {
    customerId: params.customerId,
  });
  const maintenanceReview =
    params.relatedType === "CUSTOMER_FOLLOW_UP"
      ? await loadMaintenanceFollowUpComposeContext(prisma, access, {
          followUpId: params.relatedId,
          customerId: params.customerId ?? source.selectedCustomerId,
        })
      : null;

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Communications"
        description={`Customer and business communications for ${access.workspace.business.name}. Email, SMS, and manual phone live here. Voice is not connected.`}
      />
      <CommunicationsWorkspace
        area={parseCommunicationArea(params.area)}
        source={source}
        businessId={access.businessId}
        businessName={access.workspace.business.name}
        relatedType={params.relatedType}
        relatedId={params.relatedId}
        maintenanceReview={maintenanceReview}
      />
    </PageContainer>
  );
}
