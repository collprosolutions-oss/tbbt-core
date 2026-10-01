import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { FounderRegion } from "@/components/founder-design/region";
import { FounderRegionIcon } from "@/components/founder-design/region-icon";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { RecordRow } from "@/components/record-row";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DashboardAppointmentAttentionItems } from "@/components/dashboard/appointment-attention-items";
import { OwnerTodayAppointmentAttention } from "@/components/today/owner-today-appointment-attention";
import { OwnerTodayJobCard } from "@/components/today/owner-today-job-card";
import { OwnerPaymentsGoLiveBanner } from "@/components/payments/owner-payments-go-live";
import { DashboardLaunchCard } from "@/components/launch/dashboard-card";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { requireManagementPageAccess } from "@/lib/access";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import {
  DASHBOARD_APPOINTMENT_ATTENTION_SELECT,
  DASHBOARD_APPOINTMENT_ATTENTION_TAKE,
  dashboardAppointmentAttentionCandidateWhere,
  dashboardAppointmentAttentionItems,
} from "@/lib/dashboard-appointment-attention";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { estimateListTotalLabel } from "@/lib/estimate-options";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { CuratedIconId } from "@/lib/founder-icons";
import { NAV_ICONS } from "@/lib/nav-icons";
import { prisma } from "@/lib/prisma";
import { loadLaunchWorkspace } from "@/lib/business-launch-data";
import { dayRange, formatISODate, startOfDay } from "@/lib/schedule";
import { getBusinessPaymentStatus } from "@/lib/payments";
import {
  OWNER_TODAY_APPOINTMENT_TAKE,
  OWNER_TODAY_FIELD_PROBLEM_SELECT,
  OWNER_TODAY_FIELD_PROBLEM_TAKE,
  OWNER_TODAY_JOB_SELECT,
  buildOwnerTodayAppointmentAttention,
  buildOwnerTodayFieldProblemAttention,
  buildOwnerTodayJobs,
  ownerTodayAppointmentCandidateWhere,
  ownerTodayScheduledWhere,
} from "@/lib/owner-today";
import {
  OWNER_DAILY_ADDITIONAL_WORK_SELECT,
  OWNER_DAILY_ATTENTION_TAKE,
  OWNER_DAILY_CALLBACK_SELECT,
  OWNER_DAILY_CHANGE_ORDER_SELECT,
  OWNER_DAILY_GROUP_TITLES,
  OWNER_DAILY_RUNNING_TIME_SELECT,
  buildOwnerDailyAdditionalWorkAttention,
  buildOwnerDailyCallbackAttention,
  buildOwnerDailyChangeOrderAttention,
  buildOwnerDailyMaterialDepositAttention,
  buildOwnerDailyRunningTimeAttention,
  buildOwnerDailyScheduleConflictAttention,
  ownerDailyUnpaidInvoiceWhere,
  ownerDailyUnscheduledApprovedWhere,
} from "@/lib/owner-daily-attention";
import { completedJobBillingAttention } from "@/lib/revenue-integrity";
import { explainPaymentsGoLiveFromStatus } from "@/lib/payments/go-live";
import {
  depositPaidByEstimateIds,
  listPaymentsGroupedByInvoiceId,
  sumInvoiceRemainingDue,
} from "@/lib/project-payments";
import { loadAvailabilitySettings } from "@/lib/availability-data";
import { addZonedCalendarDays, startOfZonedDay } from "@/lib/business-timezone";
import {
  loadCapacityJobs,
  loadSchedulingPolicy,
  loadWorkforceMembers,
} from "@/lib/workforce-data";
import { detectScheduleConflicts } from "@/lib/workforce-conflicts";
import { JOB_CALLBACK_OPEN_STATUSES } from "@/lib/job-callback";
import { listActiveTradeCodes } from "@/lib/business-trades";
import { workspaceTradeLabel } from "@/lib/trade-config";

export const metadata: Metadata = {
  title: "Dashboard",
};

const TODAY_JOBS_TAKE = 5;
const RECENT_TAKE = 5;
const ATTENTION_TAKE = 5;

