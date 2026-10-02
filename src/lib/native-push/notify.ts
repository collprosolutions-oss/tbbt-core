/**
 * Informational worker alerts after an OWNER/ADMIN assigns or materially
 * reschedules a Handyman job. Delivery never starts time, never accepts
 * an appointment, and never includes a customer address or access code.
 *
 * Called after the assignment/schedule write commits. A missing schema
 * or provider failure must not roll back that write.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { after } from "next/server";
import { isRequestPathSchemaUnavailableError } from "@/lib/request-path-schema";
import {
  NATIVE_PUSH_MAX_ATTEMPTS,
  NATIVE_PUSH_SEND_TIMEOUT_MS,
  NATIVE_PUSH_TEST_FLUSH_ENV,
  getNativePushPendingStaleMs,
} from "@/lib/native-push/config";
import {
  assignmentAlertIdempotencyKey,
  buildNativePushAlertPayload,
  isHandymanJobForNativePush,
  isOwnerSideNativePushActor,
  nativePushPayloadHasForbiddenFields,
  rescheduleAlertIdempotencyKey,
} from "@/lib/native-push/payload";
import { getNativePushProvider } from "@/lib/native-push/provider";
import { ensureNativePushSchema } from "@/lib/native-push/schema";
import type {
  NativePushAlertPayload,
  NativePushDeliveryStatus,
  NativePushKind,
} from "@/lib/native-push/types";

type Db = PrismaClient;

const JOB_TRADE_SELECT = {
  id: true,
  businessId: true,
  assignedMembershipId: true,
  updatedAt: true,
  appointmentProposalId: true,
  estimate: {
    select: {
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { serviceCatalogItem: { select: { tradeCode: true } } },
      },
    },
  },
} as const;

export type NativePushNotifyResult = {
  status: NativePushDeliveryStatus;
  deliveryId?: string;
  reason?: string;
  sentCount: number;
};

const testPendingNotifies: Promise<unknown>[] = [];

function runNotifyWork(work: () => Promise<unknown>) {
  return Promise.resolve()
    .then(work)
    .catch(() => undefined);
}

function nativePushTestFlushEnabled() {
  return process.env[NATIVE_PUSH_TEST_FLUSH_ENV] === "1";
}

export function enqueueNativePushNotify(work: () => Promise<unknown>) {
  if (nativePushTestFlushEnabled()) {
    const promise = runNotifyWork(work);
    testPendingNotifies.push(promise);
    return promise;
  }
  after(() => runNotifyWork(work));
}

export async function flushNativePushNotifies() {
  if (!nativePushTestFlushEnabled()) return;
  const pending = testPendingNotifies.splice(0);
  if (pending.length === 0) return;
  await Promise.all(pending);
}

function uniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function withTimeout<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Push send timed out.")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withDeliveryHeartbeat<T>(
  db: Db,
  deliveryId: string,
  work: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(10, Math.floor(getNativePushPendingStaleMs() / 3));
  const touch = () =>
    db.$executeRaw`
      UPDATE "NativePushDelivery" SET "updatedAt" = NOW() WHERE id = ${deliveryId} AND status = 'PENDING'
    `.catch(() => undefined);
  await touch();
  const timer = setInterval(() => {
    void touch();
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

async function loadActorRole(db: Db, businessId: string, actorMembershipId: string) {
  const actor = await db.membership.findFirst({
    where: { id: actorMembershipId, businessId },
    select: { role: true, active: true },
  });
  return actor;
}

async function loadHandymanJob(db: Db, businessId: string, jobId: string) {
  return db.job.findFirst({
    where: { id: jobId, businessId },
    select: JOB_TRADE_SELECT,
  });
}

function jobIsHandyman(job: {
  estimate: {
    serviceRequest: { tradeCode: string } | null;
    lineItems: Array<{ serviceCatalogItem: { tradeCode: string } | null }>;
  } | null;
}) {
  return isHandymanJobForNativePush({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
}

async function suppressDelivery(
  db: Db,
  input: {
    businessId: string;
    membershipId: string;
    jobId: string;
    kind: NativePushKind;
    idempotencyKey: string;
    reason: string;
    payload: NativePushAlertPayload;
  },
): Promise<NativePushNotifyResult> {
  const provider = getNativePushProvider();
  try {
    const created = await db.nativePushDelivery.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        status: "SUPPRESSED",
        attemptCount: 0,
        payloadSnapshot: input.payload,
        provider: provider.id,
        failureReason: input.reason,
      },
    });
    return { status: "SUPPRESSED", deliveryId: created.id, reason: input.reason, sentCount: 0 };
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const existing = await db.nativePushDelivery.findFirst({
      where: { businessId: input.businessId, idempotencyKey: input.idempotencyKey },
    });
    return {
      status: (existing?.status as NativePushDeliveryStatus) ?? "SUPPRESSED",
      deliveryId: existing?.id,
      reason: existing?.failureReason ?? input.reason,
      sentCount: 0,
    };
  }
}

async function settleMaxAttempts(db: Db, deliveryId: string) {
  await db.nativePushDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "FAILED",
      failureReason: "max-attempts",
    },
  });
  return {
    status: "FAILED" as const,
    deliveryId,
    reason: "max-attempts",
    sentCount: 0,
  };
}

type ClaimedDelivery = {
  id: string;
  providerMessageId: string | null;
};

async function claimDelivery(
  db: Db,
  input: {
    businessId: string;
    membershipId: string;
    jobId: string;
    kind: NativePushKind;
    idempotencyKey: string;
    payload: NativePushAlertPayload;
  },
): Promise<{ ok: true; delivery: ClaimedDelivery } | { ok: false; result: NativePushNotifyResult }> {
  const provider = getNativePushProvider();
  try {
    const created = await db.nativePushDelivery.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        status: "PENDING",
        attemptCount: 1,
        payloadSnapshot: input.payload,
        provider: provider.id,
      },
    });
    return { ok: true, delivery: created };
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
  }

  const existing = await db.nativePushDelivery.findFirst({
    where: { businessId: input.businessId, idempotencyKey: input.idempotencyKey },
  });
  if (!existing) {
    return { ok: false, result: { status: "SUPPRESSED", reason: "duplicate", sentCount: 0 } };
  }
  if (existing.status === "SENT" || existing.status === "SUPPRESSED") {
    return {
      ok: false,
      result: {
        status: "SUPPRESSED",
        deliveryId: existing.id,
        reason: "duplicate",
        sentCount: 0,
      },
    };
  }

  if (existing.attemptCount >= NATIVE_PUSH_MAX_ATTEMPTS) {
    return { ok: false, result: await settleMaxAttempts(db, existing.id) };
  }

  if (existing.status === "FAILED") {
    const claimed = await db.nativePushDelivery.updateMany({
      where: {
        id: existing.id,
        status: "FAILED",
        attemptCount: { lt: NATIVE_PUSH_MAX_ATTEMPTS },
      },
      data: {
        status: "PENDING",
        attemptCount: { increment: 1 },
        failureReason: null,
      },
    });
    if (claimed.count !== 1) {
      return {
        ok: false,
        result: {
          status: "SUPPRESSED",
          deliveryId: existing.id,
          reason: "duplicate",
          sentCount: 0,
        },
      };
    }
    const delivery = await db.nativePushDelivery.findFirst({ where: { id: existing.id } });
    if (!delivery) {
      return { ok: false, result: { status: "SUPPRESSED", reason: "duplicate", sentCount: 0 } };
    }
    return { ok: true, delivery };
  }

  const staleCutoff = new Date(Date.now() - getNativePushPendingStaleMs());
  if (existing.status === "PENDING" && existing.updatedAt <= staleCutoff) {
    const claimed = await db.nativePushDelivery.updateMany({
      where: {
        id: existing.id,
        status: "PENDING",
        updatedAt: { lte: staleCutoff },
        attemptCount: { lt: NATIVE_PUSH_MAX_ATTEMPTS },
      },
      data: {
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      return {
        ok: false,
        result: {
          status: "SUPPRESSED",
          deliveryId: existing.id,
          reason: "in-flight",
          sentCount: 0,
        },
      };
    }
    const delivery = await db.nativePushDelivery.findFirst({ where: { id: existing.id } });
    if (!delivery) {
      return { ok: false, result: { status: "SUPPRESSED", reason: "in-flight", sentCount: 0 } };
    }
    return { ok: true, delivery };
  }

  return {
    ok: false,
    result: {
      status: "SUPPRESSED",
      deliveryId: existing.id,
      reason: "in-flight",
      sentCount: 0,
    },
  };
}

async function deliverToOptedInDevices(
  db: Db,
  input: {
    businessId: string;
    membershipId: string;
    jobId: string;
    kind: NativePushKind;
    idempotencyKey: string;
    payload: NativePushAlertPayload;
  },
): Promise<NativePushNotifyResult> {
  if (nativePushPayloadHasForbiddenFields(input.payload)) {
    return suppressDelivery(db, { ...input, reason: "forbidden-payload" });
  }

  const membership = await db.membership.findFirst({
    where: {
      id: input.membershipId,
      businessId: input.businessId,
      active: true,
    },
    select: { id: true },
  });
  if (!membership) {
    return suppressDelivery(db, { ...input, reason: "inactive-membership" });
  }

  const devices = await db.nativePushDevice.findMany({
    where: {
      businessId: input.businessId,
      membershipId: input.membershipId,
      optedIn: true,
      revokedAt: null,
      sessionId: { not: null },
      session: {
        is: {
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      },
    },
  });
  if (devices.length === 0) {
    return suppressDelivery(db, { ...input, reason: "not-opted-in" });
  }

  const claimed = await claimDelivery(db, input);
  if (!claimed.ok) return claimed.result;

  const provider = getNativePushProvider();
  let sentCount = 0;
  let lastError: string | null = null;
  let lastProviderMessageId: string | null = claimed.delivery.providerMessageId;
  try {
    await withDeliveryHeartbeat(db, claimed.delivery.id, async () => {
      await withTimeout(NATIVE_PUSH_SEND_TIMEOUT_MS, async () => {
        for (const device of devices) {
          try {
            const result = await provider.send({
              businessId: input.businessId,
              membershipId: input.membershipId,
              jobId: input.jobId,
              kind: input.kind,
              deviceId: device.id,
              tokenLast4: device.tokenLast4,
              deviceToken: device.deviceToken,
              payload: input.payload,
            });
            if (result.ok) {
              sentCount += 1;
              lastProviderMessageId = result.providerMessageId;
            } else {
              lastError = result.error;
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : "Push provider failed.";
          }
        }
      });
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Push provider failed.";
  }

  if (sentCount > 0) {
    const settled = await db.nativePushDelivery.updateMany({
      where: { id: claimed.delivery.id, status: "PENDING" },
      data: {
        status: "SENT",
        provider: provider.id,
        providerMessageId: lastProviderMessageId,
        failureReason: null,
        payloadSnapshot: input.payload,
      },
    });
    if (settled.count === 1) {
      return { status: "SENT", deliveryId: claimed.delivery.id, sentCount };
    }
    return { status: "SUPPRESSED", deliveryId: claimed.delivery.id, reason: "in-flight", sentCount: 0 };
  }

  await db.nativePushDelivery.updateMany({
    where: { id: claimed.delivery.id, status: "PENDING" },
    data: {
      status: "FAILED",
      provider: provider.id,
      failureReason: lastError ?? "Push provider failed.",
      payloadSnapshot: input.payload,
    },
  });
  return {
    status: "FAILED",
    deliveryId: claimed.delivery.id,
    reason: lastError ?? "Push provider failed.",
    sentCount,
  };
}

async function withNativePushSchema<T>(
  db: Db,
  work: () => Promise<T>,
): Promise<T | NativePushNotifyResult> {
  try {
    await ensureNativePushSchema(db);
    return await work();
  } catch (error) {
    if (isRequestPathSchemaUnavailableError(error)) {
      return { status: "SUPPRESSED", reason: "schema-unavailable", sentCount: 0 };
    }
    throw error;
  }
}

export async function notifyHandymanJobAssigned(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    previousMembershipId: string | null;
    nextMembershipId: string | null;
    actorMembershipId: string;
  },
): Promise<NativePushNotifyResult> {
  if (!input.nextMembershipId || input.nextMembershipId === input.previousMembershipId) {
    return { status: "SUPPRESSED", reason: "unchanged-assignment", sentCount: 0 };
  }
  const nextMembershipId = input.nextMembershipId;
  return withNativePushSchema(db, async () => {
    const actor = await loadActorRole(db, input.businessId, input.actorMembershipId);
    if (!actor || !isOwnerSideNativePushActor(actor.role)) {
      return { status: "SUPPRESSED", reason: "not-owner-side", sentCount: 0 };
    }
    const job = await loadHandymanJob(db, input.businessId, input.jobId);
    if (!job || job.assignedMembershipId !== nextMembershipId) {
      return { status: "SUPPRESSED", reason: "job-unavailable", sentCount: 0 };
    }
    if (!jobIsHandyman(job)) {
      return { status: "SUPPRESSED", reason: "not-handyman", sentCount: 0 };
    }
    const payload = buildNativePushAlertPayload({
      kind: "JOB_ASSIGNED",
      jobId: job.id,
    });
    return deliverToOptedInDevices(db, {
      businessId: input.businessId,
      membershipId: nextMembershipId,
      jobId: job.id,
      kind: "JOB_ASSIGNED",
      idempotencyKey: assignmentAlertIdempotencyKey({
        jobId: job.id,
        nextMembershipId,
        previousMembershipId: input.previousMembershipId,
        committedAt: job.updatedAt,
      }),
      payload,
    });
  });
}

export async function notifyHandymanJobRescheduled(
  db: Db,
  input: {
    businessId: string;
    jobId: string;
    membershipId: string | null;
    actorMembershipId: string;
    proposalId: number;
  },
): Promise<NativePushNotifyResult> {
  if (!input.membershipId) {
    return { status: "SUPPRESSED", reason: "unassigned", sentCount: 0 };
  }
  const membershipId = input.membershipId;
  return withNativePushSchema(db, async () => {
    const actor = await loadActorRole(db, input.businessId, input.actorMembershipId);
    if (!actor || !isOwnerSideNativePushActor(actor.role)) {
      return { status: "SUPPRESSED", reason: "not-owner-side", sentCount: 0 };
    }
    const job = await loadHandymanJob(db, input.businessId, input.jobId);
    if (!job || job.assignedMembershipId !== membershipId) {
      return { status: "SUPPRESSED", reason: "job-unavailable", sentCount: 0 };
    }
    if (!jobIsHandyman(job)) {
      return { status: "SUPPRESSED", reason: "not-handyman", sentCount: 0 };
    }
    const payload = buildNativePushAlertPayload({
      kind: "JOB_RESCHEDULED",
      jobId: job.id,
    });
    return deliverToOptedInDevices(db, {
      businessId: input.businessId,
      membershipId,
      jobId: job.id,
      kind: "JOB_RESCHEDULED",
      idempotencyKey: rescheduleAlertIdempotencyKey({
        jobId: job.id,
        membershipId,
        proposalId: input.proposalId,
      }),
      payload,
    });
  });
}

export async function retryNativePushDelivery(db: Db, deliveryId: string) {
  await ensureNativePushSchema(db);
  const delivery = await db.nativePushDelivery.findFirst({
    where: { id: deliveryId },
  });
  if (!delivery) {
    return { status: "SUPPRESSED" as const, reason: "missing", sentCount: 0 };
  }
  if (delivery.status === "SENT" || delivery.status === "SUPPRESSED") {
    return { status: "SUPPRESSED" as const, deliveryId: delivery.id, reason: "duplicate", sentCount: 0 };
  }
  if (delivery.attemptCount >= NATIVE_PUSH_MAX_ATTEMPTS) {
    return settleMaxAttempts(db, delivery.id);
  }
  const payload = delivery.payloadSnapshot as NativePushAlertPayload;
  return deliverToOptedInDevices(db, {
    businessId: delivery.businessId,
    membershipId: delivery.membershipId,
    jobId: delivery.jobId,
    kind: delivery.kind as NativePushKind,
    idempotencyKey: delivery.idempotencyKey,
    payload,
  });
}
