import type { Prisma, PrismaClient } from "@prisma/client";
import { buildAppointmentProposedEmail } from "@/lib/appointment-mail";
import { buildEstimateReadyEmail } from "@/lib/estimate-mail";
import { buildInvoiceReadyEmail } from "@/lib/invoice-mail";
import {
  appointmentProposedEmailIdempotencyKey,
  estimateEmailIdempotencyKey,
  followUpEmailIdempotencyKey,
  getMailConfig,
  invoiceReadyIdempotencyKey,
  isUsableEmail,
  referralRequestEmailIdempotencyKey,
  reviewRequestEmailIdempotencyKey,
  sendTransactionalEmail,
  senderFrom,
} from "@/lib/mail";
import { tenantEstimateUrl, tenantInvoiceUrl, tenantProjectUrl } from "@/lib/tenant-app-url";

type Db = PrismaClient | Prisma.TransactionClient;

export type AutomationEmailResult = {
  status: "SENT" | "NOT_SENT" | "FAILED" | "SKIPPED";
  failureReason?: string;
};

async function sendOwnedCustomerEmail(
  db: Db,
  input: {
    businessId: string;
    customerId: string;
    businessName: string;
    subject: string;
    text: string;
    html: string;
    kind: "estimate" | "invoice" | "appointment" | "review" | "referral" | "follow-up";
    idempotencyKey: string;
  },
): Promise<AutomationEmailResult> {
  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: { email: true },
  });
  if (!isUsableEmail(customer?.email)) {
    return { status: "SKIPPED", failureReason: "No usable customer email." };
  }
  const config = getMailConfig();
  if ("error" in config) {
    return { status: "NOT_SENT", failureReason: "Email delivery is not connected." };
  }
  const sent = await sendTransactionalEmail({
    apiKey: config.apiKey,
    from: senderFrom(input.businessName, config.fromAddress),
    to: customer!.email!.trim(),
    subject: input.subject,
    text: input.text,
    html: input.html,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
  });
  if ("error" in sent) {
    return { status: "FAILED", failureReason: sent.error };
  }
  return { status: "SENT" };
}

async function businessSlug(db: Db, businessId: string) {
  const row = await db.business.findUnique({
    where: { id: businessId },
    select: { slug: true },
  });
  return row?.slug ?? null;
}

function parseIsoDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function attemptAutomationEmail(
  db: Db,
  input: {
    businessId: string;
    runId: string;
    purpose: string;
    subjectType: string;
    subjectId: string;
    customerId: string;
    businessName: string;
    payload: Record<string, unknown>;
  },
): Promise<AutomationEmailResult> {
  const slug = await businessSlug(db, input.businessId);
  const proposalId = typeof input.payload.proposalId === "number" ? input.payload.proposalId : 1;
  const key =
    input.purpose === "ESTIMATE_READY"
      ? estimateEmailIdempotencyKey(input.subjectId, "auto")
      : input.purpose === "INVOICE_READY"
        ? invoiceReadyIdempotencyKey(input.subjectId)
        : input.purpose === "APPOINTMENT_CONFIRMATION" || input.purpose === "SCHEDULE_CHANGE"
          ? appointmentProposedEmailIdempotencyKey(input.subjectId, proposalId, "auto")
          : input.purpose === "APPOINTMENT_REMINDER"
            ? `appointment-reminder/${input.subjectId}/${proposalId}`
            : input.purpose === "REVIEW_REQUEST"
              ? reviewRequestEmailIdempotencyKey(input.subjectId, "sent")
              : input.purpose === "REFERRAL_REQUEST"
                ? referralRequestEmailIdempotencyKey(input.subjectId, "sent")
                : input.purpose === "JOB_FOLLOW_UP" || input.purpose === "REPEAT_FOLLOW_UP"
                  ? followUpEmailIdempotencyKey(input.subjectId, "sent")
                  : input.purpose === "PAYMENT_REMINDER"
                    ? `invoice-payment-reminder/${input.subjectId}/${input.runId}`
                    : `automation-email/${input.runId}`;

  if (input.purpose === "ESTIMATE_READY") {
    const estimate = await db.estimate.findFirst({
      where: { id: input.subjectId, businessId: input.businessId },
      select: {
        publicToken: true,
        total: true,
        customer: { select: { name: true } },
      },
    });
    if (!estimate) return { status: "SKIPPED", failureReason: "Estimate is not in this business." };
    const url =
      (estimate.publicToken && slug ? tenantEstimateUrl(slug, estimate.publicToken) : null) ??
      "the estimate link in TBBT";
    const email = buildEstimateReadyEmail({
      businessName: input.businessName,
      customerName: estimate.customer?.name ?? null,
      total: estimate.total,
      address: null,
      approveUrl: url,
    });
    return sendOwnedCustomerEmail(db, {
      businessId: input.businessId,
      customerId: input.customerId,
      businessName: input.businessName,
      subject: email.subject,
      text: email.text,
      html: email.html,
      kind: "estimate",
      idempotencyKey: key,
    });
  }

  if (input.purpose === "INVOICE_READY" || input.purpose === "PAYMENT_REMINDER") {
    const invoice = await db.invoice.findFirst({
      where: { id: input.subjectId, businessId: input.businessId },
      select: {
        total: true,
        customer: { select: { name: true } },
        job: { select: { projectToken: true } },
      },
    });
    if (!invoice) return { status: "SKIPPED", failureReason: "Invoice is not in this business." };
    const url =
      (invoice.job?.projectToken && slug
        ? tenantInvoiceUrl(slug, invoice.job.projectToken)
        : null) ?? "the invoice link in TBBT";
    const email = buildInvoiceReadyEmail({
      businessName: input.businessName,
      customerName: invoice.customer?.name ?? null,
      total: invoice.total,
      address: null,
      invoiceUrl: url,
    });
    return sendOwnedCustomerEmail(db, {
      businessId: input.businessId,
      customerId: input.customerId,
      businessName: input.businessName,
      subject:
        input.purpose === "PAYMENT_REMINDER"
          ? `Payment reminder from ${input.businessName}`
          : email.subject,
      text: email.text,
      html: email.html,
      kind: "invoice",
      idempotencyKey: key,
    });
  }

  if (
    input.purpose === "APPOINTMENT_CONFIRMATION" ||
    input.purpose === "SCHEDULE_CHANGE" ||
    input.purpose === "APPOINTMENT_REMINDER"
  ) {
    const job = await db.job.findFirst({
      where: { id: input.subjectId, businessId: input.businessId },
      select: {
        scheduledAt: true,
        scheduledDurationMinutes: true,
        appointmentProposalId: true,
        projectToken: true,
        customer: { select: { name: true } },
      },
    });
    if (!job?.scheduledAt) return { status: "SKIPPED", failureReason: "Job has no recorded appointment time." };
    const payloadProposal = typeof input.payload.proposalId === "number" ? input.payload.proposalId : null;
    const payloadScheduled = parseIsoDate(input.payload.scheduledAt);
    if (
      input.purpose === "APPOINTMENT_REMINDER" &&
      (
        payloadProposal == null ||
        job.appointmentProposalId !== payloadProposal ||
        !payloadScheduled ||
        job.scheduledAt.getTime() !== payloadScheduled.getTime()
      )
    ) {
      return { status: "SKIPPED", failureReason: "Appointment reminder is stale or superseded. SENT was not recorded." };
    }
    const url =
      (job.projectToken && slug ? tenantProjectUrl(slug, job.projectToken) : null) ??
      "the project link in TBBT";
    const email = buildAppointmentProposedEmail({
      businessName: input.businessName,
      customerName: job.customer?.name ?? null,
      address: null,
      scheduledAt: job.scheduledAt,
      scheduledDurationMinutes: job.scheduledDurationMinutes,
      serviceDescription: null,
      projectUrl: url,
      rescheduled: input.purpose === "SCHEDULE_CHANGE",
    });
    return sendOwnedCustomerEmail(db, {
      businessId: input.businessId,
      customerId: input.customerId,
      businessName: input.businessName,
      subject:
        input.purpose === "APPOINTMENT_REMINDER"
          ? `Appointment reminder from ${input.businessName}`
          : email.subject,
      text: email.text,
      html: email.html,
      kind: "appointment",
      idempotencyKey: key,
    });
  }

  if (input.purpose === "REVIEW_REQUEST" || input.purpose === "REFERRAL_REQUEST") {
    if (input.purpose === "REVIEW_REQUEST") {
      if (input.subjectType !== "REVIEW_REQUEST") {
        return { status: "SKIPPED", failureReason: "Review request communications require a real ReviewRequest record." };
      }
      const request = await db.reviewRequest.findFirst({
        where: { id: input.subjectId, businessId: input.businessId },
        select: { id: true, status: true },
      });
      if (!request) return { status: "SKIPPED", failureReason: "Review request is not in this business." };
      if (request.status === "SENT" || request.status === "COMPLETED" || request.status === "CANCELLED") {
        return { status: "SKIPPED", failureReason: "Review request is already recorded as sent or closed." };
      }
      if (request.status !== "READY" && request.status !== "FAILED") {
        return { status: "SKIPPED", failureReason: "Review request is not READY. DRAFT records are not sent automatically." };
      }
    } else {
      if (input.subjectType !== "REFERRAL_REQUEST") {
        return { status: "SKIPPED", failureReason: "Referral request communications require a real ReferralRequest record." };
      }
      const request = await db.referralRequest.findFirst({
        where: { id: input.subjectId, businessId: input.businessId },
        select: { id: true, status: true },
      });
      if (!request) return { status: "SKIPPED", failureReason: "Referral request is not in this business." };
      if (request.status === "SENT" || request.status === "COMPLETED" || request.status === "CANCELLED") {
        return { status: "SKIPPED", failureReason: "Referral request is already recorded as sent or closed." };
      }
      if (request.status !== "READY" && request.status !== "FAILED") {
        return { status: "SKIPPED", failureReason: "Referral request is not READY. DRAFT records are not sent automatically." };
      }
    }
    const text =
      typeof input.payload.requestText === "string"
        ? input.payload.requestText
        : input.purpose === "REVIEW_REQUEST"
          ? "We would value an honest review of the completed work."
          : "If you know someone who needs similar work, we would appreciate a referral.";
    return sendOwnedCustomerEmail(db, {
      businessId: input.businessId,
      customerId: input.customerId,
      businessName: input.businessName,
      subject:
        input.purpose === "REVIEW_REQUEST"
          ? `${input.businessName} would value an honest review`
          : `${input.businessName} would appreciate a referral`,
      text,
      html: `<p>${text.replace(/\n/g, "<br />")}</p>`,
      kind: input.purpose === "REVIEW_REQUEST" ? "review" : "referral",
      idempotencyKey: key,
    });
  }

  if (input.purpose === "JOB_FOLLOW_UP" || input.purpose === "REPEAT_FOLLOW_UP") {
    if (input.subjectType !== "CUSTOMER_FOLLOW_UP") {
      return { status: "SKIPPED", failureReason: "Follow-up communications require a real CustomerFollowUp record." };
    }
    const followUp = await db.customerFollowUp.findFirst({
      where: { id: input.subjectId, businessId: input.businessId },
      select: { id: true, status: true },
    });
    if (!followUp) return { status: "SKIPPED", failureReason: "Follow-up is not in this business." };
    if (followUp.status === "SENT" || followUp.status === "CANCELLED") {
      return { status: "SKIPPED", failureReason: "Follow-up is already recorded as sent or closed." };
    }
    if (followUp.status !== "OPEN" && followUp.status !== "FAILED") {
      return { status: "SKIPPED", failureReason: "Follow-up is not open for send." };
    }
    const text = `Thank you again from ${input.businessName}. This is a recorded follow-up, not an automatic campaign.`;
    return sendOwnedCustomerEmail(db, {
      businessId: input.businessId,
      customerId: input.customerId,
      businessName: input.businessName,
      subject: `A follow-up from ${input.businessName}`,
      text,
      html: `<p>${text}</p>`,
      kind: "follow-up",
      idempotencyKey: key,
    });
  }

  return { status: "SKIPPED", failureReason: "No email template for this purpose." };
}
