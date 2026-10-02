/**
 * Authorized owner/office disposition for a recorded callback-needed
 * PhoneInteraction. Reuses canonical CLOSED / ReceptionistEvent audit
 * rows. Does not place a call, send SMS or email, invent a successful
 * contact, or delete unknown-caller records.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { CAPABILITIES, ForbiddenError, roleHasCapability } from "@/lib/authorization";
import {
  communicationsActionError,
} from "@/lib/communications/action-errors";
import {
  requireCommunicationsCapability,
  type CommunicationAccess,
} from "@/lib/communications/engine";

type Db = PrismaClient | Prisma.TransactionClient;

export const PHONE_INTERACTION_CLOSED_STATUS = "CLOSED";
export const RECEPTIONIST_MANUAL_DISPOSITION_KIND = "MANUAL_DISPOSITION";
export const RECEPTIONIST_MANUAL_DISPOSITION_STATUS = "RECORDED";
export const RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON =
  "That recovery item was not found.";
export const RECEPTIONIST_DISPOSITION_NOT_CALLBACK_REASON =
  "Only a recorded callback-needed phone item can be marked handled.";
export const RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON =
  "Browser businessId never authorizes a receptionist disposition.";

export type ReceptionistDispositionResult = {
  ok: boolean;
  reused: boolean;
  phoneInteractionId: string | null;
  receptionistEventId: string | null;
  actionItemId: string | null;
  status: string | null;
  callbackNeeded: boolean | null;
  customerId: string | null;
  failureReason: string | null;
  replayedViaLookup: boolean;
};

const PHONE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  followUpActionItemId: true,
  status: true,
  callbackNeeded: true,
  summary: true,
} as const;

function failed(failureReason: string): ReceptionistDispositionResult {
  return {
    ok: false,
    reused: false,
    phoneInteractionId: null,
    receptionistEventId: null,
    actionItemId: null,
    status: null,
    callbackNeeded: null,
    customerId: null,
    failureReason,
    replayedViaLookup: false,
  };
}

function succeeded(
  row: {
    id: string;
    customerId: string | null;
    followUpActionItemId: string | null;
    status: string;
    callbackNeeded: boolean;
  },
  eventId: string,
  reused: boolean,
  replayedViaLookup: boolean,
): ReceptionistDispositionResult {
  return {
    ok: true,
    reused,
    phoneInteractionId: row.id,
    receptionistEventId: eventId,
    actionItemId: row.followUpActionItemId,
    status: row.status,
    callbackNeeded: row.callbackNeeded,
    customerId: row.customerId,
    failureReason: null,
    replayedViaLookup,
  };
}

export function receptionistDispositionIdempotencyKey(phoneInteractionId: string) {
  return `receptionist-disposition:${phoneInteractionId}`;
}

export function receptionistDispositionLockKey(businessId: string, phoneInteractionId: string) {
  return `receptionist-disposition:${businessId}:${phoneInteractionId}`;
}

export function phoneInteractionIsCallbackNeeded(row: {
  status: string;
  callbackNeeded: boolean;
}) {
  return row.status === "CALLBACK_NEEDED" || row.callbackNeeded;
}

export function phoneInteractionIsClosedDisposition(row: {
  status: string;
  callbackNeeded: boolean;
}) {
  return row.status === PHONE_INTERACTION_CLOSED_STATUS && !row.callbackNeeded;
}

async function withDispositionLock<T>(
  db: Db,
  lockKey: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      return work(tx);
    });
  }
  return work(db);
}

async function findOwnedPhone(
  db: Db,
  input: { businessId: string; phoneInteractionId: string },
) {
  return db.phoneInteraction.findFirst({
    where: { id: input.phoneInteractionId, businessId: input.businessId },
    select: PHONE_SELECT,
  });
}

async function ensureDispositionEvent(
  db: Db,
  access: CommunicationAccess,
  input: {
    phoneInteractionId: string;
    customerId: string | null;
    previousStatus: string;
    previousCallbackNeeded: boolean;
    summary: string;
  },
) {
  const idempotencyKey = receptionistDispositionIdempotencyKey(input.phoneInteractionId);
  // RECEPTIONIST_DISPOSITION_IDEMPOTENCY_LOOKUP
  const existing = await db.receptionistEvent.findFirst({
    where: { businessId: access.businessId, idempotencyKey },
    select: { id: true },
  });
  if (existing) return { id: existing.id, reused: true, replayedViaLookup: true };

  try {
    const created = await db.receptionistEvent.create({
      data: {
        businessId: access.businessId,
        customerId: input.customerId,
        phoneInteractionId: input.phoneInteractionId,
        kind: RECEPTIONIST_MANUAL_DISPOSITION_KIND,
        status: RECEPTIONIST_MANUAL_DISPOSITION_STATUS,
        provider: "none",
        providerConnected: false,
        payload: {
          summary: input.summary || "Callback-needed item recorded as handled.",
          previousStatus: input.previousStatus,
          previousCallbackNeeded: input.previousCallbackNeeded,
          disposition: "HANDLED",
          contactClaimed: false,
          channel: null,
        },
        idempotencyKey,
        initiatedByMembershipId: access.workspace.membership?.id ?? null,
      },
      select: { id: true },
    });
    return { id: created.id, reused: false, replayedViaLookup: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.receptionistEvent.findFirst({
        where: { businessId: access.businessId, idempotencyKey },
        select: { id: true },
      });
      if (raced) return { id: raced.id, reused: true, replayedViaLookup: false };
    }
    throw error;
  }
}

export async function recordReceptionistCallbackDisposition(
  db: Db,
  access: CommunicationAccess,
  input: {
    phoneInteractionId: string;
    browserBusinessId?: string | null;
  },
): Promise<ReceptionistDispositionResult> {
  requireCommunicationsCapability(access);
  if (input.browserBusinessId && input.browserBusinessId !== access.businessId) {
    return failed(RECEPTIONIST_DISPOSITION_FOREIGN_BUSINESS_REASON);
  }

  const phoneInteractionId = input.phoneInteractionId.trim();
  if (!phoneInteractionId) return failed(RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON);

  return withDispositionLock(
    db,
    receptionistDispositionLockKey(access.businessId, phoneInteractionId),
    async (tx) => {
      const current = await findOwnedPhone(tx, {
        businessId: access.businessId,
        phoneInteractionId,
      });
      if (!current) return failed(RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON);

      const alreadyHandled = phoneInteractionIsClosedDisposition(current);
      if (!alreadyHandled && !phoneInteractionIsCallbackNeeded(current)) {
        return failed(RECEPTIONIST_DISPOSITION_NOT_CALLBACK_REASON);
      }

      const event = await ensureDispositionEvent(tx, access, {
        phoneInteractionId: current.id,
        customerId: current.customerId,
        previousStatus: current.status,
        previousCallbackNeeded: current.callbackNeeded,
        summary: current.summary.trim(),
      });

      if (!alreadyHandled) {
        await tx.phoneInteraction.updateMany({
          where: {
            id: current.id,
            businessId: access.businessId,
            OR: [{ callbackNeeded: true }, { status: "CALLBACK_NEEDED" }],
          },
          data: {
            status: PHONE_INTERACTION_CLOSED_STATUS,
            callbackNeeded: false,
          },
        });
      }

      if (current.followUpActionItemId) {
        await tx.businessActionItem.updateMany({
          where: {
            id: current.followUpActionItemId,
            businessId: access.businessId,
            status: "OPEN",
          },
          data: { status: "DONE" },
        });
      }

      const next = await findOwnedPhone(tx, {
        businessId: access.businessId,
        phoneInteractionId: current.id,
      });
      if (!next) return failed(RECEPTIONIST_DISPOSITION_NOT_FOUND_REASON);
      return succeeded(next, event.id, alreadyHandled || event.reused, event.replayedViaLookup);
    },
  );
}

export async function executeReceptionistDispositionAction(
  db: Db,
  access: CommunicationAccess,
  input: {
    phoneInteractionId: string;
    browserBusinessId?: string | null;
  },
): Promise<{ error?: string; message?: string }> {
  try {
    if (!roleHasCapability(access.workspace.role, CAPABILITIES.MANAGE_COMMUNICATIONS)) {
      throw new ForbiddenError();
    }
    const result = await recordReceptionistCallbackDisposition(db, access, input);
    if (!result.ok) {
      return {
        error: result.failureReason ?? "That callback-needed item could not be marked handled.",
      };
    }
    return {
      message: result.reused
        ? "That callback-needed item was already recorded as handled."
        : "Callback-needed item recorded as handled. No call or message was sent.",
    };
  } catch (error) {
    return communicationsActionError(error);
  }
}
