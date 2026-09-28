-- Named OWNER reusable draft estimate line sets.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No backfill. Existing businesses keep zero rows.
-- Stores draft line snapshots only — never catalog prices, hourly public
-- rates, SENT/APPROVED estimate mutations, invoices, or jobs.

CREATE TABLE IF NOT EXISTS "EstimateLineTemplate" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EstimateLineTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EstimateLineTemplateLine" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "type" "LineItemType" NOT NULL DEFAULT 'LABOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EstimateLineTemplateLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EstimateLineTemplate_businessId_name_key"
  ON "EstimateLineTemplate"("businessId", "name");
CREATE INDEX IF NOT EXISTS "EstimateLineTemplate_businessId_updatedAt_idx"
  ON "EstimateLineTemplate"("businessId", "updatedAt");
CREATE INDEX IF NOT EXISTS "EstimateLineTemplateLine_businessId_idx"
  ON "EstimateLineTemplateLine"("businessId");
CREATE INDEX IF NOT EXISTS "EstimateLineTemplateLine_templateId_sortOrder_idx"
  ON "EstimateLineTemplateLine"("templateId", "sortOrder");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateLineTemplate_businessId_fkey'
  ) THEN
    ALTER TABLE "EstimateLineTemplate"
      ADD CONSTRAINT "EstimateLineTemplate_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateLineTemplate_createdByMembershipId_fkey'
  ) THEN
    ALTER TABLE "EstimateLineTemplate"
      ADD CONSTRAINT "EstimateLineTemplate_createdByMembershipId_fkey"
      FOREIGN KEY ("createdByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateLineTemplateLine_businessId_fkey'
  ) THEN
    ALTER TABLE "EstimateLineTemplateLine"
      ADD CONSTRAINT "EstimateLineTemplateLine_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EstimateLineTemplateLine_templateId_fkey'
  ) THEN
    ALTER TABLE "EstimateLineTemplateLine"
      ADD CONSTRAINT "EstimateLineTemplateLine_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "EstimateLineTemplate"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
