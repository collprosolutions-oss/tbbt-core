import { Prisma, type PrismaClient } from "@prisma/client";
import { isUsableNormalizedPhone, normalizePhone } from "@/lib/customer-identity";
import { ensureCustomerMessagingSchema } from "@/lib/customer-messaging/schema";
import type { InboundSmsEvent } from "@/lib/customer-messaging/types";
import {
  recordOwnerStudioReminderStart,
  recordOwnerStudioReminderStop,
} from "@/lib/marketing-studio-reminder";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Test-only pause/fault points. Production never assigns these.
 * Used to prove leftover webhook claims stay retryable when both the
 * consent write and compensation delete fail.
 */
export const inboundConsentTestHooks: {
  afterClaim?: () => Promise<void> | void;
  afterCustomerLock?: () => Promise<void> | void;
  beforeConsentWrite?: (ctx?: { db: Db }) => Promise<void> | void;
  beforeCleanup?: () => Promise<void> | void;
} = {};

/** Claimed but not yet applied. Completing the event sets a later timestamp. */
export const INBOUND_WEBHOOK_PENDING_AT = new Date(0);

function isPendingWebhookProcessedAt(value: Date | null | undefined) {
  return !value || value.getTime() === 0;
}

/**
 * Prisma `@default(cuid())` encodes insert time in the first 8 base36 chars.
 * CustomerMessagingWebhookEvent has no createdAt; pending rows use
 * processedAt=epoch, so the committed cuid is the durable claim age.
 */
export function claimedAtFromCuid(id: string): Date | null {
  if (typeof id !== "string" || id[0] !== "c" || id.length < 10) return null;
  const ms = parseInt(id.slice(1, 9), 36);
  if (!Number.isFinite(ms) || ms < 1_000_000_000_000 || ms > Date.now() + 120_000) {
    return null;
  }
  return new Date(ms);
}

export type InboundConsentResult = {
  applied: boolean;
  reason: string;
  businessId?: string;
  customerId?: string;
  consentStatus?: string;
};

type ClaimIdentity = {
  provider: string;
  providerEventId: string;
  eventKind: "delivery" | "inbound";
};

function inboundEventLockKey(inbound: Pick<InboundSmsEvent, "provider" | "providerEventId">) {
  return `tbbt-inbound:${inbound.provider}:${inbound.providerEventId}`;
}

function inboundConsentCustomerLockKey(businessId: string, customerId: string) {
  return `tbbt-consent:${businessId}:${customerId}`;
}

async function lockInboundEvent(db: Db, inbound: Pick<InboundSmsEvent, "provider" | "providerEventId">) {
  const lockKey = inboundEventLockKey(inbound);
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

async function lockInboundConsentCustomer(db: Db, businessId: string, customerId: string) {
  const lockKey = inboundConsentCustomerLockKey(businessId, customerId);
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
}

async function rememberWebhookEvent(
  db: Db,
  input: {
    provider: string;
    providerEventId: string;
    eventKind: "delivery" | "inbound";
    businessId?: string | null;
  },
): Promise<"recorded" | "duplicate"> {
  try {
    await db.customerMessagingWebhookEvent.create({
      data: {
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventKind: input.eventKind,
        businessId: input.businessId ?? null,
        processedAt: INBOUND_WEBHOOK_PENDING_AT,
      },
    });
    return "recorded";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "duplicate";
    }
    throw error;
  }
}

export async function rememberCustomerMessagingWebhookEvent(
  db: Db,
  input: {
    provider: string;
    providerEventId: string;
    eventKind: "delivery" | "inbound";
    businessId?: string | null;
  },
) {
  await ensureCustomerMessagingSchema(db);
  return rememberWebhookEvent(db, input);
}

export type WebhookEventClaim = "claimed" | "pending" | "completed";

/**
 * Delivery and inbound share the pending processedAt sentinel. A leftover
 * pending row is retryable; only a completed timestamp is idempotent.
 */
export async function claimCustomerMessagingWebhookEvent(
  db: Db,
  input: {
    provider: string;
    providerEventId: string;
    eventKind: "delivery" | "inbound";
    businessId?: string | null;
  },
): Promise<WebhookEventClaim> {
  await ensureCustomerMessagingSchema(db);
  const identity: ClaimIdentity = {
    provider: input.provider,
    providerEventId: input.providerEventId,
    eventKind: input.eventKind,
  };
  const remembered = await rememberWebhookEvent(db, input);
  if (remembered === "recorded") return "claimed";
  const existing = await loadInboundClaim(db, identity);
  if (existing && isPendingWebhookProcessedAt(existing.processedAt)) {
    return "pending";
  }
  return "completed";
}

