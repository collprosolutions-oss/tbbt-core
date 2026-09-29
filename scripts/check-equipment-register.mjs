/**
 * OWNER equipment register: tools and vehicles after inspecting Materials
 * and Expense models. Authorization, tenant isolation, bounded lists,
 * date handling, and duplicate-submit on a dedicated test database.
 *
 * Run with:
 *   npm run test:equipment-register
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { CAPABILITIES, ForbiddenError, roleHasCapability } = await import("@/lib/authorization");
const { APP_NAV, visibleAppNav } = await import("@/lib/nav");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  EQUIPMENT_DUE_MESSAGE,
  EQUIPMENT_FIELD_SCOPED_MESSAGE,
  EQUIPMENT_KIND_LABELS,
  EQUIPMENT_KINDS,
  EQUIPMENT_LIMITS_MESSAGE,
  EQUIPMENT_MAINTENANCE_READ_LIMIT,
  EQUIPMENT_MIGRATION_NAME,
  EQUIPMENT_OVERFLOW_MESSAGE,
  EQUIPMENT_OWNER_ONLY_MESSAGE,
  EQUIPMENT_PURCHASE_CATEGORIES,
  EQUIPMENT_PURCHASE_CHOICE_LIMIT,
  EQUIPMENT_PURCHASE_MESSAGE,
  EQUIPMENT_READ_LIMIT,
  EQUIPMENT_ROUTE,
  EQUIPMENT_SCHEMA_SOURCE,
  EQUIPMENT_UNAVAILABLE_MESSAGE,
  EquipmentError,
  canReadEquipmentRegister,
  canWriteEquipmentRegister,
  equipmentIsDue,
  loadEquipmentRegister,
  parseEquipmentDate,
  equipmentRegisterTestHooks,
  recordEquipmentItem,
  recordEquipmentMaintenance,
  requireEquipmentRead,
  requireEquipmentWrite,
} = await import("@/lib/equipment");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

let parsedBase;
try {
  parsedBase = new URL(baseUrl);
} catch {
  console.error("DATABASE_URL must be a valid URL.");
  process.exit(1);
}

const dbHost = parsedBase.hostname;
if (dbHost !== "localhost" && dbHost !== "127.0.0.1") {
  console.error(
    `Refusing to run: DATABASE_URL host must be localhost or 127.0.0.1, got ${dbHost}.`,
  );
  process.exit(1);
}

const testDbName = "tbbt_equipment_register_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const clients = [];
function trackClient(client) {
  clients.push(client);
  return client;
}

let exitCode = 0;
let prisma;

function createTwoRacerBarrier() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrivedCount = 0;
  let allArrived;
  const waiting = new Promise((resolve) => {
    allArrived = resolve;
  });
  return {
    wait: async () => {
      arrivedCount += 1;
      if (arrivedCount >= 2) allArrived();
      await held;
    },
    arrived: waiting,
    release: () => release(),
  };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function disconnectClients() {
  while (clients.length) {
    const client = clients.pop();
    try {
      await client.$disconnect();
    } catch {
      // Drop still runs.
    }
  }
}

function dropTestDatabase() {
  const drop = spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`],
    { encoding: "utf8" },
  );
  if (drop.status !== 0) {
    console.error(drop.stderr || drop.stdout);
    if (exitCode === 0) exitCode = drop.status ?? 1;
  }
}

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, timezone = "America/New_York") {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, timezone },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function readRepo(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");
}

const schema = readRepo("prisma/schema.prisma");
const migration = readRepo("prisma/migrations/20260929010800_owner_equipment_register/migration.sql");
const opsSource = readRepo("src/lib/equipment/ops.ts");
const loadSource = readRepo("src/lib/equipment/load.ts");
const datesSource = readRepo("src/lib/equipment/dates.ts");
const constantsSource = readRepo("src/lib/equipment/constants.ts");
const actionsSource = readRepo("src/app/actions/equipment.ts");
const pageSource = readRepo("src/app/(app)/equipment/page.tsx");
const fieldAccessSource = readRepo("src/lib/field-access.ts");
const fieldJobsSource = readRepo("src/lib/field-jobs.ts");
const materialsOps = readRepo("src/lib/materials/access.ts");
const expenseOps = readRepo("src/lib/expense-ops.ts");

async function main() {
try {
  const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
    encoding: "utf8",
  });
  if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
    console.error(createDb.stderr || createDb.stdout);
    exitCode = createDb.status ?? 1;
    return;
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    console.error("Failed to push schema for equipment-register test database.");
    exitCode = push.status ?? 1;
    return;
  }

  prisma = trackClient(new PrismaClient({ datasourceUrl: testUrl }));

  console.log("\nSTATIC — Inspected Materials and Expenses; honest register limits");
  check("Route is /equipment", EQUIPMENT_ROUTE === "/equipment");
  check("Migration name is exact", EQUIPMENT_MIGRATION_NAME === "20260929010800_owner_equipment_register");
  check("Schema is migrate-only", EQUIPMENT_SCHEMA_SOURCE === "prisma-migrate");
  check(
    "Kinds are trade-neutral Tool and Vehicle only",
    EQUIPMENT_KINDS.join(",") === "TOOL,VEHICLE" &&
      EQUIPMENT_KIND_LABELS.TOOL === "Tool" &&
      EQUIPMENT_KIND_LABELS.VEHICLE === "Vehicle" &&
      !constantsSource.includes("HANDYMAN") &&
      !constantsSource.includes("PRESSURE"),
  );
  check(
    "Purchase categories reuse Expense TOOLS_EQUIPMENT and VEHICLE",
    EQUIPMENT_PURCHASE_CATEGORIES.TOOL === "TOOLS_EQUIPMENT" &&
      EQUIPMENT_PURCHASE_CATEGORIES.VEHICLE === "VEHICLE",
  );
  check(
    "Read limits are exact",
    EQUIPMENT_READ_LIMIT === 50 &&
      EQUIPMENT_MAINTENANCE_READ_LIMIT === 20 &&
      EQUIPMENT_PURCHASE_CHOICE_LIMIT === 50,
  );
  check(
    "Honesty copy denies telemetry, depreciation, tax, inventory, and reminders",
    /not inventory stock/.test(EQUIPMENT_LIMITS_MESSAGE) &&
      /not telemetry/.test(EQUIPMENT_LIMITS_MESSAGE) &&
      /not depreciation/.test(EQUIPMENT_LIMITS_MESSAGE) &&
      /not tax treatment/.test(EQUIPMENT_LIMITS_MESSAGE) &&
      /not an automated reminder/.test(EQUIPMENT_LIMITS_MESSAGE) &&
      /service date the owner recorded/.test(EQUIPMENT_DUE_MESSAGE) &&
      /does not invent the next service/.test(EQUIPMENT_DUE_MESSAGE) &&
      !/sends a reminder|calculates depreciation|tracks telemetry|counts inventory stock/i.test(
        pageSource + actionsSource + loadSource,
      ),
  );
  check(
    "Owner / field copy is present",
    /Only the owner/.test(EQUIPMENT_OWNER_ONLY_MESSAGE) &&
      /assigned jobs/.test(EQUIPMENT_FIELD_SCOPED_MESSAGE) &&
      /does not create the table/.test(EQUIPMENT_UNAVAILABLE_MESSAGE) &&
      /Materials catalog/.test(EQUIPMENT_PURCHASE_MESSAGE),
  );
  check(
    "Migration is additive and isolated",
    !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migration) &&
      migration.includes('CREATE TABLE IF NOT EXISTS "EquipmentItem"') &&
      migration.includes('CREATE TABLE IF NOT EXISTS "EquipmentMaintenanceEntry"') &&
      migration.includes("purchaseExpenseId") &&
      migration.includes("attemptKey") &&
      !/ALTER TABLE "MaterialCatalogItem"/i.test(migration) &&
      !/UPDATE\s+"Expense"/i.test(migration) &&
      !/UPDATE\s+"Business"/i.test(migration),
  );
  check(
    "Schema records item, optional purchase, service date, and maintenance",
    /model EquipmentItem/.test(schema) &&
      /model EquipmentMaintenanceEntry/.test(schema) &&
      schema.includes("purchaseExpenseId") &&
      schema.includes("serviceOn") &&
      schema.includes("attemptKey") &&
      !schema.includes("odometer") &&
      !schema.includes("hoursMeter") &&
      !schema.includes("depreciationAmount"),
  );
  check(
    "Writes never invent due dates from maintenance or telemetry",
    datesSource.includes("never due") &&
      !opsSource.includes("addMonths") &&
      !opsSource.includes("addDays") &&
      !loadSource.includes("odometer") &&
      !actionsSource.includes('readString(formData, "businessId")'),
  );
  check(
    "Page uses management + equipment read gates",
    pageSource.includes("requireManagementPageAccess()") &&
      pageSource.includes("requireEquipmentRead(access)") &&
      pageSource.includes("loadEquipmentRegister"),
  );
  check(
    "MEMBER field permissions stay assigned-job scoped",
    fieldAccessSource.includes("assignedJobWhere") &&
      !fieldAccessSource.includes("Equipment") &&
      !fieldJobsSource.includes("Equipment") &&
      !materialsOps.includes("EquipmentItem") &&
      expenseOps.includes("MANAGE_EXPENSES"),
  );
  check(
    "Nav is OWNER/ADMIN-only via MANAGE_EQUIPMENT",
    APP_NAV.some((item) => item.href === "/equipment" && item.capability === CAPABILITIES.MANAGE_EQUIPMENT) &&
      visibleAppNav("OWNER").some((item) => item.href === "/equipment") &&
      visibleAppNav("ADMIN").some((item) => item.href === "/equipment") &&
      !visibleAppNav("MEMBER").some((item) => item.href === "/equipment"),
  );
  check(
    "Read/write helpers: ADMIN reads, OWNER writes, MEMBER neither",
    canReadEquipmentRegister("OWNER") &&
      canReadEquipmentRegister("ADMIN") &&
      !canReadEquipmentRegister("MEMBER") &&
      canWriteEquipmentRegister("OWNER") &&
      !canWriteEquipmentRegister("ADMIN") &&
      !canWriteEquipmentRegister("MEMBER") &&
      roleHasCapability("ADMIN", CAPABILITIES.MANAGE_EQUIPMENT) &&
      !roleHasCapability("MEMBER", CAPABILITIES.MANAGE_EQUIPMENT),
  );

  const nyNow = new Date("2026-09-29T16:00:00.000Z");
  check(
    "Service date today is due; tomorrow is not; missing is not",
    equipmentIsDue(parseEquipmentDate("2026-09-29", "America/New_York"), nyNow, "America/New_York") ===
      true &&
      equipmentIsDue(parseEquipmentDate("2026-09-30", "America/New_York"), nyNow, "America/New_York") ===
        false &&
      equipmentIsDue(null, nyNow, "America/New_York") === false,
  );
  check(
    "Pacific morning is still the previous New York calendar date",
    parseEquipmentDate("2026-09-28", "America/Los_Angeles")?.toISOString() !==
      parseEquipmentDate("2026-09-28", "America/New_York")?.toISOString(),
  );
  check("Invalid date is rejected", parseEquipmentDate("2026-02-30", "America/New_York") === null);
  check("Overflow copy is capped, not silent", /capped/.test(EQUIPMENT_OVERFLOW_MESSAGE));

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-eq-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-eq-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-eq-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwnerUser = await prisma.user.create({
    data: { name: "Beta Owner", email: `beta-eq-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const cleanOwnerUser = await prisma.user.create({
    data: { name: "Cora Clean", email: `clean-eq-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Equipment",
      slug: `alpha-eq-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Equipment",
      slug: `beta-eq-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const cleanBusiness = await prisma.business.create({
    data: {
      name: "Clean Equipment",
      slug: `clean-eq-${randomUUID().slice(0, 8)}`,
      tradeCode: "CLEANING",
      timezone: "America/Los_Angeles",
    },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaOwnerMem = await prisma.membership.create({
    data: { userId: betaOwnerUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const cleanOwnerMem = await prisma.membership.create({
    data: { userId: cleanOwnerUser.id, businessId: cleanBusiness.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaOwnerMem.id);
  const ownerClean = makeAccess(cleanBusiness.id, "OWNER", cleanOwnerMem.id, "America/Los_Angeles");

  console.log("\nLIVE — Authorization and field permissions");
  check(
    "Field access still scopes by assignedMembershipId, not equipment",
    /assignedMembershipId:\s*field\.membershipId/.test(fieldAccessSource) &&
      /businessId:\s*field\.businessId/.test(fieldAccessSource) &&
      !fieldAccessSource.includes("equipment"),
  );
  await expectError(
    "MEMBER cannot read the register",
    () => loadEquipmentRegister(prisma, memberA),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record an item",
    () =>
      recordEquipmentItem(prisma, memberA, {
        kind: "TOOL",
        name: "Field drill",
        attemptKey: `mem-item-${randomUUID()}`,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "ADMIN cannot record an item",
    () =>
      recordEquipmentItem(prisma, adminA, {
        kind: "TOOL",
        name: "Admin drill",
        attemptKey: `adm-item-${randomUUID()}`,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError("MEMBER requireEquipmentRead throws", () => {
    requireEquipmentRead(memberA);
  }, (error) => error instanceof ForbiddenError);
  await expectError("ADMIN requireEquipmentWrite throws", () => {
    requireEquipmentWrite(adminA);
  }, (error) => error instanceof ForbiddenError);

  const toolExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-09-01T04:00:00.000Z"),
      description: "Shop vac",
      amount: 180,
      category: "TOOLS_EQUIPMENT",
    },
  });
  const vehicleExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-09-02T04:00:00.000Z"),
      description: "Work van",
      amount: 12000,
      category: "VEHICLE",
    },
  });
  const materialExpense = await prisma.expense.create({
    data: {
      businessId: businessA.id,
      occurredOn: new Date("2026-09-03T04:00:00.000Z"),
      description: "Plywood",
      amount: 40,
      category: "MATERIALS",
    },
  });
  const foreignExpense = await prisma.expense.create({
    data: {
      businessId: businessB.id,
      occurredOn: new Date("2026-09-04T04:00:00.000Z"),
      description: "Beta van",
      amount: 9000,
      category: "VEHICLE",
    },
  });

  const itemKey = `item-${randomUUID()}`;
  const vac = await recordEquipmentItem(prisma, ownerA, {
    kind: "TOOL",
    name: "Shop vac",
    notes: "Garage",
    serviceOn: "2026-09-20",
    purchaseExpenseId: toolExpense.id,
    attemptKey: itemKey,
  });
  check("OWNER can record a tool with purchase and service date", vac.kind === "TOOL" && vac.purchaseExpenseId === toolExpense.id);
  const vacAgain = await recordEquipmentItem(prisma, ownerA, {
    kind: "TOOL",
    name: "Shop vac retry",
    serviceOn: "2026-09-21",
    purchaseExpenseId: toolExpense.id,
    attemptKey: itemKey,
  });
  check("Duplicate item submit returns the first row", vacAgain.id === vac.id && vacAgain.name === "Shop vac");

  const van = await recordEquipmentItem(prisma, ownerA, {
    kind: "VEHICLE",
    name: "Work van",
    serviceOn: "2026-09-29",
    purchaseExpenseId: vehicleExpense.id,
    attemptKey: `van-${randomUUID()}`,
  });
  const ladder = await recordEquipmentItem(prisma, ownerA, {
    kind: "TOOL",
    name: "Ladder",
    attemptKey: `ladder-${randomUUID()}`,
  });

  await expectError(
    "Materials expense cannot be a purchase reference",
    () =>
      recordEquipmentItem(prisma, ownerA, {
        kind: "TOOL",
        name: "Bad link",
        purchaseExpenseId: materialExpense.id,
        attemptKey: `mat-${randomUUID()}`,
      }),
    (error) => error instanceof EquipmentError && /Tools & Equipment/.test(error.message),
  );
  await expectError(
    "Foreign-business expense cannot be linked",
    () =>
      recordEquipmentItem(prisma, ownerA, {
        kind: "VEHICLE",
        name: "Stolen van",
        purchaseExpenseId: foreignExpense.id,
        attemptKey: `fx-${randomUUID()}`,
      }),
    (error) => error instanceof EquipmentError,
  );
  await expectError(
    "Already-linked expense cannot back a second item",
    () =>
      recordEquipmentItem(prisma, ownerA, {
        kind: "TOOL",
        name: "Second vac",
        purchaseExpenseId: toolExpense.id,
        attemptKey: `dup-exp-${randomUUID()}`,
      }),
    (error) => error instanceof EquipmentError && /already linked/.test(error.message),
  );

  const maintKey = `maint-${randomUUID()}`;
  const oil = await recordEquipmentMaintenance(prisma, ownerA, {
    equipmentId: van.id,
    occurredOn: "2026-09-10",
    notes: "Oil change",
    attemptKey: maintKey,
  });
  const oilAgain = await recordEquipmentMaintenance(prisma, ownerA, {
    equipmentId: van.id,
    occurredOn: "2026-09-11",
    notes: "Oil change retry",
    attemptKey: maintKey,
  });
  check("Duplicate maintenance submit returns the first row", oilAgain.id === oil.id && oilAgain.notes === "Oil change");

  const raceKey = `race-${randomUUID()}`;
  const barrier = createTwoRacerBarrier();
  equipmentRegisterTestHooks.beforeItemInsert = async (input) => {
    if (input.attemptKey === raceKey) await barrier.wait();
  };
  const racerA = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const racerB = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const race = Promise.all([
    recordEquipmentItem(racerA, ownerA, {
      kind: "TOOL",
      name: "Race saw A",
      attemptKey: raceKey,
    }),
    recordEquipmentItem(racerB, ownerA, {
      kind: "TOOL",
      name: "Race saw B",
      attemptKey: raceKey,
    }),
  ]);
  await withTimeout(barrier.arrived, 4000, "both racers reached insert hold");
  barrier.release();
  const [firstRace, secondRace] = await withTimeout(race, 4000, "duplicate submit race");
  equipmentRegisterTestHooks.beforeItemInsert = undefined;
  check(
    "Concurrent duplicate submit returns the same row from both clients",
    firstRace.id === secondRace.id &&
      firstRace.attemptKey === raceKey &&
      secondRace.attemptKey === raceKey,
  );
  const raceCount = await prisma.equipmentItem.count({
    where: { businessId: businessA.id, attemptKey: raceKey },
  });
  check("Concurrent duplicate leaves exactly one row per attempt key", raceCount === 1);

  await expectError(
    "ADMIN cannot record maintenance",
    () =>
      recordEquipmentMaintenance(prisma, adminA, {
        equipmentId: van.id,
        occurredOn: "2026-09-12",
        notes: "Admin oil",
        attemptKey: `adm-m-${randomUUID()}`,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot record maintenance",
    () =>
      recordEquipmentMaintenance(prisma, memberA, {
        equipmentId: van.id,
        occurredOn: "2026-09-12",
        notes: "Member oil",
        attemptKey: `mem-m-${randomUUID()}`,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Invalid service date is rejected",
    () =>
      recordEquipmentItem(prisma, ownerA, {
        kind: "TOOL",
        name: "Bad date",
        serviceOn: "2026-13-40",
        attemptKey: `bad-date-${randomUUID()}`,
      }),
    (error) => error instanceof Error && /YYYY-MM-DD/.test(error.message),
  );

  console.log("\nLIVE — Tenant isolation");
  await expectError(
    "Business B cannot maintain business A equipment",
    () =>
      recordEquipmentMaintenance(prisma, ownerB, {
        equipmentId: van.id,
        occurredOn: "2026-09-12",
        notes: "Foreign oil",
        attemptKey: `b-m-${randomUUID()}`,
      }),
    (error) => error instanceof EquipmentError,
  );
  const betaItem = await recordEquipmentItem(prisma, ownerB, {
    kind: "VEHICLE",
    name: "Beta van",
    serviceOn: "2026-01-01",
    attemptKey: `b-item-${randomUUID()}`,
  });
  const loadedA = await loadEquipmentRegister(prisma, adminA, {
    now: new Date("2026-09-29T16:00:00.000Z"),
  });
  const loadedB = await loadEquipmentRegister(prisma, ownerB, {
    now: new Date("2026-09-29T16:00:00.000Z"),
  });
  check("ADMIN can read same-tenant items", loadedA.items.some((row) => row.id === vac.id && row.purchaseExpense?.id === toolExpense.id));
  check("ADMIN does not see foreign-business items", !loadedA.items.some((row) => row.id === betaItem.id));
  check("Business B does not see business A items", !loadedB.items.some((row) => row.id === vac.id || row.id === van.id));
  check(
    "Due list uses recorded service dates only",
    loadedA.dueItems.some((row) => row.id === van.id && row.serviceOn === "2026-09-29") &&
      loadedA.dueItems.some((row) => row.id === vac.id && row.serviceOn === "2026-09-20") &&
      !loadedA.dueItems.some((row) => row.id === ladder.id),
  );
  check(
    "Maintenance does not invent a due date for the ladder",
    loadedA.items.find((row) => row.id === ladder.id)?.due === false,
  );

  console.log("\nLIVE — Bounded lists");
  for (let i = 0; i < EQUIPMENT_READ_LIMIT + 1; i += 1) {
    await prisma.equipmentItem.create({
      data: {
        businessId: businessA.id,
        kind: "TOOL",
        name: `Fill ${i}`,
        attemptKey: `fill-${i}-${randomUUID()}`,
        createdByMembershipId: ownerMem.id,
      },
    });
  }
  for (let i = 0; i < EQUIPMENT_MAINTENANCE_READ_LIMIT + 1; i += 1) {
    await prisma.equipmentMaintenanceEntry.create({
      data: {
        businessId: businessA.id,
        equipmentId: van.id,
        occurredOn: new Date("2026-08-01T04:00:00.000Z"),
        notes: `Entry ${i}`,
        attemptKey: `fill-m-${i}-${randomUUID()}`,
        createdByMembershipId: ownerMem.id,
      },
    });
  }
  for (let i = 0; i < EQUIPMENT_PURCHASE_CHOICE_LIMIT + 1; i += 1) {
    await prisma.expense.create({
      data: {
        businessId: businessA.id,
        occurredOn: new Date("2026-07-01T04:00:00.000Z"),
        description: `Spare tool ${i}`,
        amount: 10,
        category: "TOOLS_EQUIPMENT",
      },
    });
  }
  const bounded = await loadEquipmentRegister(prisma, ownerA, {
    now: new Date("2026-09-29T16:00:00.000Z"),
  });
  check("Register list is capped at 50", bounded.items.length === EQUIPMENT_READ_LIMIT && bounded.overflow);
  check(
    "Maintenance list is capped at 20",
    bounded.items.find((row) => row.id === van.id)?.maintenance.length ===
      EQUIPMENT_MAINTENANCE_READ_LIMIT &&
      bounded.items.find((row) => row.id === van.id)?.maintenanceOverflow === true,
  );
  check(
    "Purchase choices are capped at 50",
    bounded.purchaseChoices.length === EQUIPMENT_PURCHASE_CHOICE_LIMIT &&
      bounded.purchaseChoiceOverflow,
  );

  console.log("\nLIVE — Trade-neutral CLEANING tenant");
  const cleanVac = await recordEquipmentItem(prisma, ownerClean, {
    kind: "TOOL",
    name: "Extractor",
    serviceOn: "2026-09-28",
    attemptKey: `clean-${randomUUID()}`,
  });
  const cleanLoaded = await loadEquipmentRegister(prisma, ownerClean, {
    now: new Date("2026-09-29T16:00:00.000Z"),
  });
  check("CLEANING owner can record the same Tool/Vehicle register", cleanVac.kind === "TOOL");
  check(
    "CLEANING due uses the Los Angeles recorded date, not Handyman-specific rules",
    cleanLoaded.dueItems.some((row) => row.id === cleanVac.id) &&
      cleanLoaded.items.every((row) => row.kind === "TOOL" || row.kind === "VEHICLE"),
  );
  check("CLEANING tenant does not see Handyman equipment", !cleanLoaded.items.some((row) => row.id === vac.id));

  if (failures) {
    console.error(`\n${failures} equipment-register check(s) failed.`);
    exitCode = 1;
  } else {
    console.log("\nAll equipment-register checks passed.");
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  equipmentRegisterTestHooks.beforeItemInsert = undefined;
  await disconnectClients();
  dropTestDatabase();
}

process.exit(exitCode);
}

await main();
