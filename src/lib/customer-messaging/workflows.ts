import type { Prisma, PrismaClient } from "@prisma/client";
import {
  appointmentConfirmationSmsBody,
  appointmentReminderSmsBody,
  customerSmsIdempotencyKey,
  estimateReadySmsBody,
  invoiceReadySmsBody,
  jobFollowUpSmsBody,
  paymentReminderSmsBody,
  referralRequestSmsBody,
  repeatFollowUpSmsBody,
  reviewReminderSmsBody,
  reviewRequestSmsBody,
} from "@/lib/customer-messaging/bodies";
import { safeAttemptCustomerSms } from "@/lib/customer-messaging/ops";
import type { CustomerCommunicationAttemptResult } from "@/lib/customer-messaging/types";
import { tenantEstimateUrl, tenantInvoiceUrl, tenantProjectUrl } from "@/lib/tenant-app-url";

type Db = PrismaClient | Prisma.TransactionClient;

async function businessSlug(db: Db, businessId: string) {
  const row = await db.business.findUnique({
    where: { id: businessId },
    select: { slug: true },
  });
  return row?.slug ?? null;
}

function projectUrl(slug: string | null, token: string | null | undefined) {
  return token && slug ? tenantProjectUrl(slug, token) : null;
}

function invoicePortalUrl(slug: string | null, token: string | null | undefined) {
  return token && slug ? tenantInvoiceUrl(slug, token) : null;
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
  const slug = await businessSlug(db, input.businessId);
  const url = input.publicToken && slug ? tenantEstimateUrl(slug, input.publicToken) : null;
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
  const slug = await businessSlug(db, input.businessId);
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose,
    relatedType: "JOB",
    relatedId: input.jobId,
    idempotencyKey: customerSmsIdempotencyKey(purpose, input.jobId, String(input.proposalId)),
    body: appointmentConfirmationSmsBody({
      businessName: input.businessName,
      url: projectUrl(slug, input.projectToken),
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
  const slug = await businessSlug(db, input.businessId);
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
      url: projectUrl(slug, input.projectToken),
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
  const slug = await businessSlug(db, input.businessId);
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "INVOICE_READY",
    relatedType: "INVOICE",
    relatedId: input.invoiceId,
    idempotencyKey: customerSmsIdempotencyKey("INVOICE_READY", input.invoiceId),
    body: invoiceReadySmsBody({
      businessName: input.businessName,
      url: invoicePortalUrl(slug, input.projectToken),
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
  const slug = await businessSlug(db, input.businessId);
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
      url: invoicePortalUrl(slug, input.projectToken),
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

export async function attemptReviewReminderSms(
  db: Db,
  input: {
    businessId: string;
    reviewRequestId: string;
    customerId: string;
    businessName: string;
    requestText: string;
    reminderKey: string;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "REVIEW_REMINDER",
    relatedType: "REVIEW_REQUEST",
    relatedId: input.reviewRequestId,
    idempotencyKey: customerSmsIdempotencyKey(
      "REVIEW_REMINDER",
      input.reviewRequestId,
      input.reminderKey,
    ),
    body: reviewReminderSmsBody({
      requestText: input.requestText,
      businessName: input.businessName,
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptReferralRequestSms(
  db: Db,
  input: {
    businessId: string;
    referralRequestId: string;
    customerId: string;
    businessName: string;
    requestText: string;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "REFERRAL_REQUEST",
    relatedType: "REFERRAL_REQUEST",
    relatedId: input.referralRequestId,
    idempotencyKey: customerSmsIdempotencyKey("REFERRAL_REQUEST", input.referralRequestId),
    body: referralRequestSmsBody({
      requestText: input.requestText,
      businessName: input.businessName,
    }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptJobFollowUpSms(
  db: Db,
  input: {
    businessId: string;
    followUpId: string;
    customerId: string;
    businessName: string;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "JOB_FOLLOW_UP",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: input.followUpId,
    idempotencyKey: customerSmsIdempotencyKey("JOB_FOLLOW_UP", input.followUpId),
    body: jobFollowUpSmsBody({ businessName: input.businessName }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}

export async function attemptRepeatFollowUpSms(
  db: Db,
  input: {
    businessId: string;
    followUpId: string;
    customerId: string;
    businessName: string;
    initiatedByMembershipId?: string | null;
  },
) {
  return safeAttemptCustomerSms(db, {
    businessId: input.businessId,
    customerId: input.customerId,
    purpose: "REPEAT_FOLLOW_UP",
    relatedType: "CUSTOMER_FOLLOW_UP",
    relatedId: input.followUpId,
    idempotencyKey: customerSmsIdempotencyKey("REPEAT_FOLLOW_UP", input.followUpId),
    body: repeatFollowUpSmsBody({ businessName: input.businessName }),
    initiatedByMembershipId: input.initiatedByMembershipId,
  });
}