export async function completeCustomerMessagingWebhookEvent(
  db: Db,
  input: { provider: string; providerEventId: string; eventKind: "delivery" | "inbound" },
) {
  await completeWebhookEvent(db, input);
}

async function completeWebhookEvent(
  db: Db,
  input: { provider: string; providerEventId: string; eventKind: "delivery" | "inbound" },
) {
  await db.customerMessagingWebhookEvent.updateMany({
    where: {
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventKind: input.eventKind,
      processedAt: INBOUND_WEBHOOK_PENDING_AT,
    },
    data: { processedAt: new Date() },
  });
}

async function loadInboundClaim(
  db: Db,
  identity: ClaimIdentity,
): Promise<{ id: string; processedAt: Date; businessId: string | null } | null> {
  return db.customerMessagingWebhookEvent.findUnique({
    where: { provider_providerEventId_eventKind: identity },
    select: { id: true, processedAt: true, businessId: true },
  });
}

function receivingNumberDigits(value: string) {
  return normalizePhone(value);
}

async function applyOwnerStudioReminderInbound(
  db: Db,
  input: { businessId: string; fromDigits: string; optOutType: InboundSmsEvent["optOutType"] },
): Promise<{ matched: boolean; applied: boolean; reason: string }> {
  const settings = await db.businessSettings.findUnique({
    where: { businessId: input.businessId },
    select: {
      studioWeeklyReminderOwnerSmsTo: true,
    },
  });
  const ownerDigits = normalizePhone(settings?.studioWeeklyReminderOwnerSmsTo);
  if (!settings || !ownerDigits || ownerDigits !== input.fromDigits) {
    return { matched: false, applied: false, reason: "not_owner_destination" };
  }
  if (input.optOutType === "HELP") {
    return { matched: true, applied: false, reason: "owner_help_no_change" };
  }
  if (input.optOutType === "START") {
    return recordOwnerStudioReminderStart(db, input.businessId, input.fromDigits);
  }
  return recordOwnerStudioReminderStop(db, input.businessId, input.fromDigits);
}

type PreparedInbound =
  | { status: "done"; result: InboundConsentResult }
  | {
      status: "pending";
      businessId: string;
      claimIdentity: ClaimIdentity;
      claimedAt: Date | null;
    };

/**
 * Persist the pending claim in its own autocommit so a later consent
 * transaction rollback cannot erase the original event age.
 */
async function prepareInboundConsentClaim(
  db: Db,
  inbound: InboundSmsEvent,
): Promise<PreparedInbound> {
  const claimIdentity: ClaimIdentity = {
    provider: inbound.provider,
    providerEventId: inbound.providerEventId,
    eventKind: "inbound",
  };

  const toDigits = receivingNumberDigits(inbound.to);
  if (!toDigits) {
    await rememberWebhookEvent(db, claimIdentity);
    await completeWebhookEvent(db, claimIdentity);
    return { status: "done", result: { applied: false, reason: "unknown_tenant" } };
  }

  const business = await db.business.findFirst({
    where: { operationalSmsNumber: toDigits },
    select: { id: true },
  });
  if (!business) {
    await rememberWebhookEvent(db, claimIdentity);
    await completeWebhookEvent(db, claimIdentity);
    return { status: "done", result: { applied: false, reason: "unknown_tenant" } };
  }

  // Claim is identity-only until processedAt leaves the pending sentinel.
  // Look up first so a duplicate insert cannot abort this transaction.
  // A leftover pending row is not completion and must stay retryable.
  // A completed row must not re-apply (STOP replay after START).
  const existingClaim = await loadInboundClaim(db, claimIdentity);
  if (existingClaim && !isPendingWebhookProcessedAt(existingClaim.processedAt)) {
    return {
      status: "done",
      result: { applied: true, reason: "idempotent", businessId: business.id },
    };
  }
  if (!existingClaim) {
    await rememberWebhookEvent(db, {
      ...claimIdentity,
      businessId: business.id,
    });
  }
  const claim = await loadInboundClaim(db, claimIdentity);
  if (claim && !isPendingWebhookProcessedAt(claim.processedAt)) {
    return {
      status: "done",
      result: { applied: true, reason: "idempotent", businessId: business.id },
    };
  }
  return {
    status: "pending",
    businessId: business.id,
    claimIdentity,
    claimedAt: claim ? claimedAtFromCuid(claim.id) : null,
  };
}

