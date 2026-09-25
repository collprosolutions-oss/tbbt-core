-- Additive unique claim so one logical AI company-setup attempt
-- cannot persist two proposal rows. Multiple NULL interactionIds stay allowed.

CREATE UNIQUE INDEX IF NOT EXISTS "CompanySetupProposal_businessId_interactionId_key"
ON "CompanySetupProposal" ("businessId", "interactionId");
