import type { Metadata } from "next";
import Link from "next/link";
import { ActionCenterBoard } from "@/components/actions/action-center-board";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  ACTION_CENTER_HISTORY_PATH,
  canConfirmControlledActions,
  loadControlledActionCenter,
} from "@/lib/chief-of-staff";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Action Center" };

export default async function ControlledActionCenterPage() {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const center = await loadControlledActionCenter(prisma, access);

  return (
    <PageContainer>
      <PageHeader
        title="Action Center"
        description="Owner control over existing Controlled AI Actions. This is not autonomous AI, not a second Chief-of-Staff, and not a new allowlist. Live actions use the current V1 allowlist. Existing owner-plan state is shown without inventing Controlled AI origin — origin is not recorded in Controlled Actions V1."
      >
        <Button asChild size="sm" variant="outline">
          <Link href={ACTION_CENTER_HISTORY_PATH}>Confirmed Controlled AI history</Link>
        </Button>
      </PageHeader>
      <ActionCenterBoard
        center={center}
        canConfirm={canConfirmControlledActions(access)}
      />
    </PageContainer>
  );
}
