import type { Metadata } from "next";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { CheckCircle2, DollarSign, FileText, Send } from "lucide-react";
import { CustomerFilterSelect } from "@/components/invoices/customer-filter-select";
import { DateFilterSelect } from "@/components/invoices/date-filter-select";
import {
  InvoicesWorkspace,
  type InvoiceListItem,
} from "@/components/invoices/invoices-workspace";
import { PageSizeSelect } from "@/components/invoices/page-size-select";
import { PaymentMethodFilterSelect } from "@/components/invoices/payment-method-filter-select";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { FounderRegion } from "@/components/founder-design/region";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { PageHeaderControls } from "@/components/page-header-controls";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatAddress, formatDateTime, formatMoney } from "@/lib/format";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import { prisma } from "@/lib/prisma";
import { jobScopeSummary } from "@/lib/schedule";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Invoices",
};

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

/**
 * The real Invoice lifecycle only (see prisma/schema.prisma's Invoice
 * model and src/app/actions/invoice.ts): DRAFT -> SENT -> PAID. There is
 * no OVERDUE (no due-date field exists at all) or CANCELLED status
 * anywhere in the schema or any server action -- the locked mockup's
 * "Overdue"/"Cancelled" tabs and KPIs are intentionally not implemented
 * here rather than faked.
 */
const TAB_KEYS = ["draft", "sent", "paid"] as const;
type TabKey = (typeof TAB_KEYS)[number] | "all";

function parseTab(raw: string | undefined): TabKey {
  const normalized = (raw ?? "").toLowerCase();
  return (TAB_KEYS as readonly string[]).includes(normalized) ? (normalized as TabKey) : "all";
}

