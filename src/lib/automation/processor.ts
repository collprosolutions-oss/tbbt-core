/**
 * Database-backed automation processor. No dedicated queue is required.
 * Provider failure updates the run, never the core business record.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { attemptAutomationEmail, type AutomationEmailResult } from "@/lib/automation/email";
import { parseServerScheduledAt } from "@/lib/automation/timing";
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

type ChannelAttempt = {
  channel: "EMAIL" | "SMS";
  status: string;
  failureReason?: string | null;
};

function eventPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function summarizeAttempts(attempts: ChannelAttempt[]) {
  return attempts
    .map((row) => `${row.channel} ${row.status}${row.failureReason ? ` (${row.failureReason})` : ""}`)
    .join("; ");
}

function combineChannelOutcome(attempts: ChannelAttempt[]) {
  const summary = summarizeAttempts(attempts);
  const accepted = attempts.filter(
    (row) => row.status === "SENT" || isAcceptedCustomerMessageStatus(row.status),
  );
  if (accepted.length > 0 && accepted.length === attempts.length) {
    return { status: "SUCCEEDED" as const, summary };
  }
  if (accepted.length > 0) {
    return { status: "SUCCEEDED" as const, summary: `Partial: ${summary}` };
  }
  if (attempts.some((row) => row.status === "FAILED")) {
    return { status: "FAILED" as const, summary };
  }
  if (attempts.some((row) => row.status === "BLOCKED") && attempts.every((row) => row.channel === "SMS" || row.status === "SKIPPED" || row.status === "NOT_SENT" || row.status === "BLOCKED")) {
    return { status: "BLOCKED" as const, summary };
  }
  return { status: "SKIPPED" as const, summary };
}

async function resolveSmsTarget(
  db: Db,
  event: { type: string; subjectType: string; subjectId: string; payload: unknown },
  rule: { purpose: string },
  businessId: string,
  customerId: string,
  businessName: string,
) {
  const payload = eventPayload(event.payload);

  if (rule.purpose === "ESTIMATE_READY") {
    const estimate = await db.estimate.findFirst({
      where: { id: event.subjectId, businessId },
      select: { id: true, publicToken: true },
    });
    if (!estimate) return { error: "Estimate is not in this business." };
    return {
      send: () =>
        attemptEstimateReadySms(db, {
          businessId,
          estimateId: estimate.id,
          businessName,
          publicToken: estimate.publicToken,
          customerId,
        }),
    };
  }

  if (rule.purpose === "APPOINTMENT_CONFIRMATION" || rule.purpose === "SCHEDULE_CHANGE") {
    const job = await db.job.findFirst({
      where: { id: event.subjectId, businessId },
      select: { id: true, appointmentProposalId: true, projectToken: true },
    });
    if (!job) return { error: "Job is not in this business." };
    return {
      send: () =>
        attemptAppointmentSms(db, {
          businessId,
          jobId: job.id,
          customerId,
          businessName,
          proposalId: job.appointmentProposalId ?? 1,
          rescheduled: rule.purpose === "SCHEDULE_CHANGE",
          projectToken: job.projectToken,
        }),
    };
  }

  if (rule.purpose === "APPOINTMENT_REMINDER") {
    const job = await db.job.findFirst({
      where: { id: event.subjectId, businessId },
      select: {
        id: true,
        appointmentProposalId: true,
        scheduledAt: true,
        projectToken: true,
      },
    });
    if (!job) return { skip: "Job is not in this business." };
    const payloadProposal = typeof payload.proposalId === "number" ? payload.proposalId : null;
    const payloadScheduled = parseServerScheduledAt(payload.scheduledAt);
    if (
      payloadProposal == null ||
      job.appointmentProposalId !== payloadProposal ||
      !job.scheduledAt ||
      !payloadScheduled ||
      job.scheduledAt.getTime() !== payloadScheduled.getTime()
    ) {
      return { skip: "Appointment reminder is stale or superseded. SENT was not recorded." };
    }
    return {
      send: () =>
        attemptAppointmentReminderSms(db, {
          businessId,
          jobId: job.id,
          customerId,
          businessName,
          reminderKey: `proposal-${job.appointmentProposalId}`,
          projectToken: job.projectToken,
        }),
    };
  }

  if (rule.purpose === "INVOICE_READY" || rule.purpose === "PAYMENT_REMINDER") {
    const invoice = await db.invoice.findFirst({
      where: { id: event.subjectId, businessId },
      select: { id: true, job: { select: { projectToken: true } } },
    });
    if (!invoice) return { error: "Invoice is not in this business." };
    return {
      send: () =>
        rule.purpose === "INVOICE_READY"
          ? attemptInvoiceReadySms(db, {
              businessId,
              invoiceId: invoice.id,
              customerId,
              businessName,
              projectToken: invoice.job?.projectToken ?? null,
            })
          : attemptPaymentReminderSms(db, {
              businessId,
              invoiceId: invoice.id,
              customerId,
              businessName,
              reminderKey: event.type,
              projectToken: invoice.job?.projectToken ?? null,
            }),
    };
  }

  if (rule.purpose === "REVIEW_REQUEST") {
    const reviewRequestId = event.subjectType === "REVIEW_REQUEST" ? event.subjectId : null;
    if (!reviewRequestId) {
      return { skip: "Review request communications require a real ReviewRequest record." };
    }
    const request = await db.reviewRequest.findFirst({
      where: { id: reviewRequestId, businessId },
      select: { id: true, requestText: true },
    });
    if (!request) return { skip: "Review request is not in this business." };
    return {
      related: { type: "REVIEW_REQUEST", id: request.id },
      send: () =>
        attemptReviewRequestSms(db, {
          businessId,
          reviewRequestId: request.id,
          customerId,
          businessName,
          requestText: request.requestText,
        }),
    };
  }

  if (rule.purpose === "REFERRAL_REQUEST") {
    const referralRequestId = event.subjectType === "REFERRAL_REQUEST" ? event.subjectId : null;
    if (!referralRequestId) {
      return { skip: "Referral request communications require a real ReferralRequest record." };
    }
    const request = await db.referralRequest.findFirst({
      where: { id: referralRequestId, businessId },
      select: { id: true, requestText: true },
    });
    if (!request) return { skip: "Referral request is not in this business." };
    return {
      related: { type: "REFERRAL_REQUEST", id: request.id },
      send: () =>
        attemptReferralRequestSms(db, {
          businessId,
          referralRequestId: request.id,
          customerId,
          businessName,
          requestText: request.requestText,
        }),
    };
  }

  if (rule.purpose === "JOB_FOLLOW_UP" || rule.purpose === "REPEAT_FOLLOW_UP") {
    const followUpId = event.subjectType === "CUSTOMER_FOLLOW_UP" ? event.subjectId : null;
    if (!followUpId) {
      return { skip: "Follow-up communications require a real CustomerFollowUp record." };
    }
    const followUp = await db.customerFollowUp.findFirst({
      where: { id: followUpId, businessId },
      select: { id: true, kind: true },
    });
    if (!followUp) return { skip: "Follow-up is not in this business." };
    return {
      related: { type: "CUSTOMER_FOLLOW_UP", id: followUp.id },
      send: () =>
        followUp.kind === "REPEAT"
          ? attemptRepeatFollowUpSms(db, {
              businessId,
              followUpId: followUp.id,
              customerId,
              businessName,
            })
          : attemptJobFollowUpSms(db, {
              businessId,
              followUpId: followUp.id,
              customerId,
              businessName,
            }),
    };
  }

  return { skip: "No matching communication helper for this purpose." };
}

function emailStatus(result: AutomationEmailResult): ChannelAttempt {
  return {
    channel: "EMAIL",
    status: result.status,
    failureReason: result.failureReason,
  };
}

async function applyCommunicationRule(
  db: Db,
  run: { id: string; businessId: string },
  event: { type: string; subjectType: string; subjectId: string; payload: unknown },
  rule: { purpose: string; channel: string },
) {
  if (rule.channel === "NONE") {
    return { status: "SKIPPED" as const, summary: "Rule channel is NONE. No send was attempted." };
  }

  const payload = eventPayload(event.payload);
  const customerId = typeof payload.customerId === "string" ? payload.customerId : null;
  const businessName = typeof payload.businessName === "string" ? payload.businessName : "Your contractor";
  if (!customerId) {
    return { status: "SKIPPED" as const, summary: "No customer is attached to this event." };
  }

  const wantsEmail = rule.channel === "EMAIL" || rule.channel === "BOTH";
  const wantsSms = rule.channel === "SMS" || rule.channel === "BOTH";
  if (!wantsEmail && !wantsSms) {
    return { status: "SKIPPED" as const, summary: "Rule channel is not implemented." };
  }

  const smsTarget = wantsSms
    ? await resolveSmsTarget(db, event, rule, run.businessId, customerId, businessName)
    : null;

  const attempts: ChannelAttempt[] = [];
  if (wantsEmail) {
    attempts.push(
      emailStatus(
        await attemptAutomationEmail(db, {
          businessId: run.businessId,
          runId: run.id,
          purpose: rule.purpose,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          customerId,
          businessName,
          payload,
        }),
      ),
    );
  }
  if (wantsSms) {
    if (smsTarget && "skip" in smsTarget && smsTarget.skip) {
      attempts.push({ channel: "SMS", status: "SKIPPED", failureReason: smsTarget.skip });
    } else if (smsTarget && "error" in smsTarget && smsTarget.error) {
      attempts.push({ channel: "SMS", status: "SKIPPED", failureReason: smsTarget.error });
    } else if (smsTarget?.send) {
      const result = await smsTarget.send();
      attempts.push({
        channel: "SMS",
        status: result?.status ?? "NOT_SENT",
        failureReason: result?.failureReason,
      });
    } else {
      attempts.push({ channel: "SMS", status: "SKIPPED", failureReason: "SMS was not attempted." });
    }
  }

  if (attempts.length === 0) {
    return { status: "SKIPPED" as const, summary: "No channel was attempted." };
  }
  return combineChannelOutcome(attempts);
}

export async function claimAutomationRun(
  db: Db,
  input: { id: string; businessId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const claimed = await db.automationRun.updateMany({
    where: {
      id: input.id,
      businessId: input.businessId,
      status: "PENDING",
      availableAt: { lte: now },
    },
    data: {
      status: "PROCESSING",
    },
  });
  if (claimed.count !== 1) return null;
  return db.automationRun.findFirst({
    where: { id: input.id, businessId: input.businessId, status: "PROCESSING" },
    include: { event: true, rule: true },
  });
}

export async function processPendingAutomationRuns(db: Db, businessId: string, now = new Date()) {
  const pending = await db.automationRun.findMany({
    where: {
      businessId,
      status: "PENDING",
      availableAt: { lte: now },
    },
    take: 25,
    orderBy: { availableAt: "asc" },
    select: { id: true, attemptCount: true },
  });

  const results = [];
  for (const listed of pending) {
    const nextAttempt = listed.attemptCount + 1;
    if (nextAttempt > 3) {
      const updated = await db.automationRun.updateMany({
        where: { id: listed.id, businessId, status: "PENDING" },
        data: {
          status: "FAILED",
          attemptCount: nextAttempt,
          lastError: "Retry limit reached. Core business records were not changed.",
          processedAt: now,
        },
      });
      if (updated.count === 1) {
        results.push(await db.automationRun.findUniqueOrThrow({ where: { id: listed.id } }));
      }
      continue;
    }

    const run = await claimAutomationRun(db, { id: listed.id, businessId, now });
    if (!run) continue;

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
