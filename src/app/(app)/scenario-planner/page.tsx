import type { Metadata } from "next";
import { OwnerScenarioPlannerWorkspace } from "@/components/owner-scenario-planner/workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { assertCanReadOwnerScenarioPlanner, parseOwnerScenarioAssumptions } from "@/lib/owner-scenario-planner";
import { loadOwnerScenarioPlan } from "@/lib/owner-scenario-planner-data";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Scenario Planner",
};

export default async function OwnerScenarioPlannerPage({
  searchParams,
}: {
  searchParams: Promise<{
    workload?: string;
    materials?: string;
    labor?: string;
    price?: string;
    assumeUnpaid?: string;
  }>;
}) {
  const access = await requireManagementPageAccess();
  assertCanReadOwnerScenarioPlanner(access);
  const params = await searchParams;
  const assumptions = parseOwnerScenarioAssumptions(params);
  const plan = await loadOwnerScenarioPlan(prisma, access, assumptions);

  return (
    <PageContainer>
      <PageHeader
        title="Scenario Planner"
        description="OWNER-only what-if overlay on recorded job profitability, invoice payments, and expenses. Forecasts stay labeled separately from recorded facts, unpaid invoices, and bank balance."
      />
      <OwnerScenarioPlannerWorkspace plan={plan} />
    </PageContainer>
  );
}
