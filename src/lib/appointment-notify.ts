import type { Prisma, PrismaClient } from "@prisma/client";
import { recordAppointmentEvent } from "@/lib/appointment-data";
import { buildAppointmentProposedEmail } from "@/lib/appointment-mail";
import { attemptAppointmentSms } from "@/lib/customer-messaging";
import { lineItemTitle } from "@/lib/estimate-line-scope";
import { formatMailingAddress } from "@/lib/format";
import {
  appointmentProposedEmailIdempotencyKey,
  getAppUrl,
  getMailConfig,
  isUsableEmail,
  senderFrom,
  sendTransactionalEmail,
} from "@/lib/mail";

type NotifyClient = PrismaClient | Prisma.TransactionClient;

export function appointmentServiceDescription(
  lineItems: { description: string }[] | null | undefined,
) {
  const first = lineItems?.[0]?.description;
  const title = lineItemTitle(first).trim();
  return title || "Scheduled service";
}

export async function notifyCustomerAppointmentProposed(
  db: NotifyClient,
  input: {
    businessId: string;
    jobId: string;
    businessName: string;
    proposalId: number;
    scheduledAt: Date;
    scheduledDurationMinutes: number | null;
    rescheduled: boolean;
    sendAttemptId: string;
    actorMembershipId?: string | null;
  },
): Promise<{ sent: boolean; warning?: string }> {
  const job = await db.job.findFirst({
    where: { id: input.jobId, businessId: input.businessId },
    select: {
      id: true,
      projectToken: true,
      scheduledAt: true,
      scheduledDurationMinutes: true,
      customer: { select: { id: true, name: true, email: true } },
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
      estimate: {
        select: {
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: { description: true },
            take: 1,
          },
        },
      },
      approvedEstimateVersion: {
        select: {
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: { description: true },
            take: 1,
          },
        },
      },
    },
  });

  if (!job) {
    return { sent: false, warning: "That appointment could not be notified." };
  }

  const queueSms = () =>
    attemptAppointmentSms(db, {
      businessId: input.businessId,
      jobId: job.id,
      customerId: job.customer?.id ?? null,
      businessName: input.businessName,
      proposalId: input.proposalId,
      rescheduled: input.rescheduled,
      projectToken: job.projectToken,
      initiatedByMembershipId: input.actorMembershipId,
    });

  const fail = async (
    status: "FAILED" | "SKIPPED_NO_EMAIL" | "NOT_CONFIGURED",
    warning: string,
  ) => {
    await db.job.update({
      where: { id: job.id },
      data: {
        appointmentNotificationStatus: status,
        appointmentNotificationError: warning,
        appointmentNotifiedAt: new Date(),
        appointmentNotifiedForProposalId: input.proposalId,
      },
    });
    await recordAppointmentEvent(db, {
      businessId: input.businessId,
      jobId: job.id,
      eventType: "APPOINTMENT_NOTIFICATION_FAILED",
      appointmentProposalId: input.proposalId,
      scheduledAt: input.scheduledAt,
      scheduledDurationMinutes: input.scheduledDurationMinutes,
      actorKind: input.actorMembershipId ? "OWNER" : "SYSTEM",
      actorMembershipId: input.actorMembershipId,
      payload: { notificationStatus: status },
    });
    return { sent: false, warning };
  };

  const config = getMailConfig();
  if ("error" in config) {
    const result = await fail(
      "NOT_CONFIGURED",
      "Email delivery is not configured, so the customer was not notified.",
    );
    await queueSms();
    return result;
  }

  const recipient = job.customer?.email?.trim() ?? "";
  if (!isUsableEmail(recipient)) {
    const result = await fail(
      "SKIPPED_NO_EMAIL",
      "This customer has no usable email. Copy the project link so they can confirm in the project portal.",
    );
    await queueSms();
    return result;
  }

  const appUrl = config.appUrl || getAppUrl();
  if (!appUrl) {
    const result = await fail(
      "NOT_CONFIGURED",
      "Email delivery is not configured, so the customer was not notified.",
    );
    await queueSms();
    return result;
  }

  const email = buildAppointmentProposedEmail({
    businessName: input.businessName,
    customerName: job.customer?.name ?? null,
    address: job.property ? formatMailingAddress(job.property) : null,
    scheduledAt: input.scheduledAt,
    scheduledDurationMinutes: input.scheduledDurationMinutes,
    serviceDescription: appointmentServiceDescription(
      job.approvedEstimateVersion?.lineItems ?? job.estimate?.lineItems,
    ),
    projectUrl: `${appUrl}/p/${job.projectToken}`,
    rescheduled: input.rescheduled,
  });

  const sent = await sendTransactionalEmail({
    apiKey: config.apiKey,
    from: senderFrom(input.businessName, config.fromAddress),
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
    kind: "appointment",
    idempotencyKey: appointmentProposedEmailIdempotencyKey(
      job.id,
      input.proposalId,
      input.sendAttemptId,
    ),
  });

  if (sent.error) {
    const failed = await fail("FAILED", "The appointment email could not be sent.");
    await queueSms();
    return failed;
  }

  await db.job.update({
    where: { id: job.id },
    data: {
      appointmentNotificationStatus: "SENT",
      appointmentNotificationError: null,
      appointmentNotifiedAt: new Date(),
      appointmentNotifiedForProposalId: input.proposalId,
    },
  });
  await recordAppointmentEvent(db, {
    businessId: input.businessId,
    jobId: job.id,
    eventType: "APPOINTMENT_NOTIFICATION_SENT",
    appointmentProposalId: input.proposalId,
    scheduledAt: input.scheduledAt,
    scheduledDurationMinutes: input.scheduledDurationMinutes,
    actorKind: input.actorMembershipId ? "OWNER" : "SYSTEM",
    actorMembershipId: input.actorMembershipId,
    payload: { notificationStatus: "SENT" },
  });
  await queueSms();
  return { sent: true };
}
