/**
 * OWNER assigns a same-business BusinessLocation to a Job.
 *
 * Rechecks location ownership at write time, inside the same transaction
 * that locks the Job, then takes FOR SHARE on the location row.
 * Writes only Job.businessLocationId on open, uninvoiced Jobs. Never
 * updates Business.timezone, tenant businessId, customer, property,
 * Stripe, or a terminal Job's updatedAt.
 *
 * Schema comes only from the existing BusinessLocation migration.
 * Assignment never runs DDL.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  BusinessLocationUnavailableError,
  missingBusinessLocationSchema,
} from "@/lib/business-location-ops";
import {
  JOB_LOCATION_INACTIVE_MESSAGE,
  JOB_LOCATION_INVOICED_MESSAGE,
  JOB_LOCATION_MISSING_JOB_MESSAGE,
  JOB_LOCATION_NOT_OWNED_MESSAGE,
  JOB_LOCATION_OWNER_ONLY_MESSAGE,
  JOB_LOCATION_STALE_MESSAGE,
  JOB_LOCATION_TERMINAL_MESSAGE,
  isTerminalJobLocationStatus,
  jobLocationSnapshotsEqual,
  parseJobLocationId,
} from "@/lib/job-location";
import { writeSettingsAuditLog } from "@/lib/settings-ops";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

type Db = PrismaClient | Prisma.TransactionClient;

type LockedLocationRow = {
  id: string;
  businessId: string;
  status: string;
};

export class JobLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobLocationError";
  }
}

export function jobLocationErrorMessage(error: unknown, fallback: string) {
  if (error instanceof JobLocationError || error instanceof ForbiddenError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "ForbiddenError") {
    return error.message;
  }
  if (missingBusinessLocationSchema(error)) {
    return new BusinessLocationUnavailableError().message;
  }
  return fallback;
}

function throwIfLocationSchemaMissing(error: unknown): never {
  if (missingBusinessLocationSchema(error)) {
    throw new BusinessLocationUnavailableError();
  }
  throw error;
}

function requireJobLocationOwner(access: BusinessAccess) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(JOB_LOCATION_OWNER_ONLY_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

const JOB_LOCATION_WRITE_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  propertyId: true,
  businessLocationId: true,
  status: true,
  updatedAt: true,
  invoices: { select: { id: true }, take: 1 },
} as const;

export type AssignedJobLocation = {
  id: string;
  businessId: string;
  customerId: string | null;
  propertyId: string | null;
  businessLocationId: string | null;
  status: string;
  updatedAt: Date;
};

export type AssignJobBusinessLocationInput = {
  jobId: string;
  locationId: string | null;
  expectedUpdatedAt: string;
};

async function lockOwnedBusinessLocationForShare(
  db: Db,
  businessId: string,
  locationId: string,
): Promise<LockedLocationRow | null> {
  const rows = await db.$queryRaw<LockedLocationRow[]>`
    SELECT id, "businessId", status
    FROM "BusinessLocation"
    WHERE id = ${locationId}
      AND "businessId" = ${businessId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

async function loadOwnedAssignableLocation(
  db: Db,
  access: BusinessAccess,
  jobBusinessId: string,
  locationId: string,
  currentLocationId: string | null,
) {
  const location = await lockOwnedBusinessLocationForShare(db, access.businessId, locationId);
  if (!location || location.businessId !== jobBusinessId) {
    throw new JobLocationError(JOB_LOCATION_NOT_OWNED_MESSAGE);
  }
  access.assertOwned(location);
  if (location.status !== "ACTIVE" && location.id !== currentLocationId) {
    throw new JobLocationError(JOB_LOCATION_INACTIVE_MESSAGE);
  }
  return location;
}

export async function assignJobBusinessLocation(
  db: PrismaClient,
  access: BusinessAccess,
  input: AssignJobBusinessLocationInput,
): Promise<AssignedJobLocation> {
  requireJobLocationOwner(access);

  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new JobLocationError(JOB_LOCATION_MISSING_JOB_MESSAGE);
  }

  let requestedLocationId: string | null;
  try {
    requestedLocationId = input.locationId ? parseJobLocationId(input.locationId) : null;
  } catch (error) {
    throw new JobLocationError(
      error instanceof Error ? error.message : JOB_LOCATION_NOT_OWNED_MESSAGE,
    );
  }

  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, jobId);
      if (!locked || locked.businessId !== access.businessId) {
        throw new JobLocationError(JOB_LOCATION_MISSING_JOB_MESSAGE);
      }

      const job = access.assertOwned(
        await tx.job.findFirst({
          where: { id: locked.id, businessId: access.businessId },
          select: JOB_LOCATION_WRITE_SELECT,
        }),
      );

      if (isTerminalJobLocationStatus(job.status)) {
        throw new JobLocationError(JOB_LOCATION_TERMINAL_MESSAGE);
      }
      if (job.invoices.length > 0) {
        throw new JobLocationError(JOB_LOCATION_INVOICED_MESSAGE);
      }

      if (!jobLocationSnapshotsEqual(input.expectedUpdatedAt, job.updatedAt)) {
        throw new JobLocationError(JOB_LOCATION_STALE_MESSAGE);
      }

      let nextLocationId: string | null = null;
      if (requestedLocationId) {
        const location = await loadOwnedAssignableLocation(
          tx,
          access,
          job.businessId,
          requestedLocationId,
          job.businessLocationId,
        );
        nextLocationId = location.id;
      }

      const written = await tx.job.updateMany({
        where: {
          id: job.id,
          businessId: access.businessId,
          updatedAt: job.updatedAt,
        },
        data: { businessLocationId: nextLocationId },
      });
      if (written.count !== 1) {
        throw new JobLocationError(JOB_LOCATION_STALE_MESSAGE);
      }

      await writeSettingsAuditLog(tx, {
        businessId: access.businessId,
        changedByMembershipId: access.workspace.membership.id,
        settingArea: "locations",
        settingKey: "job.businessLocation.assign",
        previousValue: { jobId: job.id, businessLocationId: job.businessLocationId },
        newValue: { jobId: job.id, businessLocationId: nextLocationId },
      });

      const updated = access.assertOwned(
        await tx.job.findFirst({
          where: { id: job.id, businessId: access.businessId },
          select: JOB_LOCATION_WRITE_SELECT,
        }),
      );

      if (
        updated.businessId !== job.businessId ||
        updated.customerId !== job.customerId ||
        updated.propertyId !== job.propertyId ||
        updated.status !== job.status ||
        updated.businessLocationId !== nextLocationId
      ) {
        throw new JobLocationError(JOB_LOCATION_STALE_MESSAGE);
      }

      return {
        id: updated.id,
        businessId: updated.businessId,
        customerId: updated.customerId,
        propertyId: updated.propertyId,
        businessLocationId: updated.businessLocationId,
        status: updated.status,
        updatedAt: updated.updatedAt,
      };
    });
  } catch (error) {
    throwIfLocationSchemaMissing(error);
  }
}