export default async function DashboardPage() {
  const access = await requireManagementPageAccess();
  const business = access.workspace.business;
  const timeZone = resolveBusinessTimeZone(business);
  const activeTradeCodes = await listActiveTradeCodes(prisma, business.id);
  const tradeName = workspaceTradeLabel(activeTradeCodes);
  const today = startOfDay(new Date(), timeZone);
  const todayRange = dayRange(today, timeZone);
  const todayIso = formatISODate(today, timeZone);

  // Founder Design Mode: platform-level, independent of Membership/role
  // (see src/lib/founder-access.ts) -- never derived from OWNER/ADMIN.
  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "dashboard" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("dashboard", founderOverride?.tokens ?? {});

  const [
    openRequests,
    sentEstimates,
    scheduledJobs,
    inProgressJobs,
    sentOutstandingInvoices,
    sentInvoicesCount,
    unscheduledJobsCount,
    draftEstimatesCount,
    requestsWithoutEstimateCount,
    unpaidInvoicesCount,
    todayJobsCount,
    requestsWithoutEstimate,
    attentionDraftEstimates,
    attentionUnscheduledJobs,
    attentionUnpaidInvoices,
    todayJobs,
    recentCustomers,
    recentJobs,
    recentRequests,
    paymentStatus,
    appointmentAttentionJobs,
    completedJobsForBilling,
  ] = await Promise.all([
    prisma.serviceRequest.count({ where: { ...access.scope, status: "OPEN" } }),
    prisma.estimate.count({ where: { ...access.scope, status: "SENT" } }),
    prisma.job.count({ where: { ...access.scope, status: "SCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "IN_PROGRESS" } }),
    // Outstanding is remaining due on SENT invoices: stored invoice total
    // minus canonical attributed Payments. Never DRAFT or PAID face value,
    // and never a recomputed estimate/catalog price.
    prisma.invoice.findMany({
      where: { ...access.scope, status: "SENT" },
      select: { id: true, status: true, total: true, jobId: true, kind: true },
    }),
    prisma.invoice.count({ where: { ...access.scope, status: "SENT" } }),
    prisma.job.count({
      where: { ...access.scope, ...ownerDailyUnscheduledApprovedWhere() },
    }),
    prisma.estimate.count({ where: { ...access.scope, status: "DRAFT" } }),
    prisma.serviceRequest.count({
      where: { ...access.scope, estimates: { none: {} } },
    }),
    prisma.invoice.count({
      where: { ...access.scope, ...ownerDailyUnpaidInvoiceWhere() },
    }),
    prisma.job.count({
      where: {
        ...access.scope,
        ...ownerTodayScheduledWhere(todayRange),
      },
    }),
    prisma.serviceRequest.findMany({
      where: { ...access.scope, estimates: { none: {} } },
      select: { id: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.estimate.findMany({
      where: { ...access.scope, status: "DRAFT" },
      select: {
        id: true,
        total: true,
        customer: { select: { name: true } },
        options: { select: { id: true } },
        approvedOption: { select: { total: true } },
      },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.job.findMany({
      where: { ...access.scope, ...ownerDailyUnscheduledApprovedWhere() },
      select: { id: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.invoice.findMany({
      where: { ...access.scope, ...ownerDailyUnpaidInvoiceWhere() },
      select: { id: true, status: true, total: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.job.findMany({
      where: {
        ...access.scope,
        ...ownerTodayScheduledWhere(todayRange),
      },
      select: OWNER_TODAY_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
      take: TODAY_JOBS_TAKE,
    }),
    prisma.customer.findMany({
      where: access.scope,
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_TAKE,
    }),
    prisma.job.findMany({
      where: access.scope,
      select: { id: true, status: true, createdAt: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: RECENT_TAKE,
    }),
    prisma.serviceRequest.findMany({
      where: access.scope,
      select: { id: true, createdAt: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: RECENT_TAKE,
    }),
    getBusinessPaymentStatus(prisma, access.businessId),
    prisma.job.findMany({
      where: {
        ...access.scope,
        ...dashboardAppointmentAttentionCandidateWhere(),
      },
      select: DASHBOARD_APPOINTMENT_ATTENTION_SELECT,
      orderBy: { updatedAt: "desc" },
      take: DASHBOARD_APPOINTMENT_ATTENTION_TAKE,
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "COMPLETED" },
      select: {
        id: true,
        customerId: true,
        estimateId: true,
        customer: { select: { name: true } },
        invoices: {
          select: { id: true, status: true, kind: true, createdAt: true, total: true },
        },
        changeOrders: {
          select: { id: true, status: true, total: true, invoiceId: true, approvedAt: true, createdAt: true },
        },
        estimate: { select: { total: true } },
        approvedEstimateOption: { select: { total: true } },
        approvedEstimateVersion: { select: { total: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const conflictRange = {
    start: todayRange.start,
    end: addZonedCalendarDays(startOfZonedDay(today, timeZone), 21, timeZone),
  };
  const [
    additionalWorkRows,
    changeOrderRows,
    callbackRows,
    runningTimeRows,
    approvedDepositEstimates,
    openFieldProblemReports,
    firstAwaitingJobs,
    conflictSettings,
    conflictPolicy,
    conflictMembers,
    conflictJobs,
  ] = await Promise.all([
    prisma.additionalWorkRequest.findMany({
      where: { ...access.scope, status: "OPEN" },
      select: OWNER_DAILY_ADDITIONAL_WORK_SELECT,
      orderBy: { createdAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.changeOrder.findMany({
      where: { ...access.scope, status: { in: ["DRAFT", "SENT"] } },
      select: OWNER_DAILY_CHANGE_ORDER_SELECT,
      orderBy: { updatedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.jobCallback.findMany({
      where: {
        ...access.scope,
        status: { in: [...JOB_CALLBACK_OPEN_STATUSES] },
      },
      select: OWNER_DAILY_CALLBACK_SELECT,
      orderBy: { recordedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.timeEntry.findMany({
      where: {
        ...access.scope,
        status: "RUNNING",
        endedAt: null,
      },
      select: OWNER_DAILY_RUNNING_TIME_SELECT,
      orderBy: { startedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.estimate.findMany({
      where: { ...access.scope, status: "APPROVED" },
      select: {
        id: true,
        businessId: true,
        status: true,
        total: true,
        customer: { select: { name: true } },
        lineItems: { select: { type: true, total: true, description: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.jobProblemReport.findMany({
      where: { businessId: access.businessId, status: "OPEN" },
      select: OWNER_TODAY_FIELD_PROBLEM_SELECT,
      orderBy: { createdAt: "desc" },
      take: OWNER_TODAY_FIELD_PROBLEM_TAKE,
    }),
    prisma.job.findMany({
      where: {
        ...access.scope,
        ...ownerTodayAppointmentCandidateWhere(todayRange.start),
      },
      select: OWNER_TODAY_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
      take: OWNER_TODAY_APPOINTMENT_TAKE,
    }),
    loadAvailabilitySettings(prisma, access.businessId),
    loadSchedulingPolicy(prisma, access.businessId),
    loadWorkforceMembers(prisma, access.businessId),
    loadCapacityJobs(prisma, access.businessId, conflictRange),
  ]);
  const depositPaid = await depositPaidByEstimateIds(
    prisma,
    access.businessId,
    approvedDepositEstimates.map((estimate) => estimate.id),
  );
  const additionalWorkAttention = buildOwnerDailyAdditionalWorkAttention(
    additionalWorkRows,
    access.businessId,
  );
  const changeOrderAttention = buildOwnerDailyChangeOrderAttention(
    changeOrderRows,
    access.businessId,
  );
  const callbackAttention = buildOwnerDailyCallbackAttention(
    callbackRows,
    access.businessId,
  );
  const runningTimeAttention = buildOwnerDailyRunningTimeAttention(
    runningTimeRows,
    access.businessId,
    timeZone,
  );
  const materialDepositAttention = buildOwnerDailyMaterialDepositAttention(
    approvedDepositEstimates,
    depositPaid,
    access.businessId,
  );
  const fieldProblemAttention = buildOwnerTodayFieldProblemAttention(
    openFieldProblemReports,
    { businessId: access.businessId, timeZone },
  );
  const firstAwaitingAttention = buildOwnerTodayAppointmentAttention(
    firstAwaitingJobs,
    { businessId: access.businessId, start: todayRange.start, timeZone },
  ).filter((item) => item.kind === "AWAITING_CUSTOMER");
  const recordedConflicts = detectScheduleConflicts({
    jobs: conflictJobs,
    settings: conflictSettings,
    policy: conflictPolicy,
    members: conflictMembers,
    timeZone,
  });
  const scheduleConflictAttention = buildOwnerDailyScheduleConflictAttention(
    recordedConflicts,
    new Map(
      conflictJobs.map((job) => [
        job.id,
        { id: job.id, businessId: access.businessId, customerName: job.customerName },
      ]),
    ),
    access.businessId,
  );

  const outstandingPayments = await listPaymentsGroupedByInvoiceId(
    prisma,
    access.businessId,
    sentOutstandingInvoices,
  );
  const outstandingTotal = sumInvoiceRemainingDue(
    sentOutstandingInvoices,
    outstandingPayments,
  );
  const paymentsGoLive = explainPaymentsGoLiveFromStatus(paymentStatus);
  const appointmentAttention = dashboardAppointmentAttentionItems(
    appointmentAttentionJobs,
    access.businessId,
  );
  const ownerTodayJobs = buildOwnerTodayJobs(todayJobs, {
    businessId: access.businessId,
    range: todayRange,
    timeZone,
    viewerMembershipId: access.workspace.membership.id,
  });

  const kpis: KpiCardProps[] = [
    {
      label: "Open Requests",
      value: openRequests,
      href: "/requests",
      icon: NAV_ICONS["/requests"],
      defaultIconId: "inbox" as CuratedIconId,
    },
    {
      label: "Estimates Awaiting Approval",
      value: sentEstimates,
      href: "/estimates",
      icon: NAV_ICONS["/estimates"],
      defaultIconId: "file-text" as CuratedIconId,
    },
    {
      label: "Upcoming Jobs",
      value: scheduledJobs,
      href: "/jobs",
      icon: NAV_ICONS["/jobs"],
      defaultIconId: "calendar-clock" as CuratedIconId,
    },
    {
      label: "Jobs In Progress",
      value: inProgressJobs,
      href: "/jobs?view=list",
      icon: NAV_ICONS["/jobs"],
      defaultIconId: "calendar-clock" as CuratedIconId,
    },
    {
      label: "Outstanding Invoices",
      value: formatMoney(outstandingTotal),
      sublabel: `${sentInvoicesCount} sent, unpaid`,
      href: "/invoices",
      icon: NAV_ICONS["/invoices"],
      defaultIconId: "receipt" as CuratedIconId,
    },
  ];

  const unbilledCompletedJobs = completedJobsForBilling.filter((job) => {
    const attention = completedJobBillingAttention({
      jobStatus: "COMPLETED",
      originalApprovedTotal:
        job.approvedEstimateOption?.total ??
        job.approvedEstimateVersion?.total ??
        job.estimate?.total ??
        null,
      invoices: job.invoices,
      changeOrders: job.changeOrders,
    });
    return attention.unbilled;
  });

  const attentionGroups: AttentionGroupData[] = [
    {
      title: "Requests without an estimate",
      count: requestsWithoutEstimateCount,
      items: requestsWithoutEstimate.map((request) => ({
        key: request.id,
        name: request.customer?.name ?? "Customer",
        href: `/requests?selected=${request.id}`,
        action: "Open requests",
      })),
    },
    {
      title: "Draft estimates",
      count: draftEstimatesCount,
      items: attentionDraftEstimates.map((estimate) => ({
        key: estimate.id,
        name: estimate.customer?.name ?? "Customer",
        meta: estimateListTotalLabel(estimate, formatMoney),
        href: `/estimates/${estimate.id}`,
        action: "Open",
      })),
    },
    {
      title: "Unscheduled jobs",
      count: unscheduledJobsCount,
      items: attentionUnscheduledJobs.map((job) => ({
        key: job.id,
        name: job.customer?.name ?? "Customer",
        href: `/jobs/${job.id}`,
        action: "Open",
      })),
    },
    {
      title: "Unpaid invoices",
      count: unpaidInvoicesCount,
      items: attentionUnpaidInvoices.map((invoice) => ({
        key: invoice.id,
        name: invoice.customer?.name ?? "Customer",
        meta: formatMoney(invoice.total),
        status: invoice.status,
        href: `/invoices/${invoice.id}`,
        action: "Open",
      })),
    },
    {
      title: "Completed jobs with unbilled work",
      count: unbilledCompletedJobs.length,
      items: unbilledCompletedJobs.slice(0, ATTENTION_TAKE).map((job) => ({
        key: job.id,
        name: job.customer?.name ?? "Customer",
        href: `/jobs/${job.id}`,
        action: "Open",
      })),
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.additionalWork,
      count: additionalWorkAttention.length,
      items: additionalWorkAttention,
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.changeOrders,
      count: changeOrderAttention.length,
      items: changeOrderAttention,
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.callbacks,
      count: callbackAttention.length,
      items: callbackAttention,
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.runningTime,
      count: runningTimeAttention.length,
      items: runningTimeAttention,
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.materialDeposits,
      count: materialDepositAttention.length,
      items: materialDepositAttention,
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.scheduleConflicts,
      count: scheduleConflictAttention.length,
      items: scheduleConflictAttention,
    },
    {
      title: OWNER_DAILY_GROUP_TITLES.fieldProblems,
      count: fieldProblemAttention.length,
      items: fieldProblemAttention.map((item) => ({
        key: item.reportId,
        name: item.customerName,
        meta: item.description,
        href: item.href,
        action: "Open",
      })),
    },
  ].filter((group) => group.count > 0);

  const recentGroups: AttentionGroupData[] = [
    {
      title: "Recent customers",
      count: recentCustomers.length,
      items: recentCustomers.map((customer) => ({
        key: customer.id,
        name: customer.name,
        meta: formatDate(customer.createdAt),
        href: `/customers/${customer.id}`,
        action: "Open",
      })),
    },
    {
      title: "Recent jobs",
      count: recentJobs.length,
      items: recentJobs.map((job) => ({
        key: job.id,
        name: job.customer?.name ?? "Customer",
        meta: formatDateTime(job.createdAt),
        status: job.status,
        href: `/jobs/${job.id}`,
        action: "Open",
      })),
    },
    {
      title: "Recent requests",
      count: recentRequests.length,
      items: recentRequests.map((request) => ({
        key: request.id,
        name: request.customer?.name ?? "Customer",
        meta: formatDateTime(request.createdAt),
        href: `/requests?selected=${request.id}`,
        action: "Open requests",
      })),
    },
  ].filter((group) => group.count > 0);

  const launchWorkspace =
    access.workspace.role === "OWNER"
      ? await loadLaunchWorkspace(prisma, access.businessId)
      : null;

  const attentionTotal =
    appointmentAttention.length +
    firstAwaitingAttention.length +
    attentionGroups.reduce((sum, group) => sum + group.count, 0);

  return (
    <PageContainer width="xl">
      {/*
       * Primary page action, per the approved header architecture (TBBT
       * logo -> business switcher -> page title -> primary page action ->
       * page search -> ... -> theme -> account): registers into the
       * shared AppShell top header instead of living in this page's own
       * content. Dashboard has no real "search the dashboard" capability
       * to wire up, so that slot is intentionally left unset here rather
       * than inventing one -- see PageHeaderControls' own docs.
       */}
      <PageHeaderControls
        actions={
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/requests/log-lead">Log lead</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/estimates/new">Create Estimate</Link>
            </Button>
          </div>
        }
      />
      <PageHeader
        title="Dashboard"
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{business.name}</span>
            <span className="text-muted-foreground/40">·</span>
            <span>{tradeName}</span>
            <span className="text-muted-foreground/40">·</span>
            <span>
              {todayJobsCount === 0
                ? "No jobs scheduled today"
                : `${todayJobsCount} job${todayJobsCount === 1 ? "" : "s"} scheduled today`}
            </span>
          </div>
        }
      />

      {launchWorkspace &&
      !(launchWorkspace.progress.hasRecordedProgress && launchWorkspace.progress.status === "COMPLETED") ? (
        <div className="mb-6">
          <DashboardLaunchCard progress={launchWorkspace.progress} />
        </div>
      ) : null}

      {paymentsGoLive.showOwnerBanner ? (
        <div className="mb-6">
          <OwnerPaymentsGoLiveBanner explanation={paymentsGoLive} />
        </div>
      ) : null}

      <FounderDesignRoot
        pageKey="dashboard"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
      <FounderRegion id="kpi">
      <KpiCardsLayout gridClassName="sm:grid-cols-2 lg:grid-cols-5" defaultGapPx={12}>
        {kpis.map((kpi, index) => (
          <TunableKpiCard
            key={kpi.label}
            index={index}
            label={kpi.label}
            value={kpi.value}
            sublabel={kpi.sublabel}
            href={kpi.href}
            defaultIconId={kpi.defaultIconId}
            variant="dashboard"
            pageKey="dashboard"
          />
        ))}
      </KpiCardsLayout>
      </FounderRegion>

      <div className="grid gap-6 lg:grid-cols-3">
        <FounderRegion id="attention" className="lg:col-span-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>
              {attentionTotal === 0
                ? "Nothing waiting right now."
                : `${attentionTotal} item${attentionTotal === 1 ? "" : "s"} waiting on the next step.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {attentionTotal === 0 ? (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>Nothing waiting right now.</p>
                {recentGroups.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-3">
                    <p className="font-medium text-foreground">First steps for a new workspace</p>
                    <ol className="mt-2 list-decimal space-y-1 pl-5">
                      <li>Confirm services on Services, then open your public site.</li>
                      <li>
                        Share{" "}
                        <Link className="underline" href={`/hire/${business.slug}`}>
                          /hire/{business.slug}
                        </Link>{" "}
                        or the request form at{" "}
                        <Link className="underline" href={`/r/${business.slug}`}>
                          /r/{business.slug}
                        </Link>
                        .
                      </li>
                      <li>Create an estimate from a request, then send it for customer approval.</li>
                    </ol>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-5">
                <DashboardAppointmentAttentionItems items={appointmentAttention} />
                <OwnerTodayAppointmentAttention items={firstAwaitingAttention} />
                {attentionGroups.length > 0 ? (
                  <div className="grid gap-5 sm:grid-cols-2">
                    {attentionGroups.map((group) => (
                      <AttentionGroup key={group.title} group={group} />
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
        </FounderRegion>

        <div className="space-y-6">
          <FounderRegion id="today">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FounderRegionIcon regionId="today" defaultIcon="calendar-clock" className="size-4 text-muted-foreground" />
                Today
              </CardTitle>
              <CardDescription>Scheduled work for {formatDate(today, timeZone)}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {ownerTodayJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing scheduled today.</p>
              ) : (
                ownerTodayJobs.map((job) => (
                  <OwnerTodayJobCard key={job.jobId} job={job} />
                ))
              )}
              {todayJobsCount > todayJobs.length ? (
                <p className="pt-1 text-xs text-muted-foreground">
                  +{todayJobsCount - todayJobs.length} more today.
                </p>
              ) : null}
              <Button asChild size="sm" className="w-full">
                <Link href="/today">Open Today</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="w-full">
                <Link href={`/jobs?view=day&date=${todayIso}`}>View full schedule</Link>
              </Button>
            </CardContent>
          </Card>
          </FounderRegion>

          <FounderRegion id="actions">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FounderRegionIcon regionId="actions" defaultIcon="sparkles" className="size-4 text-muted-foreground" />
                Quick actions
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button asChild size="sm" className="justify-start">
                <Link href="/requests/log-lead">Log lead</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="justify-start">
                <Link href="/estimates/new">Create Estimate</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="justify-start">
                <Link href="/requests">Review Requests</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="justify-start">
                <Link href="/jobs">Open Schedule</Link>
              </Button>
            </CardContent>
          </Card>
          </FounderRegion>
        </div>
      </div>

      <FounderRegion id="recent">
      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            The most recently added customers, jobs, and requests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recentGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="grid gap-5 lg:grid-cols-3">
              {recentGroups.map((group) => (
                <AttentionGroup key={group.title} group={group} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </FounderRegion>
      </FounderDesignRoot>
    </PageContainer>
  );
}

type KpiCardProps = {
  label: string;
  value: ReactNode;
  sublabel?: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  defaultIconId: CuratedIconId;
};

type AttentionItem = {
  key: string;
  name: string;
  meta?: string;
  status?: string;
  href: string;
  action: string;
};

type AttentionGroupData = {
  title: string;
  count: number;
  items: AttentionItem[];
};

function AttentionGroup({ group }: { group: AttentionGroupData }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">
        {group.title}
        {group.count > group.items.length ? (
          <span className="ml-1.5 text-muted-foreground">({group.count})</span>
        ) : null}
      </p>
      <div className="space-y-2">
        {group.items.map((item) => (
          <RecordRow
            key={item.key}
            title={<span className="truncate">{item.name}</span>}
            meta={
              item.status || item.meta ? (
                <>
                  {item.status ? <StatusBadge status={item.status} /> : null}
                  {item.meta ? <span>{item.meta}</span> : null}
                </>
              ) : null
            }
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={item.href}>{item.action}</Link>
              </Button>
            }
          />
        ))}
      </div>
    </div>
  );
}
