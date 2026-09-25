import { Prisma, type PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/authorization";
import { destinationFingerprint, destinationLast4 } from "@/lib/customer-messaging/eligibility";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { getOrCreateCustomerThread, touchCommunicationThread } from "@/lib/communications/thread";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";
import { consentContextSnapshot } from "@/lib/communications/consent";
import {
  PHONE_LOG_CUSTOMER_CONFLICT_REASON,
  RELATED_RECORD_NOT_OWNED_REASON,
  conflictingCustomerIds,
} from "@/lib/communications/related";

type Db = PrismaClient | Prisma.TransactionClient;

export type PhoneLogResult = {
  ok: boolean;
  phoneInteractionId: string | null;
  communicationId: string | null;
  actionItemId: string | null;
  reused: boolean;
  failureReason: string | null;
};

function failed(failureReason: string): PhoneLogResult {
  return {
    ok: false,
    phoneInteractionId: null,
    communicationId: null,
    actionItemId: null,
    reused: false,
    failureReason,
  };
}

function reusedFrom(row: {
  id: string;
  communicationId: string | null;
  followUpActionItemId: string | null;
}): PhoneLogResult {
  return {
    ok: true,
    phoneInteractionId: row.id,
    communicationId: row.communicationId,
    actionItemId: row.followUpActionItemId,
    reused: true,
    failureReason: null,
  };
}

async function resolvePhoneLogCustomer(
  db: Db,
  access: CommunicationAccess,
  input: {
    customerId?: string | null;
    callerPhone?: string | null;
    requestId?: string | null;
    jobId?: string | null;
  },
): Promise<{ ok: true; customerId: string | null } | { ok: false; reason: string }> {
  let explicitId: string | null = null;
  if (input.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: input.customerId, businessId: access.businessId },
      select: { id: true },
    });
    if (!customer) throw new ForbiddenError();
    explicitId = customer.id;
  }

  let requestCustomerId: string | null = null;
  if (input.requestId) {
    const request = await db.serviceRequest.findFirst({
      where: { id: input.requestId, businessId: access.businessId },
      select: { id: true, customerId: true },
    });
    if (!request) return { ok: false, reason: RELATED_RECORD_NOT_OWNED_REASON };
    requestCustomerId = request.customerId;
  }

  let jobCustomerId: string | null = null;
  if (input.jobId) {
    const job = await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: { id: true, customerId: true },
    });
    if (!job) return { ok: false, reason: RELATED_RECORD_NOT_OWNED_REASON };
    jobCustomerId = job.customerId;
  }

  if (conflictingCustomerIds([explicitId, requestCustomerId, jobCustomerId])) {
    return { ok: false, reason: PHONE_LOG_CUSTOMER_CONFLICT_REASON };
  }

  const linked = explicitId ?? requestCustomerId ?? jobCustomerId;
  if (linked) return { ok: true, customerId: linked };

  if (input.callerPhone) {
    const digits = normalizePhone(input.callerPhone);
    if (isUsableNormalizedPhone(digits)) {
      const matched = await db.customer.findFirst({
        where: { businessId: access.businessId, phone: digits },
        select: { id: true },
      });
      return { ok: true, customerId: matched?.id ?? null };
    }
  }

  return { ok: true, customerId: null };
}

