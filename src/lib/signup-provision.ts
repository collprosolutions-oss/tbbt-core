/**
 * Atomic signup provisioning: User + Business + OWNER Membership.
 *
 * This is the existing multi-tenant signup write, extracted so first-run
 * setup can reuse it without rebuilding authentication. The new business
 * is left with firstRunSetupCompletedAt null on purpose.
 */
import type { PrismaClient } from "@prisma/client";
import { allocateBusinessSlug } from "@/lib/slug";
import { DEFAULT_TRADE } from "@/lib/trades";

export async function provisionOwnerWorkspace(
  db: PrismaClient,
  input: {
    name: string;
    email: string;
    passwordHash: string;
    businessName: string;
  },
) {
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: input.passwordHash,
      },
    });

    const business = await tx.business.create({
      data: {
        name: input.businessName,
        slug: await allocateBusinessSlug(input.businessName, tx),
        tradeCode: DEFAULT_TRADE,
      },
    });

    const membership = await tx.membership.create({
      data: {
        userId: user.id,
        businessId: business.id,
        role: "OWNER",
      },
    });

    return { user, business, membership };
  });
}
