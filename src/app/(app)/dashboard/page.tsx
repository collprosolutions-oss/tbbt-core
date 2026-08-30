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
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatDate, formatDateTime, formatMoney, formatTime } from "@/lib/format";
import type { CuratedIconId } from "@/lib/founder-icons";
import { NAV_ICONS } from "@/lib/nav-icons";
import { prisma } from "@/lib/prisma";
import { dayRange, formatISODate, startOfDay } from "@/lib/schedule";
import { getTrade } from "@/lib/trades";

export const metadata: Metadata = {
  title: "Dashboard",
};

const TODAY_JOBS_TAKE = 5;
const RECENT_TAKE = 5;
const ATTENTION_TAKE = 5;

export default async function DashboardPage() {
  const access = await requireManagementPageAccess();
  const business = access.workspace.business;
  const trade = getTrade(business.tradeCode);
  const today = startOfDay(new Date());
  const todayRange = dayRange(today);
  const todayIso = formatISODate(today);

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
    outstandingAgg,
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
  ] = await Promise.all([
    prisma.serviceRequest.count({ where: { ...access.scope, status: "OPEN" } }),
    prisma.estimate.count({ where: { ...access.scope, status: "SENT" } }),
    prisma.job.count({ where: { ...access.scope, status: "SCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "IN_PROGRESS" } }),
    // Outstanding uses the invoice's own stored total, never a recomputed
    // estimate/catalog price, and only SENT invoices (never DRAFT or PAID).
    prisma.invoice.aggregate({
      where: { ...access.scope, status: "SENT" },
      _sum: { total: true },
    }),
    prisma.invoice.count({ where: { ...access.scope, status: "SENT" } }),
    prisma.job.count({ where: { ...access.scope, status: "UNSCHEDULED" } }),
    prisma.estimate.count({ where: { ...access.scope, status: "DRAFT" } }),
    prisma.serviceRequest.count({
      where: { ...access.scope, estimates: { none: {} } },
    }),
    prisma.invoice.count({ where: { ...access.scope, status: { not: "PAID" } } }),
    prisma.job.count({
      where: {
        ...access.scope,
        scheduledAt: { gte: todayRange.start, lt: todayRange.end },
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
      select: { id: true, total: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "UNSCHEDULED" },
      select: { id: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.invoice.findMany({
      where: { ...access.scope, status: { not: "PAID" } },
      select: { id: true, status: true, total: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: ATTENTION_TAKE,
    }),
    prisma.job.findMany({
      where: {
        ...access.scope,
        scheduledAt: { gte: todayRange.start, lt: todayRange.end },
      },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        customer: { select: { name: true } },
      },
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
  ]);

  const outstandingTotal = outstandingAgg._sum.total ?? 0;

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

  const attentionGroups: AttentionGroupData[] = [
    {
      title: "Requests without an estimate",
      count: requestsWithoutEstimateCount,
      items: requestsWithoutEstimate.map((request) => ({
        key: request.id,
        name: request.customer?.name ?? "Customer",
        href: "/requests",
        action: "Open requests",
      })),
    },
    {
      title: "Draft estimates",
      count: draftEstimatesCount,
      items: attentionDraftEstimates.map((estimate) => ({
        key: estimate.id,
        name: estimate.customer?.name ?? "Customer",
        meta: formatMoney(estimate.total),
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
        href: "/requests",
        action: "Open requests",
      })),
    },
  ].filter((group) => group.count > 0);

  const attentionTotal = attentionGroups.reduce((sum, group) => sum + group.count, 0);

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
          <Button asChild size="sm">
            <Link href="/estimates/new">Create Estimate</Link>
          </Button>
        }
      />
      <PageHeader
        title="Dashboard"
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{business.name}</span>
            <span className="text-muted-foreground/40">·</span>
            <span>{trade?.name ?? "Handyman"}</span>
            <span className="text-muted-foreground/40">·</span>
            <span>
              {todayJobsCount === 0
                ? "No jobs scheduled today"
                : `${todayJobsCount} job${todayJobsCount === 1 ? "" : "s"} scheduled today`}
            </span>
          </div>
        }
      />

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
            icon={kpi.icon}
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
            {attentionGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing waiting right now.</p>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2">
                {attentionGroups.map((group) => (
                  <AttentionGroup key={group.title} group={group} />
                ))}
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
              <CardDescription>Scheduled work for {formatDate(today)}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {todayJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing scheduled today.</p>
              ) : (
                todayJobs.map((job) => (
                  <Link
                    key={job.id}
                    href={`/jobs/${job.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/40 p-2.5 text-sm transition-colors hover:bg-accent/40"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {job.customer?.name ?? "Customer"}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                      {job.scheduledAt ? (
                        <span className="tabular-nums">{formatTime(job.scheduledAt)}</span>
                      ) : null}
                      <StatusBadge status={job.status} />
                    </span>
                  </Link>
                ))
              )}
              {todayJobsCount > todayJobs.length ? (
                <p className="pt-1 text-xs text-muted-foreground">
                  +{todayJobsCount - todayJobs.length} more today.
                </p>
              ) : null}
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
