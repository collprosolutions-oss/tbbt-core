/**
 * Communications Department schema is migrate-only.
 *
 * Authoritative change:
 *   prisma/migrations/20260926020000_communications_department/migration.sql
 * Additive PhoneInteraction FKs:
 *   prisma/migrations/20260926030000_phone_interaction_relations/migration.sql
 *
 * Do not add request-time ALTER/CREATE/DROP for these tables. Preview/production
 * apply the committed Prisma migration. Legacy customer-messaging still has its
 * own older ensure path; this department does not expand that pattern.
 */
export const COMMUNICATIONS_DEPARTMENT_SCHEMA_SOURCE = "prisma-migrate" as const;

export const COMMUNICATIONS_DEPARTMENT_MIGRATIONS = [
  "20260926020000_communications_department",
  "20260926030000_phone_interaction_relations",
] as const;
