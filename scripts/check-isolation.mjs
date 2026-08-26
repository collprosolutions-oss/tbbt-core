/**
 * Proves business-owned records cannot be read across workspaces
 * when queries are scoped by businessId.
 *
 * Runs against a disposable sibling Postgres database (created by
 * `prisma db push` and dropped afterward) derived from the configured
 * DATABASE_URL, since the schema's datasource is Postgres-only.
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run the isolation check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_isolation_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for isolation test.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function businessScope(businessId) {
  return { businessId };
}

function belongsToBusiness(record, businessId) {
  return Boolean(record && record.businessId === businessId);
}

function assertBusinessRecord(record, businessId) {
  if (!record || record.businessId !== businessId) {
    throw new Error("Record is not in the authorized business workspace.");
  }
  return record;
}

const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman", tradeCode: "HANDYMAN" },
  });

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });

  const visibleToA = await prisma.customer.findMany({
    where: businessScope(businessA.id),
  });
  const leaked = visibleToA.some((customer) => customer.businessId !== businessA.id);

  if (leaked || visibleToA.length !== 1 || visibleToA[0].name !== "Alpha Customer") {
    throw new Error("Scoped customer query leaked another business's records.");
  }

  const foreignLookup = await prisma.customer.findFirst({
    where: { id: customerA.id, ...businessScope(businessB.id) },
  });

  if (foreignLookup) {
    throw new Error("Business B was able to load Business A's customer by id.");
  }

  if (belongsToBusiness(customerA, businessB.id)) {
    throw new Error("belongsToBusiness accepted a foreign record.");
  }

  let threw = false;
  try {
    assertBusinessRecord(customerA, businessB.id);
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error("assertBusinessRecord did not reject a foreign record.");
  }

  console.log("Isolation check passed: business-scoped queries do not cross workspaces.");
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}
