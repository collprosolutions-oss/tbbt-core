/**
 * Worker-requested dated availability exceptions / time off.
 *
 * MEMBER may request only for their own membership. OWNER accepts or
 * declines. Only ACCEPT writes MembershipAvailabilityException, and only
 * when no recorded exception exists or the owner explicitly replaces it.
 * Rechecks worker ownership, PENDING status, date bounds, and
 * expectedUpdatedAt at commit. These paths never cancel, reassign, or message
 * about Jobs.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog";
import { requireProductCapability } from "@/lib/product-entitlements";
import {
  AVAILABILITY_REQUEST_AVAILABLE_HOURS_MESSAGE,
  AVAILABILITY_REQUEST_DECIDE_CONFLICT_MESSAGE,
  AVAILABILITY_REQUEST_INACTIVE_MESSAGE,
  AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE,
  AVAILABILITY_REQUEST_PENDING_LIST_LIMIT,
  AVAILABILITY_REQUEST_RECENT_LIST_LIMIT,
  AVAILABILITY_REQUEST_REPLACE_REQUIRED_MESSAGE,
  AVAILABILITY_REQUEST_SELF_LIST_LIMIT,
  AVAILABILITY_REQUEST_STALE_MESSAGE,
  requireAvailabilityRequestAcceptDate,
  requireAvailabilityRequestDate,
  requireAvailabilityRequestDecision,
  requireDayMinutesRange,
  requireExceptionKind,
  WorkforceValidationError,
  type AvailabilityExceptionRequestRecord,
  type AvailabilityRequestDecision,
  type RecordedAvailabilityException,
} from "@/lib/workforce";
import { WorkforceError } from "@/lib/workforce-ops";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Test-only barriers. Production never sets these.
 * - beforeDecideClaims: both decide transactions have read PENDING
 *   before either writes.
 * - beforeRequestCreate: both creates have passed the pending lookup
 *   before either inserts.
 */
export const availabilityRequestTestHooks: {
  beforeDecideClaims?: (input: {
    requestId: string;
    decision: AvailabilityRequestDecision;
  }) => Promise<void> | void;
  beforeRequestCreate?: (input: { membershipId: string; date: string }) => Promise<void> | void;
} = {};

function asRequestWriteError(error: unknown): never {
  if (error instanceof WorkforceError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new WorkforceError(AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE);
  }
  throw error;
}

function asDecideWriteError(error: unknown): never {
  if (error instanceof WorkforceError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new WorkforceError(AVAILABILITY_REQUEST_DECIDE_CONFLICT_MESSAGE);
  }
  throw error;
}

function toRequestRecord(
  row: {
    id: string;
    businessId: string;
    membershipId: string;
    date: string;
    kind: string;
    startMinutes: number | null;
    endMinutes: number | null;
    note: string;
    status: string;
    requestedAt: Date;
    decidedAt: Date | null;
    decidedByMembershipId: string | null;
    updatedAt: Date;
    membership?: { user?: { name?: string | null } | null } | null;
  },
  existingException: RecordedAvailabilityException | null = null,
): AvailabilityExceptionRequestRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    membershipId: row.membershipId,
    workerName: row.membership?.user?.name ?? "Worker",
    date: row.date,
    kind: row.kind === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
    startMinutes: row.startMinutes,
    endMinutes: row.endMinutes,
    note: row.note,
    status:
      row.status === "ACCEPTED" ? "ACCEPTED" : row.status === "DECLINED" ? "DECLINED" : "PENDING",
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    decidedByMembershipId: row.decidedByMembershipId,
    updatedAt: row.updatedAt,
    existingException,
  };
}

const REQUEST_SELECT = {
  id: true,
  businessId: true,
  membershipId: true,
  date: true,
  kind: true,
  startMinutes: true,
  endMinutes: true,
  note: true,
  status: true,
  requestedAt: true,
  decidedAt: true,
  decidedByMembershipId: true,
  updatedAt: true,
  membership: { select: { user: { select: { name: true } } } },
} as const;

function exceptionKey(membershipId: string, date: string) {
  return `${membershipId}:${date}`;
}

function toRecordedException(row: {
  kind: string;
  startMinutes: number | null;
  endMinutes: number | null;
  note: string;
}): RecordedAvailabilityException {
  return {
    kind: row.kind === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
    startMinutes: row.startMinutes,
    endMinutes: row.endMinutes,
    note: row.note,
  };
}

export function availabilityRequestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof WorkforceError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

