/**
 * OWNER-authorized builder for one same-business completed job/property.
 *
 * Callers must pass access.businessId from requireBusinessAccess().
 * Browser business IDs never authorize this load.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  assertCanExportCompletedJobProperty,
  noPropertyExportError,
  notCompletedExportError,
  notFoundExportError,
} from "@/lib/job-property-export/access";
import {
  JOB_PROPERTY_EXPORT_CONTRACT,
  JOB_PROPERTY_EXPORT_OMISSIONS,
  JOB_PROPERTY_EXPORT_PHOTO_READ_LIMIT,
  JOB_PROPERTY_EXPORT_PICKER_LIMIT,
  JOB_PROPERTY_EXPORT_PRODUCT,
  JOB_PROPERTY_EXPORT_SYSTEM,
  JOB_PROPERTY_EXPORT_VERSION,
  defaultJobPropertyExportLimits,
  type JobPropertyExportAuthorizationOptions,
  type JobPropertyExportDocument,
} from "@/lib/job-property-export/contract";

const COMPLETED_JOB_STATUS = "COMPLETED";

export type BuildCompletedJobPropertyExportInput = JobPropertyExportAuthorizationOptions & {
  jobId: string;
};

export type ExportableCompletedJobProperty = {
  jobId: string;
  propertyId: string;
  propertyLabel: string | null;
  city: string | null;
  region: string | null;
  updatedAt: Date;
};

export type ExportableCompletedJobPropertyList = {
  jobs: ExportableCompletedJobProperty[];
  truncated: boolean;
  limit: number;
};

export function boundExportRead<T>(
  rows: readonly T[],
  limit: number,
): { items: T[]; truncated: boolean; limit: number } {
  const truncated = rows.length > limit;
  return {
    items: truncated ? rows.slice(0, limit) : [...rows],
    truncated,
    limit,
  };
}

export async function listExportableCompletedJobProperties(
  prisma: PrismaClient,
  access: BusinessAccess,
): Promise<ExportableCompletedJobPropertyList> {
  assertCanExportCompletedJobProperty(access);
  const businessId = access.businessId;
  const jobs = await prisma.job.findMany({
    where: {
      businessId,
      status: COMPLETED_JOB_STATUS,
      propertyId: { not: null },
    },
    select: {
      id: true,
      businessId: true,
      propertyId: true,
      updatedAt: true,
      property: {
        select: {
          id: true,
          businessId: true,
          label: true,
          city: true,
          region: true,
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: JOB_PROPERTY_EXPORT_PICKER_LIMIT + 1,
  });

  const sameBusiness = jobs.flatMap((job) => {
    if (job.businessId !== businessId || !job.propertyId || !job.property) return [];
    if (job.property.businessId !== businessId || job.property.id !== job.propertyId) return [];
    return [
      {
        jobId: job.id,
        propertyId: job.property.id,
        propertyLabel: job.property.label,
        city: job.property.city,
        region: job.property.region,
        updatedAt: job.updatedAt,
      },
    ];
  });
  const bounded = boundExportRead(sameBusiness, JOB_PROPERTY_EXPORT_PICKER_LIMIT);
  return {
    jobs: bounded.items,
    truncated: bounded.truncated || jobs.length > JOB_PROPERTY_EXPORT_PICKER_LIMIT,
    limit: JOB_PROPERTY_EXPORT_PICKER_LIMIT,
  };
}

export async function buildCompletedJobPropertyExport(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: BuildCompletedJobPropertyExportInput,
): Promise<JobPropertyExportDocument> {
  assertCanExportCompletedJobProperty(access);
  const businessId = access.businessId;
  const includePrivateCustomer = Boolean(input.includePrivateCustomer);
  const includePhotos = Boolean(input.includePhotos);

  const job = await prisma.job.findFirst({
    where: { id: input.jobId, businessId },
    select: {
      id: true,
      businessId: true,
      customerId: true,
      propertyId: true,
      estimateId: true,
      status: true,
      scheduledAt: true,
      serviceIntent: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!job) {
    throw notFoundExportError();
  }
  access.assertOwned(job);
  if (job.status !== COMPLETED_JOB_STATUS) {
    throw notCompletedExportError();
  }
  if (!job.propertyId) {
    throw noPropertyExportError();
  }

  const [business, property, customer, photos] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true, slug: true, tradeCode: true },
    }),
    prisma.property.findFirst({
      where: { id: job.propertyId, businessId },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        label: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    job.customerId
      ? prisma.customer.findFirst({
          where: { id: job.customerId, businessId },
          select: {
            id: true,
            businessId: true,
            name: true,
            email: true,
            phone: true,
            updatedAt: true,
          },
        })
      : Promise.resolve(null),
    prisma.jobPhoto.findMany({
      where: { jobId: job.id, businessId },
      select: {
        id: true,
        businessId: true,
        jobId: true,
        stage: true,
        caption: true,
        createdAt: true,
        marketingPermissionStatus: true,
        url: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: JOB_PROPERTY_EXPORT_PHOTO_READ_LIMIT + 1,
    }),
  ]);

  if (!business) {
    throw notFoundExportError();
  }
  if (!property) {
    throw noPropertyExportError();
  }
  access.assertOwned(property);
  if (property.id !== job.propertyId) {
    throw noPropertyExportError();
  }
  if (customer) {
    access.assertOwned(customer);
  }

  const sameBusinessPhotos = photos.filter(
    (photo) => photo.businessId === businessId && photo.jobId === job.id,
  );
  const boundedPhotos = boundExportRead(sameBusinessPhotos, JOB_PROPERTY_EXPORT_PHOTO_READ_LIMIT);

  return {
    contract: JOB_PROPERTY_EXPORT_CONTRACT,
    version: JOB_PROPERTY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      system: JOB_PROPERTY_EXPORT_SYSTEM,
      product: JOB_PROPERTY_EXPORT_PRODUCT,
    },
    limits: defaultJobPropertyExportLimits(),
    authorization: {
      role: "OWNER",
      authorizedByMembershipId: access.workspace.membership.id,
      includePrivateCustomer,
      includePhotos,
    },
    provenance: {
      businessId: business.id,
      jobId: job.id,
      propertyId: property.id,
      customerId: customer?.id ?? null,
      sourceRecordUpdatedAt: {
        job: job.updatedAt.toISOString(),
        property: property.updatedAt.toISOString(),
        customer: customer?.updatedAt.toISOString() ?? null,
      },
    },
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      tradeCode: business.tradeCode,
    },
    job: {
      id: job.id,
      status: COMPLETED_JOB_STATUS,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      scheduledAt: job.scheduledAt?.toISOString() ?? null,
      serviceIntent: job.serviceIntent,
      estimateId: job.estimateId,
    },
    property: {
      id: property.id,
      label: property.label,
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2,
      city: property.city,
      region: property.region,
      postalCode: property.postalCode,
      createdAt: property.createdAt.toISOString(),
      updatedAt: property.updatedAt.toISOString(),
    },
    customer: {
      included: includePrivateCustomer,
      id: customer?.id ?? null,
      name: includePrivateCustomer ? (customer?.name ?? null) : null,
      email: includePrivateCustomer ? (customer?.email ?? null) : null,
      phone: includePrivateCustomer ? (customer?.phone ?? null) : null,
    },
    photos: {
      included: includePhotos,
      count: boundedPhotos.items.length,
      truncated: boundedPhotos.truncated,
      limit: boundedPhotos.limit,
      items: includePhotos
        ? boundedPhotos.items.map((photo) => ({
            id: photo.id,
            stage: photo.stage,
            caption: photo.caption,
            createdAt: photo.createdAt.toISOString(),
            marketingPermissionStatus: photo.marketingPermissionStatus,
            url: photo.url,
          }))
        : [],
    },
    omitted: [...JOB_PROPERTY_EXPORT_OMISSIONS],
  };
}
