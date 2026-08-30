import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import {
  Briefcase,
  CalendarCheck,
  DollarSign,
  FileText,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import { AreaFilterSelect } from "@/components/customers/area-filter-select";
import { ExportCustomersButton, type ExportCustomerRow } from "@/components/customers/export-customers-button";
import { NewCustomerForm } from "@/components/customers/new-customer-form";
import { PageSizeSelect } from "@/components/customers/page-size-select";
import { EmptyState } from "@/components/empty-state";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { FounderRegion } from "@/components/founder-design/region";
import { FounderRegionIcon } from "@/components/founder-design/region-icon";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatDate, formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Customers",
};

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const RECENT_ACTIVITY_TAKE = 4;
const TOP_SERVICES_TAKE = 4;

/**
 * The customer's own most-recently-updated linked record (request,
 * estimate, job, or invoice) and its REAL status -- shown as the row's
 * "Status" cell instead of a fabricated customer-status field the
 * Customer model does not have (it only has name/email/phone). Every
 * label here is a real Prisma status string; the caption is just a
 * human-readable description of which record it belongs to.
 */
const STATUS_CAPTIONS: Record<string, Record<string, string>> = {
  request: { OPEN: "New request", CONVERTED: "Request converted" },
  estimate: { DRAFT: "Estimate draft", SENT: "Estimate sent", APPROVED: "Estimate approved" },
  job: {
    UNSCHEDULED: "Job unscheduled",
    SCHEDULED: "Job scheduled",
    IN_PROGRESS: "Job in progress",
    COMPLETED: "Job completed",
  },
  invoice: { DRAFT: "Invoice draft", SENT: "Invoice sent", PAID: "Invoice paid" },
};

