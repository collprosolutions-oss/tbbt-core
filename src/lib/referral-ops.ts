import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  attemptJobFollowUpSms,
  attemptReferralRequestSms,
  attemptRepeatFollowUpSms,
} from "@/lib/customer-messaging/workflows";
import {
  followUpEmailIdempotencyKey,
  getMailConfig,
  isUsableEmail,
  referralRequestEmailIdempotencyKey,
  sendTransactionalEmail,
  senderFrom,
} from "@/lib/mail";
import { channelDeliveryAccepted } from "@/lib/reviews";
import { emitAndProcessBusinessEvent } from "@/lib/automation/events";

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
  if (request.status !== "DRAFT") {
    throw new ReferralError(
      request.status === "READY" || request.status === "FAILED"
        ? "Use send or mark sent manually."
        : "This referral request cannot be advanced.",
    );
  }
  return db.referralRequest.update({
    where: { id: request.id },
    data: { status: "READY" },
  });
}

async function attemptOwnedCustomerEmail(
  db: Db,
  input: {
    businessId: string;
    customerId: string;
    businessName: string;
    subject: string;
    text: string;
    idempotencyKey: string;
    kind: "referral" | "follow-up";
  },
) {
  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: { email: true },
  });
  if (!isUsableEmail(customer?.email)) return "SKIPPED_NO_EMAIL";
  const config = getMailConfig();
  if ("error" in config) return "NOT_CONFIGURED";
  const sent = await sendTransactionalEmail({
    apiKey: config.apiKey,
    from: senderFrom(input.businessName, config.fromAddress),
    to: customer!.email!.trim(),
    subject: input.subject,
    text: input.text,
    html: `<p>${input.text.replace(/\n/g, "<br />")}</p>`,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
  });
  return "error" in sent ? "FAILED" : "SENT";
}

export async function sendReferralRequest(
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
  if (request.status !== "READY" && request.status !== "FAILED") {
    throw new ReferralError("Only a ready or failed referral request can be sent.");
  }
  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { name: true },
  });
  const sms = await attemptReferralRequestSms(db, {
    businessId: access.businessId,
    referralRequestId: request.id,
    customerId: request.customerId,
    businessName: business?.name ?? "us",
    requestText: request.requestText,
    initiatedByMembershipId: access.workspace.membership.id,
  });
  const emailStatus = await attemptOwnedCustomerEmail(db, {
    businessId: access.businessId,
    customerId: request.customerId,
    businessName: business?.name ?? "us",
    subject: `${business?.name ?? "us"} would appreciate a referral`,
    text: request.requestText,
    idempotencyKey: referralRequestEmailIdempotencyKey(request.id),
    kind: "referral",
  });
  const delivered = channelDeliveryAccepted(sms?.status) || emailStatus === "SENT";
  return db.referralRequest.update({
    where: { id: request.id },
    data: {
      status: delivered ? "SENT" : "FAILED",
      requestedAt: delivered ? request.requestedAt ?? new Date() : request.requestedAt,
      lastSmsStatus: sms?.status ?? "NOT_SENT",
      lastEmailStatus: emailStatus,
    },
  });
}

export async function markReferralRequestSentManually(
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
  if (request.status !== "READY" && request.status !== "FAILED") {
    throw new ReferralError("Only a ready or failed referral request can be marked sent manually.");
  }
  return db.referralRequest.update({
    where: { id: request.id },
    data: {
      status: "SENT",
      requestedAt: request.requestedAt ?? new Date(),
      lastEmailStatus: request.lastEmailStatus ?? "MANUAL",
      lastSmsStatus: request.lastSmsStatus ?? "MANUAL",
    },
  });
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
  const row = await db.customerFollowUp.create({
    data: {
      businessId: access.businessId,
      customerId: input.customerId,
      jobId: input.jobId || null,
      kind: input.kind,
      notes: input.notes?.trim() ?? "",
      createdByMembershipId: access.workspace.membership.id,
    },
  });
  await emitAndProcessBusinessEvent(db, {
    businessId: access.businessId,
    type: "CUSTOMER_FOLLOW_UP_DUE",
    subjectType: "CUSTOMER_FOLLOW_UP",
    subjectId: row.id,
    payload: { customerId: row.customerId, jobId: row.jobId, followUpId: row.id },
    idempotencyKey: `CUSTOMER_FOLLOW_UP_DUE:${row.id}`,
  });
  return row;
}

export async function sendCustomerFollowUp(
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
  if (row.status !== "OPEN" && row.status !== "FAILED") {
    throw new ReferralError("Only an open or failed follow-up can be sent.");
  }
  const business = await db.business.findFirst({
    where: { id: access.businessId },
    select: { name: true },
  });
  const businessName = business?.name ?? "us";
  const sms =
    row.kind === "REPEAT"
      ? await attemptRepeatFollowUpSms(db, {
          businessId: access.businessId,
          followUpId: row.id,
          customerId: row.customerId,
          businessName,
          initiatedByMembershipId: access.workspace.membership.id,
        })
      : await attemptJobFollowUpSms(db, {
          businessId: access.businessId,
          followUpId: row.id,
          customerId: row.customerId,
          businessName,
          initiatedByMembershipId: access.workspace.membership.id,
        });
  const emailStatus = await attemptOwnedCustomerEmail(db, {
    businessId: access.businessId,
    customerId: row.customerId,
    businessName,
    subject:
      row.kind === "REPEAT"
        ? `${businessName} can help with your next project`
        : `${businessName} is checking in after your recent job`,
    text:
      row.notes.trim() ||
      (row.kind === "REPEAT"
        ? `${businessName} would be glad to help with your next project.`
        : `${businessName} is checking in after your recent job.`),
    idempotencyKey: followUpEmailIdempotencyKey(row.id),
    kind: "follow-up",
  });
  const delivered = channelDeliveryAccepted(sms?.status) || emailStatus === "SENT";
  return db.customerFollowUp.update({
    where: { id: row.id },
    data: {
      status: delivered ? "SENT" : "FAILED",
      sentAt: delivered ? row.sentAt ?? new Date() : row.sentAt,
      lastSmsStatus: sms?.status ?? "NOT_SENT",
      lastEmailStatus: emailStatus,
    },
  });
}

export async function markCustomerFollowUpSentManually(
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
  if (row.status !== "OPEN" && row.status !== "FAILED") {
    throw new ReferralError("Only an open or failed follow-up can be marked sent manually.");
  }
  return db.customerFollowUp.update({
    where: { id: row.id },
    data: {
      status: "SENT",
      sentAt: row.sentAt ?? new Date(),
      lastEmailStatus: row.lastEmailStatus ?? "MANUAL",
      lastSmsStatus: row.lastSmsStatus ?? "MANUAL",
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
