import type { Metadata } from "next";
import Link from "next/link";
import { ActionCenterHistoryList } from "@/components/actions/action-center-history";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { ACTION_CENTER_PATH, loadControlledAiActionHistory } from "@/lib/chief-of-staff";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Controlled AI history" };

export default async function ControlledAiActionHistoryPage() {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const history = await loadControlledAiActionHistory(prisma, access);

  return (
    <PageContainer>
      <PageHeader
        title="Controlled AI history"
        description="Read-only provenance for explicitly confirmed Controlled AI actions. This is not autonomous AI, not a second recommendation engine, and not inferred from older owner-plan rows."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={ACTION_CENTER_PATH}>Back to Action Center</Link>
        </Button>
      </PageHeader>
      <ActionCenterHistoryList history={history} />
    </PageContainer>
  );
}
