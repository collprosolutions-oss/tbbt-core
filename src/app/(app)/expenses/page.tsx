import type { Metadata } from "next";
import Link from "next/link";
import { ExpensesWorkspace } from "@/components/expenses/expenses-workspace";
import type {
  ExpenseCategoryCard,
  ExpenseFilterChip,
  ExpenseKpi,
  ExpenseListItem,
  ExpenseWorkspaceData,
} from "@/components/expenses/types";
import { FounderDesignRoot } from "@/components/founder-design/root";
import { FounderRegion } from "@/components/founder-design/region";
import { KpiCardsLayout } from "@/components/founder-design/kpi-cards-layout";
import { TunableKpiCard } from "@/components/founder-design/tunable-kpi-card";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { requireManagementPageAccess } from "@/lib/access";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  REIMBURSEMENT_STATUS_LABELS,
  TAX_CATEGORY_LABELS,
  asMoneyNumber,
  categoryTotals,
  expenseCategoryLabel,
  expenseRangeBounds,
  expenseSummary,
  isExpenseCategory,
  isExpenseDateRange,
  isReimbursementStatus,
  isTaxCategory,
  projectedOperatingBalance,
  type ExpenseDateRange,
} from "@/lib/expenses";
import { checkFounderAccess } from "@/lib/founder-access";
import { sanitizeFounderPageTokens } from "@/lib/founder-design";
import { formatDate, formatMoney } from "@/lib/format";
import { paymentMethodLabel } from "@/lib/invoice-payment";
import { prisma } from "@/lib/prisma";
import { addDays, formatISODate, startOfDay } from "@/lib/schedule";
import { isStorageConfigured } from "@/lib/storage";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Expenses",
};