function monthRangeUTC(now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; area?: string; page?: string; pageSize?: string }>;
}) {
  const access = await requireManagementPageAccess();

  // Founder Design Mode: platform-level, independent of Membership/role
  // (see src/lib/founder-access.ts) -- never derived from OWNER/ADMIN.
  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "customers" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("customers", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const area = params.area && params.area !== "all" ? params.area : undefined;
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize))
    ? Number(params.pageSize)
    : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(params.page) || 1);

  const searchWhere = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
          { phone: { contains: q, mode: "insensitive" as const } },
          { properties: { some: { addressLine1: { contains: q, mode: "insensitive" as const } } } },
        ],
      }
    : {};
  const areaWhere = area ? { properties: { some: { city: area } } } : {};
  const where = { ...access.scope, ...searchWhere, ...areaWhere };

  const now = new Date();
  const { start: monthStart, end: monthEnd } = monthRangeUTC(now);

  const [
    totalCustomersCount,
    matchedCount,
    customersRaw,
    areaRows,
    jobsThisMonthCount,
    revenueThisMonthAgg,
    avgJobValueAgg,
    recentNewCustomers,
    recentSentEstimates,
    recentCompletedJobs,
    recentPayments,
    completedJobsThisMonth,
  ] = await Promise.all([
    prisma.customer.count({ where: access.scope }),
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      include: {
        properties: {
          select: { addressLine1: true, city: true, region: true, postalCode: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
        invoices: { select: { id: true, status: true, total: true, paidAt: true, updatedAt: true } },
        serviceRequests: { select: { id: true, status: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
        estimates: { select: { id: true, status: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
        jobs: { select: { id: true, status: true, updatedAt: true }, orderBy: { updatedAt: "desc" }, take: 1 },
        _count: { select: { jobs: true } },
      },
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.property.findMany({
      where: { ...access.scope, city: { not: null } },
      select: { city: true },
      distinct: ["city"],
      orderBy: { city: "asc" },
    }),
    prisma.job.count({
      where: { ...access.scope, scheduledAt: { gte: monthStart, lt: monthEnd } },
    }),
    prisma.invoice.aggregate({
      where: { ...access.scope, paidAt: { gte: monthStart, lt: monthEnd } },
      _sum: { total: true },
    }),
    prisma.invoice.aggregate({
      where: { ...access.scope, paidAt: { not: null } },
      _avg: { total: true },
    }),
    prisma.customer.findMany({
      where: access.scope,
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_ACTIVITY_TAKE,
    }),
    prisma.estimate.findMany({
      where: { ...access.scope, status: { in: ["SENT", "APPROVED"] } },
      select: { id: true, status: true, updatedAt: true, customer: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: RECENT_ACTIVITY_TAKE,
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "COMPLETED" },
      select: { id: true, updatedAt: true, customer: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: RECENT_ACTIVITY_TAKE,
    }),
    prisma.invoice.findMany({
      where: { ...access.scope, paidAt: { not: null } },
      select: { id: true, paidAt: true, total: true, customer: { select: { name: true } } },
      orderBy: { paidAt: "desc" },
      take: RECENT_ACTIVITY_TAKE,
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "COMPLETED", updatedAt: { gte: monthStart, lt: monthEnd } },
      select: {
        id: true,
        estimate: {
          select: {
            lineItems: {
              where: { serviceCatalogItemId: { not: null } },
              select: { total: true, serviceCatalogItem: { select: { id: true, name: true } } },
            },
          },
        },
      },
    }),
  ]);

  const areaOptions = areaRows.map((row) => row.city).filter((city): city is string => Boolean(city));

  const customers = customersRaw.map((customer) => {
    const totalSpent = customer.invoices
      .filter((invoice) => invoice.paidAt)
      .reduce((sum, invoice) => sum + Number(invoice.total), 0);
    const balance = customer.invoices
      .filter((invoice) => invoice.status === "SENT")
      .reduce((sum, invoice) => sum + Number(invoice.total), 0);

    const latestInvoice = customer.invoices.reduce<(typeof customer.invoices)[number] | null>(
      (latest, invoice) => (!latest || invoice.updatedAt > latest.updatedAt ? invoice : latest),
      null,
    );

    type StatusCandidate = {
      type: "request" | "estimate" | "job" | "invoice";
      status: string;
      updatedAt: Date;
    };
    const candidates: StatusCandidate[] = [
      customer.serviceRequests[0] &&
        { type: "request" as const, status: customer.serviceRequests[0].status, updatedAt: customer.serviceRequests[0].updatedAt },
      customer.estimates[0] &&
        { type: "estimate" as const, status: customer.estimates[0].status, updatedAt: customer.estimates[0].updatedAt },
      customer.jobs[0] &&
        { type: "job" as const, status: customer.jobs[0].status, updatedAt: customer.jobs[0].updatedAt },
      latestInvoice &&
        { type: "invoice" as const, status: latestInvoice.status, updatedAt: latestInvoice.updatedAt },
    ].filter((candidate): candidate is StatusCandidate => Boolean(candidate));
    const latestRecord = candidates.reduce<StatusCandidate | null>((latest, candidate) => {
      if (!latest || candidate.updatedAt > latest.updatedAt) return candidate;
      return latest;
    }, null);

    const property = customer.properties[0] ?? null;
    const cityRegion = property ? [property.city, property.region].filter(Boolean).join(", ") : null;

    return {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      locationPrimary: cityRegion || property?.addressLine1 || null,
      locationSecondary: property?.postalCode ?? null,
      jobs: customer._count.jobs,
      totalSpent,
      balance,
      lastActivity: [
        customer.updatedAt,
        customer.serviceRequests[0]?.updatedAt,
        customer.estimates[0]?.updatedAt,
        customer.jobs[0]?.updatedAt,
        latestInvoice?.updatedAt,
      ].reduce<Date>((latest, date) => (date && date > latest ? date : latest), customer.updatedAt),
      statusType: latestRecord?.type ?? null,
      statusValue: latestRecord?.status ?? null,
      statusCaption: latestRecord ? STATUS_CAPTIONS[latestRecord.type]?.[latestRecord.status] ?? null : null,
    };
  });

  const exportRows: ExportCustomerRow[] = customers.map((customer) => ({
    name: customer.name,
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    location: [customer.locationPrimary, customer.locationSecondary].filter(Boolean).join(" "),
    jobs: customer.jobs,
    totalSpentLabel: formatMoney(customer.totalSpent),
    balanceLabel: formatMoney(customer.balance),
    lastActivityLabel: formatDate(customer.lastActivity),
  }));

  const avgJobValue = avgJobValueAgg._avg.total ?? 0;
  const revenueThisMonth = revenueThisMonthAgg._sum.total ?? 0;

  const overviewKpis: OverviewKpiProps[] = [
    { label: "Customers", value: totalCustomersCount, icon: Users, defaultIconId: "users" as const, accent: "blue" },
    { label: "Jobs This Month", value: jobsThisMonthCount, icon: Briefcase, defaultIconId: "briefcase" as const, accent: "purple" },
    {
      label: "Revenue This Month",
      value: formatMoney(revenueThisMonth),
      sublabel: "Paid invoices this month",
      icon: DollarSign,
      defaultIconId: "dollar-sign" as const,
      accent: "orange",
    },
    {
      label: "Avg Job Value",
      value: formatMoney(avgJobValue),
      sublabel: "Per paid invoice",
      icon: TrendingUp,
      defaultIconId: "trending-up" as const,
      accent: "teal",
    },
  ];

  type ActivityItem = { key: string; icon: ComponentType<{ className?: string }>; accent: OverviewAccent; title: string; subtitle: string; href: string; at: Date };
  const activity: ActivityItem[] = [
    ...recentNewCustomers.map((customer) => ({
      key: `customer-${customer.id}`,
      icon: UserPlus,
      accent: "blue" as const,
      title: "New customer added",
      subtitle: customer.name,
      href: `/customers/${customer.id}`,
      at: customer.createdAt,
    })),
    ...recentSentEstimates.map((estimate) => ({
      key: `estimate-${estimate.id}`,
      icon: FileText,
      accent: "purple" as const,
      title: estimate.status === "APPROVED" ? "Estimate approved" : "Estimate sent",
      subtitle: estimate.customer?.name ?? "Customer",
      href: `/estimates/${estimate.id}`,
      at: estimate.updatedAt,
    })),
    ...recentCompletedJobs.map((job) => ({
      key: `job-${job.id}`,
      icon: CalendarCheck,
      accent: "orange" as const,
      title: "Job completed",
      subtitle: job.customer?.name ?? "Customer",
      href: `/jobs/${job.id}`,
      at: job.updatedAt,
    })),
    ...recentPayments.map((invoice) => ({
      key: `invoice-${invoice.id}`,
      icon: DollarSign,
      accent: "green" as const,
      title: "Payment received",
      subtitle: `${invoice.customer?.name ?? "Customer"} · ${formatMoney(invoice.total)}`,
      href: `/invoices/${invoice.id}`,
      at: invoice.paidAt as Date,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, RECENT_ACTIVITY_TAKE);

  const topServicesMap = new Map<string, { name: string; jobs: number; revenue: number }>();
  for (const job of completedJobsThisMonth) {
    const seenInThisJob = new Set<string>();
    for (const lineItem of job.estimate?.lineItems ?? []) {
      const service = lineItem.serviceCatalogItem;
      if (!service) continue;
      const entry = topServicesMap.get(service.id) ?? { name: service.name, jobs: 0, revenue: 0 };
      entry.revenue += Number(lineItem.total);
      if (!seenInThisJob.has(service.id)) {
        entry.jobs += 1;
        seenInThisJob.add(service.id);
      }
      topServicesMap.set(service.id, entry);
    }
  }
  const topServices = Array.from(topServicesMap.values())
    .sort((a, b) => b.jobs - a.jobs)
    .slice(0, TOP_SERVICES_TAKE);

  const totalPages = Math.max(1, Math.ceil(matchedCount / pageSize));
  const rangeStart = matchedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(matchedCount, page * pageSize);

  const otherParams = new URLSearchParams();
  if (q) otherParams.set("q", q);
  if (area) otherParams.set("area", area);
  if (pageSize !== DEFAULT_PAGE_SIZE) otherParams.set("pageSize", String(pageSize));

  function pageHref(target: number) {
    const linkParams = new URLSearchParams(otherParams);
    if (target > 1) linkParams.set("page", String(target));
    const query = linkParams.toString();
    return `/customers${query ? `?${query}` : ""}`;
  }

  return (
    <PageContainer width="2xl">
      {/*
       * Shared header slots (TBBT logo -> business switcher -> page title
       * -> primary action -> search -> ... -> theme -> account). "+ New
       * Customer" is the real createCustomer() action (see
       * src/app/actions/customer.ts) -- not a decorative button.
       */}
      <PageHeaderControls
        actions={<NewCustomerForm label="New Customer" />}
        search={
          <form action="/customers" method="GET" className="flex items-center gap-2">
            <input type="hidden" name="area" value={area ?? ""} />
            <Input type="search" name="q" defaultValue={q} placeholder="Search customers..." className="h-9 w-56" />
          </form>
        }
      />
      <PageHeader
        title="Customers"
        description={`${totalCustomersCount} customer${totalCustomersCount === 1 ? "" : "s"} for ${access.workspace.business.name}.`}
      />

      <FounderDesignRoot
        pageKey="customers"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={overviewKpis.map((kpi) => kpi.label)}
      >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,300px)]">
        <FounderRegion id="table" className="space-y-4">
          {/*
           * The shared header's search slot only renders on desktop (see
           * src/components/app-shell.tsx's mobile header). Customer
           * search must still work on mobile, so this is the same real
           * GET-form search, just visible in the page body below md.
           */}
          <form action="/customers" method="GET" className="md:hidden">
            <input type="hidden" name="area" value={area ?? ""} />
            <Input type="search" name="q" defaultValue={q} placeholder="Search customers..." className="h-9" />
          </form>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
            <div className="flex items-center gap-2 rounded-md border-b-2 border-primary bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
              All Customers
              <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                {totalCustomersCount}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {areaOptions.length > 0 ? <AreaFilterSelect value={area ?? "all"} options={areaOptions} /> : null}
              <ExportCustomersButton rows={exportRows} />
            </div>
          </div>

          {customers.length === 0 ? (
            <EmptyState
              title={matchedCount === 0 && (q || area) ? "No customers match your filters" : "No customers yet"}
              description={
                matchedCount === 0 && (q || area)
                  ? "Try a different search term or service area."
                  : "Customers appear here when someone submits a service request, or you add one directly."
              }
              action={
                matchedCount === 0 && !q && !area ? (
                  <NewCustomerForm label="New Customer" />
                ) : undefined
              }
            />
          ) : (
            <>
              <div className="hidden lg:block">
                <CustomersTable customers={customers} />
              </div>
              <div className="space-y-2 lg:hidden">
                <CustomersMobileList customers={customers} />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <p className="text-sm text-muted-foreground">
                  Showing {rangeStart} to {rangeEnd} of {matchedCount} customer{matchedCount === 1 ? "" : "s"}
                </p>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    Rows per page
                    <PageSizeSelect value={pageSize} />
                  </div>
                  {totalPages > 1 ? (
                    <div className="flex items-center gap-1">
                      <Button asChild size="sm" variant="outline" disabled={page <= 1}>
                        <Link href={pageHref(Math.max(1, page - 1))} aria-disabled={page <= 1}>
                          Prev
                        </Link>
                      </Button>
                      <span className="px-2 text-sm tabular-nums text-muted-foreground">
                        {page} / {totalPages}
                      </span>
                      <Button asChild size="sm" variant="outline" disabled={page >= totalPages}>
                        <Link href={pageHref(Math.min(totalPages, page + 1))} aria-disabled={page >= totalPages}>
                          Next
                        </Link>
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </FounderRegion>

        <div className="space-y-4">
          <FounderRegion id="overview">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="text-base">Customer Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <KpiCardsLayout
                gridClassName="grid-cols-2"
                flexBreakpointClassName="sm:flex sm:flex-wrap"
                defaultGapPx={12}
              >
                {overviewKpis.map((kpi, index) => (
                  <TunableKpiCard
                    key={kpi.label}
                    index={index}
                    label={kpi.label}
                    value={kpi.value}
                    sublabel={kpi.sublabel}
                    defaultIconId={kpi.defaultIconId}
                    accentClassName={OVERVIEW_ACCENT_CLASSES[kpi.accent]}
                    variant="overview"
                    pageKey="customers"
                  />
                ))}
              </KpiCardsLayout>
            </CardContent>
          </Card>
          </FounderRegion>

          <FounderRegion id="activity">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {activity.length === 0 ? (
                <p className="text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                activity.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className="flex items-start gap-3 rounded-lg p-2 text-sm transition-colors hover:bg-accent/40"
                  >
                    <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", OVERVIEW_ACCENT_CLASSES[item.accent])}>
                      <item.icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDate(item.at)}</span>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
          </FounderRegion>

          <FounderRegion id="services">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="text-base">Top Services</CardTitle>
              <p className="text-xs text-muted-foreground">By completed jobs this month</p>
            </CardHeader>
            <CardContent className="space-y-2">
              {topServices.length === 0 ? (
                <p className="text-sm text-muted-foreground">No completed jobs yet this month.</p>
              ) : (
                topServices.map((service) => (
                  <div key={service.name} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <FounderRegionIcon regionId="services" defaultIcon="wrench" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-foreground">{service.name}</span>
                    </span>
                    <span className="shrink-0 text-right text-muted-foreground">
                      {service.jobs} job{service.jobs === 1 ? "" : "s"} · {formatMoney(service.revenue)}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          </FounderRegion>

          <NewCustomerForm label="Add New Customer" size="lg" className="w-full" />
        </div>
      </div>
      </FounderDesignRoot>
    </PageContainer>
  );
}

type OverviewAccent = "blue" | "orange" | "purple" | "teal" | "green";

const OVERVIEW_ACCENT_CLASSES: Record<OverviewAccent, string> = {
  blue: "bg-blue-500/15 text-blue-400",
  orange: "bg-orange-500/15 text-orange-400",
  purple: "bg-purple-500/15 text-purple-400",
  teal: "bg-teal-500/15 text-teal-400",
  green: "bg-green-500/15 text-green-400",
};

type OverviewKpiProps = {
  label: string;
  value: ReactNode;
  sublabel?: string;
  icon: ComponentType<{ className?: string }>;
  accent: OverviewAccent;
  defaultIconId: "users" | "briefcase" | "dollar-sign" | "trending-up";
};

type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  locationPrimary: string | null;
  locationSecondary: string | null;
  jobs: number;
  totalSpent: number;
  balance: number;
  lastActivity: Date;
  statusType: "request" | "estimate" | "job" | "invoice" | null;
  statusValue: string | null;
  statusCaption: string | null;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function CustomersTable({ customers }: { customers: CustomerRow[] }) {
  return (
    <Card className="overflow-hidden border-border/70 p-0 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontSize: "var(--tbbt-table-font-size, 14px)" }}>
          <thead>
            <tr
              className="border-b border-border/70 bg-muted/50 text-left font-semibold tracking-wide text-muted-foreground uppercase"
              style={
                {
                  "--th-py": "var(--tbbt-table-header-py, 14px)",
                  "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                  fontSize: "var(--tbbt-table-header-font-size, 12px)",
                } as CSSProperties
              }
            >
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Customer</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Contact</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Location</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Status</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Jobs</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Total Spent</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Balance</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Last Activity</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr
                key={customer.id}
                className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-accent/40"
                style={
                  {
                    "--tr-py": "var(--tbbt-table-row-py, 16px)",
                    "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                  } as CSSProperties
                }
              >
                <td className="max-w-24 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                  <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                      {initials(customer.name)}
                    </span>
                    <span className="truncate font-semibold text-foreground" style={{ fontSize: "1.09em" }}>{customer.name}</span>
                  </div>
                </td>
                <td className="max-w-28 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                  <p className="truncate text-foreground">{customer.phone || customer.email || "—"}</p>
                  {customer.phone && customer.email ? (
                    <p className="truncate text-xs text-muted-foreground">{customer.email}</p>
                  ) : null}
                </td>
                <td className="max-w-24 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                  <p className="truncate text-foreground">{customer.locationPrimary ?? "—"}</p>
                  {customer.locationSecondary ? (
                    <p className="truncate text-xs text-muted-foreground">{customer.locationSecondary}</p>
                  ) : null}
                </td>
                <td className="max-w-28 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                  {customer.statusValue ? (
                    <>
                      <StatusBadge status={customer.statusValue} />
                      {customer.statusCaption ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">{customer.statusCaption}</p>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td
                  className="text-right align-top tabular-nums text-foreground"
                  style={{ padding: "var(--tr-py) var(--cell-px)" }}
                >
                  {customer.jobs}
                </td>
                <td
                  className="text-right align-top tabular-nums text-foreground whitespace-nowrap"
                  style={{ padding: "var(--tr-py) var(--cell-px)" }}
                >
                  {formatMoney(customer.totalSpent)}
                </td>
                <td
                  className={cn(
                    "text-right align-top tabular-nums whitespace-nowrap",
                    customer.balance > 0 ? "font-medium text-amber-500" : "text-emerald-500",
                  )}
                  style={{ padding: "var(--tr-py) var(--cell-px)" }}
                >
                  {formatMoney(customer.balance)}
                </td>
                <td
                  className="max-w-24 truncate align-top text-muted-foreground"
                  style={{ padding: "var(--tr-py) var(--cell-px)" }}
                >
                  {formatDate(customer.lastActivity)}
                </td>
                <td className="text-right align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/customers/${customer.id}`}>Open</Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CustomersMobileList({ customers }: { customers: CustomerRow[] }) {
  return (
    <>
      {customers.map((customer) => (
        <Link
          key={customer.id}
          href={`/customers/${customer.id}`}
          className="block rounded-xl border border-border/70 bg-card/40 p-3.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {initials(customer.name)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{customer.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {customer.phone || customer.email || "No contact on file"}
                </p>
              </div>
            </div>
            {customer.statusValue ? <StatusBadge status={customer.statusValue} /> : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{customer.locationPrimary ?? "No address on file"}</span>
            <span>
              {customer.jobs} job{customer.jobs === 1 ? "" : "s"}
            </span>
            <span>Spent {formatMoney(customer.totalSpent)}</span>
            {customer.balance > 0 ? (
              <span className="font-medium text-amber-500">Balance {formatMoney(customer.balance)}</span>
            ) : null}
          </div>
        </Link>
      ))}
    </>
  );
}
