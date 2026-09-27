import type { Metadata } from "next";
import Link from "next/link";
import { ReceptionistRecoveryCenter } from "@/components/communications/receptionist-recovery-center";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { loadReceptionistRecoveryCenter } from "@/lib/communications/receptionist-recovery";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Receptionist recovery",
};

export default async function ReceptionistRecoveryPage() {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_COMMUNICATIONS);
  const source = await loadReceptionistRecoveryCenter(prisma, access);

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Receptionist & missed-call recovery"
        description={`Recorded inbound calls, missed calls, and receptionist events for ${access.workspace.business.name}. Voice is not connected. This page does not text, email, or call anyone.`}
      >
        <Button asChild size="sm" variant="outline">
          <Link href="/communications?area=receptionist">Back to Communications</Link>
        </Button>
      </PageHeader>
      <ReceptionistRecoveryCenter source={source} />
    </PageContainer>
  );
}
