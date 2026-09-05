"use server";

/**
 * Minimal owner-facing team onboarding -- Launch Blocker Fix for Phase 3 /
 * Step 4 Employee Field Workflow: there was previously no way to create
 * the MEMBER a Job could be assigned to. Deliberately narrow: creates only
 * a Membership (role MEMBER) on the CALLER'S OWN business, reuses an
 * existing User by email when one exists, and never creates a second
 * Business. This is NOT the future Team & Permissions module -- no role
 * changes beyond OWNER/ADMIN adding a MEMBER, no invite management UI
 * beyond a single one-time link, no payroll/HR.
 */
import { revalidatePath } from "next/cache";
import { createSecureToken, hashPassword, hashToken } from "@/lib/auth";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  getAppUrl,
  getMailConfig,
  senderFrom,
  sendTransactionalEmail,
  teamInviteIdempotencyKey,
} from "@/lib/mail";
import { buildTeamInviteEmail } from "@/lib/team-mail";
import { prisma } from "@/lib/prisma";

export type TeamActionState = {
  error?: string;
  message?: string;
  setupUrl?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETUP_TOKEN_DAYS = 7;

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * OWNER/ADMIN-only: add a field MEMBER to the caller's OWN business.
 *
 * SECURITY: the Membership row is always created with
 * `businessId: access.businessId` -- the caller's own workspace derived
 * server-side from their session, never a client-supplied business id --
 * so this can never create or attach a Membership to another business.
 * `@@unique([userId, businessId])` plus the explicit existing-membership
 * check below prevent a duplicate Membership for the same user in the
 * same business.
 */
export async function addTeamMember(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  const name = readString(formData, "name");
  const email = readString(formData, "email").toLowerCase();

  if (!name || !email) {
    return { error: "Name and email are required." };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    // Reuse the existing User -- never create a duplicate account for the
    // same email. A membership in ANOTHER business (or none at all) grants
    // no access here: only a new Membership scoped to THIS business does.
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_businessId: {
          userId: existingUser.id,
          businessId: access.businessId,
        },
      },
    });

    if (existingMembership) {
      if (existingMembership.active) {
        return { error: "This person is already on your team." };
      }
      // Previously removed from this same business -- reactivate the one
      // existing row rather than trying (and failing) to create a second
      // one, which @@unique([userId, businessId]) would reject anyway.
      await prisma.membership.update({
        where: { id: existingMembership.id },
        data: { active: true },
      });
      revalidatePath("/team");
      revalidatePath("/jobs");
      return { message: `${existingUser.name} is back on your team.` };
    }

    await prisma.membership.create({
      data: {
        userId: existingUser.id,
        businessId: access.businessId,
        role: "MEMBER",
      },
    });
    revalidatePath("/team");
    revalidatePath("/jobs");
    return {
      message: `${existingUser.name} already has a TBBT account and can sign in now with their existing password.`,
    };
  }

  const appUrl = getAppUrl();
  if (!appUrl) {
    return {
      error:
        "The app URL is not configured, so a setup link cannot be created.",
    };
  }

  // A brand-new User needs SOME passwordHash (the column is required), but
  // no one should ever be able to sign in with it: it is a random,
  // never-displayed, never-stored-in-plaintext value discarded immediately
  // after hashing. The member instead sets their OWN real password via the
  // one-time PasswordSetupToken link below (src/app/set-password/[token]).
  const unusablePasswordHash = await hashPassword(createSecureToken());
  const rawSetupToken = createSecureToken();
  const expiresAt = new Date(
    Date.now() + SETUP_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  );

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name, email, passwordHash: unusablePasswordHash },
    });
    await tx.membership.create({
      data: {
        userId: user.id,
        businessId: access.businessId,
        role: "MEMBER",
      },
    });
    await tx.passwordSetupToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawSetupToken),
        expiresAt,
      },
    });
  });

  const setupUrl = `${appUrl}/set-password/${rawSetupToken}`;

  // Best-effort only: email delivery is optional. Whether or not this
  // succeeds (or is even configured), the setup link is always returned
  // below so the owner/admin can share it directly (text, in person,
  // whatever channel they already use) -- onboarding never depends on
  // RESEND_API_KEY/EMAIL_FROM being set.
  const mailConfig = getMailConfig();
  if (!("error" in mailConfig)) {
    const invite = buildTeamInviteEmail({
      businessName: access.workspace.business.name,
      memberName: name,
      setupUrl,
    });
    await sendTransactionalEmail({
      apiKey: mailConfig.apiKey,
      from: senderFrom(access.workspace.business.name, mailConfig.fromAddress),
      to: email,
      subject: invite.subject,
      html: invite.html,
      text: invite.text,
      kind: "team",
      idempotencyKey: teamInviteIdempotencyKey(access.businessId, email),
    });
  }

  revalidatePath("/team");
  return {
    message: `${name} was added to your team.`,
    setupUrl,
  };
}

/**
 * OWNER/ADMIN-only: deactivate ("remove") or reactivate an existing
 * MEMBER's Membership at the caller's own business. Never deletes the
 * Membership row -- Job.assignedMembershipId and
 * JobProblemReport.membershipId keep pointing at real history either way.
 *
 * SECURITY: the target Membership is re-fetched scoped by
 * `businessId: access.businessId` AND `role: "MEMBER"` in the same query
 * used to validate it, exactly like assignJobMember() in
 * src/app/actions/job.ts -- a membershipId belonging to a different
 * business, or to an OWNER/ADMIN membership, simply does not come back.
 * A deactivated MEMBER immediately loses ALL access (not just this
 * business): requireWorkspace() in src/lib/workspace.ts only resolves a
 * workspace from `active: true` memberships, and signInAction() in
 * src/app/actions/auth.ts applies the same filter, so this one flag is
 * the complete enforcement point -- there is no separate session
 * revocation step needed.
 */
export async function setTeamMemberActive(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);

  const membershipId = readString(formData, "membershipId");
  const active = readString(formData, "active") === "1";

  if (!membershipId) {
    return { error: "That team member could not be found." };
  }

  const membership = await prisma.membership.findFirst({
    where: {
      id: membershipId,
      businessId: access.businessId,
      role: "MEMBER",
    },
  });

  if (!membership) {
    return { error: "That team member could not be found." };
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: { active },
  });

  revalidatePath("/team");
  revalidatePath("/jobs");
  return {
    message: active
      ? "Team member reactivated. They can sign in again."
      : "Team member removed. They can no longer sign in.",
  };
}