export async function recordMissedOrManualCall(
  db: Db,
  access: CommunicationAccess,
  input: {
    kind: "MISSED_CALL" | "MANUAL_PHONE";
    customerId?: string | null;
    callerPhone?: string | null;
    summary: string;
    callbackNeeded?: boolean;
    requestId?: string | null;
    jobId?: string | null;
    idempotencyKey: string;
    browserBusinessId?: string | null;
  },
): Promise<PhoneLogResult> {
  requireCommunicationsCapability(access);
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return failed("Browser businessId never authorizes a phone log.");
  }
  if (!input.idempotencyKey.trim() || !input.summary.trim()) {
    return failed("Summary and idempotency key are required.");
  }

  const existing = await db.phoneInteraction.findFirst({
    where: {
      businessId: access.businessId,
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existing) return reusedFrom(existing);

  const resolved = await resolvePhoneLogCustomer(db, access, input);
  if (!resolved.ok) return failed(resolved.reason);

  const customer = resolved.customerId
    ? await db.customer.findFirst({
        where: { id: resolved.customerId, businessId: access.businessId },
        select: { id: true, name: true, smsConsentStatus: true, email: true },
      })
    : null;
  if (resolved.customerId && !customer) throw new ForbiddenError();

  const digits = normalizePhone(input.callerPhone);
  const usable = isUsableNormalizedPhone(digits);
  const thread = customer
    ? await getOrCreateCustomerThread(db, {
        businessId: access.businessId,
        customerId: customer.id,
        title: customer.name,
      })
    : null;

  let claimed;
  try {
    claimed = await db.phoneInteraction.create({
      data: {
        businessId: access.businessId,
        customerId: customer?.id ?? null,
        threadId: thread?.id ?? null,
        kind: input.kind,
        status: input.callbackNeeded ? "CALLBACK_NEEDED" : "LOGGED",
        direction: "INBOUND",
        callerLast4: usable ? destinationLast4(digits) : null,
        callerFingerprint: usable ? destinationFingerprint(access.businessId, digits) : null,
        summary: input.summary.trim(),
        callbackNeeded: Boolean(input.callbackNeeded),
        idempotencyKey: input.idempotencyKey,
        initiatedByMembershipId: access.workspace.membership?.id ?? null,
        requestId: input.requestId || null,
        jobId: input.jobId || null,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.phoneInteraction.findFirst({
        where: {
          businessId: access.businessId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (raced) return reusedFrom(raced);
    }
    return failed("The phone log could not be saved.");
  }

  const recommendationKey = `phone-callback:${input.idempotencyKey}`;
  let actionItemId: string | null = null;
  if (input.callbackNeeded) {
    const existingAction = await db.businessActionItem.findFirst({
      where: { businessId: access.businessId, recommendationKey },
    });
    if (existingAction) {
      actionItemId = existingAction.id;
    } else {
      try {
        const action = await db.businessActionItem.create({
          data: {
            businessId: access.businessId,
            recommendationKey,
            title: customer ? `Call back ${customer.name}` : "Call back a missed caller",
            notes: input.summary.trim(),
            createdByMembershipId: access.workspace.membership?.id ?? null,
          },
        });
        actionItemId = action.id;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const racedAction = await db.businessActionItem.findFirst({
            where: { businessId: access.businessId, recommendationKey },
          });
          actionItemId = racedAction?.id ?? null;
        } else {
          throw error;
        }
      }
    }
  }

  const communicationKey = `phone:${input.kind}:${input.idempotencyKey}`;
  let communicationId: string | null = null;
  if (customer) {
    const existingCommunication = await db.customerCommunication.findFirst({
      where: { businessId: access.businessId, idempotencyKey: communicationKey },
    });
    if (existingCommunication) {
      communicationId = existingCommunication.id;
    } else {
      try {
        const communication = await db.customerCommunication.create({
          data: {
            businessId: access.businessId,
            customerId: customer.id,
            threadId: thread?.id ?? null,
            direction: "INBOUND",
            channel: "PHONE",
            purpose: input.kind,
            subject: input.callbackNeeded ? "Callback needed" : "Phone log",
            relatedType: "PHONE_INTERACTION",
            relatedId: claimed.id,
            idempotencyKey: communicationKey,
            destinationLast4: usable ? destinationLast4(digits) : null,
            destinationFingerprint: usable
              ? destinationFingerprint(access.businessId, digits)
              : null,
            consentContext: consentContextSnapshot({
              smsConsentStatus: customer.smsConsentStatus,
              emailAvailable: Boolean(customer.email),
              channel: "PHONE",
            }),
            bodySnapshot: input.summary.trim(),
            status: "SENT",
            provider: "manual",
            initiatedByMembershipId: access.workspace.membership?.id ?? null,
            attemptedAt: new Date(),
          },
        });
        communicationId = communication.id;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const racedCommunication = await db.customerCommunication.findFirst({
            where: { businessId: access.businessId, idempotencyKey: communicationKey },
          });
          communicationId = racedCommunication?.id ?? null;
        } else {
          throw error;
        }
      }
    }
  }

  await db.phoneInteraction.updateMany({
    where: { id: claimed.id, businessId: access.businessId },
    data: {
      communicationId,
      followUpActionItemId: actionItemId,
      requestId: input.requestId || null,
      jobId: input.jobId || null,
    },
  });
  if (thread) {
    await touchCommunicationThread(db, {
      businessId: access.businessId,
      threadId: thread.id,
    });
  }

  return {
    ok: true,
    phoneInteractionId: claimed.id,
    communicationId,
    actionItemId,
    reused: false,
    failureReason: null,
  };
}
