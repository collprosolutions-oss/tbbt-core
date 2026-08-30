"use client";

import { useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { Briefcase, ExternalLink, FileText, Mail, MapPin, Phone } from "lucide-react";
import { ClearDraftEstimateButton } from "@/components/estimates/clear-draft-estimate-button";
import { CopyEstimateLinkButton } from "@/components/estimates/copy-estimate-link-button";
import { EditEstimateButton } from "@/components/estimates/edit-estimate-button";
import { EmailEstimateButton } from "@/components/estimates/email-estimate-button";
import { SendEstimateButton } from "@/components/estimates/send-estimate-button";
import { EmptyState } from "@/components/empty-state";
import { CreateJobButton } from "@/components/jobs/create-job-button";
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

export type EstimateLineItem = {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
  type: "LABOR" | "MATERIAL" | "OTHER";
};

export type EstimateListItem = {
  id: string;
  status: string;
  totalLabel: string;
  createdAtLabel: string;
  serviceLabel: string;
  isManual: boolean;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  propertyLabel: string | null;
  laborMinimumWaived: boolean;
  laborMinimumAdjustmentLabel: string | null;
  lineItems: EstimateLineItem[];
  laborSubtotalLabel: string;
  materialSubtotalLabel: string | null;
  otherSubtotalLabel: string | null;
  jobId: string | null;
  hasCustomerEmail: boolean;
  publicToken: string;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The Estimates master/detail workspace: a dense table (left, desktop) or
 * stacked card list (mobile), plus an Estimate Details panel (right on
 * desktop, a bottom sheet on mobile). All data is pre-fetched and already
 * business/tenant-scoped and filtered server-side (see
 * src/app/(app)/estimates/page.tsx); selecting a row only changes local
 * client state -- it never triggers a new fetch or exposes another
 * business's data. Every mutation button here (Send, Return to Draft,
 * Email, Create/Open Job, Copy link) is the SAME real, already-tested
 * server action used on the full estimate builder page
 * (src/app/(app)/estimates/[estimateId]/page.tsx) -- nothing here
 * reimplements or bypasses that lifecycle.
 */
export function EstimatesWorkspace({ estimates }: { estimates: EstimateListItem[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(estimates[0]?.id ?? null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const selected = estimates.find((estimate) => estimate.id === selectedId) ?? null;

  function selectEstimate(id: string) {
    setSelectedId(id);
    // Only open the bottom sheet below the `lg` breakpoint where the
    // desktop Details panel (rendered separately, see below) is hidden.
    // Sheet's overlay covers the full viewport and intercepts pointer
    // events on the table beneath it regardless of whether its content
    // is itself hidden by a `lg:hidden` class, so this must never open on
    // desktop -- otherwise every row after the first becomes unclickable.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      setMobileOpen(true);
    }
  }

  if (estimates.length === 0) {
    return (
      <EmptyState
        title="No estimates match your filters"
        description="Try a different status, customer, service, or search term."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,350px)]">
      <div className="hidden sm:block">
        <EstimatesTable estimates={estimates} selectedId={selectedId} onSelect={selectEstimate} />
      </div>
      <div className="space-y-2 sm:hidden">
        <EstimatesMobileList estimates={estimates} selectedId={selectedId} onSelect={selectEstimate} />
      </div>

      <div className="hidden lg:block">
        <EstimateDetailsPanel estimate={selected} />
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Estimate details</SheetTitle>
          </SheetHeader>
          <EstimateDetailsPanel estimate={selected} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EstimatesTable({
  estimates,
  selectedId,
  onSelect,
}: {
  estimates: EstimateListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden border-border/70 p-0 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="border-b border-border/70 bg-muted/50 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              style={{ "--th-py": "var(--tbbt-table-header-py, 14px)" } as CSSProperties}
            >
              <th className="px-2.5 font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Estimate #</th>
              <th className="px-2.5 font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Customer</th>
              <th className="px-2.5 font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Service / Description</th>
              <th className="px-2.5 text-right font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Amount</th>
              <th className="px-2.5 font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Status</th>
              <th className="px-2.5 font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Date</th>
              <th className="px-2.5 text-right font-semibold" style={{ paddingBlock: "var(--th-py)" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {estimates.map((estimate) => {
              const active = estimate.id === selectedId;
              return (
                <tr
                  key={estimate.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(estimate.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(estimate.id);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/60 outline-none transition-colors last:border-b-0 hover:bg-accent/40",
                    active && "bg-primary/10 hover:bg-primary/10",
                  )}
                  style={{ "--tr-py": "var(--tbbt-table-row-py, 16px)" } as CSSProperties}
                >
                  <td
                    className={cn(
                      "px-2.5 align-top font-mono text-xs text-muted-foreground",
                      active && "border-l-2 border-l-primary",
                    )}
                    style={{ paddingBlock: "var(--tr-py)" }}
                  >
                    #{estimate.id.slice(-8)}
                  </td>
                  <td className="max-w-24 px-2.5 align-top" style={{ paddingBlock: "var(--tr-py)" }}>
                    <p className="truncate text-[0.95rem] font-semibold text-foreground">
                      {estimate.customer?.name ?? "Customer"}
                    </p>
                    {estimate.propertyLabel ? (
                      <p className="truncate text-xs text-muted-foreground">{estimate.propertyLabel}</p>
                    ) : null}
                  </td>
                  <td className="max-w-32 px-2.5 align-top" style={{ paddingBlock: "var(--tr-py)" }}>
                    <p className="truncate text-[0.95rem] font-medium text-foreground">{estimate.serviceLabel}</p>
                  </td>
                  <td
                    className="px-2.5 text-right align-top tabular-nums font-semibold text-foreground whitespace-nowrap"
                    style={{ paddingBlock: "var(--tr-py)" }}
                  >
                    {estimate.totalLabel}
                  </td>
                  <td className="px-2.5 align-top" style={{ paddingBlock: "var(--tr-py)" }}>
                    <StatusBadge status={estimate.status} />
                  </td>
                  <td
                    className="px-2.5 align-top text-muted-foreground whitespace-nowrap"
                    style={{ paddingBlock: "var(--tr-py)" }}
                  >
                    {estimate.createdAtLabel}
                  </td>
                  <td
                    className="px-2.5 text-right align-top"
                    style={{ paddingBlock: "var(--tr-py)" }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/estimates/${estimate.id}`}>Open</Link>
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

function EstimatesMobileList({
  estimates,
  selectedId,
  onSelect,
}: {
  estimates: EstimateListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {estimates.map((estimate) => {
        const active = estimate.id === selectedId;
        return (
          <button
            key={estimate.id}
            type="button"
            onClick={() => onSelect(estimate.id)}
            className={cn(
              "block w-full rounded-xl border p-3.5 text-left transition-colors active:bg-accent/60",
              active ? "border-primary/40 bg-accent/40" : "border-border/70 bg-card/40",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{estimate.customer?.name ?? "Customer"}</p>
                <p className="truncate text-xs text-muted-foreground">{estimate.serviceLabel}</p>
              </div>
              <StatusBadge status={estimate.status} />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-mono">#{estimate.id.slice(-8)}</span>
              <span className="text-sm font-semibold text-foreground">{estimate.totalLabel}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{estimate.createdAtLabel}</p>
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

function LineItemTypeLabel(type: EstimateLineItem["type"]) {
  return type === "LABOR" ? "Labor" : type === "MATERIAL" ? "Material" : "Other";
}

function EstimateDetailsPanel({ estimate }: { estimate: EstimateListItem | null }) {
  if (!estimate) {
    return (
      <Card className="flex h-full min-h-64 items-center justify-center border-border/70 p-8 text-center">
        <p className="text-sm text-muted-foreground">Select an estimate to see its details.</p>
      </Card>
    );
  }

  const tel = telHref(estimate.customer?.phone ?? null);
  const mailto = estimate.customer?.email ? `mailto:${estimate.customer.email}` : null;
  const customerName = estimate.customer?.name ?? "Customer";
  const isDraft = estimate.status === "DRAFT";
  const isSent = estimate.status === "SENT";
  const isApproved = estimate.status === "APPROVED";

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
              <CardDescription className="font-mono">#{estimate.id.slice(-8)}</CardDescription>
            </div>
          </div>
          <StatusBadge status={estimate.status} />
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-6 overflow-y-auto pt-5">
        <DetailField icon={FileText} label="Estimate Summary">
          <p>Date Created: {estimate.createdAtLabel}</p>
          <p className="text-muted-foreground">
            {estimate.isManual ? "Manual estimate" : estimate.serviceLabel}
          </p>
        </DetailField>

        <DetailField icon={Phone} label="Contact">
          <p>{estimate.customer?.phone || "No phone on file"}</p>
          <p>{estimate.customer?.email || "No email on file"}</p>
        </DetailField>

        <DetailField icon={MapPin} label="Service address">
          {estimate.propertyLabel ?? "None on file"}
        </DetailField>

        <div className="space-y-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Line Items
          </p>
          {estimate.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items yet.</p>
          ) : (
            <ul className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3 text-sm">
              {estimate.lineItems.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words text-foreground">
                    <span className="text-muted-foreground">{LineItemTypeLabel(item.type)}:</span>{" "}
                    {item.description} × {item.quantity}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-foreground">{item.total}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1 text-sm">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Labor subtotal</span>
              <span className="tabular-nums">{estimate.laborSubtotalLabel}</span>
            </div>
            {estimate.materialSubtotalLabel ? (
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Materials</span>
                <span className="tabular-nums">{estimate.materialSubtotalLabel}</span>
              </div>
            ) : null}
            {estimate.otherSubtotalLabel ? (
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Other</span>
                <span className="tabular-nums">{estimate.otherSubtotalLabel}</span>
              </div>
            ) : null}
            {estimate.laborMinimumAdjustmentLabel ? (
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Labor Minimum Service Fee Adjustment</span>
                <span className="tabular-nums">{estimate.laborMinimumAdjustmentLabel}</span>
              </div>
            ) : null}
            {estimate.laborMinimumWaived ? (
              <p className="text-xs text-muted-foreground">Labor minimum waived for this estimate.</p>
            ) : null}
            <div className="flex items-center justify-between border-t border-border/60 pt-2 text-base font-semibold text-foreground">
              <span>Total</span>
              <span className="tabular-nums">{estimate.totalLabel}</span>
            </div>
          </div>
        </div>
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
        {isDraft ? (
          <>
            <Button asChild variant="outline">
              <Link href={`/estimates/${estimate.id}`}>Edit Estimate</Link>
            </Button>
            <SendEstimateButton estimateId={estimate.id} disabled={estimate.lineItems.length === 0} />
            {estimate.lineItems.length > 0 ? (
              <ClearDraftEstimateButton estimateId={estimate.id} />
            ) : null}
          </>
        ) : null}
        {isSent ? (
          <>
            <EditEstimateButton estimateId={estimate.id} />
            <CopyEstimateLinkButton publicToken={estimate.publicToken} />
            {estimate.hasCustomerEmail ? <EmailEstimateButton estimateId={estimate.id} /> : null}
          </>
        ) : null}
        {isApproved ? (
          estimate.jobId ? (
            <Button asChild>
              <Link href={`/jobs/${estimate.jobId}`}>
                <Briefcase className="size-4" />
                Open Job
              </Link>
            </Button>
          ) : (
            <CreateJobButton estimateId={estimate.id} />
          )
        ) : null}
        {estimate.jobId && !isApproved ? (
          <Button asChild variant="outline">
            <Link href={`/jobs/${estimate.jobId}`}>Open Job</Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost" className="ml-auto">
          <Link href={`/estimates/${estimate.id}`}>
            <ExternalLink className="size-4" />
            Open full estimate
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
