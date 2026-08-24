import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";
import { formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Dashboard",
};

const COUNT_CARDS = [
  { key: "openRequests", label: "Open requests", href: "/requests" },
  { key: "draftEstimates", label: "Draft estimates", href: "/estimates" },
  { key: "approvedEstimates", label: "Approved estimates", href: "/estimates" },
  { key: "unscheduledJobs", label: "Unscheduled jobs", href: "/jobs" },
  { key: "scheduledJobs", label: "Scheduled jobs", href: "/jobs" },
  { key: "completedJobs", label: "Completed jobs", href: "/jobs" },
  { key: "draftInvoices", label: "Draft invoices", href: "/invoices" },
  { key: "paidInvoices", label: "Paid invoices", href: "/invoices" },
] as const;

export default async function DashboardPage() {
  const access = await requireBusinessAccess();
  const [
    openRequests,
    draftEstimates,
    approvedEstimates,
    unscheduledJobs,
    scheduledJobs,
    completedJobs,
    draftInvoices,
    paidInvoices,
    requestsWithoutEstimate,
    attentionDraftEstimates,
    attentionUnscheduledJobs,
    attentionUnpaidInvoices,
  ] = await Promise.all([
    prisma.serviceRequest.count({
      where: { ...access.scope, status: "OPEN" },
    }),
    prisma.estimate.count({ where: { ...access.scope, status: "DRAFT" } }),
    prisma.estimate.count({ where: { ...access.scope, status: "APPROVED" } }),
    prisma.job.count({ where: { ...access.scope, status: "UNSCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "SCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "COMPLETED" } }),
    prisma.invoice.count({ where: { ...access.scope, status: "DRAFT" } }),
    prisma.invoice.count({ where: { ...access.scope, status: "PAID" } }),
    prisma.serviceRequest.findMany({
      where: { ...access.scope, estimates: { none: {} } },
      select: {
        id: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.estimate.findMany({
      where: { ...access.scope, status: "DRAFT" },
      select: {
        id: true,
        total: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.job.findMany({
      where: { ...access.scope, status: "UNSCHEDULED" },
      select: {
        id: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.invoice.findMany({
      where: { ...access.scope, status: { not: "PAID" } },
      select: {
        id: true,
        status: true,
        total: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const counts = {
    openRequests,
    draftEstimates,
    approvedEstimates,
    unscheduledJobs,
    scheduledJobs,
    completedJobs,
    draftInvoices,
    paidInvoices,
  };

  const hasAttention =
    requestsWithoutEstimate.length > 0 ||
    attentionDraftEstimates.length > 0 ||
    attentionUnscheduledJobs.length > 0 ||
    attentionUnpaidInvoices.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Dashboard"
        description={`Work for ${access.workspace.business.name}.`}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {COUNT_CARDS.map((card) => (
          <Link key={card.key} href={card.href} className="block">
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardDescription>{card.label}</CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {counts[card.key]}
                </CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Needs attention</CardTitle>
          <CardDescription>
            Items waiting on the next step in the job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!hasAttention ? (
            <p className="text-sm text-muted-foreground">
              Nothing waiting right now.
            </p>
          ) : (
            <>
              {requestsWithoutEstimate.length > 0 ? (
                <AttentionGroup title="Requests without an estimate">
                  {requestsWithoutEstimate.map((request) => (
                    <AttentionRow
                      key={request.id}
                      name={request.customer?.name ?? "Customer"}
                      href="/requests"
                      action="Open requests"
                    />
                  ))}
                </AttentionGroup>
              ) : null}
              {attentionDraftEstimates.length > 0 ? (
                <AttentionGroup title="Draft estimates">
                  {attentionDraftEstimates.map((estimate) => (
                    <AttentionRow
                      key={estimate.id}
                      name={estimate.customer?.name ?? "Customer"}
                      meta={formatMoney(estimate.total)}
                      href={`/estimates/${estimate.id}`}
                      action="Open"
                    />
                  ))}
                </AttentionGroup>
              ) : null}
              {attentionUnscheduledJobs.length > 0 ? (
                <AttentionGroup title="Unscheduled jobs">
                  {attentionUnscheduledJobs.map((job) => (
                    <AttentionRow
                      key={job.id}
                      name={job.customer?.name ?? "Customer"}
                      href={`/jobs/${job.id}`}
                      action="Open"
                    />
                  ))}
                </AttentionGroup>
              ) : null}
              {attentionUnpaidInvoices.length > 0 ? (
                <AttentionGroup title="Unpaid invoices">
                  {attentionUnpaidInvoices.map((invoice) => (
                    <AttentionRow
                      key={invoice.id}
                      name={invoice.customer?.name ?? "Customer"}
                      meta={formatMoney(invoice.total)}
                      status={invoice.status}
                      href={`/invoices/${invoice.id}`}
                      action="Open"
                    />
                  ))}
                </AttentionGroup>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AttentionGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function AttentionRow({
  name,
  meta,
  status,
  href,
  action,
}: {
  name: string;
  meta?: string;
  status?: string;
  href: string;
  action: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{name}</p>
        {meta || status ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
            {status ? <StatusBadge status={status} /> : null}
            {meta ? <span>{meta}</span> : null}
          </div>
        ) : null}
      </div>
      <Button asChild size="sm" variant="outline">
        <Link href={href}>{action}</Link>
      </Button>
    </div>
  );
}
