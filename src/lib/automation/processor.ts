/**
 * Database-backed automation processor. No dedicated queue is required.
 * Provider failure updates the run, never the core business record.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  attemptAppointmentReminderSms,
  attemptAppointmentSms,
  attemptEstimateReadySms,
  attemptInvoiceReadySms,
  attemptJobFollowUpSms,
  attemptPaymentReminderSms,
  attemptReferralRequestSms,
  attemptRepeatFollowUpSms,
  attemptReviewRequestSms,
} from "@/lib/customer-messaging/workflows";
import { isAcceptedCustomerMessageStatus } from "@/lib/customer-messaging/types";

type Db = PrismaClient | Prisma.TransactionClient;

async function applyCommunicationRule(
  db: Db,
  run: { id: string; businessId: string },
  event: { type: string; subjectId: string; payload: unknown },
  rule: { purpose: string; channel: string },
) {
  if (rule.channel === "NONE") {
    return { status: "SKIPPED" as const, summary: "Rule channel is NONE. No send was attempted." };
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const customerId = typeof payload.customerId === "string" ? payload.customerId : null;
  const businessName = typeof payload.businessName === "string" ? payload.businessName : "Your contractor";
  if (!customerId) {
    return { status: "SKIPPED" as const, summary: "No customer is attached to this event." };
  }

  if (rule.channel === "EMAIL") {
    return {
      status: "SKIPPED" as const,
      summary: "Email automation uses the existing Resend path at the source action. This rule did not mark anything SENT.",
    };
  }

  let result: { status?: string; failureReason?: string | null } | null = null;
  if (rule.purpose === "ESTIMATE_READY") {
    result = await attemptEstimateReadySms(db, {
      businessId: run.businessId,
      estimateId: event.subjectId,
      businessName,
      publicToken: typeof payload.publicToken === "string" ? payload.publicToken : null,
      customerId,
    });
  } else if (rule.purpose === "APPOINTMENT_CONFIRMATION" || rule.purpose === "SCHEDULE_CHANGE") {
    result = await attemptAppointmentSms(db, {
      businessId: run.businessId,
      jobId: event.subjectId,
      customerId,
      businessName,
      proposalId: typeof payload.proposalId === "number" ? payload.proposalId : 1,
      rescheduled: rule.purpose === "SCHEDULE_CHANGE",
      projectToken: typeof payload.projectToken === "string" ? payload.projectToken : null,
    });
  } else if (rule.purpose === "APPOINTMENT_REMINDER") {
    result = await attemptAppointmentReminderSms(db, {
      businessId: run.businessId,
      jobId: event.subjectId,
      customerId,
      businessName,
      reminderKey: typeof payload.reminderKey === "string" ? payload.reminderKey : "due",
      projectToken: typeof payload.projectToken === "string" ? payload.projectToken : null,
    });
  } else if (rule.purpose === "INVOICE_READY") {
    result = await attemptInvoiceReadySms(db, {
      businessId: run.businessId,
      invoiceId: event.subjectId,
      customerId,
      businessName,
      projectToken: typeof payload.projectToken === "string" ? payload.projectToken : null,
    });
  } else if (rule.purpose === "PAYMENT_REMINDER") {
    result = await attemptPaymentReminderSms(db, {
      businessId: run.businessId,
      invoiceId: event.subjectId,
      customerId,
      businessName,
      reminderKey: typeof payload.reminderKey === "string" ? payload.reminderKey : event.type,
      projectToken: typeof payload.projectToken === "string" ? payload.projectToken : null,
    });
  } else if (rule.purpose === "REVIEW_REQUEST") {
    result = await attemptReviewRequestSms(db, {
      businessId: run.businessId,
      reviewRequestId: typeof payload.reviewRequestId === "string" ? payload.reviewRequestId : event.subjectId,
      customerId,
      businessName,
      requestText: typeof payload.requestText === "string" ? payload.requestText : "We would value an honest review of the completed work.",
    });
  } else if (rule.purpose === "REFERRAL_REQUEST") {
    result = await attemptReferralRequestSms(db, {
      businessId: run.businessId,
      referralRequestId: typeof payload.referralRequestId === "string" ? payload.referralRequestId : event.subjectId,
      customerId,
      businessName,
      requestText: typeof payload.requestText === "string" ? payload.requestText : "If you know someone who needs similar work, we would appreciate a referral.",
    });
  } else if (rule.purpose === "JOB_FOLLOW_UP") {
    result = await attemptJobFollowUpSms(db, {
      businessId: run.businessId,
      followUpId: typeof payload.followUpId === "string" ? payload.followUpId : event.subjectId,
      customerId,
      businessName,
    });
  } else if (rule.purpose === "REPEAT_FOLLOW_UP") {
    result = await attemptRepeatFollowUpSms(db, {
      businessId: run.businessId,
      followUpId: event.subjectId,
      customerId,
      businessName,
    });
  }

  if (!result?.status) {
    return { status: "SKIPPED" as const, summary: "No matching communication helper for this purpose." };
  }
  if (isAcceptedCustomerMessageStatus(result.status)) {
    return { status: "SUCCEEDED" as const, summary: `Provider accepted SMS as ${result.status}.` };
  }
  if (result.status === "BLOCKED") {
    return { status: "BLOCKED" as const, summary: result.failureReason || "SMS was blocked by consent or preference." };
  }
  if (result.status === "NOT_SENT") {
    return { status: "SKIPPED" as const, summary: result.failureReason || "SMS delivery is not connected." };
  }
  return { status: "FAILED" as const, summary: result.failureReason || "Provider did not accept the message. SENT was not recorded." };
}

export async function processPendingAutomationRuns(db: Db, businessId: string, now = new Date()) {
  const pending = await db.automationRun.findMany({
    where: {
      businessId,
      status: "PENDING",
      availableAt: { lte: now },
    },
    include: {
      event: true,
      rule: true,
    },
    take: 25,
    orderBy: { availableAt: "asc" },
  });

  const results = [];
  for (const run of pending) {
    const nextAttempt = run.attemptCount + 1;
    if (nextAttempt > 3) {
      const updated = await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          attemptCount: nextAttempt,
          lastError: "Retry limit reached. Core business records were not changed.",
          processedAt: now,
        },
      });
      results.push(updated);
      continue;
    }
    try {
      if (!run.rule) {
        const updated = await db.automationRun.update({
          where: { id: run.id },
          data: {
            status: "SKIPPED",
            attemptCount: nextAttempt,
            resultSummary: "Rule is no longer available.",
            processedAt: now,
          },
        });
        results.push(updated);
        continue;
      }
      if (run.rule.kind === "ACTION_SUGGESTION") {
        const updated = await db.automationRun.update({
          where: { id: run.id },
          data: {
            status: "SUCCEEDED",
            attemptCount: nextAttempt,
            resultSummary: `Recorded ${run.event.type} for owner action. No message was sent.`,
            processedAt: now,
          },
        });
        results.push(updated);
        continue;
      }
      const outcome = await applyCommunicationRule(db, run, run.event, run.rule);
      const updated = await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: outcome.status,
          attemptCount: nextAttempt,
          resultSummary: outcome.summary,
          lastError: outcome.status === "FAILED" ? outcome.summary : null,
          processedAt: now,
        },
      });
      results.push(updated);
    } catch (error) {
      const updated = await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: nextAttempt >= 3 ? "FAILED" : "PENDING",
          attemptCount: nextAttempt,
          lastError: error instanceof Error ? error.message : "Automation run failed.",
          processedAt: nextAttempt >= 3 ? now : null,
        },
      });
      results.push(updated);
    }
  }
  return results;
}
