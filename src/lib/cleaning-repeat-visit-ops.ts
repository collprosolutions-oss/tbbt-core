/**
 * Existing Cleaning customer submits a request for another visit.
 *
 * Resolves the job from projectToken only. Binds the same-business
 * customer. Reuses the public request + website-published intake snapshot
 * path. Never creates or schedules a Job, charge, invoice, or message.
 */
import type { PrismaClient } from "@prisma/client";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";
import { createPublicServiceRequest, type PublicIntakeInput } from "@/lib/public-intake";
import {
  CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE,
  cleaningRepeatVisitEligible,
  publicRepeatVisitPath,
  resolveCleaningRepeatVisitTradeCode,
} from "@/lib/cleaning-repeat-visit";

export type CleaningRepeatVisitSubmitInput = {
  token: string;
  /** Browser slug is never authorization. Must match the token business. */
  slug?: string | null;
  name: string;
  email: string;
  phone: string;
  address: string;
  streetAddress?: string;
  unit?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  notes: string;
  catalogItemIds: string[];
  catalogQuantities?: Record<string, unknown>;
  includeOther: boolean;
  otherDescription: string;
  otherQuantity?: unknown;
  photoUrls?: string[];
  photoAssetIds?: string[];
  measurements?: PublicIntakeInput["measurements"];
  workAreaAnswers?: PublicIntakeInput["workAreaAnswers"];
  submissionId?: string | null;
  smsOptIn?: unknown;
  intakeAnswers?: Record<string, unknown>;
  requestedTradeCode?: string | null;
  tenantIntakeSnapshotId?: string | null;
};

export type CleaningRepeatVisitSubmitResult =
  | { ok: true; requestId: string; alreadyExists: boolean }
  | { ok: false; error: string };

const SOURCE_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  business: { select: { id: true, slug: true } },
  customer: { select: { id: true, businessId: true, name: true } },
  estimate: {
    select: {
      serviceRequest: { select: { tradeCode: true } },
      lineItems: { select: { serviceCatalogItem: { select: { tradeCode: true } } } },
    },
  },
} as const;

function sameBusinessCustomer(job: {
  businessId: string;
  customerId: string | null;
  customer: { id: string; businessId: string; name: string } | null;
}) {
  if (
    job.customer &&
    job.customer.businessId === job.businessId &&
    job.customerId === job.customer.id
  ) {
    return job.customer;
  }
  return null;
}

async function findExistingRepeatVisit(
  db: PrismaClient,
  businessId: string,
  sourceJobId: string,
) {
  return db.serviceRequest.findFirst({
    where: { businessId, repeatVisitSourceJobId: sourceJobId },
    select: { id: true },
  });
}

export async function createCleaningCustomerRepeatVisitRequest(
  db: PrismaClient,
  input: CleaningRepeatVisitSubmitInput,
): Promise<CleaningRepeatVisitSubmitResult> {
  const token = input.token.trim();
  if (!token) {
    return { ok: false, error: CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE };
  }

  const job = await findLiveJobByProjectToken(db, token, SOURCE_JOB_SELECT);
  if (!job || job.business.id !== job.businessId) {
    return { ok: false, error: CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE };
  }

  const offeredSlug = input.slug?.trim().toLowerCase() ?? "";
  if (offeredSlug && offeredSlug !== job.business.slug) {
    return { ok: false, error: CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE };
  }

  const tradeCode = resolveCleaningRepeatVisitTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
  if (!cleaningRepeatVisitEligible(tradeCode)) {
    return { ok: false, error: CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE };
  }

  const customer = sameBusinessCustomer(job);
  if (!customer) {
    return { ok: false, error: CLEANING_REPEAT_VISIT_UNAVAILABLE_MESSAGE };
  }

  const existing = await findExistingRepeatVisit(db, job.businessId, job.id);
  if (existing) {
    return { ok: true, requestId: existing.id, alreadyExists: true };
  }

  const configuredAreas = (
    await db.serviceArea.findMany({ where: { businessId: job.businessId } })
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    enabled: row.enabled,
    travelAdjustment: row.travelAdjustment ? Number(row.travelAdjustment) : null,
    minimumAdjustment: row.minimumAdjustment ? Number(row.minimumAdjustment) : null,
    notes: row.notes,
  }));

  const created = await createPublicServiceRequest(db, {
    slug: job.business.slug,
    name: input.name.trim() || customer.name,
    email: input.email,
    phone: input.phone,
    address: input.address,
    streetAddress: input.streetAddress,
    unit: input.unit,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
    notes: input.notes,
    catalogItemIds: input.catalogItemIds,
    catalogQuantities: input.catalogQuantities,
    includeOther: input.includeOther,
    otherDescription: input.otherDescription,
    otherQuantity: input.otherQuantity,
    photoUrls: input.photoUrls,
    photoAssetIds: input.photoAssetIds,
    measurements: input.measurements,
    workAreaAnswers: input.workAreaAnswers,
    submissionId: input.submissionId,
    smsOptIn: input.smsOptIn,
    intakeAnswers: input.intakeAnswers,
    requestedTradeCode: "CLEANING",
    tenantIntakeSnapshotId: input.tenantIntakeSnapshotId,
    leadSource: "WEBSITE",
    landingPagePath: publicRepeatVisitPath(token),
    configuredAreas,
    existingCustomer: {
      customerId: customer.id,
      repeatVisitSourceJobId: job.id,
    },
  });

  if (!created.ok) {
    return created;
  }

  return { ok: true, requestId: created.requestId, alreadyExists: false };
}

export async function countBusinessJobs(db: PrismaClient, businessId: string) {
  return db.job.count({ where: { businessId } });
}

export async function countBusinessInvoices(db: PrismaClient, businessId: string) {
  return db.invoice.count({ where: { businessId } });
}

export async function countBusinessPayments(db: PrismaClient, businessId: string) {
  return db.payment.count({ where: { businessId } });
}

export async function countBusinessCustomerMessages(db: PrismaClient, businessId: string) {
  return db.customerCommunication.count({ where: { businessId } });
}
