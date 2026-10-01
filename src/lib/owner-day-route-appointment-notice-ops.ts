/**
 * OWNER mutation: review and send a notice for one same-business
 * recorded appointment from the day-route page.
 *
 * Uses the existing communications provider and consent rules. Page load
 * and the appointment change itself never call this. Does not invent an
 * arrival time or claim travel optimization.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { customerNotificationNeeded } from "@/lib/appointment-confirmation";
import { recordAppointmentEvent } from "@/lib/appointment-data";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import { composeCustomerCommunication } from "@/lib/communications";
import type { CommunicationSendResult } from "@/lib/communications/engine";
import { isAcceptedCustomerMessageStatus } from "@/lib/customer-messaging/types";
import { isCustomerMessagingConfigured } from "@/lib/customer-messaging/config";
import { sameBusinessJob } from "@/lib/owner-day-route/address";
import {
  ownerDayRouteScheduleSnapshotsEqual,
  scheduleSnapshotFromJob,
} from "@/lib/owner-day-route/snapshot";
import type { OwnerDayRouteScheduleSnapshot } from "@/lib/owner-day-route/types";
import {
  buildDayRouteAppointmentNoticeBody,
  buildDayRouteAppointmentNoticeSubject,
  buildOwnerDayRouteAppointmentNoticePreview,
  DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE,
  DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE,
  dayRouteAppointmentNoticeDestinationFingerprint,
  dayRouteAppointmentNoticeIdempotencyKey,
  parseDayRouteAppointmentNoticeReviewSnapshot,
  parseDayRouteAppointmentNoticeSnapshot,
  recordedDayRouteAppointmentNoticeEligible,
  resolveDayRouteAppointmentNoticeChannel,
  scheduleFieldsFromNoticeReview,
  type DayRouteAppointmentNoticeChannel,
  type DayRouteAppointmentNoticeJob,
  type DayRouteAppointmentNoticeReviewSnapshot,
  type OwnerDayRouteAppointmentNoticePreview,
} from "@/lib/owner-day-route-appointment-notice";
import {
  dayRouteAppointmentErrorMessage,
  missingDayRouteAppointmentSchema,
} from "@/lib/owner-day-route-appointment-ops";
import { hasProductCapability } from "@/lib/product-entitlements/enforce";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { DEFAULT_SETTINGS_PREFERENCES, isEmailDeliveryConfigured } from "@/lib/settings";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";
import { tenantProjectUrl } from "@/lib/tenant-app-url";

type NoticeDb = PrismaClient | Prisma.TransactionClient;

export class DayRouteAppointmentNoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayRouteAppointmentNoticeError";
  }
}

const NOTICE_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  status: true,
  scheduledAt: true,
  scheduledDurationMinutes: true,
  arrivalWindowMinutes: true,
  pickupDurationMinutes: true,
  assignedMembershipId: true,
  appointmentProposalId: true,
  appointmentNotificationStatus: true,
  appointmentNotificationError: true,
  appointmentNotifiedAt: true,
  appointmentNotifiedForProposalId: true,
  projectToken: true,
  customer: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      smsConsentStatus: true,
    },
  },
} as const;

type NoticeJob = Prisma.JobGetPayload<{ select: typeof NOTICE_JOB_SELECT }>;

export type SendOwnerDayRouteAppointmentNoticeInput = {
  jobId: string;
  snapshot: OwnerDayRouteScheduleSnapshot | DayRouteAppointmentNoticeReviewSnapshot | string;
  confirmSend: string;
  timeZone?: string | null;
  reviewedChannel?: string | null;
  reviewedProposalId?: number | string | null;
  reviewedCustomerId?: string | null;
  reviewedDestinationFingerprint?: string | null;
};

export type SentOwnerDayRouteAppointmentNotice = {
  jobId: string;
  businessId: string;
  channel: DayRouteAppointmentNoticeChannel;
  appointmentWindowLabel: string;
  recipientLabel: string;
  communicationId: string | null;
  reused: false;
};

function assertOwner(access: BusinessAccess) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function readBindingField(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function snapshotBinding(
  snapshot: OwnerDayRouteScheduleSnapshot | DayRouteAppointmentNoticeReviewSnapshot,
  key: "customerId" | "destinationFingerprint",
) {
  if (!(key in snapshot)) return null;
  const value = (snapshot as DayRouteAppointmentNoticeReviewSnapshot)[key];
  return typeof value === "string" ? readBindingField(value) : null;
}

function readReviewSnapshot(
  input: SendOwnerDayRouteAppointmentNoticeInput,
): DayRouteAppointmentNoticeReviewSnapshot {
  const parsed =
    typeof input.snapshot === "string"
      ? parseDayRouteAppointmentNoticeReviewSnapshot(input.snapshot, input.jobId) ??
        parseDayRouteAppointmentNoticeSnapshot(input.snapshot, input.jobId)
      : input.snapshot.jobId === input.jobId
        ? input.snapshot
        : null;
  if (!parsed) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }

  const snapshotCustomerId = snapshotBinding(parsed, "customerId");
  const snapshotFingerprint = snapshotBinding(parsed, "destinationFingerprint");
  const reviewedCustomerId = readBindingField(input.reviewedCustomerId);
  const reviewedFingerprint = readBindingField(input.reviewedDestinationFingerprint);
  const customerId = reviewedCustomerId ?? snapshotCustomerId;
  const destinationFingerprint = reviewedFingerprint ?? snapshotFingerprint;
  if (!customerId || !destinationFingerprint) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
  if (snapshotCustomerId && snapshotCustomerId !== customerId) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
  if (snapshotFingerprint && snapshotFingerprint !== destinationFingerprint) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
  if (reviewedCustomerId && reviewedCustomerId !== customerId) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
  if (reviewedFingerprint && reviewedFingerprint !== destinationFingerprint) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }

  return {
    ...scheduleFieldsFromNoticeReview({
      ...parsed,
      customerId,
      destinationFingerprint,
    }),
    customerId,
    destinationFingerprint,
  };
}

function assertCurrentSnapshot(job: NoticeJob, snapshot: OwnerDayRouteScheduleSnapshot) {
  if (
    !ownerDayRouteScheduleSnapshotsEqual(
      {
        jobId: snapshot.jobId,
        scheduledAt: snapshot.scheduledAt,
        status: snapshot.status,
        pickupDurationMinutes: snapshot.pickupDurationMinutes,
        arrivalWindowMinutes: snapshot.arrivalWindowMinutes,
        assignedMembershipId: snapshot.assignedMembershipId,
      },
      scheduleSnapshotFromJob({
        id: job.id,
        scheduledAt: job.scheduledAt,
        status: job.status,
        pickupDurationMinutes: job.pickupDurationMinutes,
        arrivalWindowMinutes: job.arrivalWindowMinutes,
        assignedMembershipId: job.assignedMembershipId,
      }),
    )
  ) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
}

function assertReviewedRecipient(
  job: NoticeJob,
  review: DayRouteAppointmentNoticeReviewSnapshot,
  flags: {
    preferences: Awaited<ReturnType<typeof loadNoticePreferences>>;
    smsEntitled: boolean;
    smsConfigured: boolean;
    emailConfigured: boolean;
  },
) {
  const currentCustomerId = job.customerId ?? job.customer?.id ?? null;
  if (!currentCustomerId || currentCustomerId !== review.customerId) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
  const resolved = resolveDayRouteAppointmentNoticeChannel({
    businessId: job.businessId,
    email: job.customer?.email,
    phone: job.customer?.phone,
    smsConsentStatus: job.customer?.smsConsentStatus,
    preferences: flags.preferences,
    smsEntitled: flags.smsEntitled,
    smsConfigured: flags.smsConfigured,
    emailConfigured: flags.emailConfigured,
  });
  const currentFingerprint = dayRouteAppointmentNoticeDestinationFingerprint(resolved.eligibility);
  if (!currentFingerprint || currentFingerprint !== review.destinationFingerprint) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
}

function assertRecordedChange(job: NoticeJob) {
  if (job.status === "COMPLETED" || job.status === "CANCELLED" || !job.scheduledAt || !job.customer?.id) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE);
  }
  if ((job.appointmentProposalId ?? 0) <= 0) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE);
  }
  if (!recordedDayRouteAppointmentNoticeEligible(job)) {
    if (alreadyNotified(job) || !customerNotificationNeeded({
      scheduledAt: job.scheduledAt,
      appointmentProposalId: job.appointmentProposalId ?? 0,
      appointmentNotificationStatus: job.appointmentNotificationStatus,
      appointmentNotifiedForProposalId: job.appointmentNotifiedForProposalId,
    })) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
    }
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE);
  }
}

function noticeJobAsPreviewJob(job: NoticeJob): DayRouteAppointmentNoticeJob {
  return job;
}

export function dayRouteAppointmentNoticeErrorMessage(error: unknown, fallback: string) {
  if (error instanceof DayRouteAppointmentNoticeError) return error.message;
  return dayRouteAppointmentErrorMessage(error, fallback);
}

async function loadNoticePreferences(db: NoticeDb, businessId: string) {
  return (
    (await db.businessSettings.findFirst({
      where: { businessId },
      select: {
        estimateCommunicationEnabled: true,
        scheduleNotificationEnabled: true,
        invoiceCommunicationEnabled: true,
        reviewRequestPreferenceEnabled: true,
        marketingCommunicationEnabled: true,
      },
    })) ?? DEFAULT_SETTINGS_PREFERENCES
  );
}

async function loadNoticeChannelFlags(db: NoticeDb, businessId: string) {
  const [preferences, smsEntitled] = await Promise.all([
    loadNoticePreferences(db, businessId),
    hasProductCapability(db, businessId, PRODUCT_CAPABILITIES.SMS_MESSAGING),
  ]);
  return {
    preferences,
    smsEntitled,
    smsConfigured: isCustomerMessagingConfigured(),
    emailConfigured: isEmailDeliveryConfigured(),
  };
}

export async function previewOwnerDayRouteAppointmentNotice(
  db: NoticeDb,
  access: BusinessAccess,
  input: { jobId: string; timeZone: string },
): Promise<OwnerDayRouteAppointmentNoticePreview | null> {
  assertOwner(access);
  const jobId = input.jobId.trim();
  if (!jobId) return null;
  const job = access.assertOwned(
    await db.job.findFirst({
      where: { id: jobId, ...access.scope },
      select: NOTICE_JOB_SELECT,
    }),
  );
  if (!sameBusinessJob(job, access.businessId)) return null;
  const flags = await loadNoticeChannelFlags(db, access.businessId);
  return buildOwnerDayRouteAppointmentNoticePreview({
    job: noticeJobAsPreviewJob(job),
    snapshot: scheduleSnapshotFromJob(job),
    timeZone: input.timeZone,
    businessId: access.businessId,
    ...flags,
  });
}

export async function loadOwnerDayRouteAppointmentNotices(
  db: NoticeDb,
  access: Pick<BusinessAccess, "businessId"> & { workspace?: { role?: string } },
  input: { jobIds: readonly string[]; timeZone: string },
): Promise<Record<string, OwnerDayRouteAppointmentNoticePreview>> {
  if (access.workspace?.role !== "OWNER") return {};
  const jobIds = input.jobIds.filter(Boolean);
  if (jobIds.length === 0) return {};

  const [jobs, flags] = await Promise.all([
    db.job.findMany({
      where: { businessId: access.businessId, id: { in: jobIds } },
      select: NOTICE_JOB_SELECT,
    }),
    loadNoticeChannelFlags(db, access.businessId),
  ]);

  const notices: Record<string, OwnerDayRouteAppointmentNoticePreview> = {};
  for (const job of jobs) {
    if (!sameBusinessJob(job, access.businessId)) continue;
    const preview = buildOwnerDayRouteAppointmentNoticePreview({
      job: noticeJobAsPreviewJob(job),
      snapshot: scheduleSnapshotFromJob(job),
      timeZone: input.timeZone,
      businessId: access.businessId,
      ...flags,
    });
    if (preview) notices[job.id] = preview;
  }
  return notices;
}

async function stampNotification(
  db: NoticeDb,
  input: {
    businessId: string;
    job: NoticeJob;
    proposalId: number;
    status: "SENT" | "FAILED";
    warning: string | null;
    actorMembershipId: string | null;
    scheduledAt: Date;
    scheduledDurationMinutes: number | null;
  },
) {
  const updated = await db.job.updateMany({
    where: {
      id: input.job.id,
      businessId: input.businessId,
      appointmentProposalId: input.proposalId,
    },
    data: {
      appointmentNotificationStatus: input.status,
      appointmentNotificationError: input.warning,
      appointmentNotifiedAt: new Date(),
      appointmentNotifiedForProposalId: input.proposalId,
    },
  });
  if (updated.count !== 1) return;
  await recordAppointmentEvent(db, {
    businessId: input.businessId,
    jobId: input.job.id,
    eventType:
      input.status === "SENT" ? "APPOINTMENT_NOTIFICATION_SENT" : "APPOINTMENT_NOTIFICATION_FAILED",
    appointmentProposalId: input.proposalId,
    scheduledAt: input.scheduledAt,
    scheduledDurationMinutes: input.scheduledDurationMinutes,
    actorKind: "OWNER",
    actorMembershipId: input.actorMembershipId,
    payload: { notificationStatus: input.status, source: "day-route-review" },
  });
}

function alreadyNotified(job: NoticeJob) {
  return (
    job.appointmentNotifiedForProposalId === (job.appointmentProposalId ?? 0) &&
    job.appointmentNotificationStatus === "SENT"
  );
}

const NOTICE_CLAIM_STATUS = "READY";

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function claimDayRouteAppointmentNotice(
  db: NoticeDb,
  input: {
    businessId: string;
    customerId: string;
    jobId: string;
    proposalId: number;
    channel: DayRouteAppointmentNoticeChannel;
    destinationFingerprint: string;
    initiatedByMembershipId: string | null;
  },
): Promise<{ won: true; communicationId: string } | { won: false; communicationId: string | null }> {
  const idempotencyKey = dayRouteAppointmentNoticeIdempotencyKey(input.jobId, input.proposalId);
  const existing = await db.customerCommunication.findFirst({
    where: { businessId: input.businessId, idempotencyKey },
    select: { id: true, status: true },
  });

  if (existing) {
    if (isAcceptedCustomerMessageStatus(existing.status)) {
      return { won: false, communicationId: existing.id };
    }
    if (existing.status === "FAILED") {
      const claimed = await db.customerCommunication.updateMany({
        where: {
          id: existing.id,
          businessId: input.businessId,
          status: "FAILED",
        },
        data: {
          status: NOTICE_CLAIM_STATUS,
          customerId: input.customerId,
          channel: input.channel,
          destinationFingerprint: input.destinationFingerprint,
          failureReason: null,
          attemptedAt: new Date(),
        },
      });
      if (claimed.count === 1) {
        return { won: true, communicationId: existing.id };
      }
      return { won: false, communicationId: existing.id };
    }
    return { won: false, communicationId: existing.id };
  }

  try {
    const created = await db.customerCommunication.create({
      data: {
        businessId: input.businessId,
        customerId: input.customerId,
        channel: input.channel,
        purpose: "SCHEDULE_CHANGE",
        relatedType: "JOB",
        relatedId: input.jobId,
        idempotencyKey,
        destinationFingerprint: input.destinationFingerprint,
        bodySnapshot: "",
        status: NOTICE_CLAIM_STATUS,
        provider: "none",
        initiatedByMembershipId: input.initiatedByMembershipId,
        attemptedAt: new Date(),
      },
      select: { id: true },
    });
    return { won: true, communicationId: created.id };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { won: false, communicationId: null };
    }
    throw error;
  }
}

async function markNoticeCommunicationFailed(
  db: NoticeDb,
  input: { businessId: string; communicationId: string | null; failureReason: string | null },
) {
  if (!input.communicationId) return;
  await db.customerCommunication.updateMany({
    where: {
      id: input.communicationId,
      businessId: input.businessId,
      status: { notIn: ["QUEUED", "ACCEPTED", "SENT", "DELIVERED"] },
    },
    data: {
      status: "FAILED",
      failureReason: input.failureReason,
    },
  });
}

export async function sendOwnerDayRouteAppointmentNotice(
  db: PrismaClient,
  access: BusinessAccess,
  input: SendOwnerDayRouteAppointmentNoticeInput,
): Promise<SentOwnerDayRouteAppointmentNotice> {
  assertOwner(access);

  if (input.confirmSend.trim() !== DAY_ROUTE_APPOINTMENT_NOTICE_CONFIRM_VALUE) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE);
  }

  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE);
  }
  const review = readReviewSnapshot({ ...input, jobId });

  try {
    const found = await db.job.findFirst({
      where: { id: jobId, ...access.scope },
      select: NOTICE_JOB_SELECT,
    });
    if (!found) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE);
    }
    const job = access.assertOwned(found);
    if (!sameBusinessJob(job, access.businessId)) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE);
    }
    assertRecordedChange(job);
    assertCurrentSnapshot(job, review);

    const proposalId = job.appointmentProposalId ?? 0;
    const reviewedProposalId =
      input.reviewedProposalId == null || input.reviewedProposalId === ""
        ? proposalId
        : Number(input.reviewedProposalId);
    if (!Number.isInteger(reviewedProposalId) || reviewedProposalId !== proposalId) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
    }
    if (alreadyNotified(job)) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
    }

    const flags = await loadNoticeChannelFlags(db, access.businessId);
    assertReviewedRecipient(job, review, flags);
    const timeZone = resolveBusinessTimeZone(access.workspace.business);
    const preview = buildOwnerDayRouteAppointmentNoticePreview({
      job: noticeJobAsPreviewJob(job),
      snapshot: scheduleFieldsFromNoticeReview(review),
      timeZone,
      businessId: access.businessId,
      ...flags,
    });
    if (!preview?.offerSend || !preview.channel || !preview.destinationFingerprint) {
      throw new DayRouteAppointmentNoticeError(
        preview?.unavailableReason ||
          (preview ? DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE : DAY_ROUTE_APPOINTMENT_NOTICE_NOT_RECORDED_MESSAGE),
      );
    }
    const channel = preview.channel;
    if (input.reviewedChannel && input.reviewedChannel !== channel) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
    }
    if (
      preview.customerId !== review.customerId ||
      preview.destinationFingerprint !== review.destinationFingerprint
    ) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
    }

    const business = await db.business.findFirst({
      where: { id: access.businessId },
      select: { name: true, slug: true },
    });
    if (!business) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE);
    }

    const claimed = await db.$transaction(async (tx) => {
      const held = await lockTenantOwnedJob(tx, access.businessId, job.id);
      if (!held) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
      }
      const fresh = await tx.job.findFirst({
        where: { id: job.id, businessId: access.businessId },
        select: NOTICE_JOB_SELECT,
      });
      if (!fresh) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
      }
      assertRecordedChange(fresh);
      assertCurrentSnapshot(fresh, review);
      assertReviewedRecipient(fresh, review, flags);
      if ((fresh.appointmentProposalId ?? 0) !== proposalId) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
      }
      if (alreadyNotified(fresh)) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
      }
      const claim = await claimDayRouteAppointmentNotice(tx, {
        businessId: access.businessId,
        customerId: review.customerId,
        jobId: fresh.id,
        proposalId,
        channel,
        destinationFingerprint: review.destinationFingerprint,
        initiatedByMembershipId: access.workspace.membership.id,
      });
      if (!claim.won) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
      }
      return { job: fresh, communicationId: claim.communicationId };
    });

    const projectUrl = claimed.job.projectToken
      ? tenantProjectUrl(business.slug, claimed.job.projectToken)
      : null;
    const body = buildDayRouteAppointmentNoticeBody({
      businessName: access.workspace.business.name || business.name,
      appointmentWindowLabel: preview.appointmentWindowLabel,
      projectUrl,
    });

    let result: CommunicationSendResult;
    try {
      result = await composeCustomerCommunication(db, access, {
        customerId: review.customerId,
        channel,
        purpose: "SCHEDULE_CHANGE",
        subject: buildDayRouteAppointmentNoticeSubject(
          access.workspace.business.name || business.name,
        ),
        body,
        relatedType: "JOB",
        relatedId: claimed.job.id,
        idempotencyKey: dayRouteAppointmentNoticeIdempotencyKey(claimed.job.id, proposalId),
      });
    } catch (error) {
      await markNoticeCommunicationFailed(db, {
        businessId: access.businessId,
        communicationId: claimed.communicationId,
        failureReason: error instanceof Error ? error.message : "The communication provider failed.",
      });
      await stampNotification(db, {
        businessId: access.businessId,
        job: claimed.job,
        proposalId,
        status: "FAILED",
        warning: error instanceof Error ? error.message : "The communication provider failed.",
        actorMembershipId: access.workspace.membership.id,
        scheduledAt: claimed.job.scheduledAt!,
        scheduledDurationMinutes: claimed.job.scheduledDurationMinutes,
      });
      throw error;
    }

    if (!result.ok) {
      await markNoticeCommunicationFailed(db, {
        businessId: access.businessId,
        communicationId: result.communicationId ?? claimed.communicationId,
        failureReason: result.failureReason,
      });
      await stampNotification(db, {
        businessId: access.businessId,
        job: claimed.job,
        proposalId,
        status: "FAILED",
        warning: result.failureReason,
        actorMembershipId: access.workspace.membership.id,
        scheduledAt: claimed.job.scheduledAt!,
        scheduledDurationMinutes: claimed.job.scheduledDurationMinutes,
      });
      throw new DayRouteAppointmentNoticeError(
        result.failureReason || DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE,
      );
    }

    await stampNotification(db, {
      businessId: access.businessId,
      job: claimed.job,
      proposalId,
      status: "SENT",
      warning: null,
      actorMembershipId: access.workspace.membership.id,
      scheduledAt: claimed.job.scheduledAt!,
      scheduledDurationMinutes: claimed.job.scheduledDurationMinutes,
    });

    return {
      jobId: claimed.job.id,
      businessId: access.businessId,
      channel,
      appointmentWindowLabel: preview.appointmentWindowLabel,
      recipientLabel: preview.recipientLabel,
      communicationId: result.communicationId,
      reused: false,
    };
  } catch (error) {
    if (missingDayRouteAppointmentSchema(error)) {
      throw new DayRouteAppointmentNoticeError(
        dayRouteAppointmentErrorMessage(error, DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE),
      );
    }
    throw error;
  }
}
