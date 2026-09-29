import type { Metadata } from "next";
import { MonthlyGoalsWorkspace } from "@/components/goals/monthly-goals-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireProductCapability } from "@/lib/product-entitlements";
import { assertCanReadMonthlyGoals } from "@/lib/monthly-goals";
import { loadMonthlyGoalsWorkspace } from "@/lib/monthly-goals-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Monthly goals",
};

export default async function MonthlyGoalsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const access = await requireManagementPageAccess();
  assertCanReadMonthlyGoals(access);
  await requireProductCapability(prisma, access.businessId, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);

  const params = await searchParams;
  const workspace = await loadMonthlyGoalsWorkspace(prisma, access, params);

  return (
    <PageContainer>
      <PageHeader
        title="Monthly goals"
        description="OWNER-set monthly targets compared with recorded jobs completed, invoices paid, and revenue received. Targets are not forecasts and not a bank balance. ADMIN may view. MEMBER is denied."
      />
      <MonthlyGoalsWorkspace workspace={workspace} />
    </PageContainer>
  );
}
