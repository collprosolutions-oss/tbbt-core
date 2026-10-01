/**
 * Create / rotate / revoke a hashed calendar-subscription token.
 *
 * Raw tokens are returned once and never stored. Rotate and revoke use
 * conditional updateMany so a revoke that commits after a stale read
 * cannot be overwritten, and a losing rotate never returns a live URL.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import { createSecureToken, hashToken } from "@/lib/auth-crypto";
import { getAppUrl } from "@/lib/mail";
import { assertCanManageScheduleCalendarSubscription } from "@/lib/schedule-calendar-subscription/access";
import {
  SCHEDULE_CALENDAR_SUBSCRIPTION_ALREADY_ACTIVE_MESSAGE,
  SCHEDULE_CALENDAR_SUBSCRIPTION_NOT_ACTIVE_MESSAGE,
  SCHEDULE_CALENDAR_SUBSCRIPTION_UNAVAILABLE_MESSAGE,
  emptyScheduleCalendarSubscriptionStatus,
  scheduleCalendarFeedUrl,
  type ScheduleCalendarSubscriptionScope,
  type ScheduleCalendarSubscriptionStatus,
} from "@/lib/schedule-calendar-subscription/contract";
import { missingScheduleCalendarSubscriptionSchema } from "@/lib/schedule-calendar-subscription/schema";

type Db = PrismaClient | Prisma.TransactionClient;

export class ScheduleCalendarSubscriptionError extends Error {
  readonly status: number;
  readonly code: "FORBIDDEN" | "INVALID" | "UNAVAILABLE" | "NOT_FOUND";

  constructor(
    code: ScheduleCalendarSubscriptionError["code"],
    message: string,
    status = code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 400,
  ) {
    super(message);
    this.name = "ScheduleCalendarSubscriptionError";
    this.code = code;
    this.status = status;
  }
}

export function scheduleCalendarSubscriptionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ScheduleCalendarSubscriptionError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (missingScheduleCalendarSubscriptionSchema(error)) {
    return SCHEDULE_CALENDAR_SUBSCRIPTION_UNAVAILABLE_MESSAGE;
  }
  return fallback;
}

function isUniqueConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      String((error as { code?: string }).code) === "P2002",
  );
}

function rethrowSubscriptionWriteError(error: unknown): never {
  if (error instanceof ScheduleCalendarSubscriptionError || error instanceof ForbiddenError) {
    throw error;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    throw error;
  }
  if (missingScheduleCalendarSubscriptionSchema(error)) {
    throw new ScheduleCalendarSubscriptionError(
      "UNAVAILABLE",
      SCHEDULE_CALENDAR_SUBSCRIPTION_UNAVAILABLE_MESSAGE,
    );
  }
  if (isUniqueConflict(error)) {
    throw new ScheduleCalendarSubscriptionError(
      "INVALID",
      SCHEDULE_CALENDAR_SUBSCRIPTION_ALREADY_ACTIVE_MESSAGE,
    );
  }
  throw error;
}

function issueToken() {
  const rawToken = createSecureToken();
  return { rawToken, tokenHash: hashToken(rawToken) };
}

export const scheduleCalendarSubscriptionMutationTestHooks: {
  afterFindUnique?: (input: {
    id: string | null;
    mode: "create" | "rotate" | "revoke";
    tokenHash: string | null;
    revokedAt: Date | null;
  }) => Promise<void> | void;
} = {};

async function findOwnedSubscription(
  prisma: Db,
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
  mode: "create" | "rotate" | "revoke",
) {
  const existing = await prisma.scheduleCalendarSubscription.findUnique({
    where: {
      membershipId_scope: {
        membershipId: access.workspace.membership.id,
        scope,
      },
    },
    select: {
      id: true,
      businessId: true,
      revokedAt: true,
      tokenHash: true,
    },
  });
  if (existing) access.assertOwned(existing);
  await scheduleCalendarSubscriptionMutationTestHooks.afterFindUnique?.({
    id: existing?.id ?? null,
    mode,
    tokenHash: existing?.tokenHash ?? null,
    revokedAt: existing?.revokedAt ?? null,
  });
  return existing;
}

export async function loadScheduleCalendarSubscriptionStatus(
  prisma: Db,
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
): Promise<ScheduleCalendarSubscriptionStatus> {
  try {
    const row = await prisma.scheduleCalendarSubscription.findUnique({
      where: {
        membershipId_scope: {
          membershipId: access.workspace.membership.id,
          scope,
        },
      },
      select: {
        id: true,
        businessId: true,
        scope: true,
        createdAt: true,
        rotatedAt: true,
        revokedAt: true,
      },
    });
    if (!row) return emptyScheduleCalendarSubscriptionStatus(scope, true);
    access.assertOwned(row);
    return {
      available: true,
      active: row.revokedAt == null,
      scope,
      createdAt: row.createdAt,
      rotatedAt: row.rotatedAt,
      revokedAt: row.revokedAt,
    };
  } catch (error) {
    if (missingScheduleCalendarSubscriptionSchema(error)) {
      return emptyScheduleCalendarSubscriptionStatus(scope, false);
    }
    throw error;
  }
}

export type IssuedScheduleCalendarSubscription = {
  rawToken: string;
  feedUrl: string;
  scope: ScheduleCalendarSubscriptionScope;
};

async function issueOrReplaceSubscription(
  prisma: Db,
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
  mode: "create" | "rotate",
): Promise<IssuedScheduleCalendarSubscription> {
  assertCanManageScheduleCalendarSubscription(access, scope);
  const membershipId = access.workspace.membership.id;
  const businessId = access.businessId;
  const now = new Date();
  const issued = issueToken();

  try {
    const existing = await findOwnedSubscription(prisma, access, scope, mode);

    if (mode === "rotate") {
      if (!existing || existing.revokedAt != null) {
        throw new ScheduleCalendarSubscriptionError(
          "INVALID",
          SCHEDULE_CALENDAR_SUBSCRIPTION_NOT_ACTIVE_MESSAGE,
        );
      }
      const rotated = await prisma.scheduleCalendarSubscription.updateMany({
        where: {
          id: existing.id,
          revokedAt: null,
          tokenHash: existing.tokenHash,
        },
        data: {
          tokenHash: issued.tokenHash,
          rotatedAt: now,
        },
      });
      if (rotated.count !== 1) {
        throw new ScheduleCalendarSubscriptionError(
          "INVALID",
          SCHEDULE_CALENDAR_SUBSCRIPTION_NOT_ACTIVE_MESSAGE,
        );
      }
    } else if (existing && existing.revokedAt == null) {
      throw new ScheduleCalendarSubscriptionError(
        "INVALID",
        SCHEDULE_CALENDAR_SUBSCRIPTION_ALREADY_ACTIVE_MESSAGE,
      );
    } else if (existing && existing.revokedAt != null) {
      const reissued = await prisma.scheduleCalendarSubscription.updateMany({
        where: {
          id: existing.id,
          revokedAt: { not: null },
        },
        data: {
          tokenHash: issued.tokenHash,
          rotatedAt: now,
          revokedAt: null,
        },
      });
      if (reissued.count !== 1) {
        throw new ScheduleCalendarSubscriptionError(
          "INVALID",
          SCHEDULE_CALENDAR_SUBSCRIPTION_ALREADY_ACTIVE_MESSAGE,
        );
      }
    } else {
      try {
        await prisma.scheduleCalendarSubscription.create({
          data: {
            businessId,
            membershipId,
            scope,
            tokenHash: issued.tokenHash,
          },
        });
      } catch (error) {
        if (isUniqueConflict(error)) {
          throw new ScheduleCalendarSubscriptionError(
            "INVALID",
            SCHEDULE_CALENDAR_SUBSCRIPTION_ALREADY_ACTIVE_MESSAGE,
          );
        }
        throw error;
      }
    }
  } catch (error) {
    rethrowSubscriptionWriteError(error);
  }

  return {
    rawToken: issued.rawToken,
    feedUrl: scheduleCalendarFeedUrl(getAppUrl(), issued.rawToken),
    scope,
  };
}

export async function createScheduleCalendarSubscription(
  prisma: Db,
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
): Promise<IssuedScheduleCalendarSubscription> {
  return issueOrReplaceSubscription(prisma, access, scope, "create");
}

export async function rotateScheduleCalendarSubscription(
  prisma: Db,
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
): Promise<IssuedScheduleCalendarSubscription> {
  return issueOrReplaceSubscription(prisma, access, scope, "rotate");
}

export async function revokeScheduleCalendarSubscription(
  prisma: Db,
  access: BusinessAccess,
  scope: ScheduleCalendarSubscriptionScope,
): Promise<void> {
  assertCanManageScheduleCalendarSubscription(access, scope);
  const burned = issueToken();

  try {
    const existing = await findOwnedSubscription(prisma, access, scope, "revoke");
    if (!existing || existing.revokedAt != null) {
      throw new ScheduleCalendarSubscriptionError(
        "INVALID",
        SCHEDULE_CALENDAR_SUBSCRIPTION_NOT_ACTIVE_MESSAGE,
      );
    }
    const revoked = await prisma.scheduleCalendarSubscription.updateMany({
      where: {
        id: existing.id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        tokenHash: burned.tokenHash,
      },
    });
    if (revoked.count !== 1) {
      throw new ScheduleCalendarSubscriptionError(
        "INVALID",
        SCHEDULE_CALENDAR_SUBSCRIPTION_NOT_ACTIVE_MESSAGE,
      );
    }
  } catch (error) {
    rethrowSubscriptionWriteError(error);
  }
}
