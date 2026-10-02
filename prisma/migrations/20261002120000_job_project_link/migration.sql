-- OWNER rotate/revoke of a Job's customer project link.
-- Additive only. Preview shares Production and skips migrate, so every
-- statement is IF NOT EXISTS. No Job column changes — concurrent
-- Job-column chats do not collide. Job.projectToken stays the live URL
-- key; this table records ACTIVE/REVOKED status and append-only history.
-- Application code must never send a customer message from these rows.
-- Timestamp is 20261002120000 so it sits after
-- 20261001200000_project_document_review.

CREATE TABLE IF NOT EXISTS "JobProjectLink" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "updatedByMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JobProjectLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobProjectLink_jobId_key"
  ON "JobProjectLink"("jobId");
CREATE INDEX IF NOT EXISTS "JobProjectLink_businessId_idx"
  ON "JobProjectLink"("businessId");
CREATE INDEX IF NOT EXISTS "JobProjectLink_businessId_status_idx"
  ON "JobProjectLink"("businessId", "status");

CREATE TABLE IF NOT EXISTS "JobProjectLinkEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "previousToken" TEXT NOT NULL,
    "nextToken" TEXT,
    "actorMembershipId" TEXT NOT NULL,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobProjectLinkEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JobProjectLinkEvent_previousToken_key"
  ON "JobProjectLinkEvent"("previousToken");
CREATE INDEX IF NOT EXISTS "JobProjectLinkEvent_businessId_idx"
  ON "JobProjectLinkEvent"("businessId");
CREATE INDEX IF NOT EXISTS "JobProjectLinkEvent_jobId_createdAt_idx"
  ON "JobProjectLinkEvent"("jobId", "createdAt");
CREATE INDEX IF NOT EXISTS "JobProjectLinkEvent_linkId_createdAt_idx"
  ON "JobProjectLinkEvent"("linkId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLink_businessId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLink"
      ADD CONSTRAINT "JobProjectLink_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLink_jobId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLink"
      ADD CONSTRAINT "JobProjectLink_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLink_updatedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLink"
      ADD CONSTRAINT "JobProjectLink_updatedByMembershipId_fkey"
      FOREIGN KEY ("updatedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLinkEvent_businessId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLinkEvent"
      ADD CONSTRAINT "JobProjectLinkEvent_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLinkEvent_jobId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLinkEvent"
      ADD CONSTRAINT "JobProjectLinkEvent_jobId_fkey"
      FOREIGN KEY ("jobId") REFERENCES "Job"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLinkEvent_linkId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLinkEvent"
      ADD CONSTRAINT "JobProjectLinkEvent_linkId_fkey"
      FOREIGN KEY ("linkId") REFERENCES "JobProjectLink"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JobProjectLinkEvent_actorMembershipId_fkey'
  ) THEN
    ALTER TABLE "JobProjectLinkEvent"
      ADD CONSTRAINT "JobProjectLinkEvent_actorMembershipId_fkey"
      FOREIGN KEY ("actorMembershipId") REFERENCES "Membership"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
