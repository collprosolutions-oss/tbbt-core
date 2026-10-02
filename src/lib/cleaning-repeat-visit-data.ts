/**
 * Public read model for an existing Cleaning customer requesting another visit.
 * Token lookup only. Mutation-free. Never returns private job notes, costs,
 * other jobs, payment metadata, or owner-only fields.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { catalogItemIsPubliclyOffered } from "@/lib/public-request-trade";
import {
  cleaningRepeatVisitEligible,
  resolveCleaningRepeatVisitTradeCode,
} from "@/lib/cleaning-repeat-visit";
import { findLiveJobByProjectToken } from "@/lib/project-link-data";
import { emptySelectedWork, type SelectedWorkState } from "@/lib/selected-work";

type Db = PrismaClient | Prisma.TransactionClient;

export type CleaningRepeatVisitContact = {
  name: string;
  email: string;
  phone: string;
  streetAddress: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
};

export type CleaningRepeatVisitPublicView =
  | {
      status: "unavailable";
    }
  | {
      status: "ready";
      slug: string;
      businessName: string;
      businessId: string;
      customerId: string;
      alreadyRequested: boolean;
      contact: CleaningRepeatVisitContact;
      initialSelected: SelectedWorkState;
    };

const SOURCE_JOB_SELECT = {
  id: true,
  businessId: true,
  customerId: true,
  propertyId: true,
  business: { select: { id: true, name: true, slug: true, tradeCode: true } },
  customer: {
    select: { id: true, businessId: true, name: true, email: true, phone: true },
  },
  property: {
    select: {
      id: true,
      businessId: true,
      customerId: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
  estimate: {
    select: {
      id: true,
      businessId: true,
      serviceRequest: { select: { tradeCode: true } },
      lineItems: {
        select: {
          serviceCatalogItemId: true,
          serviceCatalogItem: { select: { id: true, tradeCode: true, active: true } },
        },
      },
    },
  },
} as const;

type SourceJob = Prisma.JobGetPayload<{ select: typeof SOURCE_JOB_SELECT }>;

function sameBusinessCustomer(job: SourceJob) {
  if (
    job.customer &&
    job.customer.businessId === job.businessId &&
    job.customerId === job.customer.id
  ) {
    return job.customer;
  }
  return null;
}

function sameBusinessProperty(job: SourceJob, customerId: string) {
  if (
    job.property &&
    job.property.businessId === job.businessId &&
    job.property.customerId === customerId &&
    job.propertyId === job.property.id
  ) {
    return job.property;
  }
  return null;
}

export function resolveCleaningRepeatVisitJob(job: {
  estimate?: {
    serviceRequest?: { tradeCode?: string | null } | null;
    lineItems?: Array<{
      serviceCatalogItem?: { tradeCode?: string | null } | null;
    }>;
  } | null;
}) {
  return resolveCleaningRepeatVisitTradeCode({
    requestTradeCode: job.estimate?.serviceRequest?.tradeCode,
    catalogTradeCodes: (job.estimate?.lineItems ?? []).map(
      (line) => line.serviceCatalogItem?.tradeCode,
    ),
  });
}

function publicSelectedWork(job: SourceJob, activeTradeCodes: string[]): SelectedWorkState {
  const catalogIds = [
    ...new Set(
      (job.estimate?.businessId === job.businessId ? job.estimate.lineItems : []).flatMap(
        (line) => {
          const item = line.serviceCatalogItem;
          if (!item?.id || item.id !== line.serviceCatalogItemId) return [];
          if (!catalogItemIsPubliclyOffered(item, activeTradeCodes)) return [];
          if (item.tradeCode && item.tradeCode !== "CLEANING") return [];
          return [item.id];
        },
      ),
    ),
  ];
  if (catalogIds.length > 0) {
    return {
      ...emptySelectedWork(),
      catalogIds,
      quantities: Object.fromEntries(catalogIds.map((id) => [id, 1])),
    };
  }
  return {
    ...emptySelectedWork(),
    includeOther: true,
    otherDescription: "Another cleaning visit",
  };
}

export async function loadCleaningRepeatVisitPublicView(
  db: Db,
  token: string,
): Promise<CleaningRepeatVisitPublicView> {
  const projectToken = token.trim();
  if (!projectToken) return { status: "unavailable" };

  const job = await findLiveJobByProjectToken(db, projectToken, SOURCE_JOB_SELECT);
  if (!job || job.business.id !== job.businessId) return { status: "unavailable" };

  const tradeCode = resolveCleaningRepeatVisitJob(job);
  if (!cleaningRepeatVisitEligible(tradeCode)) return { status: "unavailable" };

  const customer = sameBusinessCustomer(job);
  if (!customer) return { status: "unavailable" };

  const property = sameBusinessProperty(job, customer.id);
  const existing = await db.serviceRequest.findFirst({
    where: { businessId: job.businessId, repeatVisitSourceJobId: job.id },
    select: { id: true },
  });

  return {
    status: "ready",
    slug: job.business.slug,
    businessName: job.business.name,
    businessId: job.businessId,
    customerId: customer.id,
    alreadyRequested: Boolean(existing),
    contact: {
      name: customer.name,
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      streetAddress: property?.addressLine1 ?? "",
      unit: property?.addressLine2 ?? "",
      city: property?.city ?? "",
      region: property?.region ?? "",
      postalCode: property?.postalCode ?? "",
    },
    initialSelected: publicSelectedWork(job, ["CLEANING"]),
  };
}
