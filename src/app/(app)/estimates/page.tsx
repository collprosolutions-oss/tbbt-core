import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { Prisma } from "@prisma/client";
import { Briefcase, CheckCircle2, FileText, Send } from "lucide-react";
import { CustomerFilterSelect } from "@/components/estimates/customer-filter-select";
import { DateFilterSelect } from "@/components/estimates/date-filter-select";
import {
  EstimatesWorkspace,
  type EstimateListItem,
} from "@/components/estimates/estimates-workspace";
import { PageSizeSelect } from "@/components/estimates/page-size-select";
import { ServiceFilterSelect } from "@/components/estimates/service-filter-select";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { FounderRegion } from "@/components/founder-design/region";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatAddress, formatDate, formatMoney } from "@/lib/format";
import { isUsableEmail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Estimates",
};

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

/**
 * The real estimate lifecycle (see prisma/schema.prisma's Estimate.status
 * comment and src/app/actions/estimate.ts / public-estimate.ts) is only
 * ever DRAFT -> SENT -> APPROVED. There is no VIEWED, PENDING, DECLINED,
 * or EXPIRED anywhere in the schema or any server action -- those locked-
 * mockup tabs/KPIs are intentionally not implemented here rather than
 * faked. "Converted to Job" is not a fourth Estimate.status value; it is
 * an APPROVED estimate that also has a linked Job (Job.estimateId).
 */
const TAB_KEYS = ["draft", "sent", "approved", "job"] as const;
type TabKey = (typeof TAB_KEYS)[number] | "all";

function parseTab(raw: string | undefined): TabKey {
  return (TAB_KEYS as readonly string[]).includes(raw ?? "") ? (raw as TabKey) : "all";
}

