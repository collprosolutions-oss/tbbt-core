import type { Metadata } from "next";
import { EquipmentWorkspace } from "@/components/equipment/workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import {
  EQUIPMENT_LIMITS_MESSAGE,
  loadEquipmentRegister,
  requireEquipmentRead,
} from "@/lib/equipment";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Equipment",
};

export default async function EquipmentPage() {
  const access = await requireManagementPageAccess();
  requireEquipmentRead(access);
  const workspace = await loadEquipmentRegister(prisma, access);

  return (
    <PageContainer>
      <PageHeader
        title="Equipment"
        description={`Tools and vehicles recorded for ${access.workspace.business.name}. ${EQUIPMENT_LIMITS_MESSAGE}`}
      />
      <EquipmentWorkspace workspace={workspace} />
    </PageContainer>
  );
}
