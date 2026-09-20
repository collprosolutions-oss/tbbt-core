/**
 * Public self-service signup handoff.
 *
 * Marketing "Start Free Trial" lands on /sign-up. This module is the
 * one write path that turns a new account into a tenant: User + Business
 * + OWNER membership, then the existing local Founder trial. It does not
 * create a Stripe Customer, Subscription, Checkout Session, or Connect
 * account. First-run /setup still reuses this business; it does not
 * create a second tenant.
 */
import type { PrismaClient } from "@prisma/client";
import { postAuthenticationPath } from "@/lib/first-run-setup";
import { startFounderTrialIfEligible } from "@/lib/saas-billing";
import { provisionOwnerWorkspace } from "@/lib/signup-provision";

export async function provisionNewOwnerWithFounderTrial(
  db: PrismaClient,
  input: {
    name: string;
    email: string;
    passwordHash: string;
    businessName: string;
    now?: Date;
  },
) {
  const provisioned = await provisionOwnerWorkspace(db, {
    name: input.name,
    email: input.email,
    passwordHash: input.passwordHash,
    businessName: input.businessName,
  });
  const trial = await startFounderTrialIfEligible(db, {
    businessId: provisioned.business.id,
    slug: provisioned.business.slug,
    changedByMembershipId: provisioned.membership.id,
    now: input.now,
  });
  return {
    ...provisioned,
    trial,
    nextPath: postAuthenticationPath({
      role: provisioned.membership.role,
      business: provisioned.business,
    }),
  };
}
