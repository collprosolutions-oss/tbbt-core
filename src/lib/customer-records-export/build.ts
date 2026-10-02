/**
 * OWNER-authorized builder for tenant-scoped customer records.
 *
 * Callers must pass access.businessId from requireBusinessAccess().
 * Browser business IDs never authorize this load.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  assertCanExportCustomerRecords,
  invalidCustomerRecordsExportError,
  notFoundCustomerRecordsExportError,
} from "@/lib/customer-records-export/access";
import {
  CUSTOMER_RECORDS_EXPORT_CONTRACT,
  CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
  CUSTOMER_RECORDS_EXPORT_OMISSIONS,
  CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
  CUSTOMER_RECORDS_EXPORT_PRODUCT,
  CUSTOMER_RECORDS_EXPORT_PROJECT_DOCUMENT_PURPOSE,
  CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  CUSTOMER_RECORDS_EXPORT_SYSTEM,
  CUSTOMER_RECORDS_EXPORT_VERSION,
  PRIVATE_FILE_OMISSION,
  defaultCustomerRecordsExportLimits,
  type CustomerRecordsExportCollection,
  type CustomerRecordsExportCustomerPacket,
  type CustomerRecordsExportDocument,
  type CustomerRecordsExportFileRef,
} from "@/lib/customer-records-export/contract";

export type BuildCustomerRecordsExportInput = {
  cursor?: string | null;
  customerId?: string | null;
};

export type ExportableCustomerRecord = {
  customerId: string;
  name: string;
  propertyCount: number;
  requestCount: number;
  estimateCount: number;
  jobCount: number;
  invoiceCount: number;
  paymentCount: number;
  creditCount: number;
  timeCardCount: number;
  updatedAt: Date;
};

export type ExportableCustomerRecordList = {
  customers: ExportableCustomerRecord[];
  truncated: boolean;
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
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

function money(value: Prisma.Decimal | number | string): string {
  const amount = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return amount.toFixed(2);
}

function collection<T>(
  rows: readonly T[],
  limit: number,
): CustomerRecordsExportCollection<T> {
  const bounded = boundExportRead(rows, limit);
  return {
    count: bounded.items.length,
    truncated: bounded.truncated,
    limit: bounded.limit,
    items: bounded.items,
  };
}

export async function listExportableCustomerRecords(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: BuildCustomerRecordsExportInput = {},
): Promise<ExportableCustomerRecordList> {
  const document = await buildCustomerRecordsExport(prisma, access, input);
  return {
    customers: document.customers.map((packet) => ({
      customerId: packet.customer.id,
      name: packet.customer.name,
      propertyCount: packet.properties.count,
      requestCount: packet.requests.count,
      estimateCount: packet.estimates.count,
      jobCount: packet.jobs.count,
      invoiceCount: packet.invoices.count,
      paymentCount: packet.payments.count,
      creditCount: packet.credits.count,
      timeCardCount: packet.timeCards.count,
      updatedAt: new Date(packet.customer.updatedAt),
    })),
    truncated: document.provenance.page.truncated,
    limit: document.provenance.page.limit,
    cursor: document.provenance.page.cursor,
    nextCursor: document.provenance.page.nextCursor,
  };
}

export async function buildCustomerRecordsExport(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: BuildCustomerRecordsExportInput = {},
): Promise<CustomerRecordsExportDocument> {
  assertCanExportCustomerRecords(access);
  const businessId = access.businessId;
  const customerId = input.customerId?.trim() || null;
  const cursor = input.cursor?.trim() || null;
  if (customerId && cursor) {
    throw invalidCustomerRecordsExportError("A single-customer export cannot also use a page cursor.");
  }
  if (cursor) {
    const cursorRow = await prisma.customer.findFirst({
      where: { id: cursor, businessId },
      select: { id: true, businessId: true },
    });
    if (!cursorRow) {
      throw invalidCustomerRecordsExportError("Export page cursor was not found in this workspace.");
    }
    access.assertOwned(cursorRow);
  }

  const [business, customerRows] = await Promise.all([
    prisma.business.findFirst({
      where: { id: businessId },
      select: { id: true, name: true, slug: true, tradeCode: true },
    }),
    customerId
      ? prisma.customer
          .findFirst({
            where: { id: customerId, businessId },
            select: {
              id: true,
              businessId: true,
              name: true,
              email: true,
              phone: true,
              smsConsentStatus: true,
              firstLeadSource: true,
              createdAt: true,
              updatedAt: true,
            },
          })
          .then((row) => (row ? [row] : []))
      : prisma.customer.findMany({
          where: { businessId },
          select: {
            id: true,
            businessId: true,
            name: true,
            email: true,
            phone: true,
            smsConsentStatus: true,
            firstLeadSource: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          take: CUSTOMER_RECORDS_EXPORT_PAGE_SIZE + 1,
        }),
  ]);

  if (!business) {
    throw notFoundCustomerRecordsExportError();
  }
  if (customerId && customerRows.length === 0) {
    throw notFoundCustomerRecordsExportError();
  }

  const sameBusinessCustomers = customerRows.filter((row) => row.businessId === businessId);
  for (const customer of sameBusinessCustomers) {
    access.assertOwned(customer);
  }

  const page = customerId
    ? { items: sameBusinessCustomers, truncated: false, limit: CUSTOMER_RECORDS_EXPORT_PAGE_SIZE }
    : boundExportRead(sameBusinessCustomers, CUSTOMER_RECORDS_EXPORT_PAGE_SIZE);
  const customers = page.items;
  const truncated = page.truncated;
  const packets = await Promise.all(
    customers.map((customer) => buildCustomerPacket(prisma, access, customer)),
  );

  return {
    contract: CUSTOMER_RECORDS_EXPORT_CONTRACT,
    version: CUSTOMER_RECORDS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      system: CUSTOMER_RECORDS_EXPORT_SYSTEM,
      product: CUSTOMER_RECORDS_EXPORT_PRODUCT,
    },
    limits: defaultCustomerRecordsExportLimits(),
    authorization: {
      role: "OWNER",
      authorizedByMembershipId: access.workspace.membership.id,
    },
    provenance: {
      businessId: business.id,
      page: {
        limit: CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
        count: packets.length,
        truncated,
        cursor: customerId ? null : cursor,
        nextCursor: truncated ? (customers[customers.length - 1]?.id ?? null) : null,
        customerId,
      },
    },
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      tradeCode: business.tradeCode,
    },
    customers: packets,
    omitted: [...CUSTOMER_RECORDS_EXPORT_OMISSIONS],
  };
}

async function buildCustomerPacket(
  prisma: PrismaClient,
  access: BusinessAccess,
  customer: {
    id: string;
    businessId: string;
    name: string;
    email: string | null;
    phone: string | null;
    smsConsentStatus: string;
    firstLeadSource: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
): Promise<CustomerRecordsExportCustomerPacket> {
  const businessId = access.businessId;
  const [properties, requests, estimates, jobs, invoices, payments, credits, timeCards] = await Promise.all([
    prisma.property.findMany({
      where: { businessId, customerId: customer.id },
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
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.serviceRequest.findMany({
      where: { businessId, customerId: customer.id },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        propertyId: true,
        status: true,
        summary: true,
        description: true,
        leadSource: true,
        serviceIntent: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.estimate.findMany({
      where: { businessId, customerId: customer.id },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        propertyId: true,
        serviceRequestId: true,
        status: true,
        total: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.job.findMany({
      where: { businessId, customerId: customer.id },
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
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.invoice.findMany({
      where: { businessId, customerId: customer.id },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        jobId: true,
        kind: true,
        status: true,
        total: true,
        paidAt: true,
        paymentMethod: true,
        paymentReference: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.payment.findMany({
      where: { businessId, customerId: customer.id },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        estimateId: true,
        jobId: true,
        invoiceId: true,
        purpose: true,
        amount: true,
        method: true,
        receivedAt: true,
        note: true,
        createdAt: true,
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.invoiceCredit.findMany({
      where: {
        businessId,
        invoice: { is: { businessId, customerId: customer.id } },
      },
      select: {
        id: true,
        businessId: true,
        customerId: true,
        invoiceId: true,
        amount: true,
        reason: true,
        createdAt: true,
        invoice: { select: { businessId: true, customerId: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
    prisma.timeEntry.findMany({
      where: {
        businessId,
        job: { is: { businessId, customerId: customer.id } },
      },
      select: {
        id: true,
        businessId: true,
        jobId: true,
        membershipId: true,
        activityType: true,
        status: true,
        startedAt: true,
        endedAt: true,
        note: true,
        source: true,
        createdAt: true,
        job: { select: { businessId: true, customerId: true } },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT + 1,
    }),
  ]);

  const ownedProperties = properties.filter(
    (row) => row.businessId === businessId && row.customerId === customer.id,
  );
  const ownedRequests = requests.filter(
    (row) => row.businessId === businessId && row.customerId === customer.id,
  );
  const ownedEstimates = estimates.filter(
    (row) => row.businessId === businessId && row.customerId === customer.id,
  );
  const ownedJobs = jobs.filter(
    (row) => row.businessId === businessId && row.customerId === customer.id,
  );
  const ownedInvoices = invoices.filter(
    (row) => row.businessId === businessId && row.customerId === customer.id,
  );
  const ownedPayments = payments.filter(
    (row) => row.businessId === businessId && row.customerId === customer.id,
  );
  const ownedCredits = credits.filter(
    (row) =>
      row.businessId === businessId &&
      row.invoice.businessId === businessId &&
      row.invoice.customerId === customer.id,
  );
  const ownedTimeCards = timeCards.filter(
    (row) =>
      row.businessId === businessId &&
      row.job?.businessId === businessId &&
      row.job.customerId === customer.id,
  );

  for (const row of [
    ...ownedProperties,
    ...ownedRequests,
    ...ownedEstimates,
    ...ownedJobs,
    ...ownedInvoices,
    ...ownedPayments,
    ...ownedCredits,
    ...ownedTimeCards,
  ]) {
    access.assertOwned(row);
  }

  const propertyCollection = collection(
    ownedProperties.map((row) => ({
      id: row.id,
      customerId: customer.id,
      label: row.label,
      address: {
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2,
        city: row.city,
        region: row.region,
        postalCode: row.postalCode,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const requestCollection = collection(
    ownedRequests.map((row) => ({
      id: row.id,
      customerId: customer.id,
      propertyId: row.propertyId,
      status: row.status,
      summary: row.summary,
      description: row.description,
      leadSource: row.leadSource,
      serviceIntent: row.serviceIntent,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const estimateCollection = collection(
    ownedEstimates.map((row) => ({
      id: row.id,
      customerId: customer.id,
      propertyId: row.propertyId,
      serviceRequestId: row.serviceRequestId,
      status: row.status,
      total: money(row.total),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const jobCollection = collection(
    ownedJobs.map((row) => ({
      id: row.id,
      customerId: customer.id,
      propertyId: row.propertyId,
      estimateId: row.estimateId,
      status: row.status,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      serviceIntent: row.serviceIntent,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const invoiceCollection = collection(
    ownedInvoices.map((row) => ({
      id: row.id,
      customerId: customer.id,
      jobId: row.jobId,
      kind: row.kind,
      status: row.status,
      total: money(row.total),
      paidAt: row.paidAt?.toISOString() ?? null,
      paymentMethod: row.paymentMethod,
      paymentReference: row.paymentReference,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const paymentCollection = collection(
    ownedPayments.map((row) => ({
      id: row.id,
      customerId: customer.id,
      estimateId: row.estimateId,
      jobId: row.jobId,
      invoiceId: row.invoiceId,
      purpose: row.purpose,
      amount: money(row.amount),
      method: row.method,
      receivedAt: row.receivedAt.toISOString(),
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const creditCollection = collection(
    ownedCredits.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      invoiceId: row.invoiceId,
      amount: money(row.amount),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );
  const timeCardCollection = collection(
    ownedTimeCards.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      membershipId: row.membershipId,
      activityType: row.activityType,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      note: row.note,
      source: row.source,
      createdAt: row.createdAt.toISOString(),
    })),
    CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  );

  const includedRequestIds = requestCollection.items.map((row) => row.id);
  const includedJobIds = jobCollection.items.map((row) => row.id);
  const fileRefs = await loadFileReferences(prisma, access, {
    requestIds: includedRequestIds,
    jobIds: includedJobIds,
  });

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      smsConsentStatus: customer.smsConsentStatus,
      firstLeadSource: customer.firstLeadSource,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    },
    properties: propertyCollection,
    requests: requestCollection,
    estimates: estimateCollection,
    jobs: jobCollection,
    invoices: invoiceCollection,
    payments: paymentCollection,
    credits: creditCollection,
    timeCards: timeCardCollection,
    files: collection(fileRefs, CUSTOMER_RECORDS_EXPORT_FILE_LIMIT),
  };
}

async function loadFileReferences(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: { requestIds: string[]; jobIds: string[] },
): Promise<CustomerRecordsExportFileRef[]> {
  const businessId = access.businessId;
  const [requestPhotos, jobPhotos, projectDocuments] = await Promise.all([
    input.requestIds.length > 0
      ? prisma.serviceRequestPhoto.findMany({
          where: { businessId, serviceRequestId: { in: input.requestIds } },
          select: {
            id: true,
            businessId: true,
            serviceRequestId: true,
            storedAsset: {
              select: {
                id: true,
                businessId: true,
                originalFilename: true,
                mimeType: true,
                visibility: true,
                status: true,
              },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT + 1,
        })
      : Promise.resolve([]),
    input.jobIds.length > 0
      ? prisma.jobPhoto.findMany({
          where: { businessId, jobId: { in: input.jobIds } },
          select: {
            id: true,
            businessId: true,
            jobId: true,
            storedAsset: {
              select: {
                id: true,
                businessId: true,
                originalFilename: true,
                mimeType: true,
                visibility: true,
                status: true,
              },
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT + 1,
        })
      : Promise.resolve([]),
    input.jobIds.length > 0
      ? prisma.storedAsset.findMany({
          where: {
            businessId,
            jobId: { in: input.jobIds },
            category: "DOCUMENT",
            purpose: CUSTOMER_RECORDS_EXPORT_PROJECT_DOCUMENT_PURPOSE,
            visibility: "PRIVATE",
            status: "READY",
            deletedAt: null,
            publicPath: null,
          },
          select: {
            id: true,
            businessId: true,
            jobId: true,
            originalFilename: true,
            mimeType: true,
            visibility: true,
            status: true,
            purpose: true,
            category: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT + 1,
        })
      : Promise.resolve([]),
  ]);

  const refs: CustomerRecordsExportFileRef[] = [];
  for (const photo of requestPhotos) {
    if (photo.businessId !== businessId || !input.requestIds.includes(photo.serviceRequestId)) {
      continue;
    }
    access.assertOwned(photo);
    if (photo.storedAsset) {
      access.assertOwned(photo.storedAsset);
    }
    refs.push({
      id: photo.id,
      kind: "REQUEST_PHOTO",
      relatedRequestId: photo.serviceRequestId,
      relatedJobId: null,
      originalFilename: photo.storedAsset?.originalFilename ?? null,
      mimeType: photo.storedAsset?.mimeType ?? null,
      visibility: photo.storedAsset?.visibility ?? "PRIVATE",
      status: "REFERENCE",
      omission: PRIVATE_FILE_OMISSION,
    });
  }
  for (const photo of jobPhotos) {
    if (photo.businessId !== businessId || !input.jobIds.includes(photo.jobId)) {
      continue;
    }
    access.assertOwned(photo);
    if (photo.storedAsset) {
      access.assertOwned(photo.storedAsset);
    }
    refs.push({
      id: photo.id,
      kind: "JOB_PHOTO",
      relatedRequestId: null,
      relatedJobId: photo.jobId,
      originalFilename: photo.storedAsset?.originalFilename ?? null,
      mimeType: photo.storedAsset?.mimeType ?? null,
      visibility: photo.storedAsset?.visibility ?? "PRIVATE",
      status: "REFERENCE",
      omission: PRIVATE_FILE_OMISSION,
    });
  }
  for (const asset of projectDocuments) {
    if (
      asset.businessId !== businessId ||
      !asset.jobId ||
      !input.jobIds.includes(asset.jobId) ||
      asset.purpose !== CUSTOMER_RECORDS_EXPORT_PROJECT_DOCUMENT_PURPOSE ||
      asset.category !== "DOCUMENT" ||
      asset.visibility !== "PRIVATE" ||
      asset.status !== "READY"
    ) {
      continue;
    }
    access.assertOwned(asset);
    refs.push({
      id: asset.id,
      kind: "PROJECT_DOCUMENT",
      relatedRequestId: null,
      relatedJobId: asset.jobId,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      visibility: asset.visibility,
      status: "REFERENCE",
      omission: PRIVATE_FILE_OMISSION,
    });
  }
  return refs;
}
