/**
 * Materials / suppliers schema lives only in committed Prisma
 * migrations, including
 * `prisma/migrations/20260926011500_add_materials_suppliers_operations`
 * and `prisma/migrations/20261002181000_material_supplier_quotes`.
 *
 * This module does not run CREATE/ALTER/INDEX SQL on authenticated
 * request paths. Catalog, estimate, job, expense, pickup, PO
 * receipt, and supplier-quote reads must not mutate schema. Prisma
 * migrate is authoritative.
 */
export const MATERIALS_SUPPLIERS_SCHEMA_SOURCE = "prisma-migrate" as const;
