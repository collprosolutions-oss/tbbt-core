import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutomationCenterView } from "@/components/automations/automation-center";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { loadAutomationOwnerCenter } from "@/lib/automations";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Automations",
};

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ruleId?: string }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  const params = await searchParams;

  let center;
  try {
    center = await loadAutomationOwnerCenter(prisma, access, {
      ruleId: params.ruleId,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("authorized business workspace")
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Automation Center"
        description={`Recorded automation rules for ${access.workspace.business.name}. This is not a workflow builder. Enabling a rule does not run it now.`}
      />
      <AutomationCenterView center={center} />
    </PageContainer>
  );
}
