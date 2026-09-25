import type { Metadata } from "next";
import { AddTeamMemberForm } from "@/components/team/add-team-member-form";
import { SetTeamMemberActiveForm } from "@/components/team/set-team-member-active-form";
import { FillInBenchForm, FillInBenchUseButton } from "@/components/team/fill-in-bench-form";
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
import { prisma } from "@/lib/prisma";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { hasProductCapability } from "@/lib/product-entitlements";
import { formatProgression, skillLabel } from "@/lib/workforce";
import { loadFillInBench, loadWorkforceMembers } from "@/lib/workforce-data";

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
  const [workforceMembers, bench] = canManageWorkforce
    ? await Promise.all([
        loadWorkforceMembers(prisma, access.businessId),
        loadFillInBench(prisma, access.businessId),
      ])
    : [[], []];

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
            are never public and are not a cross-business marketplace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <FillInBenchForm />
          {bench.map((worker) => (
            <div key={worker.id} className="space-y-2 rounded-lg border p-3">
              <p className="text-sm font-medium">
                {worker.displayName}
                {worker.approved ? " · Approved" : " · Not approved"}
                {worker.lastUsedAt ? ` · last used ${worker.lastUsedAt.toLocaleDateString("en-US")}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                {worker.skills.map(skillLabel).join(", ") || "No skills recorded"} ·{" "}
                {worker.contactPreference}
              </p>
              <FillInBenchForm worker={worker} />
              <FillInBenchUseButton benchWorkerId={worker.id} />
            </div>
          ))}
        </CardContent>
      </Card>
      ) : null}
    </PageContainer>
  );
}
