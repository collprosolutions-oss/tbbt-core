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
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Dashboard",
};

type CountCard = {
  key: string;
  label: string;
  href: string;
  value: number | string;
};

export default async function DashboardPage() {
  const access = await requireBusinessAccess();
  const [
    openRequests,
    draftEstimates,
    sentEstimates,
    unscheduledJobs,
    scheduledJobs,
    inProgressJobs,
    draftInvoices,
    sentInvoices,
    outstandingInvoices,
    requestsWithoutEstimate,
    attentionDraftEstimates,
    attentionUnscheduledJobs,
    attentionUnpaidInvoices,
    recentCustomers,
    recentJobs,
    recentRequests,
  ] = await Promise.all([
    prisma.serviceRequest.count({
      where: { ...access.scope, status: "OPEN" },
    }),
    prisma.estimate.count({ where: { ...access.scope, status: "DRAFT" } }),
    prisma.estimate.count({ where: { ...access.scope, status: "SENT" } }),
    prisma.job.count({ where: { ...access.scope, status: "UNSCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "SCHEDULED" } }),
    prisma.job.count({ where: { ...access.scope, status: "IN_PROGRESS" } }),
    prisma.invoice.count({ where: { ...access.scope, status: "DRAFT" } }),
    prisma.invoice.count({ where: { ...access.scope, status: "SENT" } }),
    // Outstanding uses the invoice's own stored total, never a recomputed
    // estimate/catalog price, and only SENT invoices (never DRAFT or PAID).
    prisma.invoice.aggregate({
      where: { ...access.scope, status: "SENT" },
      _sum: { total: true },
    }),
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
    prisma.customer.findMany({
      where: access.scope,
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.job.findMany({
      where: access.scope,
      select: {
        id: true,
        status: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.serviceRequest.findMany({
      where: access.scope,
      select: {
        id: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const outstandingTotal = outstandingInvoices._sum.total ?? 0;

  const requestCards: CountCard[] = [
    { key: "openRequests", label: "Open requests", href: "/requests", value: openRequests },
  ];
  const estimateCards: CountCard[] = [
    { key: "draftEstimates", label: "Draft estimates", href: "/estimates", value: draftEstimates },
    {
      key: "sentEstimates",
      label: "Sent, awaiting approval",
      href: "/estimates",
      value: sentEstimates,
    },
  ];
  const jobCards: CountCard[] = [
    { key: "unscheduledJobs", label: "Unscheduled jobs", href: "/jobs", value: unscheduledJobs },
    {
      key: "scheduledJobs",
      label: "Upcoming scheduled jobs",
      href: "/jobs",
      value: scheduledJobs,
    },
    { key: "inProgressJobs", label: "Jobs in progress", href: "/jobs", value: inProgressJobs },
  ];
  const invoiceCards: CountCard[] = [
    { key: "draftInvoices", label: "Draft invoices", href: "/invoices", value: draftInvoices },
    { key: "sentInvoices", label: "Sent, unpaid", href: "/invoices", value: sentInvoices },
    {
      key: "outstandingTotal",
      label: "Outstanding (sent, unpaid)",
      href: "/invoices",
      value: formatMoney(outstandingTotal),
    },
  ];

  const hasAttention =
    requestsWithoutEstimate.length > 0 ||
    attentionDraftEstimates.length > 0 ||
    attentionUnscheduledJobs.length > 0 ||
    attentionUnpaidInvoices.length > 0;

  const hasRecentActivity =
    recentCustomers.length > 0 ||
    recentJobs.length > 0 ||
    recentRequests.length > 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Dashboard"
        description={`Work for ${access.workspace.business.name}.`}
      />

      <DashboardSection title="Requests" cards={requestCards} />
      <DashboardSection title="Estimates" cards={estimateCards} />
      <DashboardSection title="Jobs" cards={jobCards} />
      <DashboardSection title="Invoices" cards={invoiceCards} />

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

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            The most recently added customers, jobs, and requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!hasRecentActivity ? (
            <p className="text-sm text-muted-foreground">
              No activity yet.
            </p>
          ) : (
            <>
              {recentCustomers.length > 0 ? (
                <AttentionGroup title="Recent customers">
                  {recentCustomers.map((customer) => (
                    <AttentionRow
                      key={customer.id}
                      name={customer.name}
                      meta={formatDate(customer.createdAt)}
                      href={`/customers/${customer.id}`}
                      action="Open"
                    />
                  ))}
                </AttentionGroup>
              ) : null}
              {recentJobs.length > 0 ? (
                <AttentionGroup title="Recent jobs">
                  {recentJobs.map((job) => (
                    <AttentionRow
                      key={job.id}
                      name={job.customer?.name ?? "Customer"}
                      meta={formatDateTime(job.createdAt)}
                      status={job.status}
                      href={`/jobs/${job.id}`}
                      action="Open"
                    />
                  ))}
                </AttentionGroup>
              ) : null}
              {recentRequests.length > 0 ? (
                <AttentionGroup title="Recent requests">
                  {recentRequests.map((request) => (
                    <AttentionRow
                      key={request.id}
                      name={request.customer?.name ?? "Customer"}
                      meta={formatDateTime(request.createdAt)}
                      href="/requests"
                      action="Open requests"
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

function DashboardSection({
  title,
  cards,
}: {
  title: string;
  cards: CountCard[];
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.key} href={card.href} className="block">
            <Card className="h-full transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardDescription>{card.label}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {card.value}
                </CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
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