export async function applyInboundConsentEvent(
  db: Db,
  inbound: InboundSmsEvent,
): Promise<InboundConsentResult> {
  await ensureCustomerMessagingSchema(db);
  const prepared = await prepareInboundConsentClaim(db, inbound);
  if (prepared.status === "done") return prepared.result;

  if (inboundConsentTestHooks.afterClaim) {
    await inboundConsentTestHooks.afterClaim();
  }

  const client = db as PrismaClient;
  const runConsent = async (tx: Db): Promise<InboundConsentResult> => {
    await lockInboundEvent(tx, inbound);
    const claim = await loadInboundClaim(tx, prepared.claimIdentity);
    if (claim && !isPendingWebhookProcessedAt(claim.processedAt)) {
      return { applied: true, reason: "idempotent", businessId: prepared.businessId };
    }
    const result = await applyRecordedInboundConsent(
      tx,
      inbound,
      prepared.businessId,
      prepared.claimIdentity,
      prepared.claimedAt ?? (claim ? claimedAtFromCuid(claim.id) : null),
    );
    await completeWebhookEvent(tx, prepared.claimIdentity);
    return result;
  };

  try {
    if (typeof client.$transaction === "function") {
      return await client.$transaction((tx) => runConsent(tx), {
        timeout: 20_000,
        maxWait: 20_000,
      });
    }
    return await runConsent(db);
  } catch (error) {
    await abandonRecordedInboundWebhook(db, {
      businessId: prepared.businessId,
      provider: inbound.provider,
      providerEventId: inbound.providerEventId,
      error,
    });
    throw error;
  }
}

async function applyRecordedInboundConsent(
  db: Db,
  inbound: InboundSmsEvent,
  businessId: string,
  claimIdentity: ClaimIdentity,
  claimedAt: Date | null,
): Promise<InboundConsentResult> {
  if (!inbound.optOutType) {
    return { applied: false, reason: "ignored_inbound", businessId };
  }

  const fromDigits = normalizePhone(inbound.from);
  if (!isUsableNormalizedPhone(fromDigits)) {
    return { applied: false, reason: "unusable_from", businessId };
  }

  const ownerHandled = await applyOwnerStudioReminderInbound(db, {
    businessId,
    fromDigits,
    optOutType: inbound.optOutType,
  });
  if (ownerHandled.matched) {
    return {
      applied: ownerHandled.applied,
      reason: ownerHandled.reason,
      businessId,
    };
  }

  const candidates = await db.customer.findMany({
    where: { businessId, phone: { not: null } },
    select: { id: true, phone: true, smsConsentStatus: true, smsConsentUpdatedAt: true },
  });
  const matches = candidates.filter(
    (row) => normalizePhone(row.phone) === fromDigits,
  );
  if (matches.length > 1) {
    return {
      applied: false,
      reason: "ambiguous_customer",
      businessId,
    };
  }

  let customer: {
    id: string;
    smsConsentStatus: string;
    smsConsentUpdatedAt?: Date | null;
  } | null = matches[0] ?? null;
  if (!customer && inbound.optOutType === "STOP") {
    const absorbed = await findUnambiguousSurvivorForAbsorbedPhone(
      db,
      businessId,
      fromDigits,
    );
    if (absorbed.status === "ambiguous") {
      return { applied: false, reason: "ambiguous_customer", businessId };
    }
    customer = absorbed.customer;
  }
  if (!customer) {
    return {
      applied: false,
      reason: "unknown_customer",
      businessId,
    };
  }
  if (inbound.optOutType === "HELP") {
    return {
      applied: false,
      reason: "help_no_consent_change",
      businessId,
      customerId: customer.id,
      consentStatus: customer.smsConsentStatus,
    };
  }

  // Pause here so a newer STOP can commit before this event's consent write.
  // The customer lock is taken after this hook; the GRANT write is still
  // conditional on smsConsentUpdatedAt < claimedAt.
  if (inboundConsentTestHooks.beforeConsentWrite) {
    await inboundConsentTestHooks.beforeConsentWrite({ db });
  }

  await lockInboundConsentCustomer(db, businessId, customer.id);
  if (inboundConsentTestHooks.afterCustomerLock) {
    await inboundConsentTestHooks.afterCustomerLock();
  }

  const claimAfterLock = await loadInboundClaim(db, claimIdentity);
  if (claimAfterLock && !isPendingWebhookProcessedAt(claimAfterLock.processedAt)) {
    return { applied: true, reason: "idempotent", businessId, customerId: customer.id };
  }

  const live = await db.customer.findFirst({
    where: { id: customer.id, businessId },
    select: { id: true, smsConsentStatus: true, smsConsentUpdatedAt: true },
  });
  if (live) customer = live;

  if (inbound.optOutType === "STOP") {
    if (customer && customer.smsConsentStatus === "REVOKED") {
      await db.customer.updateMany({
        where: { id: customer.id, businessId, smsConsentStatus: "REVOKED" },
        data: { smsConsentUpdatedAt: new Date() },
      });
      return {
        applied: true,
        reason: "idempotent",
        businessId,
        customerId: customer.id,
        consentStatus: "REVOKED",
      };
    }
    return applyConsentStatus(db, {
      businessId,
      customerId: customer.id,
      fromDigits,
      status: "REVOKED",
      reason: "revoked",
    });
  }

  // START is recognized Twilio Advanced Opt-Out re-opt-in only from REVOKED.
  if (!customer || customer.smsConsentStatus !== "REVOKED") {
    return {
      applied: false,
      reason: "start_not_applicable",
      businessId,
      customerId: customer?.id,
      consentStatus: customer?.smsConsentStatus,
    };
  }
  return applyConsentStatus(db, {
    businessId,
    customerId: customer.id,
    fromDigits,
    status: "GRANTED",
    reason: "granted",
    claimedAt,
  });
}