function rangeFilterStart(preset: string | undefined, now: Date) {
  if (preset === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (preset === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (preset === "year") return new Date(now.getFullYear(), 0, 1);
  return null;
}

const LINE_ITEM_SELECT = { description: true } as const;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    customer?: string;
    method?: string;
    range?: string;
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
        where: { userId_pageKey: { userId: founder.id, pageKey: "invoices" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("invoices", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const tab = parseTab(params.status);
  const customerId = params.customer && params.customer !== "all" ? params.customer : undefined;
  const method = params.method && params.method !== "all" ? params.method : undefined;
  const rangePreset = params.range && params.range !== "all" ? params.range : undefined;
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize))
    ? Number(params.pageSize)
    : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(params.page) || 1);

  const tabWhere = tab === "all" ? {} : { status: tab.toUpperCase() };
  const searchWhere = q
    ? {
        OR: [
          { customer: { name: { contains: q, mode: "insensitive" as const } } },
          { customer: { email: { contains: q, mode: "insensitive" as const } } },
          { customer: { phone: { contains: q, mode: "insensitive" as const } } },
          { job: { property: { addressLine1: { contains: q, mode: "insensitive" as const } } } },
          {
            job: {
              approvedEstimateVersion: {
                lineItems: { some: { description: { contains: q, mode: "insensitive" as const } } },
              },
            },
          },
          {
            job: {
              estimate: {
                lineItems: { some: { description: { contains: q, mode: "insensitive" as const } } },
              },
            },
          },
        ],
      }
    : {};
  const customerWhere = customerId ? { customerId } : {};
  const methodWhere = method ? { paymentMethod: method } : {};
  const now = new Date();
  const rangeStart = rangeFilterStart(rangePreset, now);
  const rangeWhere = rangeStart ? { createdAt: { gte: rangeStart } } : {};

  const where = { ...access.scope, ...tabWhere, ...searchWhere, ...customerWhere, ...methodWhere, ...rangeWhere };

  const [
    allAgg,
    draftAgg,
    sentAgg,
    paidAgg,
    matchedCount,
    invoicesRaw,
    customerOptions,
  ] = await Promise.all([
    prisma.invoice.aggregate({ where: access.scope, _count: { _all: true }, _sum: { total: true } }),
    prisma.invoice.aggregate({
      where: { ...access.scope, status: "DRAFT" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.invoice.aggregate({
      where: { ...access.scope, status: "SENT" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.invoice.aggregate({
      where: { ...access.scope, status: "PAID" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        job: {
          select: {
            id: true,
            projectToken: true,
            property: {
              select: { addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true },
            },
            approvedEstimateVersion: {
              select: { lineItems: { take: 1, orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT } },
            },
            estimate: {
              select: { lineItems: { take: 1, orderBy: { createdAt: "asc" }, select: LINE_ITEM_SELECT } },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customer.findMany({
      where: { ...access.scope, invoices: { some: {} } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const invoices: InvoiceListItem[] = invoicesRaw.map((invoice) => ({
    id: invoice.id,
    status: invoice.status,
    totalLabel: formatMoney(invoice.total),
    balanceLabel: invoice.status === "PAID" ? formatMoney(0) : formatMoney(invoice.total),
    createdAtLabel: formatDateTime(invoice.createdAt),
    customer: invoice.customer,
    propertyLabel: invoice.job?.property ? formatAddress(invoice.job.property) : null,
    scopeSummary: invoice.job ? jobScopeSummary(invoice.job) : null,
    jobId: invoice.job?.id ?? null,
    jobProjectToken: invoice.job?.projectToken ?? null,
    paidAtLabel: invoice.paidAt ? formatDateTime(invoice.paidAt) : null,
    paymentMethodLabel: paymentMethodLabel(invoice.paymentMethod),
    paymentReference: invoice.paymentReference,
  }));

  const kpis: KpiCardProps[] = [
    {
      label: "Total Invoices",
      value: allAgg._count._all,
      sublabel: formatMoney(allAgg._sum.total ?? 0),
      icon: FileText,
      defaultIconId: "file-text" as const,
      accent: "blue",
      href: "/invoices",
    },
    {
      label: "Draft",
      value: draftAgg._count._all,
      sublabel: formatMoney(draftAgg._sum.total ?? 0),
      icon: FileText,
      defaultIconId: "file-text" as const,
      accent: "slate",
      href: "/invoices?status=draft",
    },
    {
      label: "Sent",
      value: sentAgg._count._all,
      sublabel: formatMoney(sentAgg._sum.total ?? 0),
      icon: Send,
      defaultIconId: "send" as const,
      accent: "orange",
      href: "/invoices?status=sent",
    },
    {
      label: "Paid",
      value: paidAgg._count._all,
      icon: CheckCircle2,
      defaultIconId: "check-circle" as const,
      accent: "green",
      href: "/invoices?status=paid",
    },
    {
      label: "Total Revenue",
      value: formatMoney(paidAgg._sum.total ?? 0),
      sublabel: "Paid invoices only",
      icon: DollarSign,
      defaultIconId: "dollar-sign" as const,
      accent: "teal",
      href: "/invoices?status=paid",
    },
  ];

  const otherParams = new URLSearchParams();
  if (q) otherParams.set("q", q);
  if (customerId) otherParams.set("customer", customerId);
  if (method) otherParams.set("method", method);
  if (rangePreset) otherParams.set("range", rangePreset);
  if (pageSize !== DEFAULT_PAGE_SIZE) otherParams.set("pageSize", String(pageSize));

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "all", label: "All Invoices", count: allAgg._count._all },
    { key: "draft", label: "Draft", count: draftAgg._count._all },
    { key: "sent", label: "Sent", count: sentAgg._count._all },
    { key: "paid", label: "Paid", count: paidAgg._count._all },
  ];

  const totalPages = Math.max(1, Math.ceil(matchedCount / pageSize));
  const rangeStartRow = matchedCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEndRow = Math.min(matchedCount, page * pageSize);

  function pageHref(target: number) {
    const linkParams = new URLSearchParams(otherParams);
    if (tab !== "all") linkParams.set("status", tab);
    if (target > 1) linkParams.set("page", String(target));
    const query = linkParams.toString();
    return `/invoices${query ? `?${query}` : ""}`;
  }

  return (
    <PageContainer width="2xl">
      {/*
       * Shared header slots (TBBT logo -> business switcher -> page title
       * -> primary action -> search -> ... -> theme -> account). No
       * primary action is registered: creating an Invoice directly
       * (bypassing Job completion) is not a supported, lifecycle-safe
       * workflow -- createInvoiceFromJob() in src/app/actions/invoice.ts
       * is the ONLY way an Invoice is ever created, and it requires a
       * COMPLETED job. Inventing a "+ New Invoice" action here would
       * either do nothing real or bypass that lifecycle, so the slot is
       * intentionally left empty rather than fabricated.
       */}
      <PageHeaderControls
        search={
          <form action="/invoices" method="GET" className="flex items-center gap-2">
            <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
            <input type="hidden" name="customer" value={customerId ?? ""} />
            <input type="hidden" name="method" value={method ?? ""} />
            <input type="hidden" name="range" value={rangePreset ?? ""} />
            <Input type="search" name="q" defaultValue={q} placeholder="Search invoices..." className="h-9 w-56" />
          </form>
        }
      />
      <PageHeader title="Invoices" description={`Invoices for ${access.workspace.business.name}.`} />

      <FounderDesignRoot
        pageKey="invoices"
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
            icon={kpi.icon}
            defaultIconId={kpi.defaultIconId}
            accentClassName={KPI_ACCENT_CLASSES[kpi.accent]}
            variant="workspace"
            pageKey="invoices"
          />
        ))}
      </KpiCardsLayout>
      </FounderRegion>

      {/* Mobile-only search fallback -- the shared header's search slot only renders on desktop. */}
      <form action="/invoices" method="GET" className="md:hidden">
        <input type="hidden" name="status" value={tab === "all" ? "" : tab} />
        <input type="hidden" name="customer" value={customerId ?? ""} />
        <input type="hidden" name="method" value={method ?? ""} />
        <input type="hidden" name="range" value={rangePreset ?? ""} />
        <Input type="search" name="q" defaultValue={q} placeholder="Search invoices..." className="h-9" />
      </form>

      <FounderRegion id="tabs" className="tbbt-founder-box">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        <nav className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
          {tabs.map((tabItem) => {
            const linkParams = new URLSearchParams(otherParams);
            if (tabItem.key !== "all") linkParams.set("status", tabItem.key);
            const query = linkParams.toString();
            const active = tabItem.key === tab;
            return (
              <Link
                key={tabItem.key}
                href={`/invoices${query ? `?${query}` : ""}`}
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
          <PaymentMethodFilterSelect value={method ?? "all"} />
          <DateFilterSelect value={rangePreset ?? "all"} />
        </div>
      </div>
      </FounderRegion>

      <InvoicesWorkspace invoices={invoices} />

      {invoices.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-sm text-muted-foreground">
            Showing {rangeStartRow} to {rangeEndRow} of {matchedCount} invoice{matchedCount === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              Rows per page
              <PageSizeSelect value={pageSize} />
            </div>
            {totalPages > 1 ? (
              <div className="flex items-center gap-1">
                <Link
                  href={pageHref(Math.max(1, page - 1))}
                  aria-disabled={page <= 1}
                  className={cn(
                    "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm",
                    page <= 1 && "pointer-events-none opacity-50",
                  )}
                >
                  Prev
                </Link>
                <span className="px-2 text-sm tabular-nums text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Link
                  href={pageHref(Math.min(totalPages, page + 1))}
                  aria-disabled={page >= totalPages}
                  className={cn(
                    "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm",
                    page >= totalPages && "pointer-events-none opacity-50",
                  )}
                >
                  Next
                </Link>
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
  defaultIconId: "file-text" | "send" | "check-circle" | "dollar-sign";
};
