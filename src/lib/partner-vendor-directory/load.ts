/**
 * Tenant-scoped directory loader. Every query is keyed by the
 * authenticated workspace businessId. Linked Supplier / Referral details
 * are included only when those rows belong to the same business.
 *
 * Opportunity, supplier, and referral reads are capped. Kind / source /
 * review / text filters are applied in the query before the cap so a
 * matching row is not hidden behind newer non-matches.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { requirePartnerVendorDirectoryAccess } from "@/lib/partner-vendor-directory/access";
import {
  DIRECTORY_KIND_LABELS,
  DIRECTORY_LIMITS_MESSAGE,
  DIRECTORY_LINK_MESSAGE,
  DIRECTORY_OVERFLOW_MESSAGE,
  DIRECTORY_REVIEW_LABELS,
  DIRECTORY_SEARCH_MESSAGE,
  DIRECTORY_SOURCE_LABELS,
  type DirectoryKind,
  type DirectoryReviewStatus,
  type DirectorySource,
} from "@/lib/partner-vendor-directory/constants";
import {
  boundDirectoryRows,
  directoryLabelSearchKinds,
  directoryLabelSearchReviews,
  directoryLabelSearchSources,
  isDirectoryKind,
  isDirectoryReviewStatus,
  isDirectorySource,
  needsDirectoryReview,
  parseDirectoryKindFilter,
  parseDirectoryReviewFilter,
  parseDirectorySourceFilter,
  resolveDirectoryReadLimit,
} from "@/lib/partner-vendor-directory/search";
import type {
  DirectoryLinkableReferral,
  DirectoryLinkableSupplier,
  DirectoryOpportunityView,
  DirectoryQuery,
  DirectoryWorkspace,
} from "@/lib/partner-vendor-directory/types";

type OpportunityRow = {
  id: string;
  kind: string;
  name: string;
  summary: string;
  notes: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  category: string | null;
  locationDescription: string | null;
  source: string;
  reviewStatus: string;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastReviewedAt: Date | null;
  supplier: { id: string; businessId: string; name: string } | null;
  referral: {
    id: string;
    businessId: string;
    notes: string;
    sourceCustomer: { name: string };
  } | null;
};

const OPPORTUNITY_INCLUDE = {
  supplier: { select: { id: true, businessId: true, name: true } },
  referral: {
    select: {
      id: true,
      businessId: true,
      notes: true,
      sourceCustomer: { select: { name: true } },
    },
  },
} as const;

function asKind(value: string): DirectoryKind {
  return isDirectoryKind(value) ? value : "VENDOR";
}

function asSource(value: string): DirectorySource {
  return isDirectorySource(value) ? value : "MANUAL";
}

function asReview(value: string): DirectoryReviewStatus {
  return isDirectoryReviewStatus(value) ? value : "PENDING_REVIEW";
}

function toOpportunityView(row: OpportunityRow, businessId: string): DirectoryOpportunityView {
  const kind = asKind(row.kind);
  const source = asSource(row.source);
  const reviewStatus = asReview(row.reviewStatus);
  const sameBusinessSupplier =
    row.supplier && row.supplier.businessId === businessId ? row.supplier : null;
  const sameBusinessReferral =
    row.referral && row.referral.businessId === businessId ? row.referral : null;
  return {
    id: row.id,
    kind,
    kindLabel: DIRECTORY_KIND_LABELS[kind],
    name: row.name,
    summary: row.summary,
    notes: row.notes,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    website: row.website,
    category: row.category,
    locationDescription: row.locationDescription,
    source,
    sourceLabel: DIRECTORY_SOURCE_LABELS[source],
    reviewStatus,
    reviewLabel: DIRECTORY_REVIEW_LABELS[reviewStatus],
    needsReview: needsDirectoryReview(reviewStatus),
    supplierId: sameBusinessSupplier?.id ?? null,
    supplierName: sameBusinessSupplier?.name ?? null,
    referralId: sameBusinessReferral?.id ?? null,
    referralLabel: sameBusinessReferral
      ? `Referral from ${sameBusinessReferral.sourceCustomer.name}`
      : null,
    reviewNotes: row.reviewNotes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastReviewedAt: row.lastReviewedAt,
  };
}

function opportunitySearchWhere(
  businessId: string,
  needle: string,
): Prisma.PartnerVendorOpportunityWhereInput {
  const or: Prisma.PartnerVendorOpportunityWhereInput[] = [
    { name: { contains: needle, mode: "insensitive" } },
    { summary: { contains: needle, mode: "insensitive" } },
    { notes: { contains: needle, mode: "insensitive" } },
    { category: { contains: needle, mode: "insensitive" } },
    { contactName: { contains: needle, mode: "insensitive" } },
    {
      supplier: {
        is: { businessId, name: { contains: needle, mode: "insensitive" } },
      },
    },
    {
      referral: {
        is: { businessId, notes: { contains: needle, mode: "insensitive" } },
      },
    },
    {
      referral: {
        is: {
          businessId,
          sourceCustomer: {
            is: { businessId, name: { contains: needle, mode: "insensitive" } },
          },
        },
      },
    },
    ...directoryLabelSearchSources(needle).map((source) => ({ source })),
    ...directoryLabelSearchKinds(needle).map((kind) => ({ kind })),
    ...directoryLabelSearchReviews(needle).map((reviewStatus) => ({ reviewStatus })),
  ];
  return { OR: or };
}

function opportunityWhere(
  businessId: string,
  query: DirectoryQuery,
): Prisma.PartnerVendorOpportunityWhereInput {
  const where: Prisma.PartnerVendorOpportunityWhereInput = { businessId };
  if (query.kind !== "all") where.kind = query.kind;
  if (query.source !== "all") where.source = query.source;
  if (query.review !== "all") where.reviewStatus = query.review;
  if (query.q) {
    where.AND = [opportunitySearchWhere(businessId, query.q)];
  }
  return where;
}

export type LoadPartnerVendorDirectoryOptions = {
  limit?: number;
};

export async function loadPartnerVendorDirectory(
  prisma: PrismaClient,
  access: { businessId: string; workspace?: { role: "OWNER" | "ADMIN" | "MEMBER" } },
  rawQuery: {
    q?: string;
    kind?: string;
    source?: string;
    review?: string;
    selected?: string;
  },
  options?: LoadPartnerVendorDirectoryOptions,
): Promise<DirectoryWorkspace> {
  requirePartnerVendorDirectoryAccess(access);
  const businessId = access.businessId;
  const readLimit = resolveDirectoryReadLimit(options?.limit);
  const query: DirectoryQuery = {
    q: rawQuery.q?.trim() ?? "",
    kind: parseDirectoryKindFilter(rawQuery.kind),
    source: parseDirectorySourceFilter(rawQuery.source),
    review: parseDirectoryReviewFilter(rawQuery.review),
    selected: rawQuery.selected?.trim() ?? "",
  };
  const where = opportunityWhere(businessId, query);
  const take = readLimit + 1;

  const [rows, supplierRows, referralRows, selectedRow] = await Promise.all([
    prisma.partnerVendorOpportunity.findMany({
      where,
      include: OPPORTUNITY_INCLUDE,
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      take,
    }),
    prisma.supplier.findMany({
      where: { businessId },
      select: { id: true, name: true, active: true },
      orderBy: [{ preferred: "desc" }, { name: "asc" }],
      take,
    }),
    prisma.referral.findMany({
      where: { businessId },
      select: {
        id: true,
        notes: true,
        sourceCustomer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take,
    }),
    query.selected
      ? prisma.partnerVendorOpportunity.findFirst({
          where: { ...where, id: query.selected, businessId },
          include: OPPORTUNITY_INCLUDE,
        })
      : Promise.resolve(null),
  ]);

  const boundedOpportunities = boundDirectoryRows(rows, readLimit);
  const boundedSuppliers = boundDirectoryRows(supplierRows, readLimit);
  const boundedReferrals = boundDirectoryRows(referralRows, readLimit);

  const opportunities = boundedOpportunities.items.map((row) => toOpportunityView(row, businessId));
  const selectedFromList = opportunities.find((row) => row.id === query.selected) ?? null;
  const selected =
    selectedFromList ??
    (selectedRow ? toOpportunityView(selectedRow, businessId) : null) ??
    opportunities[0] ??
    null;

  const linkableSuppliers: DirectoryLinkableSupplier[] = boundedSuppliers.items.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
  }));
  const linkableReferrals: DirectoryLinkableReferral[] = boundedReferrals.items.map((row) => ({
    id: row.id,
    label: `Referral from ${row.sourceCustomer.name}`,
    notes: row.notes,
  }));

  return {
    query: {
      ...query,
      selected: selected?.id ?? "",
    },
    opportunities,
    selected,
    linkableSuppliers,
    linkableReferrals,
    readLimit,
    overflow: {
      opportunities: boundedOpportunities.overflow,
      suppliers: boundedSuppliers.overflow,
      referrals: boundedReferrals.overflow,
    },
    overflowMessage: DIRECTORY_OVERFLOW_MESSAGE,
    counts: {
      total: opportunities.length,
      pendingReview: opportunities.filter((row) => row.needsReview).length,
      partners: opportunities.filter((row) => row.kind === "PARTNER").length,
      vendors: opportunities.filter((row) => row.kind === "VENDOR").length,
    },
    limitsMessage: DIRECTORY_LIMITS_MESSAGE,
    searchMessage: DIRECTORY_SEARCH_MESSAGE,
    linkMessage: DIRECTORY_LINK_MESSAGE,
  };
}
