import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { CalendarClock, CalendarDays, Inbox, Sparkles, TrendingUp, Wrench } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { RequestsWorkspace, type RequestListItem } from "@/components/requests/requests-workspace";
import { ServiceFilterSelect } from "@/components/requests/service-filter-select";
import { MonthView } from "@/components/schedule/month-view";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import { formatAddress, formatDate, formatMoney, formatTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  SCHEDULE_JOB_SELECT,
  dayRange,
  findScheduleConflicts,
  groupJobsByDay,
  monthGridRange,
  monthLabel,
  startOfDay,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Requests",
};

/**
 * The approved title for this page's own heading + shared-header segment
 * ("Requests / New Leads") -- deliberately NOT the sidebar nav label
 * ("Requests" in src/lib/nav.ts stays unchanged; see setPageTitle on
 * PageHeaderControls below for how a page can override just its own
 * header segment without touching AppShell's nav-derived default).
 */
const PAGE_TITLE = "Requests / New Leads";

/**
 * Real, supported request status/estimate filters only -- see the
 * inspection notes below. TBBT's actual ServiceRequest.status only ever
 * holds "OPEN" (set at intake) or "CONVERTED" (set the moment an Estimate
 * is created from it -- see createEstimate() in src/app/actions/
 * estimate.ts). There is no "Contacted" or "Not Interested" state
 * anywhere in the schema or any server action, so those locked-mockup
 * tabs are intentionally NOT implemented here rather than faked.
 * "Estimate Sent" is a real, reliably-derivable filter: requests whose
 * linked Estimate has actually reached SENT or APPROVED (not just been
 * created as a DRAFT).
 */
const TAB_KEYS = ["new", "estimate-sent", "converted"] as const;
type TabKey = (typeof TAB_KEYS)[number] | "all";

