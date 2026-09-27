-- Private owner-managed partner / vendor opportunity directory.
-- Additive only. Prisma migrate is the authoritative schema source.
-- Application request paths must not run CREATE/ALTER/INDEX DDL.
-- Tenant-scoped notes only. Not a marketplace, live inventory,
-- affiliate payout ledger, or BSOS Network membership store.

CREATE TABLE IF NOT EXISTS "PartnerVendorOpportunity" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "website" TEXT,
    "category" TEXT,
    "locationDescription" TEXT,
    "source" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "supplierId" TEXT,
    "referralId" TEXT,
    "createdByMembershipId" TEXT NOT NULL,
    "lastReviewedAt" TIMESTAMP(3),
    "lastReviewedByMembershipId" TEXT,
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerVendorOpportunity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PartnerVendorOpportunity_businessId_idx"
  ON "PartnerVendorOpportunity"("businessId");

CREATE INDEX IF NOT EXISTS "PartnerVendorOpportunity_businessId_kind_idx"
  ON "PartnerVendorOpportunity"("businessId", "kind");

CREATE INDEX IF NOT EXISTS "PartnerVendorOpportunity_businessId_reviewStatus_idx"
  ON "PartnerVendorOpportunity"("businessId", "reviewStatus");

CREATE INDEX IF NOT EXISTS "PartnerVendorOpportunity_businessId_source_idx"
  ON "PartnerVendorOpportunity"("businessId", "source");

CREATE INDEX IF NOT EXISTS "PartnerVendorOpportunity_supplierId_idx"
  ON "PartnerVendorOpportunity"("supplierId");

CREATE INDEX IF NOT EXISTS "PartnerVendorOpportunity_referralId_idx"
  ON "PartnerVendorOpportunity"("referralId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PartnerVendorOpportunity_businessId_fkey'
  ) THEN
    ALTER TABLE "PartnerVendorOpportunity"
      ADD CONSTRAINT "PartnerVendorOpportunity_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PartnerVendorOpportunity_supplierId_fkey'
  ) THEN
    ALTER TABLE "PartnerVendorOpportunity"
      ADD CONSTRAINT "PartnerVendorOpportunity_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PartnerVendorOpportunity_referralId_fkey'
  ) THEN
    ALTER TABLE "PartnerVendorOpportunity"
      ADD CONSTRAINT "PartnerVendorOpportunity_referralId_fkey"
      FOREIGN KEY ("referralId") REFERENCES "Referral"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PartnerVendorOpportunity_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "PartnerVendorOpportunity"
      ADD CONSTRAINT "PartnerVendorOpportunity_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PartnerVendorOpportunity_lastReviewedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "PartnerVendorOpportunity"
      ADD CONSTRAINT "PartnerVendorOpportunity_lastReviewedByMembershipId_fkey"
      FOREIGN KEY ("lastReviewedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
