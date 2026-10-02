import { Prisma } from "@prisma/client";

/**
 * Bind a JS Date into TIMESTAMP without time zone as UTC wall time.
 *
 * Prisma DateTime columns are TIMESTAMP(3). A raw `${Date}` parameter is
 * interpreted in the Postgres session timezone, so a non-UTC session
 * stores a shifted wall clock. Casting the ISO instant through
 * timestamptz AT TIME ZONE 'UTC' keeps the stored value aligned with
 * Prisma Client reads regardless of SHOW timezone.
 */
export function utcTimestampSql(value: Date): Prisma.Sql {
  return Prisma.sql`(${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
