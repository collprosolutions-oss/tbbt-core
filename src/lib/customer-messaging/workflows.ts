import type { Prisma, PrismaClient } from "@prisma/client";
import {
  appointmentConfirmationSmsBody,
  appointmentReminderSmsBody,
  customerSmsIdempotencyKey,
  estimateReadySmsBody,
  invoiceReadySmsBody,
  paymentReminderSmsBody,
  reviewRequestSmsBody,
} from "@/lib/customer-messaging/bodies";
import { safeAttemptCustomerSms } from "@/lib/customer-messaging/ops";
import type { CustomerCommunicationAttemptResult } from "@/lib/customer-messaging/types";
import { getAppUrl } from "@/lib/mail";

type Db = PrismaClient | Prisma.TransactionClient;

function projectUrl(token: string | null | undefined) {
  const appUrl = getAppUrl();
  if (!appUrl || !token) return null;
  return `${appUrl}/p/${token}`;
}

function invoicePortalUrl(token: string | null | undefined) {
  const portal = projectUrl(token);
  return portal ? `${portal}/invoice` : null;
}

export async function attemptEstimateReadySms(
  db: Db,
  input: {
    businessId: string;
    estimateId: string;
    businessName: string;
    publicToken?: string | null;
    customerId?: string | null;
    initiatedByMembershipId?: string | null;
  },
): Promise<CustomerCommunicationAttemptResult | null> {
  if (!input.customerId) return null;
  const appUrl = getAppUrl();
  const url = appUrl && input.publicToken ? `${appUrl}/e/${input.publicToken}` : null;
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "ESTIMATE_READY",
    relatedType: "ESTIMATE",
    relatedId: input.estimateId,
    idempotencyKey: customerSmsIdempotencyKey("ESTIMATE_READY", input.estimateId),
    body: estimateReadySmsBody({ businessName: input.businessName, url }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptAppointmentSms(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    customerId?: string | null;
    businessName: string;
    proposalId: number;
    rescheduled: boolean;
    projectToken?: string | null;
    initiatedByMembershipId?: string | null;
  },
): Promise<CustomerCommunicationAttemptResult | null> {
  if (!input.customerId) return null;
  const purpose = input.rescheduled ? "SCHEDULE_CHANGE" : "APPOINTMENT_CONFIRMATION";
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose,
    relatedType: "JOB",
    relatedId: input.jobId,
    idempotencyKey: customerSmsIdempotencyKey(purpose, input.jobId, String(input.proposalId)),
    body: appointmentConfirmationSmsBody({
      businessName: input.businessName,
      url: projectUrl(input.projectToken),
      rescheduled: input.rescheduled,
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptAppointmentReminderSms(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    customerId: string;
    businessName: string;
    reminderKey: string;
    projectToken?: string | null;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "APPOINTMENT_REMINDER",
    relatedType: "JOB",
    relatedId: input.jobId,
    idempotencyKey: customerSmsIdempotencyKey(
      "APPOINTMENT_REMINDER",
      input.jobId,
      input.reminderKey,
    ),
    body: appointmentReminderSmsBody({
      businessName: input.businessName,
      url: projectUrl(input.projectToken),
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptInvoiceReadySms(
  db: Db,
  input: {
    businessId: string;
    invoiceId: string;
    customerId?: string | null;
    businessName: string;
    projectToken?: string | null;
    initiatedByMembershipId?: string | null;
  },
) {
  if (!input.customerId) return null;
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "INVOICE_READY",
    relatedType: "INVOICE",
    relatedId: input.invoiceId,
    idempotencyKey: customerSmsIdempotencyKey("INVOICE_READY", input.invoiceId),
    body: invoiceReadySmsBody({
      businessName: input.businessName,
      url: invoicePortalUrl(input.projectToken),
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptPaymentReminderSms(
  db: Db,
  input: {
    businessId: string;
    invoiceId: string;
    customerId: string;
    businessName: string;
    reminderKey: string;
    projectToken?: string | null;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "PAYMENT_REMINDER",
    relatedType: "INVOICE",
    relatedId: input.invoiceId,
    idempotencyKey: customerSmsIdempotencyKey(
      "PAYMENT_REMINDER",
      input.invoiceId,
      input.reminderKey,
    ),
    body: paymentReminderSmsBody({
      businessName: input.businessName,
      url: invoicePortalUrl(input.projectToken),
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptReviewRequestSms(
  db: Db,
  input: {
    businessId: string;
    reviewRequestId: string;
    customerId: string;
    businessName: string;
    requestText: string;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "REVIEW_REQUEST",
    relatedType: "REVIEW_REQUEST",
    relatedId: input.reviewRequestId,
    idempotencyKey: customerSmsIdempotencyKey("REVIEW_REQUEST", input.reviewRequestId),
    body: reviewRequestSmsBody({
      requestText: input.requestText,
      businessName: input.businessName,
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}
