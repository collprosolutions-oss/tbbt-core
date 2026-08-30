"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { Briefcase, ExternalLink, FileText, Mail, MapPin, Phone, Receipt } from "lucide-react";
import { MarkInvoicePaidForm } from "@/components/invoices/mark-invoice-paid-form";
import { MarkInvoiceSentButton } from "@/components/invoices/mark-invoice-sent-button";
import { CopyProjectLinkButton } from "@/components/jobs/copy-project-link-button";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { telHref } from "@/lib/directions";
import { cn } from "@/lib/utils";

export type InvoiceListItem = {
  id: string;
  status: string;
  totalLabel: string;
  balanceLabel: string;
  createdAtLabel: string;
  customer: { id: string; name: string; phone: string | null; email: string | null } | null;
  propertyLabel: string | null;
  scopeSummary: string | null;
  jobId: string | null;
  jobProjectToken: string | null;
  paidAtLabel: string | null;
  paymentMethodLabel: string | null;
  paymentReference: string | null;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The Invoices master/detail workspace: a dense table (desktop) or
 * stacked card list (mobile), plus an Invoice Details panel (right on
 * desktop, a bottom sheet on mobile). Every mutation button here (Mark
 * Sent, Record Payment) is the exact same real, already-tested server
 * action used on the full invoice detail page
 * (src/app/(app)/invoices/[invoiceId]/page.tsx) -- nothing here
 * reimplements or bypasses that lifecycle.
 */
export function InvoicesWorkspace({ invoices }: { invoices: InvoiceListItem[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(invoices[0]?.id ?? null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const selected = invoices.find((invoice) => invoice.id === selectedId) ?? null;

  function selectInvoice(id: string) {
    setSelectedId(id);
    // Only open the bottom sheet below the `lg` breakpoint where the
    // desktop Details panel (rendered separately, see below) is hidden.
    // Sheet's overlay covers the full viewport and intercepts pointer
    // events on the table beneath it regardless of whether its content
    // is itself hidden by a `lg:hidden` class -- the exact bug found and
    // fixed on Estimates/Jobs. This must never open on desktop, or every
    // row after the first becomes unclickable.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      setMobileOpen(true);
    }
  }

  if (invoices.length === 0) {
    return (
      <EmptyState
        title="No invoices match your filters"
        description="Try a different status, customer, payment method, or search term."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="hidden sm:block">
        <InvoicesTable invoices={invoices} selectedId={selectedId} onSelect={selectInvoice} />
      </div>
      <div className="space-y-2 sm:hidden">
        <InvoicesMobileList invoices={invoices} selectedId={selectedId} onSelect={selectInvoice} />
      </div>

      <div className="hidden lg:block">
        <InvoiceDetailsPanel invoice={selected} />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Invoice details</SheetTitle>
          </SheetHeader>
          <InvoiceDetailsPanel invoice={selected} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function InvoicesTable({
  invoices,
  selectedId,
  onSelect,
}: {
  invoices: InvoiceListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden border-border/70 p-0 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/70 bg-muted/50 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-2 py-3.5 font-semibold">Invoice #</th>
              <th className="px-2 py-3.5 font-semibold">Customer</th>
              <th className="px-2 py-3.5 font-semibold">Job / Service</th>
              <th className="px-2 py-3.5 font-semibold">Date</th>
              <th className="px-2 py-3.5 font-semibold">Status</th>
              <th className="px-2 py-3.5 text-right font-semibold">Amount</th>
              <th className="px-2 py-3.5 text-right font-semibold">Balance</th>
              <th className="px-2 py-3.5 text-right font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => {
              const active = invoice.id === selectedId;
              return (
                <tr
                  key={invoice.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(invoice.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(invoice.id);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/60 outline-none transition-colors last:border-b-0 hover:bg-accent/40",
                    active && "bg-primary/10 hover:bg-primary/10",
                  )}
                >
                  <td
                    className={cn(
                      "px-2 py-4 align-top font-mono text-xs text-muted-foreground",
                      active && "border-l-2 border-l-primary",
                    )}
                  >
                    #{invoice.id.slice(-8)}
                  </td>
                  <td className="max-w-20 px-2 py-4 align-top">
                    <p className="truncate text-[0.95rem] font-semibold text-foreground">
                      {invoice.customer?.name ?? "Customer"}
                    </p>
                    {invoice.propertyLabel ? (
                      <p className="truncate text-xs text-muted-foreground">{invoice.propertyLabel}</p>
                    ) : null}
                  </td>
                  <td className="max-w-24 px-2 py-4 align-top">
                    <p className="truncate text-[0.95rem] font-medium text-foreground">
                      {invoice.scopeSummary ?? "—"}
                    </p>
                  </td>
                  <td className="px-2 py-4 align-top text-muted-foreground whitespace-nowrap">
                    {invoice.createdAtLabel}
                  </td>
                  <td className="px-2 py-4 align-top">
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td className="px-2 py-4 text-right align-top tabular-nums font-semibold text-foreground whitespace-nowrap">
                    {invoice.totalLabel}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-4 text-right align-top tabular-nums whitespace-nowrap",
                      invoice.status === "PAID" ? "text-emerald-500" : "font-medium text-amber-500",
                    )}
                  >
                    {invoice.balanceLabel}
                  </td>
                  <td
                    className="px-2 py-4 text-right align-top"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/invoices/${invoice.id}`}>Open</Link>
                    </Button>
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

function InvoicesMobileList({
  invoices,
  selectedId,
  onSelect,
}: {
  invoices: InvoiceListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {invoices.map((invoice) => {
        const active = invoice.id === selectedId;
        return (
          <button
            key={invoice.id}
            type="button"
            onClick={() => onSelect(invoice.id)}
            className={cn(
              "block w-full rounded-xl border p-3.5 text-left transition-colors active:bg-accent/60",
              active ? "border-primary/40 bg-accent/40" : "border-border/70 bg-card/40",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{invoice.customer?.name ?? "Customer"}</p>
                <p className="truncate text-xs text-muted-foreground">{invoice.scopeSummary ?? "—"}</p>
              </div>
              <StatusBadge status={invoice.status} />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-mono">#{invoice.id.slice(-8)}</span>
              <span className="text-sm font-semibold text-foreground">{invoice.totalLabel}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>{invoice.createdAtLabel}</span>
              {invoice.status !== "PAID" ? (
                <span className="font-medium text-amber-500">Balance {invoice.balanceLabel}</span>
              ) : (
                <span className="text-emerald-500">Paid in full</span>
              )}
            </div>
          </button>
        );
      })}
    </>
  );
}

function DetailField({
  icon: Icon,
  label,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {Icon ? <Icon className="size-3.5" /> : null}
        {label}
      </p>
      <div className="text-[0.95rem] text-foreground">{children}</div>
    </div>
  );
}

function InvoiceDetailsPanel({ invoice }: { invoice: InvoiceListItem | null }) {
  if (!invoice) {
    return (
      <Card className="flex h-full min-h-64 items-center justify-center border-border/70 p-8 text-center">
        <p className="text-sm text-muted-foreground">Select an invoice to see its details.</p>
      </Card>
    );
  }

  const tel = telHref(invoice.customer?.phone ?? null);
  const mailto = invoice.customer?.email ? `mailto:${invoice.customer.email}` : null;
  const customerName = invoice.customer?.name ?? "Customer";
  const isDraft = invoice.status === "DRAFT";
  const isSent = invoice.status === "SENT";
  const isPaid = invoice.status === "PAID";

  return (
    <Card className="flex h-full flex-col border-border/70 shadow-sm">
      <CardHeader className="border-b border-border/60 pb-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Avatar size="lg" className="ring-2 ring-primary/15">
              <AvatarFallback className="bg-primary/15 text-base font-semibold text-primary">
                {initials(customerName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <CardTitle className="text-xl">{customerName}</CardTitle>
              <CardDescription className="font-mono">#{invoice.id.slice(-8)}</CardDescription>
            </div>
          </div>
          <StatusBadge status={invoice.status} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-6 overflow-y-auto pt-5">
        <DetailField icon={FileText} label="Created">
          {invoice.createdAtLabel}
        </DetailField>

        <DetailField icon={Phone} label="Contact">
          <p>{invoice.customer?.phone || "No phone on file"}</p>
          <p>{invoice.customer?.email || "No email on file"}</p>
        </DetailField>

        <DetailField icon={MapPin} label="Service address">
          {invoice.propertyLabel ?? "None on file"}
        </DetailField>

        <DetailField icon={Briefcase} label="Billed for">
          {invoice.scopeSummary ?? "No linked job scope on file"}
        </DetailField>

        <div className="space-y-1 rounded-lg border border-border/60 bg-card/40 p-3 text-sm">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Total</span>
            <span className="tabular-nums text-foreground">{invoice.totalLabel}</span>
          </div>
          <div className="flex items-center justify-between border-t border-border/60 pt-2 text-base font-semibold text-foreground">
            <span>Balance Due</span>
            <span className={cn("tabular-nums", isPaid ? "text-emerald-500" : "text-amber-500")}>
              {invoice.balanceLabel}
            </span>
          </div>
        </div>

        {isPaid ? (
          <DetailField icon={Receipt} label="Payment">
            <p>Paid {invoice.paidAtLabel}</p>
            <p className="text-muted-foreground">
              {invoice.paymentMethodLabel ?? "Unknown method"}
              {invoice.paymentReference ? ` · ${invoice.paymentReference}` : ""}
            </p>
          </DetailField>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 border-t border-border/60 pt-5">
        {tel ? (
          <Button asChild variant="outline">
            <a href={tel}>
              <Phone className="size-4" />
              Call
            </a>
          </Button>
        ) : null}
        {mailto ? (
          <Button asChild variant="outline">
            <a href={mailto}>
              <Mail className="size-4" />
              Email
            </a>
          </Button>
        ) : null}
        {isDraft ? <MarkInvoiceSentButton invoiceId={invoice.id} /> : null}
        {isSent ? <MarkInvoicePaidForm invoiceId={invoice.id} /> : null}
        {invoice.customer ? (
          <Button asChild variant="outline">
            <Link href={`/customers/${invoice.customer.id}`}>Open Customer</Link>
          </Button>
        ) : null}
        {invoice.jobId ? (
          <Button asChild variant="outline">
            <Link href={`/jobs/${invoice.jobId}`}>
              <ExternalLink className="size-4" />
              Open Job
            </Link>
          </Button>
        ) : null}
        {invoice.jobProjectToken ? (
          <CopyProjectLinkButton projectToken={invoice.jobProjectToken} />
        ) : null}
      </CardFooter>
    </Card>
  );
}
