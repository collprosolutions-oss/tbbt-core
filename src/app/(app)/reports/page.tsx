import type { Metadata } from "next";
import { ExportReportButton } from "@/components/reports/export-report-button";
import { ReportsWorkspace } from "@/components/reports/reports-workspace";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { requireManagementPageAccess } from "@/lib/access";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import type { CuratedIconId } from "@/lib/founder-icons";
import { formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { loadReportSource } from "@/lib/reports-data";
import { buildFinancialIntelligence, managementReportCsvRows } from "@/lib/financial-intelligence";
import {
  buildReport,
  parseDatePreset,
  parseReportArea,
  parseReportDate,
  reportCsvRows,
  resolveReportRange,
} from "@/lib/reports";
import { formatDurationClock } from "@/lib/time-cards";
import { addDays, formatISODate } from "@/lib/schedule";

export const metadata: Metadata = {
  title: "Reports",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; range?: string; from?: string; to?: string }>;
}) {
  const access = await requireManagementPageAccess();

  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "reports" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("reports", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const timeZone = resolveBusinessTimeZone(access.workspace.business);
  const area = parseReportArea(params.area);
  const rangePreset = parseDatePreset(params.range);
  const range = resolveReportRange(rangePreset, params.from, params.to, new Date(), timeZone);
  const from = rangePreset === "custom" && parseReportDate(params.from, timeZone) ? params.from! : "";
  const to = rangePreset === "custom" && parseReportDate(params.to, timeZone) ? params.to! : "";

  const source = await loadReportSource(prisma, access.businessId);
  const report = buildReport(source, range);
  const intelligence = buildFinancialIntelligence(source, report);

  const laborHint = report.labor.laborCostIncomplete
    ? "Wage snapshot missing on some approved time"
    : `${formatDurationClock(report.labor.approvedHours)} approved hours`;

  const kpis: Array<{
    label: string;
    value: string;
    sublabel: string;
    defaultIconId: CuratedIconId;
  }> = [
    {
      label: "Paid revenue",
      value: formatMoney(report.paidRevenue.current),
      sublabel:
        report.paidRevenue.changePercent == null
          ? "PAID invoices · paid date"
          : `${report.paidRevenue.changePercent > 0 ? "+" : ""}${report.paidRevenue.changePercent.toFixed(1)}% vs prior period`,
      defaultIconId: "dollar-sign",
    },
    {
      label: "Outstanding",
      value: formatMoney(report.outstanding.current),
      sublabel: `${report.outstanding.count} sent, unpaid`,
      defaultIconId: "receipt",
    },
    {
      label: "Completed jobs",
      value: String(report.completedJobsOpened.current),
      sublabel: "Opened in this period · currently completed",
      defaultIconId: "calendar-check",
    },
    {
      label: "Approved labor",
      value: report.labor.laborCost == null ? "—" : formatMoney(report.labor.laborCost),
      sublabel: laborHint,
      defaultIconId: "clock",
    },
    {
      label: "Customers",
      value: String(report.newCustomers.current),
      sublabel: `${report.customerCount} on file · ${report.repeatCustomers} repeat`,
      defaultIconId: "users",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeaderControls
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportReportButton
              filename={`tbbt-${area}-${formatISODate(new Date(), timeZone)}.csv`}
              {...reportCsvRows(area, report)}
            />
            <ExportReportButton
              filename={`tbbt-management-${formatISODate(new Date(), timeZone)}.csv`}
              {...managementReportCsvRows(intelligence)}
            />
          </div>
        }
      />
      <PageHeader
        title="Reports"
        description={`Business reports for ${access.workspace.business.name}. Figures come from invoices, jobs, approved labor, and recorded expenses in TBBT. Profit & Loss is TBBT-recorded P&L, not full accounting or tax books.`}
      />

      <FounderDesignRoot
        pageKey="reports"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="summary">
          <KpiCardsLayout gridClassName="grid-cols-1 sm:grid-cols-2 xl:grid-cols-5" defaultGapPx={20}>
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                variant="workspace"
                pageKey="reports"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <ReportsWorkspace
          area={area}
          rangePreset={range.start && rangePreset === "custom" ? "custom" : range.preset}
          from={from || (range.start ? formatISODate(range.start, timeZone) : "")}
          to={to || (range.end ? formatISODate(addDays(range.end, -1, timeZone), timeZone) : "")}
          report={report}
          intelligence={intelligence}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}
