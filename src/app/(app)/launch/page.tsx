import type { Metadata } from "next";
import Link from "next/link";
import { LaunchWorkspace } from "@/components/launch/launch-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { loadLaunchWorkspace } from "@/lib/business-launch-data";
import { parseLaunchStepKey } from "@/lib/business-launch";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Business Launch",
};

export default async function BusinessLaunchPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  requireBusinessRole(access, "OWNER");
  const workspace = await loadLaunchWorkspace(prisma, access.businessId);
  const params = await searchParams;
  const step = parseLaunchStepKey(params.step ?? workspace.progress.recommendedNext ?? undefined);

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Help me build and understand my business"
        description="A resumable owner setup — not forty blank settings. Each step writes into the records you already own."
      >
        <Button asChild variant="outline">
          <Link href="/launch/build">Build my company with AI</Link>
        </Button>
      </PageHeader>
      <LaunchWorkspace workspace={workspace} step={step} />
    </PageContainer>
  );
}
