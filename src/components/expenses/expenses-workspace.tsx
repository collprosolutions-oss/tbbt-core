"use client";

import { useActionState, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  Car,
  Check,
  ChevronDown,
  Flag,
  Filter,
  Plus,
  Receipt,
  Repeat,
  Upload,
} from "lucide-react";
import {
  reviewExpenseAction,
  setReimbursementStatusAction,
  type ExpenseActionState,
} from "@/app/actions/expenses";
import {
  AddExpenseSheet,
  type ExpenseSheetMode,
} from "@/components/expenses/add-expense-sheet";
import type {
  ExpenseCategoryCard,
  ExpenseListItem,
  ExpenseWorkspaceData,
} from "@/components/expenses/types";
import { EmptyState } from "@/components/empty-state";
import { FounderRegion } from "@/components/founder-design/region";
import { PageHeaderControls } from "@/components/page-header-controls";
import { StatusBadge } from "@/components/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EXPENSE_CATEGORY_ACCENTS } from "@/lib/expenses";
import { ICON_COLOR_CLASSES } from "@/lib/founder-icons";
import { cn } from "@/lib/utils";

const CATEGORY_ACCENT: Record<string, string> = {
  purple: ICON_COLOR_CLASSES.purple,
  orange: ICON_COLOR_CLASSES.orange,
  blue: ICON_COLOR_CLASSES.blue,
  green: ICON_COLOR_CLASSES.green,
  gold: ICON_COLOR_CLASSES.gold,
  gray: ICON_COLOR_CLASSES.gray,
  red: ICON_COLOR_CLASSES.red,
};

const BAR_COLORS: Record<string, string> = {
  purple: "bg-violet-500",
  orange: "bg-orange-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  gold: "bg-amber-500",
  gray: "bg-zinc-500",
  red: "bg-red-500",
};

export function ExpensesHeaderActions({
  storageConfigured,
  onAdd,
}: {
  storageConfigured: boolean;
  onAdd: (mode: ExpenseSheetMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="lg">
            <Plus />
            Add Expense
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onAdd("expense")}>Expense</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAdd("mileage")}>Mileage</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAdd("recurring")}>Recurring expense</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="lg"
        onClick={() => onAdd(storageConfigured ? "expense" : "expense")}
      >
        <Upload />
        Upload Receipt
      </Button>
    </div>
  );
}

