/**
 * Partner / vendor opportunity mutations. Tenant scope always comes from
 * BusinessAccess (authenticated workspace), never from a client-supplied
 * businessId. Linked Supplier and Referral rows must already belong to
 * the same business.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  directoryActorMembershipId,
  requirePartnerVendorDirectoryAccess,
} from "@/lib/partner-vendor-directory/access";
import {
  isDirectoryKind,
  isDirectoryReviewStatus,
  isDirectorySource,
} from "@/lib/partner-vendor-directory/search";
import type { DirectoryKind, DirectoryReviewStatus, DirectorySource } from "@/lib/partner-vendor-directory/constants";

type Db = PrismaClient | Prisma.TransactionClient;

export class PartnerVendorDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnerVendorDirectoryError";
  }
}

export function directoryErrorMessage(error: unknown, fallback: string) {
  if (error instanceof PartnerVendorDirectoryError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  return fallback;
}

function trimOrNull(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function trimOrEmpty(value: string | null | undefined) {
  return value?.trim() ?? "";
}

export type DirectoryOpportunityInput = {
  kind: string;
  name?: string;
  summary?: string;
  notes?: string;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  category?: string | null;
  locationDescription?: string | null;
  source: string;
  supplierId?: string | null;
  referralId?: string | null;
};

async function requireOwnedOpportunity(db: Db, access: BusinessAccess, opportunityId: string) {
  return access.assertOwned(
    await db.partnerVendorOpportunity.findFirst({
      where: { id: opportunityId, businessId: access.businessId },
    }),
  );
}

async function resolveOwnedSupplier(db: Db, access: BusinessAccess, supplierId: string) {
  return access.assertOwned(
    await db.supplier.findFirst({
      where: { id: supplierId, businessId: access.businessId },
      select: { id: true, businessId: true, name: true },
    }),
  );
}

async function resolveOwnedReferral(db: Db, access: BusinessAccess, referralId: string) {
  return access.assertOwned(
    await db.referral.findFirst({
      where: { id: referralId, businessId: access.businessId },
      select: {
        id: true,
        businessId: true,
        notes: true,
        sourceCustomer: { select: { name: true } },
      },
    }),
  );
}

async function resolveDirectoryLinks(
  db: Db,
  access: BusinessAccess,
  input: DirectoryOpportunityInput,
): Promise<{
  kind: DirectoryKind;
  source: DirectorySource;
  name: string;
  supplierId: string | null;
  referralId: string | null;
}> {
  if (!isDirectoryKind(input.kind)) {
    throw new PartnerVendorDirectoryError("Choose partner or vendor.");
  }
  if (!isDirectorySource(input.source)) {
    throw new PartnerVendorDirectoryError("Choose a recorded source for this opportunity.");
  }

  const requestedName = trimOrEmpty(input.name);
  let supplierId: string | null = null;
  let referralId: string | null = null;
  let name = requestedName;

  if (input.source === "MANUAL") {
    if (input.supplierId || input.referralId) {
      throw new PartnerVendorDirectoryError(
        "Owner-entered opportunities cannot link a supplier or referral. Choose the matching source first.",
      );
    }
    if (!name) throw new PartnerVendorDirectoryError("Enter a name for this opportunity.");
  }

  if (input.source === "SUPPLIER") {
    const supplierKey = trimOrEmpty(input.supplierId);
    if (!supplierKey) {
      throw new PartnerVendorDirectoryError("Link a supplier from this business.");
    }
    if (input.referralId) {
      throw new PartnerVendorDirectoryError("A supplier-sourced opportunity cannot also link a referral.");
    }
    const supplier = await resolveOwnedSupplier(db, access, supplierKey);
    supplierId = supplier.id;
    if (!name) name = supplier.name;
  }

  if (input.source === "REFERRAL") {
    const referralKey = trimOrEmpty(input.referralId);
    if (!referralKey) {
      throw new PartnerVendorDirectoryError("Link a referral from this business.");
    }
    if (input.supplierId) {
      throw new PartnerVendorDirectoryError("A referral-sourced opportunity cannot also link a supplier.");
    }
    const referral = await resolveOwnedReferral(db, access, referralKey);
    referralId = referral.id;
    if (!name) {
      const customerName = referral.sourceCustomer.name.trim() || "recorded customer";
      name = `Referral from ${customerName}`;
    }
  }

  if (!name) throw new PartnerVendorDirectoryError("Enter a name for this opportunity.");

  return {
    kind: input.kind,
    source: input.source,
    name,
    supplierId,
    referralId,
  };
}

function contactFields(input: DirectoryOpportunityInput) {
  return {
    summary: trimOrEmpty(input.summary),
    notes: trimOrEmpty(input.notes),
    contactName: trimOrNull(input.contactName),
    contactEmail: trimOrNull(input.contactEmail),
    contactPhone: trimOrNull(input.contactPhone),
    website: trimOrNull(input.website),
    category: trimOrNull(input.category),
    locationDescription: trimOrNull(input.locationDescription),
  };
}

export async function createPartnerVendorOpportunity(
  db: Db,
  access: BusinessAccess,
  input: DirectoryOpportunityInput,
) {
  requirePartnerVendorDirectoryAccess(access);
  const links = await resolveDirectoryLinks(db, access, input);
  return db.partnerVendorOpportunity.create({
    data: {
      businessId: access.businessId,
      kind: links.kind,
      name: links.name,
      source: links.source,
      supplierId: links.supplierId,
      referralId: links.referralId,
      reviewStatus: "PENDING_REVIEW",
      createdByMembershipId: directoryActorMembershipId(access),
      ...contactFields(input),
    },
  });
}

export async function updatePartnerVendorOpportunity(
  db: Db,
  access: BusinessAccess,
  input: DirectoryOpportunityInput & { opportunityId: string },
) {
  requirePartnerVendorDirectoryAccess(access);
  const existing = await requireOwnedOpportunity(db, access, input.opportunityId);
  const links = await resolveDirectoryLinks(db, access, input);
  return db.partnerVendorOpportunity.update({
    where: { id: existing.id },
    data: {
      kind: links.kind,
      name: links.name,
      source: links.source,
      supplierId: links.supplierId,
      referralId: links.referralId,
      ...contactFields(input),
    },
  });
}

export async function reviewPartnerVendorOpportunity(
  db: Db,
  access: BusinessAccess,
  input: { opportunityId: string; reviewStatus: string; reviewNotes?: string | null },
) {
  requirePartnerVendorDirectoryAccess(access);
  if (!isDirectoryReviewStatus(input.reviewStatus)) {
    throw new PartnerVendorDirectoryError("Choose a review status.");
  }
  const existing = await requireOwnedOpportunity(db, access, input.opportunityId);
  return db.partnerVendorOpportunity.update({
    where: { id: existing.id },
    data: {
      reviewStatus: input.reviewStatus as DirectoryReviewStatus,
      reviewNotes: trimOrNull(input.reviewNotes),
      lastReviewedAt: new Date(),
      lastReviewedByMembershipId: directoryActorMembershipId(access),
    },
  });
}