export async function loadSelfAvailabilityExceptionRequests(
  db: Db,
  input: { businessId: string; membershipId: string },
): Promise<AvailabilityExceptionRequestRecord[]> {
  await requireProductCapability(db, input.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  const rows = await db.membershipAvailabilityExceptionRequest.findMany({
    where: {
      businessId: input.businessId,
      membershipId: input.membershipId,
    },
    select: REQUEST_SELECT,
    orderBy: [{ requestedAt: "desc" }],
    take: AVAILABILITY_REQUEST_SELF_LIST_LIMIT,
  });
  return rows.map((row) => toRequestRecord(row));
}

export async function loadOwnAvailabilityExceptionRequests(
  db: Db,
  access: BusinessAccess,
): Promise<AvailabilityExceptionRequestRecord[]> {
  return loadSelfAvailabilityExceptionRequests(db, {
    businessId: access.businessId,
    membershipId: access.workspace.membership.id,
  });
}

export async function loadOwnedAvailabilityExceptionRequests(
  db: Db,
  access: BusinessAccess,
): Promise<{
  pending: AvailabilityExceptionRequestRecord[];
  recent: AvailabilityExceptionRequestRecord[];
  canDecide: boolean;
  timeZone: string;
}> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);
  const business = await db.business.findUnique({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const [pendingRows, recentRows] = await Promise.all([
    db.membershipAvailabilityExceptionRequest.findMany({
      where: { businessId: access.businessId, status: "PENDING" },
      select: REQUEST_SELECT,
      orderBy: [{ date: "asc" }, { requestedAt: "asc" }],
      take: AVAILABILITY_REQUEST_PENDING_LIST_LIMIT,
    }),
    db.membershipAvailabilityExceptionRequest.findMany({
      where: { businessId: access.businessId, status: { in: ["ACCEPTED", "DECLINED"] } },
      select: REQUEST_SELECT,
      orderBy: [{ decidedAt: "desc" }, { requestedAt: "desc" }],
      take: AVAILABILITY_REQUEST_RECENT_LIST_LIMIT,
    }),
  ]);
  const exceptions =
    pendingRows.length === 0
      ? []
      : await db.membershipAvailabilityException.findMany({
          where: {
            businessId: access.businessId,
            OR: pendingRows.map((row) => ({
              membershipId: row.membershipId,
              date: row.date,
            })),
          },
          select: {
            membershipId: true,
            date: true,
            kind: true,
            startMinutes: true,
            endMinutes: true,
            note: true,
          },
        });
  const exceptionByKey = new Map(
    exceptions.map((row) => [exceptionKey(row.membershipId, row.date), toRecordedException(row)]),
  );
  return {
    pending: pendingRows.map((row) =>
      toRequestRecord(row, exceptionByKey.get(exceptionKey(row.membershipId, row.date)) ?? null),
    ),
    recent: recentRows.map((row) => toRequestRecord(row)),
    canDecide: access.workspace.role === "OWNER",
    timeZone: resolveBusinessTimeZone(business),
  };
}

export async function requestMemberAvailabilityExceptionOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    membershipId: string;
    date: string;
    kind: "AVAILABLE" | "UNAVAILABLE";
    startMinutes?: number | null;
    endMinutes?: number | null;
    note?: string;
    now?: Date;
  },
) {
  if (access.workspace.role !== "MEMBER") {
    throw new ForbiddenError();
  }
  if (input.membershipId !== access.workspace.membership.id) {
    throw new ForbiddenError();
  }
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);

  const membership = await db.membership.findFirst({
    where: {
      id: access.workspace.membership.id,
      businessId: access.businessId,
      role: "MEMBER",
    },
    select: { id: true, businessId: true, active: true, role: true },
  });
  if (!membership) throw new ForbiddenError();
  access.assertOwned(membership);
  if (!membership.active) {
    throw new WorkforceError(AVAILABILITY_REQUEST_INACTIVE_MESSAGE);
  }

  const business = await db.business.findUnique({
    where: { id: access.businessId },
    select: { timezone: true },
  });
  const timeZone = resolveBusinessTimeZone(business);
  const now = input.now ?? new Date();

  let date: string;
  let kind: "AVAILABLE" | "UNAVAILABLE";
  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  try {
    date = requireAvailabilityRequestDate(input.date, now, timeZone);
    kind = requireExceptionKind(input.kind);
    if (kind === "AVAILABLE") {
      if (input.startMinutes == null || input.endMinutes == null) {
        throw new WorkforceValidationError(AVAILABILITY_REQUEST_AVAILABLE_HOURS_MESSAGE);
      }
      const range = requireDayMinutesRange(input.startMinutes, input.endMinutes);
      startMinutes = range.startMinutes;
      endMinutes = range.endMinutes;
    }
  } catch (error) {
    if (error instanceof WorkforceValidationError) {
      throw new WorkforceError(error.message);
    }
    throw error;
  }

  const pending = await db.membershipAvailabilityExceptionRequest.findFirst({
    where: {
      businessId: access.businessId,
      membershipId: membership.id,
      date,
      status: "PENDING",
    },
    select: { id: true },
  });
  if (pending) {
    throw new WorkforceError(AVAILABILITY_REQUEST_PENDING_EXISTS_MESSAGE);
  }

  try {
    await availabilityRequestTestHooks.beforeRequestCreate?.({
      membershipId: membership.id,
      date,
    });
    const created = await db.membershipAvailabilityExceptionRequest.create({
      data: {
        businessId: access.businessId,
        membershipId: membership.id,
        date,
        kind,
        startMinutes,
        endMinutes,
        note: (input.note ?? "").trim().slice(0, 240),
        status: "PENDING",
      },
      select: REQUEST_SELECT,
    });
    return toRequestRecord(created);
  } catch (error) {
    asRequestWriteError(error);
  }
}