function parseTab(raw: string | undefined): TabKey {
  return (TAB_KEYS as readonly string[]).includes(raw ?? "") ? (raw as TabKey) : "all";
}

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; service?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const tab = parseTab(params.status);
  const q = (params.q ?? "").trim();
  const serviceId = params.service && params.service !== "all" ? params.service : undefined;

  const tabWhere =
    tab === "new"
      ? { status: "OPEN" }
      : tab === "converted"
        ? { status: "CONVERTED" }
        : tab === "estimate-sent"
          ? { estimates: { some: { status: { in: ["SENT", "APPROVED"] } } } }
          : {};

  const searchWhere = q
    ? {
        OR: [
          { customer: { name: { contains: q, mode: "insensitive" as const } } },
          { description: { contains: q, mode: "insensitive" as const } },
          { summary: { contains: q, mode: "insensitive" as const } },
          { serviceCatalogItem: { name: { contains: q, mode: "insensitive" as const } } },
          { property: { addressLine1: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const serviceWhere = serviceId ? { serviceCatalogItemId: serviceId } : {};

  const where = { ...access.scope, ...tabWhere, ...searchWhere, ...serviceWhere };

  const today = startOfDay(new Date());
  const todayRange = dayRange(today);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthRange = monthGridRange(today);

  const [
    requestsRaw,
    totalCount,
    newCount,
    estimateSentCount,
    convertedCount,
    newThisWeekCount,
    services,
    todayJobs,
    monthJobs,
  ] = await Promise.all([
    prisma.serviceRequest.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        property: {
          select: { addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true },
        },
        serviceCatalogItem: { select: { name: true } },
        estimates: {
          select: { id: true, status: true, total: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.serviceRequest.count({ where: access.scope }),
    prisma.serviceRequest.count({ where: { ...access.scope, status: "OPEN" } }),
    prisma.serviceRequest.count({
      where: { ...access.scope, estimates: { some: { status: { in: ["SENT", "APPROVED"] } } } },
    }),
    prisma.serviceRequest.count({ where: { ...access.scope, status: "CONVERTED" } }),
    prisma.serviceRequest.count({ where: { ...access.scope, createdAt: { gte: sevenDaysAgo } } }),
    prisma.serviceCatalogItem.findMany({
      where: { ...access.scope, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.job.findMany({
      where: { ...access.scope, scheduledAt: { gte: todayRange.start, lt: todayRange.end } },
      select: { id: true, status: true, scheduledAt: true, customer: { select: { name: true } } },
      orderBy: { scheduledAt: "asc" },
      take: 5,
    }),
    // The exact same bounded month-grid query (and MonthView component)
    // the Jobs/Schedule calendar itself uses -- see monthGridRange()/
    // SCHEDULE_JOB_SELECT in src/lib/schedule.ts. No second scheduling
    // engine, no fabricated events.
    prisma.job.findMany({
      where: { ...access.scope, scheduledAt: { gte: monthRange.start, lt: monthRange.end } },
      select: SCHEDULE_JOB_SELECT,
      orderBy: { scheduledAt: "asc" },
    }),
  ]);

  const monthJobsByDay = groupJobsByDay(monthJobs);
  const monthConflicts = findScheduleConflicts(monthJobs);

  // Decimal/Date fields are pre-formatted to plain strings here -- Prisma's
  // Decimal is a class instance and cannot cross the Server->Client
  // Component boundary as a prop.
  const requests: RequestListItem[] = requestsRaw.map((request) => ({
    id: request.id,
    status: request.status,
    createdAtLabel: formatDate(request.createdAt),
    description: request.description,
    summary: request.summary,
    serviceName: request.serviceCatalogItem?.name ?? null,
    propertyLabel: request.property ? formatAddress(request.property) : null,
    customer: request.customer
      ? {
          id: request.customer.id,
          name: request.customer.name,
          email: request.customer.email,
          phone: request.customer.phone,
        }
      : null,
    estimate: request.estimates[0]
      ? {
          id: request.estimates[0].id,
          status: request.estimates[0].status,
          totalLabel: formatMoney(request.estimates[0].total),
        }
      : null,
  }));

  const kpis: KpiCardProps[] = [
    { label: "New Requests", value: newCount, icon: Inbox, href: "/requests?status=new" },
    {
      label: "Estimate Sent",
      value: estimateSentCount,
      icon: TrendingUp,
      href: "/requests?status=estimate-sent",
    },
    {
      label: "Converted",
      value: convertedCount,
      icon: Wrench,
      href: "/requests?status=converted",
      sublabel:
        totalCount > 0
          ? `${Math.round((convertedCount / totalCount) * 100)}% of all requests`
          : undefined,
    },
    { label: "New This Week", value: newThisWeekCount, icon: Sparkles, href: "/requests" },
  ];

  const otherParams = new URLSearchParams();
  if (q) otherParams.set("q", q);
  if (serviceId) otherParams.set("service", serviceId);

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "all", label: "All Requests", count: totalCount },
    { key: "new", label: "New", count: newCount },
    { key: "estimate-sent", label: "Estimate Sent", count: estimateSentCount },
    { key: "converted", label: "Converted", count: convertedCount },
  ];

  return (
    <PageContainer width="2xl">
      {/*
       * Contextual header search (TBBT logo -> business switcher -> page
       * title -> primary action -> search -> ... -> theme -> account).
       * Real, server-filtered search -- a plain GET form, no client state,
       * no fabricated results. There is no genuine owner-facing "create a
       * request" flow anywhere in the app (requests are only ever created
       * by a customer through the public intake form, see
       * src/app/actions/intake.ts) -- rather than fabricate a "+ New
       * Request" button with no real action behind it, the header's
       * primary-action slot is intentionally left empty for this page.
       */}
      <PageHeaderControls
        title={PAGE_TITLE}
        search={
          <form action="/requests" method="GET" className="flex items-center gap-2">
            <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
            <input type="hidden" name="service" value={serviceId ?? ""} />
            <Input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search requests..."
              className="h-8"
            />
          </form>
        }
      />
      <PageHeader
        title={PAGE_TITLE}
        description={`Service requests for ${access.workspace.business.name}.`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap items-center gap-1 overflow-x-auto">
          {tabs.map((tabItem) => {
            const linkParams = new URLSearchParams(otherParams);
            if (tabItem.key !== "all") {
              linkParams.set("status", tabItem.key);
            }
            const query = linkParams.toString();
            const active = tabItem.key === tab;
            return (
              <Link
                key={tabItem.key}
                href={`/requests${query ? `?${query}` : ""}`}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {tabItem.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs tabular-nums",
                    active ? "bg-primary/15" : "bg-muted",
                  )}
                >
                  {tabItem.count}
                </span>
              </Link>
            );
          })}
        </nav>
        {services.length > 0 ? (
          <ServiceFilterSelect value={serviceId ?? "all"} options={services} />
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <RequestsWorkspace requests={requests} />

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                <CalendarDays className="size-4 text-muted-foreground" />
                Schedule &amp; Calendar
              </p>
              <Link
                href="/jobs"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {monthLabel(today)}
              </Link>
            </div>
            <MonthView
              days={monthRange.days}
              monthStart={monthRange.monthStart}
              monthEnd={monthRange.monthEnd}
              today={today}
              jobsByDay={monthJobsByDay}
              conflicts={monthConflicts}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="size-4 text-muted-foreground" />
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
              <Button asChild size="sm" variant="outline" className="w-full">
                <Link href="/jobs">View full schedule</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-muted-foreground" />
                Quick actions
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Button asChild size="sm" variant="outline" className="justify-start">
                <Link href="/estimates/new">Create estimate</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="justify-start">
                <Link href="/estimates">Review estimates</Link>
              </Button>
              <Button asChild size="sm" variant="outline" className="justify-start">
                <Link href="/jobs">Open schedule</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}

type KpiCardProps = {
  label: string;
  value: ReactNode;
  sublabel?: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
};

function KpiCard({ label, value, sublabel, href, icon: Icon }: KpiCardProps) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:border-primary/40 hover:bg-accent/30">
        <CardContent className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
              {value}
            </p>
            {sublabel ? <p className="mt-1 text-xs text-muted-foreground">{sublabel}</p> : null}
          </div>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-4.5" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