const DEFAULT_PAGE_SIZE = 8;
const PAGE_SIZE_OPTIONS = [8, 25, 50];
const RANGE_OPTIONS: { value: ExpenseDateRange; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "30d", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
  { value: "all", label: "All dates" },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function jobLabel(job: {
  id: string;
  customer: { name: string } | null;
  property: { addressLine1: string } | null;
}) {
  const tail = job.id.slice(-6).toUpperCase();
  const who = job.customer?.name ?? job.property?.addressLine1;
  return who ? `Job #${tail} ${who}` : `Job #${tail}`;
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    range?: string;
    category?: string;
    purchaser?: string;
    method?: string;
    reimbursable?: string;
    page?: string;
    pageSize?: string;
    filters?: string;
  }>;
}) {
  const access = await requireManagementPageAccess();
  const founder = await checkFounderAccess();
  const founderOverride = founder
    ? await prisma.founderDesignOverride.findUnique({
        where: { userId_pageKey: { userId: founder.id, pageKey: "expenses" } },
      })
    : null;
  const founderTokens = sanitizeFounderPageTokens("expenses", founderOverride?.tokens ?? {});

  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const rangePreset: ExpenseDateRange = isExpenseDateRange(params.range ?? "")
    ? (params.range as ExpenseDateRange)
    : "week";
  const rawCategory = params.category ?? "";
  const category = isExpenseCategory(rawCategory) ? rawCategory : undefined;
  const purchaserId = params.purchaser && params.purchaser !== "all" ? params.purchaser : undefined;
  const method = params.method && params.method !== "all" ? params.method : undefined;
  const reimbursableFilter =
    params.reimbursable === "yes" ? true : params.reimbursable === "no" ? false : undefined;
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.pageSize))
    ? Number(params.pageSize)
    : DEFAULT_PAGE_SIZE;
  const page = Math.max(1, Number(params.page) || 1);
  const showFilters = params.filters === "1";

  const now = new Date();
  const bounds = expenseRangeBounds(rangePreset, now);
  const rangeWhere = bounds ? { occurredOn: { gte: bounds.start, lt: bounds.end } } : {};
  const searchWhere = q
    ? {
        OR: [
          { description: { contains: q, mode: "insensitive" as const } },
          { vendor: { contains: q, mode: "insensitive" as const } },
          { notes: { contains: q, mode: "insensitive" as const } },
          { customer: { name: { contains: q, mode: "insensitive" as const } } },
        ],
      }
    : {};
  const categoryWhere = category ? { category } : {};
  const purchaserWhere = purchaserId ? { purchaserMembershipId: purchaserId } : {};
  const methodWhere = method ? { paymentMethod: method } : {};
  const reimbursableWhere =
    reimbursableFilter === undefined ? {} : { reimbursable: reimbursableFilter };

  const listWhere = {
    ...access.scope,
    ...rangeWhere,
    ...searchWhere,
    ...categoryWhere,
    ...purchaserWhere,
    ...methodWhere,
    ...reimbursableWhere,
  };
  const summaryWhere = { ...access.scope, ...rangeWhere };

  const horizonStart = startOfDay(now);
  const horizonEnd = addDays(horizonStart, 30);

  const [
    rangeExpenses,
    matchedCount,
    pageRows,
    memberships,
    jobs,
    customers,
    sentInvoices,
    upcomingExpenses,
  ] = await Promise.all([
    prisma.expense.findMany({
      where: summaryWhere,
      select: { amount: true, category: true, reimbursable: true },
    }),
    prisma.expense.count({ where: listWhere }),
    prisma.expense.findMany({
      where: listWhere,
      include: {
        purchaser: { include: { user: { select: { name: true } } } },
        customer: { select: { id: true, name: true } },
        job: {
          select: {
            id: true,
            customer: { select: { name: true } },
            property: { select: { addressLine1: true } },
          },
        },
      },
      orderBy: { occurredOn: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.membership.findMany({
      where: access.scope,
      include: { user: { select: { name: true } } },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    }),
    prisma.job.findMany({
      where: access.scope,
      select: {
        id: true,
        customerId: true,
        customer: { select: { name: true } },
        property: { select: { addressLine1: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
    prisma.customer.findMany({
      where: access.scope,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 80,
    }),
    prisma.invoice.aggregate({
      where: { ...access.scope, status: "SENT" },
      _sum: { total: true },
      _count: { _all: true },
    }),
    prisma.expense.aggregate({
      where: { ...access.scope, occurredOn: { gte: horizonStart, lt: horizonEnd } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const summary = expenseSummary(rangeExpenses);
  const totals = categoryTotals(rangeExpenses);
  const projection = projectedOperatingBalance({
    knownInflows: asMoneyNumber(sentInvoices._sum.total),
    knownOutflows: asMoneyNumber(upcomingExpenses._sum.amount),
  });

  function hrefWith(updates: Record<string, string | undefined>, dropPage = true) {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (rangePreset !== "week") next.set("range", rangePreset);
    if (category) next.set("category", category);
    if (purchaserId) next.set("purchaser", purchaserId);
    if (method) next.set("method", method);
    if (reimbursableFilter === true) next.set("reimbursable", "yes");
    if (reimbursableFilter === false) next.set("reimbursable", "no");
    if (showFilters) next.set("filters", "1");
    if (pageSize !== DEFAULT_PAGE_SIZE) next.set("pageSize", String(pageSize));
    for (const [key, value] of Object.entries(updates)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    if (dropPage) next.delete("page");
    const query = next.toString();
    return `/expenses${query ? `?${query}` : ""}`;
  }

  const rangeLabel = bounds
    ? `${formatDate(bounds.start)} – ${formatDate(addDays(bounds.end, -1))}`
    : "All dates";

  const kpis: ExpenseKpi[] = [
    {
      label: "Date Range",
      value: rangeLabel,
      sublabel: RANGE_OPTIONS.find((option) => option.value === rangePreset)?.label ?? "Selected range",
      defaultIconId: "calendar-days",
    },
    {
      label: "Total Expenses",
      value: formatMoney(summary.total),
      sublabel: `${summary.count} ${summary.count === 1 ? "expense" : "expenses"}`,
      defaultIconId: "circle-dollar",
      accentClassName: "bg-emerald-500/15 text-emerald-400",
    },
    {
      label: "Reimbursable",
      value: formatMoney(summary.reimbursable),
      sublabel: `${summary.reimbursableCount} ${summary.reimbursableCount === 1 ? "expense" : "expenses"}`,
      defaultIconId: "receipt",
      accentClassName: "bg-orange-500/15 text-orange-400",
    },
    {
      label: "Non-Reimbursable",
      value: formatMoney(summary.nonReimbursable),
      sublabel: `${summary.nonReimbursableCount} ${summary.nonReimbursableCount === 1 ? "expense" : "expenses"}`,
      defaultIconId: "dollar-sign",
      accentClassName: "bg-red-500/15 text-red-400",
    },
    {
      label: "Projected Operating Balance",
      value: "Unavailable",
      sublabel: "Bank not connected · see right panel",
      defaultIconId: "trending-up",
      accentClassName: "bg-blue-500/15 text-blue-400",
    },
  ];

  const categoryCards: ExpenseCategoryCard[] = totals.map((total) => ({
    category: total.category,
    label: EXPENSE_CATEGORY_LABELS[total.category],
    amountLabel: formatMoney(total.amount),
    percent: total.percent,
    count: total.count,
    href: hrefWith({ category: category === total.category ? undefined : total.category }),
    active: category === total.category,
  }));

  const items: ExpenseListItem[] = pageRows.map((expense) => {
    const purchaserName = expense.purchaser?.user.name ?? null;
    return {
      id: expense.id,
      occurredOnLabel: formatDate(expense.occurredOn),
      description: expense.description,
      vendor: expense.vendor,
      category: expense.category,
      categoryLabel: expenseCategoryLabel(expense.category),
      amountLabel: formatMoney(expense.amount),
      purchaserName,
      purchaserInitials: purchaserName ? initials(purchaserName) : null,
      jobLabel: expense.job ? jobLabel(expense.job) : null,
      customerName: expense.customer?.name ?? null,
      hasReceipt: Boolean(expense.receiptUrl),
      receiptUrl: expense.receiptUrl,
      reimbursable: expense.reimbursable,
      reimbursementStatus: expense.reimbursementStatus,
      reimbursementLabel: isReimbursementStatus(expense.reimbursementStatus)
        ? REIMBURSEMENT_STATUS_LABELS[expense.reimbursementStatus]
        : expense.reimbursementStatus,
      paymentMethodLabel: paymentMethodLabel(expense.paymentMethod),
      reviewStatus: expense.reviewStatus,
      reviewLabel: expense.reviewStatus,
      recurring: expense.recurring,
      mileageMilesLabel: expense.mileageMiles != null ? `${asMoneyNumber(expense.mileageMiles)} miles` : null,
      notes: expense.notes,
      taxCategoryLabel: expense.taxCategory && isTaxCategory(expense.taxCategory)
        ? TAX_CATEGORY_LABELS[expense.taxCategory]
        : expense.taxCategory,
    };
  });

  const filters: ExpenseFilterChip[] = [
    { key: "range", label: `Date: ${rangeLabel}`, clearHref: hrefWith({ range: "all" }) },
  ];
  if (category) {
    filters.push({
      key: "category",
      label: EXPENSE_CATEGORY_LABELS[category],
      clearHref: hrefWith({ category: undefined }),
    });
  }
  if (purchaserId) {
    const worker = memberships.find((membership) => membership.id === purchaserId);
    filters.push({
      key: "purchaser",
      label: worker?.user.name ?? "Employee",
      clearHref: hrefWith({ purchaser: undefined }),
    });
  }
  if (method) {
    filters.push({
      key: "method",
      label: paymentMethodLabel(method) ?? method,
      clearHref: hrefWith({ method: undefined }),
    });
  }
  if (reimbursableFilter !== undefined) {
    filters.push({
      key: "reimbursable",
      label: reimbursableFilter ? "Reimbursable" : "Non-reimbursable",
      clearHref: hrefWith({ reimbursable: undefined }),
    });
  }
  if (q) {
    filters.push({ key: "q", label: `Search: ${q}`, clearHref: hrefWith({ q: undefined }) });
  }

  const totalPages = Math.max(1, Math.ceil(matchedCount / pageSize));
  const pageHrefs = {
    prev: page > 1 ? hrefWith({ page: String(page - 1) }, false) : null,
    next: page < totalPages ? hrefWith({ page: String(page + 1) }, false) : null,
    pages: Array.from({ length: totalPages }, (_, index) => ({
      n: index + 1,
      href: hrefWith({ page: index + 1 === 1 ? undefined : String(index + 1) }, false),
    })).slice(0, 8),
  };

  const workspace: ExpenseWorkspaceData = {
    items,
    workers: memberships.map((membership) => ({
      membershipId: membership.id,
      name: membership.user.name,
    })),
    jobs: jobs.map((job) => ({
      id: job.id,
      label: jobLabel(job),
      customerId: job.customerId,
    })),
    customers,
    financial: {
      bankConnected: false,
      verifiedBalanceLabel: "Not connected",
      knownInflowsLabel: formatMoney(projection.knownInflows),
      knownInflowsDetail:
        sentInvoices._count._all === 0
          ? "No outstanding sent invoices"
          : `${sentInvoices._count._all} outstanding sent invoice${sentInvoices._count._all === 1 ? "" : "s"}`,
      knownOutflowsLabel: formatMoney(projection.knownOutflows),
      knownOutflowsDetail:
        upcomingExpenses._count._all === 0
          ? "No expenses dated in the next 30 days"
          : `${upcomingExpenses._count._all} recorded expense${upcomingExpenses._count._all === 1 ? "" : "s"} in the next 30 days`,
      projectedBalanceLabel: "Unavailable",
      projectedDetail: projection.unavailableReason,
    },
    filters,
    storageConfigured: isStorageConfigured(),
    defaultDate: formatISODate(now),
    page,
    totalPages,
    pageSize,
    matchedCount,
    rangeStartRow: matchedCount === 0 ? 0 : (page - 1) * pageSize + 1,
    rangeEndRow: Math.min(matchedCount, page * pageSize),
    pageHrefs,
  };

  return (
    <PageContainer width="2xl">
      <PageHeader
        title="Expenses"
        description="Track and manage business expenses."
      />

      <FounderDesignRoot
        pageKey="expenses"
        isFounder={Boolean(founder)}
        savedTokens={founderTokens}
        kpiCardLabels={kpis.map((kpi) => kpi.label)}
      >
        <FounderRegion id="kpi">
          <KpiCardsLayout gridClassName="grid-cols-1 sm:grid-cols-2 xl:grid-cols-5" defaultGapPx={20}>
            {kpis.map((kpi, index) => (
              <TunableKpiCard
                key={kpi.label}
                index={index}
                label={kpi.label}
                value={kpi.value}
                sublabel={kpi.sublabel}
                defaultIconId={kpi.defaultIconId}
                accentClassName={kpi.accentClassName}
                variant="workspace"
                pageKey="expenses"
              />
            ))}
          </KpiCardsLayout>
        </FounderRegion>

        <form action="/expenses" method="GET" className="flex flex-wrap items-end gap-2">
          {reimbursableFilter !== undefined ? (
            <input type="hidden" name="reimbursable" value={reimbursableFilter ? "yes" : "no"} />
          ) : null}
          {method ? <input type="hidden" name="method" value={method} /> : null}
          {showFilters ? <input type="hidden" name="filters" value="1" /> : null}
          <Input type="search" name="q" defaultValue={q} placeholder="Search expenses..." className="h-9 w-56" />
          <select
            name="range"
            defaultValue={rangePreset}
            className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm dark:bg-input/30"
            aria-label="Date range"
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            name="category"
            defaultValue={category ?? "all"}
            className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm dark:bg-input/30"
            aria-label="Category"
          >
            <option value="all">All categories</option>
            {EXPENSE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {EXPENSE_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
          <select
            name="purchaser"
            defaultValue={purchaserId ?? "all"}
            className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm dark:bg-input/30"
            aria-label="Employee"
          >
            <option value="all">All employees</option>
            {memberships.map((membership) => (
              <option key={membership.id} value={membership.id}>
                {membership.user.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="h-9 rounded-lg border border-input px-3 text-sm hover:bg-accent"
          >
            Apply filters
          </button>
          <Link
            href={hrefWith({ filters: showFilters ? undefined : "1" })}
            className={cn(
              "inline-flex h-9 items-center rounded-lg border border-input px-3 text-sm hover:bg-accent",
              showFilters && "bg-primary/10 text-primary",
            )}
          >
            Filters
          </Link>
        </form>

        <ExpensesWorkspace workspace={workspace} categories={categoryCards} showFilters={showFilters} />
      </FounderDesignRoot>
    </PageContainer>
  );
}
