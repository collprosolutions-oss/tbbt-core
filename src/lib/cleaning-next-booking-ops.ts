/**
 * OWNER mutation: create one next booking from a completed Cleaning job.
 *
 * Copies same-business customer, property, and selected service scope.
 * Requires an explicit date and confirmation. Never writes invoices,
 * customer messages, or extra future Job rows.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";
import {
  CLEANING_NEXT_BOOKING_CONFIRM_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_CUSTOMER_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_DATE_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_INVALID_DATE_MESSAGE,
  CLEANING_NEXT_BOOKING_NOT_COMPLETED_MESSAGE,
  CLEANING_NEXT_BOOKING_ONLY_MESSAGE,
  CLEANING_NEXT_BOOKING_PROPERTY_REQUIRED_MESSAGE,
  CLEANING_NEXT_BOOKING_SCOPE_REQUIRED_MESSAGE,
  OWNER_CREATES_NEXT_BOOKING_MESSAGE,
  businessTimeZoneForNextBooking,
  cleaningNextBookingEligible,
  hasSelectedServiceScope,
  oneTimeNextBookingPlan,
  parseOwnerNextBookingConfirmation,
  parseOwnerNextBookingStart,
  resolveCleaningJobTradeCode,
} from "@/lib/cleaning-next-booking";
import { lockTenantOwnedJob } from "@/lib/time-card-ops";

export class CleaningNextBookingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleaningNextBookingError";
  }
}

export function cleaningNextBookingErrorMessage(error: unknown, fallback: string) {
  if (error instanceof CleaningNextBookingError) return error.message;
  if (error instanceof ForbiddenError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

const SOURCE_JOB_SELECT = {
  id: true,
  businessId: true,
  status: true,
  customerId: true,
  propertyId: true,
  estimateId: true,
  approvedEstimateVersionId: true,
  scheduledDurationMinutes: true,
  leadSource: true,
  campaignId: true,
  businessLocationId: true,
  customer: { select: { id: true, businessId: true } },
  property: { select: { id: true, businessId: true, customerId: true } },
  estimate: {
    select: {
      id: true,
      businessId: true,
      customerId: true,
      propertyId: true,
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: { id: true, serviceCatalogItem: { select: { tradeCode: true } } },
      },
      property: { select: { id: true, businessId: true, customerId: true } },
    },
  },
  approvedEstimateVersion: {
    select: {
      id: true,
      businessId: true,
      lineItems: { select: { id: true } },
    },
  },
} as const;

type SourceJob = Prisma.JobGetPayload<{ select: typeof SOURCE_JOB_SELECT }>;

export type CreateCleaningNextBookingInput = {
  jobId: string;
  date: string;
  time?: string;
  confirmCreate: string | boolean;
};

export type CreatedCleaningNextBooking = {
  id: string;
  businessId: string;
  customerId: string | null;
  propertyId: string | null;
  estimateId: string | null;
  approvedEstimateVersionId: string | null;
  recurrenceSourceJobId: string | null;
  status: string;
  scheduledAt: Date | null;
  serviceIntent: string;
  recurrenceCadence: string;
  recurrenceStatus: string;
  nextOccurrenceAt: Date | null;
  alreadyExists: boolean;
};

const CREATED_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  propertyId: true,
  estimateId: true,
  approvedEstimateVersionId: true,
  recurrenceSourceJobId: true,
  status: true,
  scheduledAt: true,
  serviceIntent: true,
  recurrenceCadence: true,
  recurrenceStatus: true,
  nextOccurrenceAt: true,
} as const;

function assertOwner(access: BusinessAccess) {
  if (access.workspace.role !== "OWNER") {
    throw new ForbiddenError(OWNER_CREATES_NEXT_BOOKING_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function assertCleaningCompleted(job: SourceJob) {
  const tradeCode = resolveCleaningJobTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningNextBookingEligible(tradeCode)) {
    throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_ONLY_MESSAGE);
  }
  if (job.status !== "COMPLETED") {
    throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_NOT_COMPLETED_MESSAGE);
  }
}

function sameBusinessCustomer(job: SourceJob, businessId: string) {
  if (job.customer && job.customer.businessId === businessId && job.customerId === job.customer.id) {
    return job.customer;
  }
  return null;
}

function sameBusinessProperty(job: SourceJob, businessId: string, customerId: string) {
  if (
    job.property &&
    job.property.businessId === businessId &&
    job.property.customerId === customerId &&
    job.propertyId === job.property.id
  ) {
    return job.property;
  }
  const estimateProperty = job.estimate?.property;
  if (
    estimateProperty &&
    estimateProperty.businessId === businessId &&
    estimateProperty.customerId === customerId &&
    job.estimate?.businessId === businessId
  ) {
    return estimateProperty;
  }
  return null;
}

function selectedScopeBinding(job: SourceJob, businessId: string) {
  const approvedVersion =
    job.approvedEstimateVersion && job.approvedEstimateVersion.businessId === businessId
      ? job.approvedEstimateVersion
      : null;
  const estimate = job.estimate && job.estimate.businessId === businessId ? job.estimate : null;
  const scopeLineCount =
    (approvedVersion?.lineItems.length ?? 0) + (estimate?.lineItems.length ?? 0);
  if (
    !hasSelectedServiceScope({
      approvedEstimateVersionId: approvedVersion?.id ?? job.approvedEstimateVersionId,
      estimateId: estimate?.id ?? (job.estimateId && estimate ? job.estimateId : null),
      scopeLineCount,
    })
  ) {
    return null;
  }
  return {
    estimateId: estimate?.id ?? null,
    approvedEstimateVersionId: approvedVersion?.id ?? null,
  };
}

async function findExistingNextBooking(
  db: Prisma.TransactionClient | PrismaClient,
  businessId: string,
  sourceJobId: string,
) {
  return db.job.findFirst({
    where: { businessId, recurrenceSourceJobId: sourceJobId },
    select: CREATED_SELECT,
  });
}

function asCreated(
  row: Prisma.JobGetPayload<{ select: typeof CREATED_SELECT }>,
  alreadyExists: boolean,
): CreatedCleaningNextBooking {
  return { ...row, alreadyExists };
}

export async function createNextBookingFromCompletedCleaningJob(
  db: PrismaClient,
  access: BusinessAccess,
  input: CreateCleaningNextBookingInput,
): Promise<CreatedCleaningNextBooking> {
  assertOwner(access);

  if (!input.jobId.trim()) {
    throw new CleaningNextBookingError("That job could not be found.");
  }
  if (!input.date.trim()) {
    throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_DATE_REQUIRED_MESSAGE);
  }
  if (!parseOwnerNextBookingConfirmation(input.confirmCreate)) {
    throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_CONFIRM_REQUIRED_MESSAGE);
  }

  const timeZone = businessTimeZoneForNextBooking(access.workspace.business);
  const scheduledAt = parseOwnerNextBookingStart({
    date: input.date,
    time: input.time,
    timeZone,
  });
  if (!scheduledAt) {
    throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_INVALID_DATE_MESSAGE);
  }

  const source = access.assertOwned(
    await db.job.findFirst({
      where: { id: input.jobId, businessId: access.businessId },
      select: SOURCE_JOB_SELECT,
    }),
  );
  assertCleaningCompleted(source);

  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockTenantOwnedJob(tx, access.businessId, source.id);
      if (!locked) {
        throw new Error("Record is not in the authorized business workspace.");
      }

      const existing = await findExistingNextBooking(tx, access.businessId, source.id);
      if (existing) {
        return asCreated(existing, true);
      }

      const fresh = access.assertOwned(
        await tx.job.findFirst({
          where: { id: source.id, businessId: access.businessId },
          select: SOURCE_JOB_SELECT,
        }),
      );
      assertCleaningCompleted(fresh);

      const customer = sameBusinessCustomer(fresh, access.businessId);
      if (!customer) {
        throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_CUSTOMER_REQUIRED_MESSAGE);
      }
      const property = sameBusinessProperty(fresh, access.businessId, customer.id);
      if (!property) {
        throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_PROPERTY_REQUIRED_MESSAGE);
      }
      const scope = selectedScopeBinding(fresh, access.businessId);
      if (!scope) {
        throw new CleaningNextBookingError(CLEANING_NEXT_BOOKING_SCOPE_REQUIRED_MESSAGE);
      }

      const oneTime = oneTimeNextBookingPlan();
      const created = await tx.job.create({
        data: {
          businessId: access.businessId,
          customerId: customer.id,
          propertyId: property.id,
          estimateId: scope.estimateId,
          approvedEstimateVersionId: scope.approvedEstimateVersionId,
          projectToken: randomUUID(),
          status: "SCHEDULED",
          scheduledAt,
          scheduledDurationMinutes: fresh.scheduledDurationMinutes,
          leadSource: fresh.leadSource,
          campaignId: fresh.campaignId,
          businessLocationId: fresh.businessLocationId,
          serviceIntent: oneTime.serviceIntent,
          recurrenceCadence: oneTime.recurrenceCadence,
          recurrenceStatus: oneTime.recurrenceStatus,
          nextOccurrenceAt: oneTime.nextOccurrenceAt,
          recurrenceSourceJobId: fresh.id,
          appointmentConfirmationStatus: "NONE",
        },
        select: CREATED_SELECT,
      });
      return asCreated(created, false);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await findExistingNextBooking(db, access.businessId, source.id);
      if (existing) {
        return asCreated(existing, true);
      }
    }
    throw error;
  }
}

export async function countBusinessJobs(db: PrismaClient, businessId: string) {
  return db.job.count({ where: { businessId } });
}

export async function countBusinessInvoices(db: PrismaClient, businessId: string) {
  return db.invoice.count({ where: { businessId } });
}
