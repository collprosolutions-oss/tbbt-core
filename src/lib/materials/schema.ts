/**
 * Materials / suppliers schema lives only in the committed Prisma
 * migration `prisma/migrations/20260926011500_add_materials_suppliers_operations`.
 *
 * This module does not run CREATE/ALTER/INDEX SQL on authenticated
 * request paths. Catalog, estimate, job, expense, and pickup reads
 * must not mutate schema. Prisma migrate is authoritative.
 */
export const MATERIALS_SUPPLIERS_SCHEMA_SOURCE = "prisma-migrate" as const;
