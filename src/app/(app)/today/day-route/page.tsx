import type { Metadata } from "next";
import { OwnerDayRouteView } from "@/components/today/owner-day-route";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { requireManagementPageAccess } from "@/lib/access";
import { loadOwnerDayRoute } from "@/lib/owner-day-route";
import { loadOwnerDayRouteAppointmentNotices } from "@/lib/owner-day-route-appointment-notice-ops";
import { prisma } from "@/lib/prisma";
import { addDays, formatISODate, parseScheduleDate } from "@/lib/schedule";

export const metadata: Metadata = {
  title: "Day route",
};

export default async function OwnerDayRoutePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const access = await requireManagementPageAccess();
  const params = await searchParams;
  const view = await loadOwnerDayRoute(prisma, {
    businessId: access.businessId,
    role: access.workspace.role,
    date: params.date,
    timeZone: access.workspace.business.timezone,
  });
  const appointmentNotices = await loadOwnerDayRouteAppointmentNotices(prisma, access, {
    jobIds: view.stops.map((stop) => stop.jobId),
    timeZone: view.timeZone,
  });
  const day = parseScheduleDate(params.date, view.timeZone);
  const previousDateIso = formatISODate(addDays(day, -1, view.timeZone), view.timeZone);
  const nextDateIso = formatISODate(addDays(day, 1, view.timeZone), view.timeZone);

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Day route"
        description={`${view.dayLabel}. Recorded same-business scheduled jobs and structured property addresses only.`}
      />
      <OwnerDayRouteView
        view={view}
        previousDateIso={previousDateIso}
        nextDateIso={nextDateIso}
        canChangeAppointment={access.workspace.role === "OWNER"}
        appointmentNotices={appointmentNotices}
      />
    </PageContainer>
  );
}
