/**
 * Tenant-scoped directory loader. Every query is keyed by the
 * authenticated workspace businessId. Linked Supplier / Referral details
 * are included only when those rows belong to the same business.
 */

import type { PrismaClient } from "@prisma/client";
import { requirePartnerVendorDirectoryAccess } from "@/lib/partner-vendor-directory/access";
import {
  DIRECTORY_KIND_LABELS,
  DIRECTORY_LIMITS_MESSAGE,
  DIRECTORY_LINK_MESSAGE,
  DIRECTORY_REVIEW_LABELS,
  DIRECTORY_SEARCH_MESSAGE,
  DIRECTORY_SOURCE_LABELS,
  type DirectoryKind,
  type DirectoryReviewStatus,
  type DirectorySource,
} from "@/lib/partner-vendor-directory/constants";
import {
  isDirectoryKind,
  isDirectoryReviewStatus,
  isDirectorySource,
  matchesDirectorySearch,
  needsDirectoryReview,
  parseDirectoryKindFilter,
  parseDirectoryReviewFilter,
  parseDirectorySourceFilter,
} from "@/lib/partner-vendor-directory/search";
import type {
  DirectoryLinkableReferral,
  DirectoryLinkableSupplier,
  DirectoryOpportunityView,
  DirectoryWorkspace,
} from "@/lib/partner-vendor-directory/types";

function asKind(value: string): DirectoryKind {
  return isDirectoryKind(value) ? value : "VENDOR";
}

function asSource(value: string): DirectorySource {
  return isDirectorySource(value) ? value : "MANUAL";
}

function asReview(value: string): DirectoryReviewStatus {
  return isDirectoryReviewStatus(value) ? value : "PENDING_REVIEW";
}

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
): Promise<DirectoryWorkspace> {
  requirePartnerVendorDirectoryAccess(access);
  const businessId = access.businessId;
  const query = {
    q: rawQuery.q?.trim() ?? "",
    kind: parseDirectoryKindFilter(rawQuery.kind),
    source: parseDirectorySourceFilter(rawQuery.source),
    review: parseDirectoryReviewFilter(rawQuery.review),
    selected: rawQuery.selected?.trim() ?? "",
  };

  const [rows, suppliers, referrals] = await Promise.all([
    prisma.partnerVendorOpportunity.findMany({
      where: { businessId },
      include: {
        supplier: { select: { id: true, businessId: true, name: true } },
        referral: {
          select: {
            id: true,
            businessId: true,
            notes: true,
            sourceCustomer: { select: { name: true } },
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    }),
    prisma.supplier.findMany({
      where: { businessId },
      select: { id: true, name: true, active: true },
      orderBy: [{ preferred: "desc" }, { name: "asc" }],
    }),
    prisma.referral.findMany({
      where: { businessId },
      select: {
        id: true,
        notes: true,
        sourceCustomer: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const opportunities: DirectoryOpportunityView[] = rows
    .map((row) => {
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
    })
    .filter((row) => (query.kind === "all" ? true : row.kind === query.kind))
    .filter((row) => (query.source === "all" ? true : row.source === query.source))
    .filter((row) => (query.review === "all" ? true : row.reviewStatus === query.review))
    .filter((row) =>
      matchesDirectorySearch(
        [
          row.name,
          row.summary,
          row.notes,
          row.category,
          row.contactName,
          row.supplierName,
          row.referralLabel,
          row.sourceLabel,
        ],
        query.q,
      ),
    );

  const selected =
    opportunities.find((row) => row.id === query.selected) ?? opportunities[0] ?? null;

  const linkableSuppliers: DirectoryLinkableSupplier[] = suppliers.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
  }));
  const linkableReferrals: DirectoryLinkableReferral[] = referrals.map((row) => ({
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
