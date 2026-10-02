import type { Metadata } from "next";
import Link from "next/link";
import { AddTeamMemberForm } from "@/components/team/add-team-member-form";
import { SetTeamMemberActiveForm } from "@/components/team/set-team-member-active-form";
import { FillInBenchWorkspace } from "@/components/team/fill-in-bench-workspace";
import { AvailabilityExceptionRequestsPanel } from "@/components/team/availability-exception-requests";
import { JobReassignmentRequestsPanel } from "@/components/team/job-reassignment-requests";
import { StaffingRecommendationsPanel } from "@/components/team/staffing-recommendations";
import { WeeklyAvailabilityForm } from "@/components/team/weekly-availability-form";
import { WorkforceProfileForm } from "@/components/team/workforce-profile-form";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { RecordRow } from "@/components/record-row";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { loadOwnedFillInBench } from "@/lib/fill-in-bench";
import { prisma } from "@/lib/prisma";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { hasProductCapability } from "@/lib/product-entitlements";
import { formatProgression, skillLabel } from "@/lib/workforce";
import { loadWorkforceMembers } from "@/lib/workforce-data";
import { loadOwnedAvailabilityExceptionRequests } from "@/lib/workforce-availability-request-ops";
import { loadOwnedJobReassignmentRequests } from "@/lib/job-reassignment-request-ops";
import { loadOwnedStaffingReview } from "@/lib/workforce-staffing-ops";

export const metadata: Metadata = {
  title: "Team",
};

/**
 * Minimal owner-facing Team page -- Launch Blocker Fix for Phase 3 / Step 4
 * Employee Field Workflow. Lets OWNER/ADMIN add a field MEMBER (name +
 * email, role fixed to MEMBER) and remove/reactivate an existing one. See
 * src/app/actions/team.ts for the full authorization/security notes; this
 * page only reads data already scoped to the caller's own business via
 * requireManagementPageAccess()/access.scope, exactly like every other
 * management-console page.
 */
export default async function TeamPage() {
  const access = await requireManagementPageAccess();

  const members = await prisma.membership.findMany({
    where: access.scope,
    select: {
      id: true,
      role: true,
      active: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  const canManageWorkforce = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.TEAM_MANAGEMENT,
  );
  const canManageJobs = await hasProductCapability(
    prisma,
    access.businessId,
    PRODUCT_CAPABILITIES.JOBS_TASKS,
  );
  const emptyReassignmentQueue = {
    pending: [],
    recent: [],
    canDecide: false,
    timeZone: "",
  };
  const [workforceMembers, bench, staffing, availabilityRequests, reassignmentRequests] =
    await Promise.all([
      canManageWorkforce ? loadWorkforceMembers(prisma, access.businessId) : Promise.resolve([]),
      canManageWorkforce ? loadOwnedFillInBench(prisma, access) : Promise.resolve([]),
      canManageWorkforce
        ? loadOwnedStaffingReview(prisma, access)
        : Promise.resolve({ pending: [], accepted: [], history: [], canReview: false }),
      canManageWorkforce
        ? loadOwnedAvailabilityExceptionRequests(prisma, access)
        : Promise.resolve({ pending: [], recent: [], canDecide: false, timeZone: "" }),
      canManageJobs
        ? loadOwnedJobReassignmentRequests(prisma, access)
        : Promise.resolve(emptyReassignmentQueue),
    ]);

  return (
    <PageContainer>
      <PageHeader
        title="Team"
        description={`Field team members for ${access.workspace.business.name}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a team member</CardTitle>
          <CardDescription>
            Adding an existing TBBT account joins them to this business only
            -- it never creates a second business or changes their access
            anywhere else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddTeamMemberForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current team</CardTitle>
          <CardDescription>
            Removing a MEMBER deactivates their access to this business
            immediately; it does not delete their account or job history.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {members.map((member) => (
            <RecordRow
              key={member.id}
              title={
                <>
                  <span>{member.user.name}</span>
                  <Badge variant="secondary">{member.role}</Badge>
                  {!member.active ? (
                    <Badge variant="outline">Removed</Badge>
                  ) : null}
                </>
              }
              subtitle={member.user.email}
              action={
                member.role === "MEMBER" ? (
                  <SetTeamMemberActiveForm
                    membershipId={member.id}
                    active={member.active}
                  />
                ) : null
              }
            />
          ))}
        </CardContent>
      </Card>

      {canManageWorkforce ? (
        <StaffingRecommendationsPanel
          pending={staffing.pending}
          accepted={staffing.accepted}
          history={staffing.history}
          canReview={staffing.canReview}
        />
      ) : null}

      {canManageWorkforce ? (
        <AvailabilityExceptionRequestsPanel
          pending={availabilityRequests.pending}
          recent={availabilityRequests.recent}
          canDecide={availabilityRequests.canDecide}
        />
      ) : null}

      {canManageJobs ? (
        <JobReassignmentRequestsPanel
          pending={reassignmentRequests.pending}
          recent={reassignmentRequests.recent}
          canDecide={reassignmentRequests.canDecide}
          timeZone={reassignmentRequests.timeZone}
        />
      ) : null}

      {canManageWorkforce ? (
      <Card>
        <CardHeader>
          <CardTitle>Workforce profiles</CardTitle>
          <CardDescription>
            Skills, progression, weekly hours, and scheduling status live on the
            existing Membership. This is not a second employee identity and not a
            performance-rating system. Preferred/allowed job types stay as
            owner notes until a canonical job-type identity exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {workforceMembers.map((member) => (
            <div key={member.membershipId} className="space-y-2">
              <p className="text-sm font-medium">
                {member.name} — {formatProgression(member.progression)}
                {member.skills.length > 0
                  ? ` · ${member.skills.map((skill) => skillLabel(skill.skillKey)).join(", ")}`
                  : ""}
              </p>
              <WorkforceProfileForm member={member} />
              <WeeklyAvailabilityForm member={member} />
            </div>
          ))}
        </CardContent>
      </Card>
      ) : null}

      {canManageWorkforce ? (
      <Card>
        <CardHeader>
          <CardTitle>Internal Fill-In Bench</CardTitle>
          <CardDescription>
            Approved helpers and subcontractors for this business only. Profiles
            are never public and are not a cross-business marketplace.{" "}
            <Link href="/team/bench" className="underline underline-offset-4">
              Open the Fill-In Bench workspace
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FillInBenchWorkspace
            bench={bench}
            teamMembers={workforceMembers.map((member) => ({
              membershipId: member.membershipId,
              name: member.name,
            }))}
          />
        </CardContent>
      </Card>
      ) : null}
    </PageContainer>
  );
}
