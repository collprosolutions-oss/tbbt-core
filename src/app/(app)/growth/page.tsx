import type { Metadata } from "next";
import { GrowthWorkspace } from "@/components/growth/growth-workspace";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { parseGrowthArea } from "@/lib/growth";
import { loadGrowthWorkspace } from "@/lib/growth-data";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { hasProductCapability } from "@/lib/product-entitlements";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = {
  title: "Growth",
};

export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const access = await requireManagementPageAccess();

  const entitled = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.MARKETING_TOOLS,
  );
  const reporting = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.REPORTING_INSIGHTS,
  );
  const params = await searchParams;
  const area = parseGrowthArea(params.area);
  const source = reporting ? await loadGrowthWorkspace(prisma, access.businessId) : null;

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Growth"
        description={`Where leads come from, which ones pay, and what to do next for ${access.workspace.business.name}.`}
      />
      {!entitled || !reporting || !source ? (
        <p className="text-sm text-muted-foreground">
          The current TBBT plan does not include Marketing Tools and Reporting Insights. Existing records are retained.
        </p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Leads" value={String(source.totals.leads)} note="Recorded requests" />
            <Kpi label="Collected" value={formatMoney(source.totals.collected)} note="PAID invoices only" />
            <Kpi label="Recovery queue" value={String(source.totals.recoveryOpen)} note="Deterministic follow-ups" />
            <Kpi
              label="Reactivation"
              value={String(source.totals.reactivationEligible)}
              note="Consent-eligible prior customers"
            />
          </div>
          <GrowthWorkspace area={area} source={source} />
        </>
      )}
    </PageContainer>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
