import type { Metadata } from "next";
import { CommunicationsWorkspace } from "@/components/communications/communications-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { loadCommunicationsWorkspace } from "@/lib/communications/data";
import { parseCommunicationArea } from "@/lib/communications/types";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Communications",
};

export default async function CommunicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; customerId?: string }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
  const params = await searchParams;
  const source = await loadCommunicationsWorkspace(prisma, access, {
    customerId: params.customerId,
  });

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Communications"
        description={`Customer and business communications for ${access.workspace.business.name}. Email, SMS, and manual phone live here. Voice is not connected.`}
      />
      <CommunicationsWorkspace
        area={parseCommunicationArea(params.area)}
        source={source}
        businessName={access.workspace.business.name}
      />
    </PageContainer>
  );
}
