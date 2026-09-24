/**
 * Owner-intelligence schema lives only in committed Prisma migrations:
 * `prisma/migrations/20260924040000_add_owner_intelligence` and
 * `prisma/migrations/20260924053000_owner_intelligence_fks`.
 *
 * Preview shares Production and skips migrate. This module does not run
 * ALTER/CREATE/index/constraint SQL on authenticated requests, so a
 * Preview hit cannot mutate Production schema before
 * `prisma migrate deploy`.
 */
export const OWNER_INTELLIGENCE_SCHEMA_SOURCE = "prisma-migrate" as const;
