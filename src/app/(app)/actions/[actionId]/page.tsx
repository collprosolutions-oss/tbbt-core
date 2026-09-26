import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionCenterBoard } from "@/components/actions/action-center-board";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  ACTION_CENTER_PATH,
  canConfirmControlledActions,
  loadControlledActionCenterItem,
} from "@/lib/chief-of-staff";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Action Center" };

export default async function ControlledActionCenterDetailPage({
  params,
}: {
  params: Promise<{ actionId: string }>;
}) {
  const { actionId } = await params;
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const detail = await loadControlledActionCenterItem(prisma, access, actionId);
  if (!detail) notFound();

  return (
    <PageContainer>
      <PageHeader
        title={detail.live?.targetLabel ?? detail.recordedOwnerPlanState[0]?.targetLabel ?? "Action"}
        description="Same-tenant Action Center target. Existing owner-plan state does not prove Controlled AI origin. Foreign IDs fail closed."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={ACTION_CENTER_PATH}>Back to Action Center</Link>
        </Button>
      </PageHeader>
      <ActionCenterBoard
        center={{
          needsOwnerConfirmation: detail.live ? [detail.live] : [],
          recordedOwnerPlanState: detail.recordedOwnerPlanState,
        }}
        canConfirm={canConfirmControlledActions(access)}
        showCatalog={false}
      />
    </PageContainer>
  );
}
