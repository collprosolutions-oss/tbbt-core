import type { Metadata } from "next";
import { PayrollWorkspace } from "@/components/payroll/payroll-workspace";
import type { PayrollKpi, PayrollReviewItem, PayrollWorkspaceData } from "@/components/payroll/types";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { roleHasCapability, CAPABILITIES } from "@/lib/authorization";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import {
  PAYROLL_EXCEPTION_LABELS,
  PAYROLL_STATUS_LABELS,
  defaultPayPeriod,
  isEditablePayrollStatus,
  isLockedPayrollStatus,
  parsePayPeriodDates,
  type PayrollRunStatus,
} from "@/lib/payroll";
import { payrollItemExceptions, refreshPayrollRunIfUnlocked } from "@/lib/payroll-ops";
import { prisma } from "@/lib/prisma";
import { addDays, formatISODate } from "@/lib/schedule";
import { formatDurationClock } from "@/lib/time-cards";

export const metadata: Metadata = {
  title: "Payroll",
};

function asNumber(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null;
  return Number(value.toString());
}

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; item?: string; start?: string; end?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "payroll" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("payroll", founderOverride?.tokens ?? {});

  const parsedPeriod = params.start && params.end ? parsePayPeriodDates(params.start, params.end) : null;
  const fallbackPeriod = defaultPayPeriod();
  const requestedPeriod =
    parsedPeriod && !("error" in parsedPeriod) ? parsedPeriod : fallbackPeriod;

  const [runs, memberships, approvedWeeks, openWeeks] = await Promise.all([
    prisma.payrollRun.findMany({
      where: access.scope,
      include: { items: { include: { timesheetWeek: true } } },
      orderBy: { payPeriodStart: "desc" },
    }),
    prisma.membership.findMany({
      where: access.scope,
      include: { user: { select: { name: true } } },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    }),
    prisma.timesheetWeek.findMany({
      where: {
        ...access.scope,
        status: "APPROVED",
        weekStartedAt: { gte: requestedPeriod.start, lt: requestedPeriod.end },
      },
      include: { membership: { include: { user: { select: { name: true } } } } },
    }),
    prisma.timesheetWeek.findMany({
      where: {
        ...access.scope,
        status: { not: "APPROVED" },
        weekStartedAt: { gte: requestedPeriod.start, lt: requestedPeriod.end },
      },
      include: { membership: { include: { user: { select: { name: true } } } } },
    }),
  ]);

  let selected = params.run ? runs.find((run) => run.id === params.run) ?? null : null;
  if (!selected) {
    selected =
      runs.find(
        (run) =>
          run.status !== "CANCELLED" &&
          run.payPeriodStart.getTime() === requestedPeriod.start.getTime() &&
          run.payPeriodEnd.getTime() === requestedPeriod.end.getTime(),
      ) ??
      runs.find((run) => run.status !== "CANCELLED" && !isLockedPayrollStatus(run.status)) ??
      null;
  }

  if (selected && isEditablePayrollStatus(selected.status)) {
    selected = await refreshPayrollRunIfUnlocked(prisma, access, selected.id);
  }

  const role = access.workspace.role;
  const isOwner = role === "OWNER";
  const canAuthorize = roleHasCapability(role, CAPABILITIES.AUTHORIZE_PAYROLL);
  const periodStart = selected?.payPeriodStart ?? requestedPeriod.start;
  const periodEnd = selected?.payPeriodEnd ?? requestedPeriod.end;
  const periodEndInclusive = addDays(periodEnd, -1);

  const finalizedWeekIds = new Set(
    runs
      .filter((run) => run.status === "AUTHORIZED" || run.status === "PROCESSED")
      .flatMap((run) => run.items.map((item) => item.timesheetWeekId)),
  );
  const includedWeekIds = new Set(selected?.items.map((item) => item.timesheetWeekId) ?? []);
  const membershipById = new Map(memberships.map((membership) => [membership.id, membership]));

  const items: PayrollReviewItem[] = (selected?.items ?? []).map((item) => {
    const membership = membershipById.get(item.membershipId);
    const exceptions = payrollItemExceptions(item.exceptions);
    if (
      selected &&
      isLockedPayrollStatus(selected.status) &&
      item.timesheetWeek?.status &&
      item.timesheetWeek.status !== "APPROVED" &&
      !exceptions.includes("TIMESHEET_REOPENED_AFTER_AUTHORIZATION")
    ) {
      exceptions.push("TIMESHEET_REOPENED_AFTER_AUTHORIZATION");
    }
    const wage = asNumber(item.approvedHourlyWage);
    const gross = asNumber(item.grossLaborAmount);
    const hours = asNumber(item.approvedHours) ?? 0;
    return {
      id: item.id,
      membershipId: item.membershipId,
      timesheetWeekId: item.timesheetWeekId,
      workerName: membership?.user.name ?? "Worker",
      workerRole: membership?.role ?? "MEMBER",
      workerActive: membership?.active ?? false,
      weekStartedAt: formatISODate(item.weekStartedAt),
      weekLabel: formatDate(item.weekStartedAt),
      approvedHours: hours,
      approvedHoursLabel: formatDurationClock(hours),
      regularHours: asNumber(item.regularHours) ?? 0,
      regularHoursLabel: formatDurationClock(asNumber(item.regularHours) ?? 0),
      overtimeHours: asNumber(item.overtimeHours) ?? 0,
      overtimeHoursLabel: formatDurationClock(asNumber(item.overtimeHours) ?? 0),
      wageSnapshot: wage,
      wageSnapshotLabel: wage != null ? `${formatMoney(wage)} / hr` : "No wage snapshot",
      grossLaborAmount: gross,
      grossLabel: gross != null ? formatMoney(gross) : "—",
      timesheetStatus: item.timesheetWeek?.status ?? "APPROVED",
      timesheetStatusLabel: (item.timesheetWeek?.status ?? "APPROVED") === "APPROVED" ? "Approved" : "Open",
      readiness: item.readiness,
      exceptions,
      exceptionLabels: exceptions.map((code) => PAYROLL_EXCEPTION_LABELS[code]),
      canRemove: Boolean(selected && isEditablePayrollStatus(selected.status)),
      timesheetHref: `/time-cards?view=timesheets&week=${formatISODate(item.weekStartedAt)}&worker=${item.membershipId}`,
    };
  });

  const attention: PayrollWorkspaceData["attention"] = [];
  for (const item of items) {
    for (const label of item.exceptionLabels) {
      attention.push({
        key: `${item.id}:${label}`,
        label: item.workerName,
        detail: label,
      });
    }
  }
  for (const week of openWeeks) {
    if (includedWeekIds.has(week.id)) continue;
    attention.push({
      key: `open:${week.id}`,
      label: week.membership.user.name,
      detail: week.status === "OPEN" ? "Timesheet reopened / not approved" : "Timesheet not approved",
    });
  }
  const approvedMembershipIds = new Set(approvedWeeks.map((week) => week.membershipId));
  for (const membership of memberships) {
    if (!membership.active) continue;
    if (approvedMembershipIds.has(membership.id)) continue;
    if (openWeeks.some((week) => week.membershipId === membership.id)) continue;
    attention.push({
      key: `missing:${membership.id}`,
      label: membership.user.name,
      detail: "Missing approved timesheet for this period",
    });
  }

  const availableWeeks = approvedWeeks
    .filter((week) => !includedWeekIds.has(week.id) && !finalizedWeekIds.has(week.id))
    .map((week) => ({
      timesheetWeekId: week.id,
      membershipId: week.membershipId,
      workerName: week.membership.user.name,
      weekLabel: formatDate(week.weekStartedAt),
      hoursLabel: formatDurationClock(asNumber(week.approvedHours) ?? 0),
    }));

  const liveHours = items.reduce((sum, item) => sum + item.approvedHours, 0);
  const liveGross = items.every((item) => item.grossLaborAmount == null)
    ? null
    : items.reduce((sum, item) => sum + (item.grossLaborAmount ?? 0), 0);
  const historyHours = selected && isLockedPayrollStatus(selected.status)
    ? asNumber(selected.authorizedApprovedHours) ?? liveHours
    : liveHours;
  const historyGross = selected && isLockedPayrollStatus(selected.status)
    ? asNumber(selected.authorizedGrossLaborAmount) ?? liveGross
    : liveGross;

  const status = (selected?.status ?? "DRAFT") as PayrollRunStatus;
  const workersReady = items.filter((item) => item.readiness === "READY").length;
  const workspace: PayrollWorkspaceData = {
    runId: selected?.id ?? null,
    status,
    statusLabel: PAYROLL_STATUS_LABELS[status],
    periodStart: formatISODate(periodStart),
    periodEndInclusive: formatISODate(periodEndInclusive),
    periodLabel: `${formatDate(periodStart)} – ${formatDate(periodEndInclusive)}`,
    editable: selected ? isEditablePayrollStatus(selected.status) : true,
    locked: selected ? isLockedPayrollStatus(selected.status) : false,
    canReview: selected?.status === "READY_FOR_REVIEW",
    canAuthorize: Boolean(canAuthorize && selected?.status === "REVIEWED"),
    canReopen: Boolean(
      selected &&
        (selected.status === "REVIEWED" || (selected.status === "AUTHORIZED" && canAuthorize)),
    ),
    canCancel: Boolean(selected && selected.status !== "CANCELLED" && selected.status !== "PROCESSED"),
    canMarkProcessed: Boolean(canAuthorize && selected?.status === "AUTHORIZED"),
    isOwner,
    workersReady,
    needsAttentionCount: attention.length,
    estimatedGrossLabel: historyGross != null ? formatMoney(historyGross) : "—",
    approvedHoursTotal: historyHours,
    itemCount: items.length,
    items,
    attention,
    availableWeeks,
    history: runs.map((run) => {
      const hours =
        asNumber(run.authorizedApprovedHours) ??
        run.items.reduce((sum, item) => sum + (asNumber(item.approvedHours) ?? 0), 0);
      const gross =
        asNumber(run.authorizedGrossLaborAmount) ??
        (run.items.some((item) => item.grossLaborAmount != null)
          ? run.items.reduce((sum, item) => sum + (asNumber(item.grossLaborAmount) ?? 0), 0)
          : null);
      return {
        id: run.id,
        periodLabel: `${formatDate(run.payPeriodStart)} – ${formatDate(addDays(run.payPeriodEnd, -1))}`,
        status: run.status,
        statusLabel: PAYROLL_STATUS_LABELS[run.status as PayrollRunStatus] ?? run.status,
        workerCount: run.authorizedWorkerCount ?? run.items.length,
        approvedHoursLabel: formatDurationClock(hours),
        grossLabel: gross != null ? formatMoney(gross) : "—",
        authorizedAtLabel: run.authorizedAt ? formatDateTime(run.authorizedAt) : null,
        processedAtLabel: run.processedAt ? formatDateTime(run.processedAt) : null,
      };
    }),
    fundingLabel: "Funding verification not connected",
    providerLabel: "Not connected",
    processedSourceLabel:
      selected?.processedSource === "MANUAL_EXTERNAL" ? "Processed externally / recorded manually" : null,
    providerReference: selected?.providerReference ?? null,
    authorizedAtLabel: selected?.authorizedAt ? formatDateTime(selected.authorizedAt) : null,
    processedAtLabel: selected?.processedAt ? formatDateTime(selected.processedAt) : null,
    notes: selected?.notes ?? null,
  };

  const kpis: PayrollKpi[] = [
    {
      label: "Current Pay Period",
      value: workspace.periodLabel,
      sublabel: workspace.statusLabel,
      defaultIconId: "calendar-days",
    },
    {
      label: "Workers Ready",
      value: String(workspace.workersReady),
      sublabel: `${workspace.itemCount} included`,
      defaultIconId: "check-circle",
    },
    {
      label: "Needs Attention",
      value: String(workspace.needsAttentionCount),
      sublabel: workspace.needsAttentionCount === 0 ? "No blocking issues" : "Review before authorize",
      defaultIconId: "alert-triangle",
    },
    {
      label: "Estimated Gross Payroll",
      value: workspace.estimatedGrossLabel,
      sublabel: `${workspace.approvedHoursTotal.toFixed(1)} approved hours · labor cost`,
      defaultIconId: "circle-dollar",
    },
  ];

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Payroll"
        description="Review approved time cards, check readiness, and authorize a payroll run. TBBT does not move money or calculate taxes."
      />

      <FounderDesignRoot
        pageKey="payroll"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="kpi">
          <KpiCardsLayout gridClassName="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" defaultGapPx={20}>
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                variant="workspace"
                pageKey="payroll"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <PayrollWorkspace
          workspace={workspace}
          selectedItemId={params.item ?? workspace.items[0]?.id ?? null}
        />
      </FounderDesignRoot>
    </PageContainer>
  );
}
