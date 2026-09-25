-- Additive actor relations for owner-reviewed recurring patterns.
-- Production migrate is the source of truth. Preview does not run this
-- as request-time DDL. Existing confirmedBy/dismissedBy columns stay.

CREATE INDEX IF NOT EXISTS "RecurringExpensePattern_confirmedByMembershipId_idx"
  ON "RecurringExpensePattern"("confirmedByMembershipId");

CREATE INDEX IF NOT EXISTS "RecurringExpensePattern_dismissedByMembershipId_idx"
  ON "RecurringExpensePattern"("dismissedByMembershipId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RecurringExpensePattern_confirmedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "RecurringExpensePattern"
      ADD CONSTRAINT "RecurringExpensePattern_confirmedByMembershipId_fkey"
      FOREIGN KEY ("confirmedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RecurringExpensePattern_dismissedByMembershipId_fkey'
  ) THEN
    ALTER TABLE "RecurringExpensePattern"
      ADD CONSTRAINT "RecurringExpensePattern_dismissedByMembershipId_fkey"
      FOREIGN KEY ("dismissedByMembershipId") REFERENCES "Membership"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
