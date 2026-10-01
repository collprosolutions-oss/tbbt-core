/**
 * OWNER mutation: review and send a notice for one same-business
 * recorded appointment from the day-route page.
 *
 * Uses the existing communications provider and consent rules. Page load
 * and the appointment change itself never call this. Does not invent an
 * arrival time or claim travel optimization.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
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
  DAY_ROUTE_APPOINTMENT_NOTICE_OWNER_ONLY_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE,
  DAY_ROUTE_APPOINTMENT_NOTICE_UNCONFIRMED_MESSAGE,
  dayRouteAppointmentNoticeIdempotencyKey,
  parseDayRouteAppointmentNoticeSnapshot,
  type DayRouteAppointmentNoticeChannel,
  type DayRouteAppointmentNoticeJob,
  type OwnerDayRouteAppointmentNoticePreview,
} from "@/lib/owner-day-route-appointment-notice";
import {
  dayRouteAppointmentErrorMessage,
  missingDayRouteAppointmentSchema,
} from "@/lib/owner-day-route-appointment-ops";
import { hasProductCapability } from "@/lib/product-entitlements/enforce";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { DEFAULT_SETTINGS_PREFERENCES, isEmailDeliveryConfigured } from "@/lib/settings";
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
  snapshot: OwnerDayRouteScheduleSnapshot | string;
  confirmSend: string;
  timeZone?: string | null;
  reviewedChannel?: string | null;
  reviewedProposalId?: number | string | null;
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

function readSnapshot(
  input: SendOwnerDayRouteAppointmentNoticeInput,
): OwnerDayRouteScheduleSnapshot {
  const snapshot =
    typeof input.snapshot === "string"
      ? parseDayRouteAppointmentNoticeSnapshot(input.snapshot, input.jobId)
      : input.snapshot.jobId === input.jobId
        ? input.snapshot
        : null;
  if (!snapshot) {
    throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
  }
  return snapshot;
}

function assertCurrentSnapshot(job: NoticeJob, snapshot: OwnerDayRouteScheduleSnapshot) {
  if (
    !ownerDayRouteScheduleSnapshotsEqual(
      snapshot,
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
  const snapshot = readSnapshot({ ...input, jobId });

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
    if (job.status === "COMPLETED" || !job.scheduledAt || !job.customer?.id) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_MISSING_JOB_MESSAGE);
    }
    assertCurrentSnapshot(job, snapshot);

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
    if (
      !customerNotificationNeeded({
        scheduledAt: job.scheduledAt,
        appointmentProposalId: proposalId,
        appointmentNotificationStatus: job.appointmentNotificationStatus,
        appointmentNotifiedForProposalId: job.appointmentNotifiedForProposalId,
      })
    ) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
    }

    const flags = await loadNoticeChannelFlags(db, access.businessId);
    const timeZone = input.timeZone?.trim() || access.workspace.business.timezone;
    const preview = buildOwnerDayRouteAppointmentNoticePreview({
      job: noticeJobAsPreviewJob(job),
      snapshot,
      timeZone,
      businessId: access.businessId,
      ...flags,
    });
    if (!preview?.offerSend || !preview.channel) {
      throw new DayRouteAppointmentNoticeError(
        preview?.unavailableReason || DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE,
      );
    }
    if (input.reviewedChannel && input.reviewedChannel !== preview.channel) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
    }

    const existing = await db.customerCommunication.findFirst({
      where: {
        businessId: access.businessId,
        idempotencyKey: dayRouteAppointmentNoticeIdempotencyKey(job.id, proposalId),
      },
      select: { status: true },
    });
    if (existing && isAcceptedCustomerMessageStatus(existing.status)) {
      await stampNotification(db, {
        businessId: access.businessId,
        job,
        proposalId,
        status: "SENT",
        warning: null,
        actorMembershipId: access.workspace.membership.id,
        scheduledAt: job.scheduledAt,
        scheduledDurationMinutes: job.scheduledDurationMinutes,
      });
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
    }

    const business = await db.business.findFirst({
      where: { id: access.businessId },
      select: { name: true, slug: true },
    });
    if (!business) {
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_FOREIGN_MESSAGE);
    }

    const locked = await db.$transaction(async (tx) => {
      const held = await lockTenantOwnedJob(tx, access.businessId, job.id);
      if (!held) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
      }
      const fresh = await tx.job.findFirst({
        where: { id: job.id, businessId: access.businessId },
        select: NOTICE_JOB_SELECT,
      });
      if (!fresh || !fresh.scheduledAt || !fresh.customer?.id) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
      }
      assertCurrentSnapshot(fresh, snapshot);
      if ((fresh.appointmentProposalId ?? 0) !== proposalId) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_STALE_MESSAGE);
      }
      if (alreadyNotified(fresh)) {
        throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
      }
      return fresh;
    });

    const projectUrl = locked.projectToken
      ? tenantProjectUrl(business.slug, locked.projectToken)
      : null;
    const body = buildDayRouteAppointmentNoticeBody({
      businessName: access.workspace.business.name || business.name,
      appointmentWindowLabel: preview.appointmentWindowLabel,
      projectUrl,
    });

    const result: CommunicationSendResult = await composeCustomerCommunication(db, access, {
      customerId: locked.customer!.id,
      channel: preview.channel,
      purpose: "SCHEDULE_CHANGE",
      subject: buildDayRouteAppointmentNoticeSubject(
        access.workspace.business.name || business.name,
      ),
      body,
      relatedType: "JOB",
      relatedId: locked.id,
      idempotencyKey: dayRouteAppointmentNoticeIdempotencyKey(locked.id, proposalId),
    });

    if (result.reused && isAcceptedCustomerMessageStatus(result.status)) {
      await stampNotification(db, {
        businessId: access.businessId,
        job: locked,
        proposalId,
        status: "SENT",
        warning: null,
        actorMembershipId: access.workspace.membership.id,
        scheduledAt: locked.scheduledAt!,
        scheduledDurationMinutes: locked.scheduledDurationMinutes,
      });
      throw new DayRouteAppointmentNoticeError(DAY_ROUTE_APPOINTMENT_NOTICE_DUPLICATE_MESSAGE);
    }

    if (!result.ok) {
      await stampNotification(db, {
        businessId: access.businessId,
        job: locked,
        proposalId,
        status: "FAILED",
        warning: result.failureReason,
        actorMembershipId: access.workspace.membership.id,
        scheduledAt: locked.scheduledAt!,
        scheduledDurationMinutes: locked.scheduledDurationMinutes,
      });
      throw new DayRouteAppointmentNoticeError(
        result.failureReason || DAY_ROUTE_APPOINTMENT_NOTICE_UNAVAILABLE_MESSAGE,
      );
    }

    await stampNotification(db, {
      businessId: access.businessId,
      job: locked,
      proposalId,
      status: "SENT",
      warning: null,
      actorMembershipId: access.workspace.membership.id,
      scheduledAt: locked.scheduledAt!,
      scheduledDurationMinutes: locked.scheduledDurationMinutes,
    });

    return {
      jobId: locked.id,
      businessId: access.businessId,
      channel: preview.channel,
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
