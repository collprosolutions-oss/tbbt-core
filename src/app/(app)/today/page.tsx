import type { Metadata } from "next";
import Link from "next/link";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { OwnerDailyAttentionList } from "@/components/today/owner-daily-attention-list";
import { OwnerTodayAppointmentAttention } from "@/components/today/owner-today-appointment-attention";
import { OwnerTodayFieldProblemAttention } from "@/components/today/owner-today-field-problem-attention";
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
import {
  addZonedCalendarDays,
  resolveBusinessTimeZone,
  startOfZonedDay,
} from "@/lib/business-timezone";
import { formatDate } from "@/lib/format";
import { JOB_CALLBACK_OPEN_STATUSES } from "@/lib/job-callback";
import {
  OWNER_DAILY_ADDITIONAL_WORK_SELECT,
  OWNER_DAILY_ATTENTION_TAKE,
  OWNER_DAILY_CALLBACK_SELECT,
  OWNER_DAILY_CHANGE_ORDER_SELECT,
  OWNER_DAILY_GROUP_TITLES,
  OWNER_DAILY_RUNNING_TIME_SELECT,
  buildOwnerDailyAdditionalWorkAttention,
  buildOwnerDailyCallbackAttention,
  buildOwnerDailyChangeOrderAttention,
  buildOwnerDailyRunningTimeAttention,
  ownerDailyConflictTruncationLabel,
  ownerDailyTodayNothingWaiting,
} from "@/lib/owner-daily-attention";
import { loadOwnerDailyActionableAttention } from "@/lib/owner-daily-attention-data";
import { loadProjectLinkActiveByJobIds } from "@/lib/project-link-data";
import {
  OWNER_TODAY_APPOINTMENT_TAKE,
  OWNER_TODAY_FIELD_COMPLETION_COPY,
  OWNER_TODAY_FIELD_PROBLEM_SELECT,
  OWNER_TODAY_FIELD_PROBLEM_TAKE,
  OWNER_TODAY_HANDOFF_SELECT,
  OWNER_TODAY_HANDOFF_TAKE,
  OWNER_TODAY_JOB_SELECT,
  OWNER_TODAY_JOBS_TAKE,
  buildOwnerTodayAppointmentAttention,
  buildOwnerTodayFieldProblemAttention,
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

  const conflictRange = {
    start: todayRange.start,
    end: addZonedCalendarDays(startOfZonedDay(today, timeZone), 21, timeZone),
  };
  const [
    todayJobs,
    appointmentJobs,
    completedJobsForBilling,
    openFieldProblemReports,
    eligibleMemberRows,
    additionalWorkRows,
    changeOrderRows,
    callbackRows,
    runningTimeRows,
    dailyAttention,
  ] = await Promise.all([
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
    prisma.jobProblemReport.findMany({
      where: {
        businessId: access.businessId,
        status: "OPEN",
      },
      select: OWNER_TODAY_FIELD_PROBLEM_SELECT,
      orderBy: { createdAt: "desc" },
      take: OWNER_TODAY_FIELD_PROBLEM_TAKE,
    }),
    prisma.membership.findMany({
      where: { businessId: access.businessId, role: "MEMBER", active: true },
      select: { id: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.additionalWorkRequest.findMany({
      where: { ...access.scope, status: "OPEN" },
      select: OWNER_DAILY_ADDITIONAL_WORK_SELECT,
      orderBy: { createdAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.changeOrder.findMany({
      where: { ...access.scope, status: { in: ["DRAFT", "SENT"] } },
      select: OWNER_DAILY_CHANGE_ORDER_SELECT,
      orderBy: { updatedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.jobCallback.findMany({
      where: {
        ...access.scope,
        status: { in: [...JOB_CALLBACK_OPEN_STATUSES] },
      },
      select: OWNER_DAILY_CALLBACK_SELECT,
      orderBy: { recordedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    prisma.timeEntry.findMany({
      where: {
        ...access.scope,
        status: "RUNNING",
        endedAt: null,
      },
      select: OWNER_DAILY_RUNNING_TIME_SELECT,
      orderBy: { startedAt: "desc" },
      take: OWNER_DAILY_ATTENTION_TAKE,
    }),
    loadOwnerDailyActionableAttention(prisma, {
      businessId: access.businessId,
      scope: access.scope,
      todayStart: todayRange.start,
      conflictRange,
      timeZone,
      includeFirstAwaiting: false,
    }),
  ]);

  const jobs = buildOwnerTodayJobs(todayJobs, {
    businessId: access.businessId,
    range: todayRange,
    timeZone,
    viewerMembershipId,
  });
  const projectLinkActive = await loadProjectLinkActiveByJobIds(
    prisma,
    jobs.map((job) => job.jobId),
  );
  for (const job of jobs) {
    job.projectLinkActive = projectLinkActive.get(job.jobId) ?? true;
  }
  const appointmentAttention = buildOwnerTodayAppointmentAttention(appointmentJobs, {
    businessId: access.businessId,
    start: todayRange.start,
    timeZone,
  });
  const handoffItems = buildOwnerTodayHandoffItems(
    completedJobsForBilling,
    access.businessId,
  );
  const fieldProblemAttention = buildOwnerTodayFieldProblemAttention(
    openFieldProblemReports,
    { businessId: access.businessId, timeZone },
  );
  const additionalWorkAttention = buildOwnerDailyAdditionalWorkAttention(
    additionalWorkRows,
    access.businessId,
  );
  const changeOrderAttention = buildOwnerDailyChangeOrderAttention(
    changeOrderRows,
    access.businessId,
  );
  const callbackAttention = buildOwnerDailyCallbackAttention(
    callbackRows,
    access.businessId,
  );
  const runningTimeAttention = buildOwnerDailyRunningTimeAttention(
    runningTimeRows,
    access.businessId,
    timeZone,
  );
  const materialDepositAttention = dailyAttention.materialDeposits;
  const scheduleConflictAttention = dailyAttention.scheduleConflicts;
  const maintenanceFollowUpAttention = dailyAttention.maintenanceFollowUps;
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
            Unconfirmed appointments, unassigned today work, open field reports,
            additional-work and change orders, running time, unpaid material
            deposits, scheduling conflicts, callbacks, due Handyman maintenance
            follow-ups, and completed jobs that still need an invoice.{" "}
            {OWNER_TODAY_FIELD_COMPLETION_COPY}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ownerDailyTodayNothingWaiting({
            appointmentAttention,
            unassignedToday,
            fieldProblemAttention,
            additionalWorkAttention,
            changeOrderAttention,
            callbackAttention,
            runningTimeAttention,
            materialDepositAttention,
            scheduleConflictAttention,
            handoffItems,
            maintenanceFollowUpAttention,
          }) ? (
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

          <OwnerTodayFieldProblemAttention items={fieldProblemAttention} />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.additionalWork}
            items={additionalWorkAttention}
          />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.changeOrders}
            items={changeOrderAttention}
          />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.callbacks}
            items={callbackAttention}
          />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.runningTime}
            items={runningTimeAttention}
          />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.materialDeposits}
            items={materialDepositAttention.items}
            count={materialDepositAttention.count}
            moreNotShown={materialDepositAttention.truncated}
            scanLimited={materialDepositAttention.scanLimited}
          />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.scheduleConflicts}
            items={scheduleConflictAttention.items}
            count={scheduleConflictAttention.count}
            moreNotShown={scheduleConflictAttention.truncated}
            scanLimited={scheduleConflictAttention.scanLimited}
            truncationLabel={ownerDailyConflictTruncationLabel(
              scheduleConflictAttention.count,
              scheduleConflictAttention.items.length,
              scheduleConflictAttention.scanLimited,
            )}
          />
          <OwnerDailyAttentionList
            title={OWNER_DAILY_GROUP_TITLES.maintenanceFollowUps}
            items={maintenanceFollowUpAttention.items}
            count={maintenanceFollowUpAttention.count}
            moreNotShown={maintenanceFollowUpAttention.truncated}
            scanLimited={maintenanceFollowUpAttention.scanLimited}
          />

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
