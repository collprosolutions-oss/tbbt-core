import { redirect } from "next/navigation";
import type { Business, Membership, MembershipRole } from "@prisma/client";
import { getSessionUser, getWorkspaceCookie, setWorkspaceCookie } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type WorkspaceContext = {
  user: { id: string; email: string; name: string };
  business: Business;
  membership: Membership;
  role: MembershipRole;
};

export async function requireWorkspace(): Promise<WorkspaceContext> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/sign-in");
  }

  const memberships = await prisma.membership.findMany({
    where: { userId: user.id },
    include: { business: true },
    orderBy: { createdAt: "asc" },
  });

  if (memberships.length === 0) {
    redirect("/sign-in");
  }

  const requestedId = await getWorkspaceCookie();
  const current =
    memberships.find((membership) => membership.businessId === requestedId) ??
    memberships[0];

  if (current.businessId !== requestedId) {
    await setWorkspaceCookie(current.businessId);
  }

  return {
    user,
    business: current.business,
    membership: current,
    role: current.role,
  };
}
