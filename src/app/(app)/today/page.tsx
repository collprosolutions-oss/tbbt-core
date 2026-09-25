import type { Metadata } from "next";
import Link from "next/link";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { OwnerTodayAppointmentAttention } from "@/components/today/owner-today-appointment-attention";
import { OwnerTodayHandoffCard } from "@/components/today/owner-today-handoff-card";
import { OwnerTodayJobCard } from "@/components/today/owner-today-job-card";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { formatDate } from "@/lib/format";
import {
  OWNER_TODAY_APPOINTMENT_TAKE,
  OWNER_TODAY_HANDOFF_SELECT,
  OWNER_TODAY_HANDOFF_TAKE,
  OWNER_TODAY_JOB_SELECT,
  OWNER_TODAY_JOBS_TAKE,
  buildOwnerTodayAppointmentAttention,
  buildOwnerTodayHandoffItems,
  buildOwnerTodayJobs,
  ownerTodayAppointmentCandidateWhere,
  ownerTodayScheduledWhere,
  ownerTodayViewerHasAssignedFieldJob,
} from "@/lib/owner-today";
import { prisma } from "@/lib/prisma";
import { dayRange, formatISODate, startOfDay } from "@/lib/schedule";

export const metadata: Metadata = {
  title: "Today",
};

export default async function OwnerTodayPage() {
  const access = await requireManagementPageAccess();
  const timeZone = resolveBusinessTimeZone(access.workspace.business);
  const today = startOfDay(new Date(), timeZone);
  const todayRange = dayRange(today, timeZone);
  const todayIso = formatISODate(today, timeZone);
  const viewerMembershipId = access.workspace.membership.id;

  const [todayJobs, appointmentJobs, completedJobsForBilling, eligibleMemberRows] =
    await Promise.all([
      prisma.job.findMany({
        where: {
          ...access.scope,
          ...ownerTodayScheduledWhere(todayRange),
        },
        select: OWNER_TODAY_JOB_SELECT,
        orderBy: { scheduledAt: "asc" },
        take: OWNER_TODAY_JOBS_TAKE,
      }),
      prisma.job.findMany({
        where: {
          ...access.scope,
          ...ownerTodayAppointmentCandidateWhere(todayRange.start),
        },
        select: OWNER_TODAY_JOB_SELECT,
        orderBy: { scheduledAt: "asc" },
        take: OWNER_TODAY_APPOINTMENT_TAKE,
      }),
      prisma.job.findMany({
        where: { ...access.scope, status: "COMPLETED" },
        select: OWNER_TODAY_HANDOFF_SELECT,
        orderBy: { updatedAt: "desc" },
        take: OWNER_TODAY_HANDOFF_TAKE,
      }),
      prisma.membership.findMany({
        where: { businessId: access.businessId, role: "MEMBER", active: true },
        select: { id: true, user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]);

  const jobs = buildOwnerTodayJobs(todayJobs, {
    businessId: access.businessId,
    range: todayRange,
    timeZone,
    viewerMembershipId,
  });
  const appointmentAttention = buildOwnerTodayAppointmentAttention(appointmentJobs, {
    businessId: access.businessId,
    start: todayRange.start,
    timeZone,
  });
  const handoffItems = buildOwnerTodayHandoffItems(
    completedJobsForBilling,
    access.businessId,
  );
  const unassignedToday = jobs.filter((job) => job.assignment.kind === "UNASSIGNED");
  const eligibleMembers = eligibleMemberRows.map((member) => ({
    id: member.id,
    name: member.user.name,
    email: member.user.email,
  }));
  const assignedToOwner = ownerTodayViewerHasAssignedFieldJob(
    todayJobs,
    viewerMembershipId,
  );

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Today"
        description={`Needs attention and scheduled work for ${formatDate(today, timeZone)}.`}
      >
        <div className="flex flex-wrap gap-2">
          {assignedToOwner ? (
            <Button asChild size="sm">
              <Link href="/field">Open field view</Link>
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/jobs?view=day&date=${todayIso}`}>Full schedule</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Needs attention</CardTitle>
          <CardDescription>
            Unconfirmed appointments, unassigned today work, and completed jobs
            that still need an invoice. Completing a job does not send money
            documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {appointmentAttention.length === 0 &&
          unassignedToday.length === 0 &&
          handoffItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing waiting right now.</p>
          ) : null}

          <OwnerTodayAppointmentAttention items={appointmentAttention} />

          {unassignedToday.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Unassigned today</p>
              {unassignedToday.map((job) => (
                <div
                  key={`unassigned-${job.jobId}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{job.customerName}</p>
                    {job.timeWindowLabel ? (
                      <p className="text-sm text-muted-foreground">{job.timeWindowLabel}</p>
                    ) : null}
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={job.jobHref}>Assign</Link>
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {handoffItems.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Field → office handoff</p>
              {handoffItems.map((item) => (
                <OwnerTodayHandoffCard key={item.jobId} item={item} />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Today's jobs</CardTitle>
          <CardDescription>
            {jobs.length === 0
              ? "Nothing scheduled today."
              : `${jobs.length} job${jobs.length === 1 ? "" : "s"} scheduled today.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled today.</p>
          ) : (
            jobs.map((job) => (
              <OwnerTodayJobCard
                key={job.jobId}
                job={job}
                eligibleMembers={eligibleMembers}
                showAssign
                showStart
              />
            ))
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
