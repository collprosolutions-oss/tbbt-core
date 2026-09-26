import type { Metadata } from "next";
import { IntegrationCenterView } from "@/components/integrations/integration-center";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { loadIntegrationCenter } from "@/lib/integrations";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Integrations",
};

export default async function IntegrationsPage() {
  const access = await requireManagementPageAccess();
  const center = await loadIntegrationCenter(prisma, access);

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Integrations"
        description={`Supported connections for ${access.workspace.business.name}. This page reports recorded configuration only. It does not connect Stripe, provision email, change DNS, create phone numbers, or start OAuth.`}
      />
      <IntegrationCenterView center={center} />
    </PageContainer>
  );
}