export function ExpensesWorkspace({
  workspace,
  categories,
  showFilters,
}: {
  workspace: ExpenseWorkspaceData;
  categories: ExpenseCategoryCard[];
  showFilters?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(workspace.items[0]?.id ?? null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState<ExpenseSheetMode | null>(null);
  const selected = workspace.items.find((item) => item.id === selectedId) ?? null;

  function selectExpense(id: string) {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      setMobileOpen(true);
    }
  }

  return (
    <>
      <PageHeaderControls
        title="Expenses"
        actions={
          <ExpensesHeaderActions
            storageConfigured={workspace.storageConfigured}
            onAdd={setSheetMode}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 md:hidden">
        <ExpensesHeaderActions
          storageConfigured={workspace.storageConfigured}
          onAdd={setSheetMode}
        />
      </div>

      <FounderRegion id="categories">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Expenses by Category
          </h2>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {categories.map((card) => {
            const accent = EXPENSE_CATEGORY_ACCENTS[card.category];
            return (
              <Link key={card.category} href={card.href} className="min-w-0">
                <Card
                  className={cn(
                    "h-full border-border/70 shadow-sm transition-colors hover:border-primary/40",
                    card.active && "border-primary bg-primary/5",
                  )}
                >
                  <CardContent className="space-y-2 p-4">
                    <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                      {card.label}
                    </p>
                    <p className="text-lg font-semibold tabular-nums text-foreground">{card.amountLabel}</p>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", BAR_COLORS[accent])}
                        style={{ width: `${Math.min(100, card.percent)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {card.percent}% · {card.count} {card.count === 1 ? "expense" : "expenses"}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </FounderRegion>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,340px)]">
        <FounderRegion id="table">
          {workspace.items.length === 0 ? (
            <EmptyState
              title="No expenses match your filters"
              description="Add an expense, or try a different date range, category, or search."
              action={
                <Button onClick={() => setSheetMode("expense")}>
                  <Plus />
                  Add Expense
                </Button>
              }
            />
          ) : (
            <>
              <div className="hidden sm:block">
                <ExpensesTable
                  items={workspace.items}
                  selectedId={selectedId}
                  onSelect={selectExpense}
                />
              </div>
              <div className="space-y-2 sm:hidden">
                <ExpensesMobileList
                  items={workspace.items}
                  selectedId={selectedId}
                  onSelect={selectExpense}
                />
              </div>
              <Pagination workspace={workspace} />
            </>
          )}
        </FounderRegion>

        <FounderRegion id="rail" className="hidden lg:block">
          <RightRail
            selected={selected}
            workspace={workspace}
            onAdd={setSheetMode}
            showFilters={showFilters}
          />
        </FounderRegion>
      </div>

      <div className="lg:hidden">
        <RightRail
          selected={null}
          workspace={workspace}
          onAdd={setSheetMode}
          showFilters
          mobileSummary
        />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Expense details</SheetTitle>
          </SheetHeader>
          {selected ? <ExpenseDetails expense={selected} storageConfigured={workspace.storageConfigured} /> : null}
        </SheetContent>
      </Sheet>

      {sheetMode ? (
        <AddExpenseSheet
          open
          onOpenChange={(open) => {
            if (!open) setSheetMode(null);
          }}
          mode={sheetMode}
          workers={workspace.workers}
          jobs={workspace.jobs}
          customers={workspace.customers}
          defaultDate={workspace.defaultDate}
          storageConfigured={workspace.storageConfigured}
          attachExpenseId={selected?.id}
        />
      ) : null}
    </>
  );
}

function ExpensesTable({
  items,
  selectedId,
  onSelect,
}: {
  items: ExpenseListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
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
              {["Date", "Description", "Category", "Amount", "Employee", "Job / Customer", "Receipt", "Reimbursable", "Payment"].map(
                (label) => (
                  <th key={label} className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const active = item.id === selectedId;
              const accent = CATEGORY_ACCENT[EXPENSE_CATEGORY_ACCENTS[item.category as keyof typeof EXPENSE_CATEGORY_ACCENTS] ?? "gray"];
              return (
                <tr
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(item.id);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/60 outline-none transition-colors last:border-b-0 hover:bg-accent/40",
                    active && "bg-primary/10 hover:bg-primary/10",
                  )}
                  style={
                    {
                      "--tr-py": "var(--tbbt-table-row-py, 16px)",
                      "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                    } as CSSProperties
                  }
                >
                  <td
                    className={cn("whitespace-nowrap align-top text-muted-foreground", active && "border-l-2 border-l-primary")}
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                  >
                    {item.occurredOnLabel}
                  </td>
                  <td className="max-w-40 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <p className="truncate font-semibold text-foreground">{item.description}</p>
                    {item.vendor ? <p className="truncate text-xs text-muted-foreground">{item.vendor}</p> : null}
                    {item.recurring ? <p className="text-xs text-muted-foreground">Recurring</p> : null}
                  </td>
                  <td className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <Badge variant="outline" className={cn("border-transparent", accent)}>
                      {item.categoryLabel}
                    </Badge>
                  </td>
                  <td className="align-top font-semibold tabular-nums" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    {item.amountLabel}
                    {item.mileageMilesLabel ? (
                      <p className="text-xs font-normal text-muted-foreground">{item.mileageMilesLabel}</p>
                    ) : null}
                  </td>
                  <td className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    {item.purchaserName ? (
                      <div className="flex items-center gap-2">
                        <Avatar className="size-6">
                          <AvatarFallback className="text-[10px]">{item.purchaserInitials}</AvatarFallback>
                        </Avatar>
                        <span className="truncate">{item.purchaserName}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="max-w-36 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <p className="truncate">{item.jobLabel ?? "—"}</p>
                    {item.customerName ? (
                      <p className="truncate text-xs text-muted-foreground">{item.customerName}</p>
                    ) : null}
                  </td>
                  <td className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    {item.hasReceipt ? (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <Receipt className="size-4" />
                        <Check className="size-3" />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    {item.reimbursable ? <Badge variant="success">Yes</Badge> : <Badge variant="outline">No</Badge>}
                  </td>
                  <td className="align-top text-muted-foreground" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    {item.paymentMethodLabel ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ExpensesMobileList({
  items,
  selectedId,
  onSelect,
}: {
  items: ExpenseListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          className={cn(
            "w-full rounded-xl border border-border/70 bg-card p-4 text-left shadow-sm",
            item.id === selectedId && "border-primary bg-primary/5",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold">{item.description}</p>
              <p className="text-xs text-muted-foreground">
                {item.occurredOnLabel}
                {item.vendor ? ` · ${item.vendor}` : ""}
              </p>
            </div>
            <p className="shrink-0 font-semibold tabular-nums">{item.amountLabel}</p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">{item.categoryLabel}</Badge>
            {item.reimbursable ? <Badge variant="success">Reimbursable</Badge> : null}
            {item.jobLabel ? <span className="text-muted-foreground">{item.jobLabel}</span> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

function RightRail({
  selected,
  workspace,
  onAdd,
  showFilters,
  mobileSummary,
}: {
  selected: ExpenseListItem | null;
  workspace: ExpenseWorkspaceData;
  onAdd: (mode: ExpenseSheetMode) => void;
  showFilters?: boolean;
  mobileSummary?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Card className="border-border/70 shadow-sm">
        <CardHeader>
          <CardTitle>Financial Overview</CardTitle>
          <CardDescription>
            Projection uses a verified bank balance plus known TBBT flows. It is never the live bank balance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <OverviewRow
            label="Last Verified Bank Balance"
            value={workspace.financial.verifiedBalanceLabel}
            muted
          />
          <OverviewRow
            label="Known Inflows"
            value={workspace.financial.knownInflowsLabel}
            detail={workspace.financial.knownInflowsDetail}
            positive
          />
          <OverviewRow
            label="Known Outflows"
            value={workspace.financial.knownOutflowsLabel}
            detail={workspace.financial.knownOutflowsDetail}
            negative
          />
          <OverviewRow
            label="TBBT Projected Operating Balance"
            value={workspace.financial.projectedBalanceLabel}
            detail={workspace.financial.projectedDetail}
          />
        </CardContent>
      </Card>

      <Card className="border-border/70 shadow-sm">
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button variant="ghost" className="justify-start" onClick={() => onAdd("expense")}>
            <Plus />
            Add Expense
          </Button>
          <Button variant="ghost" className="justify-start" onClick={() => onAdd("mileage")}>
            <Car />
            Add Mileage
          </Button>
          <Button variant="ghost" className="justify-start" onClick={() => onAdd("recurring")}>
            <Repeat />
            Add Recurring Expense
          </Button>
        </CardContent>
      </Card>

      {showFilters || mobileSummary ? (
        <Card className="border-border/70 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter className="size-4" />
              Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {workspace.filters.length === 0 ? (
              <p className="text-sm text-muted-foreground">No extra filters applied.</p>
            ) : (
              workspace.filters.map((chip) => (
                <Link key={chip.key} href={chip.clearHref}>
                  <Badge variant="secondary">{chip.label} ×</Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      {selected && !mobileSummary ? (
        <ExpenseDetails expense={selected} storageConfigured={workspace.storageConfigured} />
      ) : null}
    </div>
  );
}

function OverviewRow({
  label,
  value,
  detail,
  muted,
  positive,
  negative,
}: {
  label: string;
  value: string;
  detail?: string;
  muted?: boolean;
  positive?: boolean;
  negative?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          "text-base font-semibold tabular-nums",
          muted && "text-muted-foreground",
          positive && "text-emerald-400",
          negative && "text-red-400",
        )}
      >
        {value}
      </p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function ExpenseDetails({
  expense,
  storageConfigured,
}: {
  expense: ExpenseListItem;
  storageConfigured: boolean;
}) {
  const [reviewState, reviewAction, reviewPending] = useActionState(reviewExpenseAction, {} as ExpenseActionState);
  const [reimbState, reimbAction, reimbPending] = useActionState(
    setReimbursementStatusAction,
    {} as ExpenseActionState,
  );

  return (
    <Card className="border-border/70 shadow-sm">
      <CardHeader>
        <CardTitle>Expense</CardTitle>
        <CardDescription>{expense.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-lg font-semibold tabular-nums">{expense.amountLabel}</p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{expense.categoryLabel}</Badge>
          <StatusBadge status={expense.reviewStatus} />
          {expense.reimbursable ? <Badge variant="success">{expense.reimbursementLabel}</Badge> : null}
        </div>
        <p className="text-muted-foreground">{expense.occurredOnLabel}</p>
        {expense.vendor ? <p>Vendor: {expense.vendor}</p> : null}
        {expense.purchaserName ? <p>Purchaser: {expense.purchaserName}</p> : null}
        {expense.jobLabel ? <p>Job: {expense.jobLabel}</p> : null}
        {expense.customerName ? <p>Customer: {expense.customerName}</p> : null}
        {expense.mileageMilesLabel ? <p>Miles: {expense.mileageMilesLabel}</p> : null}
        {expense.paymentMethodLabel ? <p>Paid with: {expense.paymentMethodLabel}</p> : null}
        {expense.taxCategoryLabel ? <p>Tax: {expense.taxCategoryLabel}</p> : null}
        {expense.notes ? <p>{expense.notes}</p> : null}
        {expense.hasReceipt && expense.receiptUrl ? (
          <a href={expense.receiptUrl} target="_blank" rel="noreferrer" className="text-primary underline">
            View receipt
          </a>
        ) : (
          <p className="text-muted-foreground">
            {storageConfigured ? "No receipt attached." : "No receipt. Storage is not connected."}
          </p>
        )}

        <form action={reviewAction} className="flex flex-wrap gap-2">
          <input type="hidden" name="expenseId" value={expense.id} />
          <Button type="submit" name="reviewStatus" value="APPROVED" size="sm" disabled={reviewPending}>
            <Check />
            Approve
          </Button>
          <Button
            type="submit"
            name="reviewStatus"
            value="FLAGGED"
            size="sm"
            variant="outline"
            disabled={reviewPending}
          >
            <Flag />
            Flag
          </Button>
        </form>
        {reviewState.error ? <p className="text-sm text-destructive">{reviewState.error}</p> : null}

        {expense.reimbursable ? (
          <form action={reimbAction}>
            <input type="hidden" name="expenseId" value={expense.id} />
            <Button
              type="submit"
              name="reimbursementStatus"
              value="REIMBURSED"
              size="sm"
              variant="secondary"
              disabled={reimbPending || expense.reimbursementStatus === "REIMBURSED"}
            >
              Mark reimbursed
            </Button>
          </form>
        ) : null}
        {reimbState.error ? <p className="text-sm text-destructive">{reimbState.error}</p> : null}
      </CardContent>
    </Card>
  );
}

function Pagination({ workspace }: { workspace: ExpenseWorkspaceData }) {
  if (workspace.matchedCount === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <p>
        Showing {workspace.rangeStartRow} to {workspace.rangeEndRow} of {workspace.matchedCount} expenses
      </p>
      <div className="flex items-center gap-1">
        {workspace.pageHrefs.pages.map((page) => (
          <Link
            key={page.n}
            href={page.href}
            className={cn(
              "rounded-md px-2.5 py-1 text-sm",
              page.n === workspace.page ? "bg-primary/15 font-semibold text-primary" : "hover:bg-accent",
            )}
          >
            {page.n}
          </Link>
        ))}
      </div>
    </div>
  );
}
