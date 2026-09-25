import type { Metadata } from "next";
import { MaterialsWorkspace } from "@/components/materials/materials-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { loadMaterialsWorkspaceData } from "@/lib/materials/board";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { requireProductCapability } from "@/lib/product-entitlements";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Materials",
};

export default async function MaterialsPage() {
  const access = await requireManagementPageAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  await requireProductCapability(prisma, access.businessId, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
  const data = await loadMaterialsWorkspaceData(prisma, access);

  return (
    <PageContainer>
      <PageHeader
        title="Materials & suppliers"
        description="Reusable materials, preferred vendors, and last-paid prices for this business. Sent estimates stay frozen when a catalog price changes."
      />
      <MaterialsWorkspace suppliers={data.suppliers} catalog={data.catalog} />
    </PageContainer>
  );
}