function dateFilterStart(preset: string | undefined, now: Date) {
  if (preset === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (preset === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (preset === "year") return new Date(now.getFullYear(), 0, 1);
  return null;
}

export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    customer?: string;
    service?: string;
    date?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const access = await requireManagementPageAccess();

  // Founder Design Mode: platform-level, independent of Membership/role
  // (see src/lib/founder-access.ts) -- never derived from OWNER/ADMIN.
  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "estimates" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("estimates", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const tab = parseTab(params.status);
  const customerId = params.customer && params.customer !== "all" ? params.customer : undefined;
  const serviceId = params.service && params.service !== "all" ? params.service : undefined;
  const datePreset = params.date && params.date !== "all" ? params.date : undefined;
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize))
    ? Number(params.pageSize)
    : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(params.page) || 1);

  const tabWhere =
    tab === "job"
      ? { jobs: { some: {} } }
      : tab === "all"
        ? {}
        : { status: tab.toUpperCase() };

  const searchWhere = q
    ? {
        OR: [
          { customer: { name: { contains: q, mode: "insensitive" as const } } },
          { customer: { email: { contains: q, mode: "insensitive" as const } } },
          { customer: { phone: { contains: q, mode: "insensitive" as const } } },
          { serviceRequest: { description: { contains: q, mode: "insensitive" as const } } },
          { serviceRequest: { serviceCatalogItem: { name: { contains: q, mode: "insensitive" as const } } } },
        ],
      }
    : {};

  const customerWhere = customerId ? { customerId } : {};
  const serviceWhere = serviceId ? { serviceRequest: { serviceCatalogItemId: serviceId } } : {};
  const now = new Date();
  const dateStart = dateFilterStart(datePreset, now);
  const dateWhere = dateStart ? { createdAt: { gte: dateStart } } : {};

  const where = { ...access.scope, ...tabWhere, ...searchWhere, ...customerWhere, ...serviceWhere, ...dateWhere };

  const [
    allAgg,
    draftAgg,
    sentAgg,
    approvedAgg,
    jobAgg,
    matchedCount,
    estimatesRaw,
    customerOptions,
    serviceOptions,
  ] = await Promise.all([
    prisma.estimate.aggregate({ where: access.scope, _count: { _all: true }, _sum: { total: true } }),
    prisma.estimate.aggregate({
      where: { ...access.scope, status: "DRAFT" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.estimate.aggregate({
      where: { ...access.scope, status: "SENT" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.estimate.aggregate({
      where: { ...access.scope, status: "APPROVED" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.estimate.aggregate({
      where: { ...access.scope, jobs: { some: {} } },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.estimate.count({ where }),
    prisma.estimate.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        property: {
          select: { addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true },
        },
        serviceRequest: {
          select: { description: true, serviceCatalogItem: { select: { name: true } } },
        },
        jobs: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
        lineItems: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customer.findMany({
      where: { ...access.scope, estimates: { some: {} } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.serviceCatalogItem.findMany({
      where: { ...access.scope, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const estimates: EstimateListItem[] = estimatesRaw.map((estimate) => {
    const laborItems = estimate.lineItems.filter((item) => item.type === "LABOR");
    const materialItems = estimate.lineItems.filter((item) => item.type === "MATERIAL");
    const otherItems = estimate.lineItems.filter((item) => item.type === "OTHER");
    const laborSubtotal = laborItems.reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
    const materialSubtotal = materialItems.reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
    const otherSubtotal = otherItems.reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));

    const isManual = !estimate.serviceRequestId;
    const serviceLabel = isManual
      ? estimate.lineItems[0]?.description ?? "Manual estimate"
      : estimate.serviceRequest?.serviceCatalogItem?.name ??
        estimate.serviceRequest?.description ??
        "Service request";

    return {
      id: estimate.id,
      status: estimate.status,
      totalLabel: formatMoney(estimate.total),
      createdAtLabel: formatDate(estimate.createdAt),
      serviceLabel,
      isManual,
      customer: estimate.customer,
      propertyLabel: estimate.property ? formatAddress(estimate.property) : null,
      laborMinimumWaived: estimate.laborMinimumWaived,
      laborMinimumAdjustmentLabel: estimate.laborMinimumAdjustment.gt(0)
        ? formatMoney(estimate.laborMinimumAdjustment)
        : null,
      lineItems: estimate.lineItems.map((item) => ({
        id: item.id,
        description: item.description,
        quantity: item.quantity.toString(),
        unitPrice: formatMoney(item.unitPrice),
        total: formatMoney(item.total),
        type: item.type,
      })),
      laborSubtotalLabel: formatMoney(laborSubtotal),
      materialSubtotalLabel: materialSubtotal.gt(0) ? formatMoney(materialSubtotal) : null,
      otherSubtotalLabel: otherSubtotal.gt(0) ? formatMoney(otherSubtotal) : null,
      jobId: estimate.jobs[0]?.id ?? null,
      hasCustomerEmail: isUsableEmail(estimate.customer?.email ?? ""),
      publicToken: estimate.publicToken,
    };
  });

  const kpis: KpiCardProps[] = [
    {
      label: "All Estimates",
      value: allAgg._count._all,
      sublabel: formatMoney(allAgg._sum.total ?? 0),
      icon: FileText,
      defaultIconId: "file-text" as const,
      accent: "blue",
      href: "/estimates",
    },
    {
      label: "Approved",
      value: approvedAgg._count._all,
      sublabel: formatMoney(approvedAgg._sum.total ?? 0),
      icon: CheckCircle2,
      defaultIconId: "check-circle" as const,
      accent: "green",
      href: "/estimates?status=approved",
    },
    {
      label: "Sent / Awaiting Approval",
      value: sentAgg._count._all,
      sublabel: formatMoney(sentAgg._sum.total ?? 0),
      icon: Send,
      defaultIconId: "send" as const,
      accent: "orange",
      href: "/estimates?status=sent",
    },
    {
      label: "Converted to Job",
      value: jobAgg._count._all,
      sublabel: formatMoney(jobAgg._sum.total ?? 0),
      icon: Briefcase,
      defaultIconId: "briefcase" as const,
      accent: "purple",
      href: "/estimates?status=job",
    },
    {
      label: "Draft",
      value: draftAgg._count._all,
      sublabel: formatMoney(draftAgg._sum.total ?? 0),
      icon: FileText,
      defaultIconId: "file-text" as const,
      accent: "slate",
      href: "/estimates?status=draft",
    },
  ];

  const otherParams = new URLSearchParams();
  if (q) otherParams.set("q", q);
  if (customerId) otherParams.set("customer", customerId);
  if (serviceId) otherParams.set("service", serviceId);
  if (datePreset) otherParams.set("date", datePreset);
  if (pageSize !== DEFAULT_PAGE_SIZE) otherParams.set("pageSize", String(pageSize));

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "all", label: "All Estimates", count: allAgg._count._all },
    { key: "draft", label: "Draft", count: draftAgg._count._all },
    { key: "sent", label: "Sent", count: sentAgg._count._all },
    { key: "approved", label: "Approved", count: approvedAgg._count._all },
    { key: "job", label: "Job", count: jobAgg._count._all },
  ];

  const totalPages = Math.max(1, Math.ceil(matchedCount / pageSize));
  const rangeStart = matchedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(matchedCount, page * pageSize);

  function pageHref(target: number) {
    const linkParams = new URLSearchParams(otherParams);
    if (tab !== "all") linkParams.set("status", tab);
    if (target > 1) linkParams.set("page", String(target));
    const query = linkParams.toString();
    return `/estimates${query ? `?${query}` : ""}`;
  }

  return (
    <PageContainer width="2xl">
      {/*
       * Shared header slots (TBBT logo -> business switcher -> page title
       * -> primary action -> search -> ... -> theme -> account). "New
       * Estimate" is the real existing /estimates/new workflow -- not a
       * new capability.
       */}
      <PageHeaderControls
        actions={
          <Button asChild size="sm">
            <Link href="/estimates/new">New Estimate</Link>
          </Button>
        }
        search={
          <form action="/estimates" method="GET" className="flex items-center gap-2">
            <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
            <input type="hidden" name="customer" value={customerId ?? ""} />
            <input type="hidden" name="service" value={serviceId ?? ""} />
            <input type="hidden" name="date" value={datePreset ?? ""} />
            <Input type="search" name="q" defaultValue={q} placeholder="Search estimates..." className="h-9 w-56" />
          </form>
        }
      />
      <PageHeader
        title="Estimates"
        description={`Estimates for ${access.workspace.business.name}.`}
      />

      <FounderDesignRoot
        pageKey="estimates"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
      <FounderRegion id="kpi">
      <KpiCardsLayout gridClassName="sm:grid-cols-2 lg:grid-cols-5" defaultGapPx={20}>
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
            pageKey="estimates"
          />
        ))}
      </KpiCardsLayout>
      </FounderRegion>

      {/* Mobile-only search fallback -- the shared header's search slot only renders on desktop. */}
      <form action="/estimates" method="GET" className="md:hidden">
        <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
        <input type="hidden" name="customer" value={customerId ?? ""} />
        <input type="hidden" name="service" value={serviceId ?? ""} />
        <input type="hidden" name="date" value={datePreset ?? ""} />
        <Input type="search" name="q" defaultValue={q} placeholder="Search estimates..." className="h-9" />
      </form>

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
                href={`/estimates${query ? `?${query}` : ""}`}
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
        <div className="flex flex-wrap items-center gap-2">
          {customerOptions.length > 0 ? (
            <CustomerFilterSelect value={customerId ?? "all"} options={customerOptions} />
          ) : null}
          {serviceOptions.length > 0 ? (
            <ServiceFilterSelect value={serviceId ?? "all"} options={serviceOptions} />
          ) : null}
          <DateFilterSelect value={datePreset ?? "all"} />
        </div>
      </div>
      </FounderRegion>

      <EstimatesWorkspace estimates={estimates} />

      {estimates.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-sm text-muted-foreground">
            Showing {rangeStart} to {rangeEnd} of {matchedCount} estimate{matchedCount === 1 ? "" : "s"}
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
      ) : null}
      </FounderDesignRoot>
    </PageContainer>
  );
}

type KpiAccent = "blue" | "orange" | "purple" | "teal" | "green" | "slate";

const KPI_ACCENT_CLASSES: Record<KpiAccent, string> = {
  blue: "bg-blue-500/15 text-blue-400",
  orange: "bg-orange-500/15 text-orange-400",
  purple: "bg-purple-500/15 text-purple-400",
  teal: "bg-teal-500/15 text-teal-400",
  green: "bg-green-500/15 text-green-400",
  slate: "bg-slate-500/15 text-slate-400",
};

type KpiCardProps = {
  label: string;
  value: ReactNode;
  sublabel?: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  accent: KpiAccent;
  defaultIconId: "file-text" | "check-circle" | "send" | "briefcase";
};
