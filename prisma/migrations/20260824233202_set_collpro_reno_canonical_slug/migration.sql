UPDATE "Business"
SET
  slug = 'collpro-reno',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE slug = 'collpro-reno-handyman-services'
  AND NOT EXISTS (
    SELECT 1
    FROM "Business" AS other
    WHERE other.slug = 'collpro-reno'
  );