export async function decideMemberAvailabilityExceptionRequestOp(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    requestId: string;
    decision: AvailabilityRequestDecision | string;
    expectedUpdatedAt: Date;
    replaceExisting?: boolean;
    now?: Date;
  },
) {
  requireBusinessRole(access, "OWNER");
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MEMBERS);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.TEAM_MANAGEMENT);

  let decision: AvailabilityRequestDecision;
  try {
    decision = requireAvailabilityRequestDecision(input.decision);
  } catch (error) {
    if (error instanceof WorkforceValidationError) {
      throw new WorkforceError(error.message);
    }
    throw error;
  }
  if (Number.isNaN(input.expectedUpdatedAt.getTime())) {
    throw new WorkforceError(AVAILABILITY_REQUEST_STALE_MESSAGE);
  }

  try {
    return await db.$transaction(async (tx) => {
      const request = await tx.membershipAvailabilityExceptionRequest.findFirst({
        where: { id: input.requestId, businessId: access.businessId },
        select: {
          id: true,
          businessId: true,
          membershipId: true,
          date: true,
          kind: true,
          startMinutes: true,
          endMinutes: true,
          note: true,
          status: true,
          updatedAt: true,
        },
      });
      if (!request) throw new ForbiddenError();
      access.assertOwned(request);

      const membership = await tx.membership.findFirst({
        where: { id: request.membershipId, businessId: access.businessId },
        select: { id: true, businessId: true, active: true },
      });
      if (!membership) throw new ForbiddenError();
      access.assertOwned(membership);
      if (request.status !== "PENDING") {
        throw new WorkforceError(AVAILABILITY_REQUEST_STALE_MESSAGE);
      }
      if (request.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new WorkforceError(AVAILABILITY_REQUEST_STALE_MESSAGE);
      }

      await availabilityRequestTestHooks.beforeDecideClaims?.({
        requestId: request.id,
        decision,
      });

      const liveMembership = await tx.membership.findFirst({
        where: { id: request.membershipId, businessId: access.businessId },
        select: { id: true, businessId: true, active: true },
      });
      if (!liveMembership) throw new ForbiddenError();
      access.assertOwned(liveMembership);
      if (!liveMembership.active) {
        throw new WorkforceError(AVAILABILITY_REQUEST_INACTIVE_MESSAGE);
      }

      const business = await tx.business.findUnique({
        where: { id: access.businessId },
        select: { timezone: true },
      });
      try {
        requireAvailabilityRequestAcceptDate(
          request.date,
          input.now ?? new Date(),
          resolveBusinessTimeZone(business),
        );
      } catch (error) {
        if (error instanceof WorkforceValidationError) {
          throw new WorkforceError(error.message);
        }
        throw error;
      }

      if (decision === "ACCEPT") {
        const existing = await tx.membershipAvailabilityException.findFirst({
          where: {
            businessId: access.businessId,
            membershipId: liveMembership.id,
            date: request.date,
          },
          select: { id: true },
        });
        if (existing && !input.replaceExisting) {
          throw new WorkforceError(AVAILABILITY_REQUEST_REPLACE_REQUIRED_MESSAGE);
        }
      }

      const claimed = await tx.membershipAvailabilityExceptionRequest.updateMany({
        where: {
          id: request.id,
          businessId: access.businessId,
          membershipId: liveMembership.id,
          status: "PENDING",
          updatedAt: input.expectedUpdatedAt,
        },
        data: {
          status: decision === "ACCEPT" ? "ACCEPTED" : "DECLINED",
          decidedAt: new Date(),
          decidedByMembershipId: access.workspace.membership.id,
        },
      });
      if (claimed.count !== 1) {
        throw new WorkforceError(AVAILABILITY_REQUEST_STALE_MESSAGE);
      }

      if (decision === "ACCEPT") {
        await tx.membershipAvailabilityException.upsert({
          where: { membershipId_date: { membershipId: liveMembership.id, date: request.date } },
          create: {
            businessId: access.businessId,
            membershipId: liveMembership.id,
            date: request.date,
            kind: request.kind === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
            startMinutes: request.startMinutes,
            endMinutes: request.endMinutes,
            note: request.note,
          },
          update: {
            kind: request.kind === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
            startMinutes: request.startMinutes,
            endMinutes: request.endMinutes,
            note: request.note,
          },
        });
      }

      const updated = await tx.membershipAvailabilityExceptionRequest.findFirst({
        where: { id: request.id, businessId: access.businessId },
        select: REQUEST_SELECT,
      });
      if (!updated) throw new ForbiddenError();
      return {
        decision,
        request: toRequestRecord(updated),
      };
    });
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof WorkforceError) {
      throw error;
    }
    asDecideWriteError(error);
  }
}