function grantWhere(input: {
  id: string;
  businessId: string;
  claimedAt: Date;
}): Prisma.CustomerWhereInput {
  return {
    id: input.id,
    businessId: input.businessId,
    smsConsentStatus: "REVOKED",
    OR: [{ smsConsentUpdatedAt: null }, { smsConsentUpdatedAt: { lt: input.claimedAt } }],
  };
}

async function abandonRecordedInboundWebhook(
  db: Db,
  input: {
    businessId: string;
    provider: string;
    providerEventId: string;
    customerId?: string;
    status?: string;
    error: unknown;
  },
) {
  console.error("Inbound consent write failed", {
    businessId: input.businessId,
    providerEventId: input.providerEventId,
    customerId: input.customerId,
    status: input.status,
    error: input.error,
  });
  try {
    if (inboundConsentTestHooks.beforeCleanup) {
      await inboundConsentTestHooks.beforeCleanup();
    }
    // Leave the pending claim in place so a retry keeps the original event
    // identity. Deleting would mint a new claim time and let a stale START
    // win over a newer STOP.
  } catch (cleanupError) {
    console.error("Failed to delete inbound webhook after consent write error", cleanupError);
  }
}

function absorbedSnapshotPhone(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const phone = (snapshot as { phone?: unknown }).phone;
  return typeof phone === "string" ? phone : null;
}

async function absorbedPhoneSurvivorIds(
  db: Db,
  businessId: string,
  fromDigits: string,
): Promise<string[]> {
  const merges = await db.customerMerge.findMany({
    where: { businessId },
    select: { survivorCustomerId: true, absorbedSnapshot: true },
  });
  const survivorIds = new Set<string>();
  for (const merge of merges) {
    const phone = absorbedSnapshotPhone(merge.absorbedSnapshot);
    if (phone && normalizePhone(phone) === fromDigits) {
      survivorIds.add(merge.survivorCustomerId);
    }
  }
  return [...survivorIds];
}

async function resolveLiveSurvivor(
  db: Db,
  businessId: string,
  customerId: string,
): Promise<{ id: string; smsConsentStatus: string } | null> {
  let currentId = customerId;
  for (let hop = 0; hop <= CONSENT_MERGE_HOPS; hop += 1) {
    const live = await db.customer.findFirst({
      where: { id: currentId, businessId },
      select: { id: true, smsConsentStatus: true },
    });
    if (live) return live;
    const merge = await db.customerMerge.findFirst({
      where: { businessId, absorbedCustomerId: currentId },
      select: { survivorCustomerId: true },
    });
    if (!merge) return null;
    currentId = merge.survivorCustomerId;
  }
  return null;
}

/**
 * Same-business STOP only. Maps an absorbed former phone onto exactly one
 * surviving customer. Does not match email, name, or other tenants.
 * If that survivor was later absorbed, hop to the live descendant.
 */
async function findUnambiguousSurvivorForAbsorbedPhone(
  db: Db,
  businessId: string,
  fromDigits: string,
): Promise<
  | { status: "none"; customer: null }
  | { status: "ambiguous"; customer: null }
  | { status: "matched"; customer: { id: string; smsConsentStatus: string } }
> {
  const survivorIds = await absorbedPhoneSurvivorIds(db, businessId, fromDigits);
  const liveById = new Map<string, { id: string; smsConsentStatus: string }>();
  for (const survivorId of survivorIds) {
    const live = await resolveLiveSurvivor(db, businessId, survivorId);
    if (live) liveById.set(live.id, live);
  }
  if (liveById.size === 0) return { status: "none", customer: null };
  if (liveById.size !== 1) return { status: "ambiguous", customer: null };
  return { status: "matched", customer: [...liveById.values()][0] };
}

