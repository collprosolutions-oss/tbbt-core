import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { attemptReferralRequestSms } from "@/lib/customer-messaging/workflows";
import { suggestedRequestText } from "@/lib/reviews";

type Db = PrismaClient | Prisma.TransactionClient;

export class ReferralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralError";
  }
}

export function referralErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ReferralError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export function suggestedReferralText(input: { customerName: string; businessName: string }) {
  const customerName = input.customerName.trim() || "there";
  const businessName = input.businessName.trim() || "us";
  return `Hi ${customerName},\n\nIf you know a neighbor who could use ${businessName}, we would appreciate an introduction. There is no pressure — only share if you are comfortable.\n\nThank you,\n${businessName}`;
}

export async function createReferralRequest(
  db: Db,
  access: BusinessAccess,
  input: { customerId: string; jobId?: string; requestText?: string; notes?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const customer = access.assertOwned(
    await db.customer.findFirst({
      where: { id: input.customerId, ...access.scope },
      select: { id: true, businessId: true, name: true },
    }),
  );
  if (input.jobId) {
    const job = access.assertOwned(
      await db.job.findFirst({
        where: { id: input.jobId, ...access.scope },
        select: { id: true, businessId: true, customerId: true, status: true },
      }),
    );
    if (job.status !== "COMPLETED") {
      throw new ReferralError("Only a completed job can start a referral request.");
    }
    if (job.customerId && job.customerId !== customer.id) {
      throw new ReferralError("That job does not belong to this customer.");
    }
  }
  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { name: true },
  });
  return db.referralRequest.create({
    data: {
      businessId: access.businessId,
      customerId: customer.id,
      jobId: input.jobId || null,
      requestText:
        input.requestText?.trim() ||
        suggestedReferralText({
          customerName: customer.name,
          businessName: business?.name ?? "us",
        }),
      notes: input.notes?.trim() || null,
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function advanceReferralRequest(
  db: Db,
  access: BusinessAccess,
  input: { requestId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const request = access.assertOwned(
    await db.referralRequest.findFirst({
      where: { id: input.requestId, ...access.scope },
    }),
  );
  const next = request.status === "DRAFT" ? "READY" : request.status === "READY" ? "SENT" : null;
  if (!next) {
    throw new ReferralError("This referral request cannot be advanced.");
  }
  const updated = await db.referralRequest.update({
    where: { id: request.id },
    data: {
      status: next,
      requestedAt: next === "SENT" ? request.requestedAt ?? new Date() : request.requestedAt,
    },
  });
  if (next === "SENT") {
    const business = await db.business.findFirst({
      where: { id: access.businessId },
      select: { name: true },
    });
    await attemptReferralRequestSms(db, {
      businessId: access.businessId,
      referralRequestId: updated.id,
      customerId: updated.customerId,
      businessName: business?.name ?? "us",
      requestText: updated.requestText,
      initiatedByMembershipId: access.workspace.membership.id,
    });
  }
  return updated;
}

export async function cancelReferralRequest(
  db: Db,
  access: BusinessAccess,
  input: { requestId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const request = access.assertOwned(
    await db.referralRequest.findFirst({
      where: { id: input.requestId, ...access.scope },
    }),
  );
  if (request.status === "COMPLETED" || request.status === "CANCELLED") {
    throw new ReferralError("This referral request can no longer be cancelled.");
  }
  return db.referralRequest.update({
    where: { id: request.id },
    data: { status: "CANCELLED", remindersStoppedAt: new Date() },
  });
}

export async function recordReferral(
  db: Db,
  access: BusinessAccess,
  input: {
    sourceCustomerId: string;
    referredCustomerId?: string;
    referralRequestId?: string;
    campaignId?: string;
    notes?: string;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const source = access.assertOwned(
    await db.customer.findFirst({
      where: { id: input.sourceCustomerId, ...access.scope },
    }),
  );
  let referredCustomerId: string | null = null;
  if (input.referredCustomerId) {
    const referred = access.assertOwned(
      await db.customer.findFirst({
        where: { id: input.referredCustomerId, ...access.scope },
      }),
    );
    if (referred.id === source.id) {
      throw new ReferralError("A customer cannot refer themselves.");
    }
    referredCustomerId = referred.id;
  }
  if (input.referralRequestId) {
    access.assertOwned(
      await db.referralRequest.findFirst({
        where: { id: input.referralRequestId, ...access.scope },
      }),
    );
  }
  if (input.campaignId) {
    access.assertOwned(
      await db.marketingCampaign.findFirst({
        where: { id: input.campaignId, ...access.scope },
      }),
    );
  }
  const referral = await db.referral.create({
    data: {
      businessId: access.businessId,
      sourceCustomerId: source.id,
      referredCustomerId,
      referralRequestId: input.referralRequestId || null,
      campaignId: input.campaignId || null,
      notes: input.notes?.trim() ?? "",
      status: referredCustomerId ? "CONVERTED" : "RECORDED",
    },
  });
  if (input.referralRequestId) {
    await db.referralRequest.update({
      where: { id: input.referralRequestId },
      data: { status: "COMPLETED" },
    });
  }
  return referral;
}

export async function createCustomerFollowUp(
  db: Db,
  access: BusinessAccess,
  input: { customerId: string; jobId?: string; kind: "JOB_COMPLETE" | "REPEAT"; notes?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  access.assertOwned(
    await db.customer.findFirst({
      where: { id: input.customerId, ...access.scope },
    }),
  );
  if (input.jobId) {
    access.assertOwned(
      await db.job.findFirst({
        where: { id: input.jobId, ...access.scope },
      }),
    );
  }
  return db.customerFollowUp.create({
    data: {
      businessId: access.businessId,
      customerId: input.customerId,
      jobId: input.jobId || null,
      kind: input.kind,
      notes: input.notes?.trim() ?? "",
      createdByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function cancelCustomerFollowUp(
  db: Db,
  access: BusinessAccess,
  input: { followUpId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_REVIEWS);
  const row = access.assertOwned(
    await db.customerFollowUp.findFirst({
      where: { id: input.followUpId, ...access.scope },
    }),
  );
  return db.customerFollowUp.update({
    where: { id: row.id },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}
