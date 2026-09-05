"use client";

import { useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { FileText, Mail, MapPin, Phone, Receipt, Wrench } from "lucide-react";
import { CreateEstimateButton } from "@/components/estimates/create-estimate-button";
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
import { FounderRegion } from "@/components/founder-design/region";
import { cn } from "@/lib/utils";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export type RequestListItem = {
  id: string;
  status: string;
  createdAtLabel: string;
  description: string | null;
  summary: string | null;
  serviceName: string | null;
  requestedTasks: string[];
  photoCount: number;
  photoSrcs: string[];
  measurementLabels: string[];
  propertyLabel: string | null;
  customer: { id: string; name: string; email: string | null; phone: string | null } | null;
  /** Pre-formatted (Decimal -> string) server-side -- never passed as a Decimal instance across the client boundary. */
  estimate: { id: string; status: string; totalLabel: string } | null;
};

/**
 * The Requests master/detail workspace: a dense operating table (left) and
 * a Request Details panel (right on desktop, a bottom sheet on mobile --
 * see the MOBILE section of the spec). All data is pre-fetched, already
 * business/tenant-scoped and already filtered server-side (see
 * src/app/(app)/requests/page.tsx); selecting a row only changes local
 * client state, never triggers a new fetch or exposes any other
 * business's data.
 */
export function RequestsWorkspace({ requests }: { requests: RequestListItem[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(requests[0]?.id ?? null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const selected = requests.find((request) => request.id === selectedId) ?? null;

  function selectRequest(id: string) {
    setSelectedId(id);
    setMobileOpen(true);
  }

  if (requests.length === 0) {
    return (
      <FounderRegion id="table">
        <EmptyState
          title="No requests match your filters"
          description="Try a different status, service, or search term. New public intake submissions for this workspace will also appear here."
        />
      </FounderRegion>
    );
  }

  return (
    <div
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_var(--tbbt-panel-width,280px)]"
    >
      {/* Dense table at sm+ widths; a stacked, tap-friendly card list below
          that instead of forcing the same table into a narrow viewport
          (avoids horizontal scroll and tiny cramped cells on a phone). */}
      <FounderRegion id="table">
      <div className="hidden sm:block">
        <RequestsTable requests={requests} selectedId={selectedId} onSelect={selectRequest} />
      </div>
      <div className="space-y-2 sm:hidden">
        <RequestsMobileList requests={requests} selectedId={selectedId} onSelect={selectRequest} />
      </div>
      </FounderRegion>

      <FounderRegion id="details" className="hidden lg:block">
        <RequestDetailsPanel request={selected} />
      </FounderRegion>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Request details</SheetTitle>
          </SheetHeader>
          <RequestDetailsPanel request={selected} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RequestsTable({
  requests,
  selectedId,
  onSelect,
}: {
  requests: RequestListItem[];
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
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Customer</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Service / Request</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Date</th>
              <th className="font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Status</th>
              <th className="text-right font-semibold" style={{ padding: "var(--th-py) var(--cell-px)" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => {
              const active = request.id === selectedId;
              return (
                <tr
                  key={request.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(request.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(request.id);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/60 outline-none transition-colors last:border-b-0 hover:bg-accent/40",
                    active && "bg-primary/10 hover:bg-primary/10",
                  )}
                  style={
                    {
                      "--tr-py": "var(--tbbt-table-row-py, 20px)",
                      "--cell-px": "var(--tbbt-table-cell-px, 8px)",
                    } as CSSProperties
                  }
                >
                  <td
                    className={cn("max-w-20 align-top", active && "border-l-2 border-l-primary")}
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                  >
                    <p className="truncate font-semibold text-foreground" style={{ fontSize: "1.09em" }}>
                      {request.customer?.name ?? "Customer"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {request.customer?.phone || request.customer?.email || "No contact on file"}
                    </p>
                  </td>
                  <td className="max-w-20 align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <p className="truncate font-medium text-foreground" style={{ fontSize: "1.09em" }}>
                      {request.serviceName ?? "Not specified"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {request.description || request.summary || "No description"}
                    </p>
                  </td>
                  <td
                    className="max-w-24 align-top text-muted-foreground whitespace-nowrap"
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                  >
                    {request.createdAtLabel}
                  </td>
                  <td className="align-top" style={{ padding: "var(--tr-py) var(--cell-px)" }}>
                    <StatusBadge status={request.status} />
                  </td>
                  <td
                    className="text-right align-top"
                    style={{ padding: "var(--tr-py) var(--cell-px)" }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {request.estimate ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/estimates/${request.estimate.id}`}>Open estimate</Link>
                      </Button>
                    ) : (
                      <CreateEstimateButton serviceRequestId={request.id} />
                    )}
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

function RequestsMobileList({
  requests,
  selectedId,
  onSelect,
}: {
  requests: RequestListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {requests.map((request) => {
        const active = request.id === selectedId;
        return (
          <button
            key={request.id}
            type="button"
            onClick={() => onSelect(request.id)}
            className={cn(
              "block w-full rounded-xl border p-3.5 text-left transition-colors active:bg-accent/60",
              active ? "border-primary/40 bg-accent/40" : "border-border/70 bg-card/40",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {request.customer?.name ?? "Customer"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {request.customer?.phone || request.customer?.email || "No contact on file"}
                </p>
              </div>
              <StatusBadge status={request.status} />
            </div>
            <p className="mt-2 truncate text-sm font-medium text-foreground">
              {request.serviceName ?? "Not specified"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {request.description || request.summary || "No description"}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{request.createdAtLabel}</p>
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

function RequestDetailsPanel({ request }: { request: RequestListItem | null }) {
  if (!request) {
    return (
      <Card className="flex h-full min-h-64 items-center justify-center border-border/70 p-8 text-center">
        <p className="text-sm text-muted-foreground">Select a request to see its details.</p>
      </Card>
    );
  }

  const tel = telHref(request.customer?.phone ?? null);
  const mailto = request.customer?.email ? `mailto:${request.customer.email}` : null;
  const customerName = request.customer?.name ?? "Customer";

  return (
    <Card className="flex h-full flex-col border-border/70 shadow-sm">
      <CardHeader className="border-b border-border/60 pb-5">
        <div className="flex items-center gap-3">
          <Avatar size="lg" className="ring-2 ring-primary/15">
            <AvatarFallback className="bg-primary/15 text-base font-semibold text-primary">
              {initials(customerName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <CardTitle className="text-xl">{customerName}</CardTitle>
            <CardDescription>Request details</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-6 pt-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={request.status} />
          <span className="text-muted-foreground">{request.createdAtLabel}</span>
        </div>
        <DetailField icon={Wrench} label="Requested Work">
          {request.requestedTasks.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {request.requestedTasks.map((task) => (
                <li key={task}>{task}</li>
              ))}
            </ul>
          ) : (
            request.serviceName ?? "Not specified"
          )}
        </DetailField>
        <DetailField icon={FileText} label="Description">
          {request.description || request.summary || "No description provided."}
        </DetailField>
        {request.measurementLabels.length > 0 ? (
          <DetailField label="Approximate measurements">
            <ul className="space-y-1">
              {request.measurementLabels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </DetailField>
        ) : null}
        {request.photoCount > 0 ? (
          <DetailField label="Project photos">
            <div className="grid grid-cols-2 gap-2">
              {request.photoSrcs.map((src) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={src}
                  src={src}
                  alt=""
                  className="aspect-square w-full rounded-md object-cover"
                />
              ))}
            </div>
          </DetailField>
        ) : null}
        <DetailField icon={Phone} label="Contact">
          <p>{request.customer?.phone || "No phone on file"}</p>
          <p>{request.customer?.email || "No email on file"}</p>
        </DetailField>
        <DetailField icon={MapPin} label="Service address">
          {request.propertyLabel ?? "None on file"}
        </DetailField>
        {request.estimate ? (
          <DetailField icon={Receipt} label="Estimate">
            <div className="flex items-center gap-2">
              <StatusBadge status={request.estimate.status} />
              <span className="font-semibold">{request.estimate.totalLabel}</span>
            </div>
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
        {request.customer ? (
          <Button asChild variant="outline">
            <Link href={`/customers/${request.customer.id}`}>Open customer</Link>
          </Button>
        ) : null}
        {request.estimate ? (
          <Button asChild>
            <Link href={`/estimates/${request.estimate.id}`}>Open estimate</Link>
          </Button>
        ) : (
          <CreateEstimateButton serviceRequestId={request.id} />
        )}
      </CardFooter>
    </Card>
  );
}
