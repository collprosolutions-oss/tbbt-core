-- Durable business-scoped estimating defaults for registered workspaces.
-- Additive only. Project snapshots stay on estimate/version/invoice lines.

CREATE TABLE IF NOT EXISTS "BusinessEstimatingDefault" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessEstimatingDefault_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessEstimatingDefault_businessId_workspaceId_key"
  ON "BusinessEstimatingDefault"("businessId", "workspaceId");

CREATE INDEX IF NOT EXISTS "BusinessEstimatingDefault_businessId_idx"
  ON "BusinessEstimatingDefault"("businessId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'BusinessEstimatingDefault_businessId_fkey'
  ) THEN
    ALTER TABLE "BusinessEstimatingDefault"
      ADD CONSTRAINT "BusinessEstimatingDefault_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
