import type { Metadata } from "next";
import { AddTeamMemberForm } from "@/components/team/add-team-member-form";
import { SetTeamMemberActiveForm } from "@/components/team/set-team-member-active-form";
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
    </PageContainer>
  );
}
