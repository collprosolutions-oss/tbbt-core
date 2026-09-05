import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { Inbox, Sparkles, TrendingUp, Wrench } from "lucide-react";
import { FounderRegion } from "@/components/founder-design/region";
import { FounderRegionIcon } from "@/components/founder-design/region-icon";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { RequestsWorkspace, type RequestListItem } from "@/components/requests/requests-workspace";
import { ServiceFilterSelect } from "@/components/requests/service-filter-select";
import { MonthView } from "@/components/schedule/month-view";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { requestPhotoOwnerSrc } from "@/lib/business-storage/request-photos";
import { formatCustomerMeasurement } from "@/lib/catalog-intake";
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
import {
  requestedWorkLabels,
  requestedWorkSummary,
} from "@/lib/service-request-work";
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

  // Founder Design Mode: platform-level, independent of Membership/role
  // (see src/lib/founder-access.ts) -- never derived from OWNER/ADMIN.
  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "requests" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("requests", founderOverride?.tokens ?? {});

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
          { items: { some: { serviceCatalogItem: { name: { contains: q, mode: "insensitive" as const } } } } },
          { items: { some: { customDescription: { contains: q, mode: "insensitive" as const } } } },
          { property: { addressLine1: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const serviceWhere = serviceId
    ? {
        OR: [
          { serviceCatalogItemId: serviceId },
          { items: { some: { serviceCatalogItemId: serviceId } } },
        ],
      }
    : {};

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
        items: {
          orderBy: { sortOrder: "asc" },
          select: {
            customDescription: true,
            serviceCatalogItem: { select: { name: true } },
          },
        },
        photos: { select: { id: true, url: true, storedAssetId: true } },
        measurements: {
          select: {
            source: true,
            width: true,
            height: true,
            length: true,
            quantity: true,
            unit: true,
            serviceRequestItem: {
              select: { serviceCatalogItem: { select: { name: true } }, customDescription: true },
            },
          },
        },
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
  const requests: RequestListItem[] = requestsRaw.map((request) => {
    const requestedTasks = requestedWorkLabels(request);
    return {
      id: request.id,
      status: request.status,
      createdAtLabel: formatDate(request.createdAt),
      description: request.description,
      summary: request.summary,
      serviceName:
        requestedWorkSummary(requestedTasks) ??
        request.serviceCatalogItem?.name ??
        null,
      requestedTasks,
      photoCount: request.photos.length,
      photoSrcs: request.photos.map((photo) => requestPhotoOwnerSrc(photo)),
      measurementLabels: request.measurements.map((row) => {
        const name =
          row.serviceRequestItem?.serviceCatalogItem?.name ||
          row.serviceRequestItem?.customDescription ||
          "Selected work";
        const dims = formatCustomerMeasurement({
          width: row.width ? Number(row.width.toString()) : null,
          height: row.height ? Number(row.height.toString()) : null,
          length: row.length ? Number(row.length.toString()) : null,
          quantity: row.quantity,
          unit: row.unit,
        });
        const source =
          row.source === "CONTRACTOR_VERIFIED" ? "contractor verified" : "customer reported";
        return `${name}: ${dims || "on file"} (${source})`;
      }),
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
    };
  });

  const kpis: KpiCardProps[] = [
    {
      label: "New Requests",
      value: newCount,
      icon: Inbox,
      defaultIconId: "inbox" as const,
      href: "/requests?status=new",
      accent: "blue",
      sublabel:
        totalCount > 0 ? `${Math.round((newCount / totalCount) * 100)}% of total` : undefined,
    },
    {
      label: "Estimate Sent",
      value: estimateSentCount,
      icon: TrendingUp,
      defaultIconId: "trending-up" as const,
      href: "/requests?status=estimate-sent",
      accent: "orange",
      sublabel:
        totalCount > 0
          ? `${Math.round((estimateSentCount / totalCount) * 100)}% of total`
          : undefined,
    },
    {
      label: "Converted",
      value: convertedCount,
      icon: Wrench,
      defaultIconId: "wrench" as const,
      href: "/requests?status=converted",
      accent: "purple",
      sublabel:
        totalCount > 0
          ? `${Math.round((convertedCount / totalCount) * 100)}% of all requests`
          : undefined,
    },
    {
      label: "New This Week",
      value: newThisWeekCount,
      icon: Sparkles,
      defaultIconId: "sparkles" as const,
      href: "/requests",
      accent: "teal",
      sublabel: `Since ${formatDate(sevenDaysAgo)}`,
    },
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
              className="h-9 w-56"
            />
          </form>
        }
      />
      <PageHeader
        title={PAGE_TITLE}
        description={`Service requests for ${access.workspace.business.name}.`}
      />

      <FounderDesignRoot
        pageKey="requests"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
      <FounderRegion id="kpi">
      <KpiCardsLayout gridClassName="sm:grid-cols-2 lg:grid-cols-4" defaultGapPx={20}>
        {kpis.map((kpi, index) => (
          <TunableKpiCard
            key={kpi.label}
            index={index}
            label={kpi.label}
            value={kpi.value}
            sublabel={kpi.sublabel}
            href={kpi.href}
            defaultIconId={kpi.defaultIconId}
            accentClassName={KPI_ACCENT_CLASSES[kpi.accent]}
            variant="workspace"
            pageKey="requests"
          />
        ))}
      </KpiCardsLayout>
      </FounderRegion>

      <FounderRegion id="tabs" className="tbbt-founder-box">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
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
                  "flex items-center gap-2 rounded-md border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {tabItem.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums",
                    active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
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
      </FounderRegion>

      {/*
       * Primary row is Request Table + Request Details (see
       * RequestsWorkspace). Schedule & Calendar sits UNDER the table
       * column -- same main-list width -- instead of a cramped 250px
       * third column. Today / Quick Actions stay in the supporting
       * column under Request Details. --tbbt-panel-width sizes only
       * that supporting column, matching the details panel.
       */}
      <RequestsWorkspace requests={requests} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,280px)]">
        <FounderRegion id="calendar">
        <div className="tbbt-founder-box space-y-3 rounded-xl border border-border/70 bg-card/40 p-4">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-base font-semibold text-foreground">
              <FounderRegionIcon regionId="calendar" defaultIcon="calendar-days" className="size-4.5 text-muted-foreground" />
              Schedule &amp; Calendar
            </p>
            <Link
              href="/jobs"
              className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
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
        </FounderRegion>

        <div className="space-y-5">
          <FounderRegion id="today">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FounderRegionIcon regionId="today" defaultIcon="calendar-clock" className="size-4.5 text-muted-foreground" />
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
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/40 p-3 text-sm transition-colors hover:bg-accent/40"
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
          </FounderRegion>

          <FounderRegion id="actions">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FounderRegionIcon regionId="actions" defaultIcon="sparkles" className="size-4.5 text-muted-foreground" />
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
          </FounderRegion>
        </div>
      </div>
      </FounderDesignRoot>
    </PageContainer>
  );
}

type KpiAccent = "blue" | "orange" | "purple" | "teal";

const KPI_ACCENT_CLASSES: Record<KpiAccent, string> = {
  blue: "bg-blue-500/15 text-blue-400",
  orange: "bg-orange-500/15 text-orange-400",
  purple: "bg-purple-500/15 text-purple-400",
  teal: "bg-teal-500/15 text-teal-400",
};

type KpiCardProps = {
  label: string;
  value: ReactNode;
  sublabel?: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  accent: KpiAccent;
  defaultIconId: "inbox" | "trending-up" | "wrench" | "sparkles";
};
