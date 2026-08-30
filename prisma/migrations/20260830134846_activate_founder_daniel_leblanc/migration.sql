-- Data-only migration (same pattern as
-- 20260824233202_set_collpro_reno_canonical_slug): grants Founder Design
-- Mode (see src/lib/founder-access.ts) to the one real founder account,
-- "Daniel Leblanc" <collprosolutions@gmail.com>, the same way
-- scripts/set-founder-access.mjs would -- just delivered through the
-- deploy pipeline because this agent has no direct access to the
-- database backing the live Vercel preview/production deployment.
--
-- Idempotent and narrowly scoped: only ever flips isFounder from false
-- to true for a User whose email is exactly this address (case-
-- insensitive) OR whose name matches "Daniel Leblanc" (any casing).
-- Never touches any other User, never grants any tenant role, and does
-- not change how isFounder is checked anywhere in the app.
UPDATE "User"
SET "isFounder" = true
WHERE "isFounder" = false
  AND (
    lower(email) = 'collprosolutions@gmail.com'
    OR lower(name) = 'daniel leblanc'
  );
