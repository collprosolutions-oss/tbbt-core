/**
 * Business Location schema lives only in the committed Prisma migration
 * `prisma/migrations/20260927180000_add_business_location`.
 *
 * This module does not run CREATE/ALTER/INDEX SQL on authenticated
 * request paths. Settings page loads and location mutations must not
 * mutate schema. Prisma migrate is authoritative.
 *
 * Preview shares Production and skips migrate. If the table is absent,
 * the directory shows an unavailable state instead of creating schema.
 */
export const BUSINESS_LOCATION_SCHEMA_SOURCE = "prisma-migrate" as const;