const CONSENT_MERGE_HOPS = 4;

async function applyConsentStatus(
  db: Db,
  input: {
    businessId: string;
    customerId: string;
    fromDigits: string;
    status: "REVOKED" | "GRANTED";
    reason: "revoked" | "granted";
    claimedAt?: Date | null;
  },
): Promise<InboundConsentResult> {
  if (input.status === "GRANTED") {
    if (!input.claimedAt) {
      return {
        applied: false,
        reason: "stale_event",
        businessId: input.businessId,
        customerId: input.customerId,
        consentStatus: "REVOKED",
      };
    }
    const first = await db.customer.updateMany({
      where: grantWhere({
        id: input.customerId,
        businessId: input.businessId,
        claimedAt: input.claimedAt,
      }),
      data: {
        smsConsentStatus: "GRANTED",
        smsConsentUpdatedAt: new Date(),
      },
    });
    if (first.count > 0) {
      return {
        applied: true,
        reason: "granted",
        businessId: input.businessId,
        customerId: input.customerId,
        consentStatus: "GRANTED",
      };
    }
    const stillRevoked = await db.customer.findFirst({
      where: { id: input.customerId, businessId: input.businessId },
      select: { smsConsentStatus: true },
    });
    if (stillRevoked?.smsConsentStatus === "REVOKED") {
      return {
        applied: false,
        reason: "stale_event",
        businessId: input.businessId,
        customerId: input.customerId,
        consentStatus: "REVOKED",
      };
    }
  } else {
    const first = await db.customer.updateMany({
      where: { id: input.customerId, businessId: input.businessId },
      data: {
        smsConsentStatus: "REVOKED",
        smsConsentUpdatedAt: new Date(),
      },
    });
    if (first.count > 0) {
      return {
        applied: true,
        reason: input.reason,
        businessId: input.businessId,
        customerId: input.customerId,
        consentStatus: "REVOKED",
      };
    }
  }

  let currentId = input.customerId;
  for (let hop = 0; hop < CONSENT_MERGE_HOPS; hop += 1) {
    const merge = await db.customerMerge.findFirst({
      where: { businessId: input.businessId, absorbedCustomerId: currentId },
      select: { survivorCustomerId: true },
    });
    if (!merge) {
      return {
        applied: false,
        reason: "unknown_customer",
        businessId: input.businessId,
      };
    }
    currentId = merge.survivorCustomerId;

    if (input.status === "GRANTED") {
      const survivor = await db.customer.findFirst({
        where: { id: currentId, businessId: input.businessId },
        select: { id: true, phone: true, smsConsentStatus: true, smsConsentUpdatedAt: true },
      });
      if (
        !survivor ||
        survivor.smsConsentStatus !== "REVOKED" ||
        normalizePhone(survivor.phone) !== input.fromDigits
      ) {
        return {
          applied: false,
          reason: "start_not_applicable",
          businessId: input.businessId,
          customerId: survivor?.id,
          consentStatus: survivor?.smsConsentStatus,
        };
      }
      if (!input.claimedAt) {
        return {
          applied: false,
          reason: "stale_event",
          businessId: input.businessId,
          customerId: currentId,
          consentStatus: "REVOKED",
        };
      }
      const startHop = await db.customer.updateMany({
        where: grantWhere({
          id: currentId,
          businessId: input.businessId,
          claimedAt: input.claimedAt,
        }),
        data: {
          smsConsentStatus: "GRANTED",
          smsConsentUpdatedAt: new Date(),
        },
      });
      if (startHop.count > 0) {
        return {
          applied: true,
          reason: "granted",
          businessId: input.businessId,
          customerId: currentId,
          consentStatus: "GRANTED",
        };
      }
      if (survivor.smsConsentStatus === "REVOKED") {
        return {
          applied: false,
          reason: "stale_event",
          businessId: input.businessId,
          customerId: currentId,
          consentStatus: "REVOKED",
        };
      }
      continue;
    }

    const hopUpdated = await db.customer.updateMany({
      where: { id: currentId, businessId: input.businessId },
      data: {
        smsConsentStatus: "REVOKED",
        smsConsentUpdatedAt: new Date(),
      },
    });
    if (hopUpdated.count > 0) {
      return {
        applied: true,
        reason: "revoked",
        businessId: input.businessId,
        customerId: currentId,
        consentStatus: "REVOKED",
      };
    }
  }

  return {
    applied: false,
    reason: "unknown_customer",
    businessId: input.businessId,
  };
}
