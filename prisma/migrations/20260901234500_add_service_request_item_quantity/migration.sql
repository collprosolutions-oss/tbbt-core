-- Customer-selected quantity on each requested task.
-- Existing ServiceRequestItem rows default to 1.

ALTER TABLE "ServiceRequestItem" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
