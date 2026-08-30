"use client";

import { useState } from "react";
import Link from "next/link";
import { CreateEstimateButton } from "@/components/estimates/create-estimate-button";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
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

export type RequestListItem = {
  id: string;
  status: string;
  createdAtLabel: string;
  description: string | null;
  summary: string | null;
  serviceName: string | null;
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
      <EmptyState
        title="No requests match your filters"
        description="Try a different status, service, or search term. New public intake submissions for this workspace will also appear here."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      {/* Dense table at sm+ widths; a stacked, tap-friendly card list below
          that instead of forcing the same table into a narrow viewport
          (avoids horizontal scroll and tiny cramped cells on a phone). */}
      <div className="hidden sm:block">
        <RequestsTable requests={requests} selectedId={selectedId} onSelect={selectRequest} />
      </div>
      <div className="space-y-2 sm:hidden">
        <RequestsMobileList requests={requests} selectedId={selectedId} onSelect={selectRequest} />
      </div>

      <div className="hidden lg:block">
        <RequestDetailsPanel request={selected} />
      </div>

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
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/70 bg-muted/40 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-4 py-2.5 font-medium">Service / Request</th>
              <th className="px-4 py-2.5 font-medium">Date</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Action</th>
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
                    active && "bg-accent/60",
                  )}
                >
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium text-foreground">
                      {request.customer?.name ?? "Customer"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {request.customer?.phone || request.customer?.email || "No contact on file"}
                    </p>
                  </td>
                  <td className="max-w-56 px-4 py-3 align-top">
                    <p className="truncate font-medium text-foreground">
                      {request.serviceName ?? "Not specified"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {request.description || request.summary || "No description"}
                    </p>
                  </td>
                  <td className="px-4 py-3 align-top text-muted-foreground whitespace-nowrap">
                    {request.createdAtLabel}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <StatusBadge status={request.status} />
                  </td>
                  <td
                    className="px-4 py-3 text-right align-top"
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

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

function RequestDetailsPanel({ request }: { request: RequestListItem | null }) {
  if (!request) {
    return (
      <Card className="flex h-full min-h-64 items-center justify-center p-8 text-center">
        <p className="text-sm text-muted-foreground">Select a request to see its details.</p>
      </Card>
    );
  }

  const tel = telHref(request.customer?.phone ?? null);
  const mailto = request.customer?.email ? `mailto:${request.customer.email}` : null;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>{request.customer?.name ?? "Customer"}</CardTitle>
        <CardDescription>Request details</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge status={request.status} />
          <span className="text-muted-foreground">{request.createdAtLabel}</span>
        </div>
        <DetailField label="Requested service">
          {request.serviceName ?? "Not specified"}
        </DetailField>
        <DetailField label="Description">
          {request.description || request.summary || "No description provided."}
        </DetailField>
        <DetailField label="Contact">
          <p>{request.customer?.phone || "No phone on file"}</p>
          <p>{request.customer?.email || "No email on file"}</p>
        </DetailField>
        <DetailField label="Service address">
          {request.propertyLabel ?? "None on file"}
        </DetailField>
        {request.estimate ? (
          <DetailField label="Estimate">
            <div className="flex items-center gap-2">
              <StatusBadge status={request.estimate.status} />
              <span>{request.estimate.totalLabel}</span>
            </div>
          </DetailField>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {tel ? (
          <Button asChild size="sm" variant="outline">
            <a href={tel}>Call</a>
          </Button>
        ) : null}
        {mailto ? (
          <Button asChild size="sm" variant="outline">
            <a href={mailto}>Email</a>
          </Button>
        ) : null}
        {request.customer ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/customers/${request.customer.id}`}>Open customer</Link>
          </Button>
        ) : null}
        {request.estimate ? (
          <Button asChild size="sm">
            <Link href={`/estimates/${request.estimate.id}`}>Open estimate</Link>
          </Button>
        ) : (
          <CreateEstimateButton serviceRequestId={request.id} />
        )}
      </CardFooter>
    </Card>
  );
}
