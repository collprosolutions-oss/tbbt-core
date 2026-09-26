/**
 * Business timezone Settings preference + explicit-vs-fallback truth.
 *
 * Proves the Settings path reports stored timezone separately from the
 * America/New_York fallback, that only OWNER can persist a valid IANA
 * zone, and that the write does not rewrite stored UTC instants or run
 * request-time timezone DDL.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-timezone-settings.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  BUSINESS_TIMEZONE_CHANGE_MESSAGE,
  BUSINESS_TIMEZONE_FALLBACK_LABEL,
  COMMON_BUSINESS_TIMEZONES,
  DEFAULT_BUSINESS_TIMEZONE,
  addZonedCalendarDays,
  businessTimeZoneDisplayLabel,
  describeBusinessTimeZone,
  formatISODateInTimeZone,
  isValidIanaTimeZone,
  resolveBusinessTimeZone,
  zonedCivilToUtc,
} = await import("@/lib/business-timezone");
const { ForbiddenError } = await import("@/lib/authorization");
const {
  SettingsError,
  assertSettingsBusinessScope,
  updateBusinessTimeZoneOp,
} = await import("@/lib/settings-ops");
const { loadSettingsSnapshot } = await import("@/lib/settings-data");

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const CHI = "America/Chicago";

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate ? Boolean(predicate(error)) : true);
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readOwned(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const timezoneLib = readOwned("../src/lib/business-timezone.ts");
const settingsData = readOwned("../src/lib/settings-data.ts");
const settingsOps = readOwned("../src/lib/settings-ops.ts");
const settingsActions = readOwned("../src/app/actions/settings.ts");
const settingsWorkspace = readOwned("../src/components/settings/settings-workspace.tsx");
const timezoneForm = readOwned("../src/components/settings/business-timezone-form.tsx");
const settingsSurface = [settingsData, settingsOps, settingsActions, settingsWorkspace, timezoneForm].join("\n");

console.log("\nSTATIC — Fallback, labels, owner write, no request-time DDL");
check("DEFAULT_BUSINESS_TIMEZONE remains America/New_York", DEFAULT_BUSINESS_TIMEZONE === NY);
check(
  "Common IANA suggestions include the required US zones",
  COMMON_BUSINESS_TIMEZONES.includes(NY) &&
    COMMON_BUSINESS_TIMEZONES.includes("America/Chicago") &&
    COMMON_BUSINESS_TIMEZONES.includes("America/Denver") &&
    COMMON_BUSINESS_TIMEZONES.includes("America/Phoenix") &&
    COMMON_BUSINESS_TIMEZONES.includes(LA) &&
    COMMON_BUSINESS_TIMEZONES.includes("America/Anchorage") &&
    COMMON_BUSINESS_TIMEZONES.includes("Pacific/Honolulu"),
);
check(
  "Settings snapshot uses describeBusinessTimeZone, not a second resolver",
  settingsData.includes('import { describeBusinessTimeZone } from "@/lib/business-timezone"') &&
    settingsData.includes("timezone: describeBusinessTimeZone(business)") &&
    settingsData.includes("timezone: true") &&
    !settingsData.includes("function resolveBusinessTimeZone"),
);
check(
  "Timezone write lives in settings-ops and is OWNER-gated",
  settingsOps.includes("export async function updateBusinessTimeZoneOp") &&
    /export async function updateBusinessTimeZoneOp[\s\S]*requireBusinessCapability\(access, CAPABILITIES.MANAGE_SETTINGS\)/.test(
      settingsOps,
    ) &&
    /export async function updateBusinessTimeZoneOp[\s\S]*requireBusinessRole\(access, "OWNER"\)/.test(
      settingsOps,
    ) &&
    settingsOps.includes("isValidIanaTimeZone(timezone)") &&
    !timezoneForm.includes("prisma.business.update") &&
    !settingsWorkspace.includes("prisma.business.update"),
);
check(
  "Server action never trusts a browser-submitted businessId",
  settingsActions.includes("export async function updateBusinessTimeZoneSettings") &&
    settingsActions.includes("assertSettingsBusinessScope(access, readString(formData, \"businessId\") || null)") &&
    settingsActions.includes("updateBusinessTimeZoneOp(prisma, access,"),
);
check(
  "Timezone save revalidates settings, jobs, today, dashboard, and field",
  settingsActions.includes('revalidatePath("/settings")') &&
    settingsActions.includes('revalidatePath("/jobs")') &&
    settingsActions.includes('revalidatePath("/today")') &&
    settingsActions.includes('revalidatePath("/dashboard")') &&
    settingsActions.includes('revalidatePath("/field")'),
);
check(
  "Settings Profile shows distinct stored vs fallback copy",
  settingsWorkspace.includes("BusinessTimeZoneForm") &&
    timezoneForm.includes("businessTimeZoneDisplayLabel") &&
    timezoneForm.includes("COMMON_BUSINESS_TIMEZONES") &&
    timezoneForm.includes("confirmConsequential") &&
    timezoneForm.includes("BUSINESS_TIMEZONE_CHANGE_MESSAGE") &&
    timezoneLib.includes(BUSINESS_TIMEZONE_CHANGE_MESSAGE) &&
    !timezoneForm.includes("clear timezone") &&
    !timezoneForm.includes("Clear timezone"),
);
check(
  "Settings reads/writes do not introduce request-time timezone DDL",
  !settingsSurface.includes("ensureBusinessTimezoneSchema") &&
    !settingsSurface.includes("BUSINESS_TIMEZONE_ENSURE_SQL") &&
    !settingsSurface.includes("$executeRaw") &&
    !settingsSurface.includes("$executeRawUnsafe") &&
    !settingsSurface.includes("ALTER TABLE"),
);
check(
  "Timezone resolution helper still owns the fallback",
  timezoneLib.includes("export const DEFAULT_BUSINESS_TIMEZONE = \"America/New_York\"") &&
    timezoneLib.includes("export function resolveBusinessTimeZone") &&
    timezoneLib.includes("return DEFAULT_BUSINESS_TIMEZONE"),
);

console.log("\nUNIT — Null fallback vs explicit Eastern");
const nullBusiness = { timezone: null };
const emptyBusiness = { timezone: "  " };
const invalidBusiness = { timezone: "Eastern" };
const explicitNy = { timezone: NY };
const explicitLa = { timezone: LA };

check("Null timezone still resolves to America/New_York", resolveBusinessTimeZone(nullBusiness) === NY);
check(
  "Null timezone is labeled as fallback, not configured",
  describeBusinessTimeZone(nullBusiness).isExplicit === false &&
    describeBusinessTimeZone(nullBusiness).storedTimezone === null &&
    describeBusinessTimeZone(nullBusiness).resolvedTimezone === NY &&
    businessTimeZoneDisplayLabel(nullBusiness) ===
      "Timezone is not explicitly set. TBBT is currently using the America/New_York default." &&
    businessTimeZoneDisplayLabel(nullBusiness) === BUSINESS_TIMEZONE_FALLBACK_LABEL,
);
check(
  "Blank / invalid stored values stay fallback, not configured",
  describeBusinessTimeZone(emptyBusiness).isExplicit === false &&
    describeBusinessTimeZone(invalidBusiness).isExplicit === false &&
    resolveBusinessTimeZone(invalidBusiness) === NY &&
    businessTimeZoneDisplayLabel(invalidBusiness) === BUSINESS_TIMEZONE_FALLBACK_LABEL &&
    !isValidIanaTimeZone("Eastern"),
);
check(
  "Explicit America/New_York is distinguishable from the null fallback",
  describeBusinessTimeZone(explicitNy).isExplicit === true &&
    describeBusinessTimeZone(explicitNy).storedTimezone === NY &&
    describeBusinessTimeZone(explicitNy).resolvedTimezone === NY &&
    businessTimeZoneDisplayLabel(explicitNy) === `Business timezone: ${NY}` &&
    businessTimeZoneDisplayLabel(explicitNy) !== businessTimeZoneDisplayLabel(nullBusiness),
);
check(
  "Stored Los Angeles resolves Los Angeles and is labeled configured",
  resolveBusinessTimeZone(explicitLa) === LA &&
    describeBusinessTimeZone(explicitLa).isExplicit === true &&
    businessTimeZoneDisplayLabel(explicitLa) === `Business timezone: ${LA}`,
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_business_timezone_settings_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for business-timezone settings test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Timezone Settings",
      slug: `alpha-tz-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Timezone Settings",
      slug: `beta-tz-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: CHI,
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-tz-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-tz-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-tz-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-tz-${randomUUID()}@example.com`, passwordHash: "x" },
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
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Customer" },
  });
  const scheduledAt = new Date("2026-09-15T15:00:00.000Z");
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      status: "SCHEDULED",
      scheduledAt,
      scheduledDurationMinutes: 90,
      projectToken: randomUUID(),
    },
  });
  const startedAt = new Date("2026-09-15T14:00:00.000Z");
  const endedAt = new Date("2026-09-15T16:30:00.000Z");
  const timeEntry = await prisma.timeEntry.create({
    data: {
      businessId: businessA.id,
      membershipId: ownerMem.id,
      jobId: job.id,
      activityType: "JOB",
      status: "READY",
      startedAt,
      endedAt,
    },
  });

  console.log("\nDB — Snapshot fallback vs explicit + owner write");
  const createdA = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("New business stores a null timezone (no mass backfill)", createdA.timezone == null);
  check(
    "Null stored timezone still resolves to America/New_York",
    resolveBusinessTimeZone(createdA) === NY,
  );

  const snapshotNull = await loadSettingsSnapshot(prisma, businessA.id);
  check(
    "Settings snapshot labels null timezone as fallback, not configured",
    snapshotNull.timezone.storedTimezone == null &&
      snapshotNull.timezone.resolvedTimezone === NY &&
      snapshotNull.timezone.isExplicit === false &&
      businessTimeZoneDisplayLabel({ timezone: snapshotNull.timezone.storedTimezone }) ===
        BUSINESS_TIMEZONE_FALLBACK_LABEL,
  );

  await expectError(
    "OWNER must confirm a timezone change",
    () => updateBusinessTimeZoneOp(prisma, ownerA, { timezone: LA, confirmed: false }),
    (error) => error instanceof SettingsError && /Confirm this business-timezone change/i.test(error.message),
  );
  const afterUnconfirmed = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Unconfirmed timezone change makes no write", afterUnconfirmed.timezone == null);

  await expectError(
    "Invalid IANA string is rejected with no write",
    () => updateBusinessTimeZoneOp(prisma, ownerA, { timezone: "Eastern", confirmed: true }),
    (error) => error instanceof SettingsError && /valid IANA timezone/i.test(error.message),
  );
  const afterInvalid = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("Invalid IANA value left timezone null", afterInvalid.timezone == null);

  await expectError(
    "Empty timezone is rejected instead of clearing to the Eastern fallback",
    () => updateBusinessTimeZoneOp(prisma, ownerA, { timezone: "   ", confirmed: true }),
    (error) => error instanceof SettingsError && /valid IANA timezone/i.test(error.message),
  );

  await updateBusinessTimeZoneOp(prisma, ownerA, { timezone: LA, confirmed: true });
  const afterLa = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("OWNER can save America/Los_Angeles", afterLa.timezone === LA);
  check("Stored LA resolves LA", resolveBusinessTimeZone(afterLa) === LA);

  const snapshotLa = await loadSettingsSnapshot(prisma, businessA.id);
  check(
    "Settings snapshot reports stored LA as explicit",
    snapshotLa.timezone.storedTimezone === LA &&
      snapshotLa.timezone.resolvedTimezone === LA &&
      snapshotLa.timezone.isExplicit === true &&
      businessTimeZoneDisplayLabel({ timezone: snapshotLa.timezone.storedTimezone }) ===
        `Business timezone: ${LA}`,
  );

  const jobAfterLa = await prisma.job.findUnique({ where: { id: job.id } });
  const timeAfterLa = await prisma.timeEntry.findUnique({ where: { id: timeEntry.id } });
  check(
    "Changing timezone does not rewrite Job.scheduledAt",
    jobAfterLa.scheduledAt.getTime() === scheduledAt.getTime(),
  );
  check(
    "Changing timezone does not rewrite TimeEntry timestamps",
    timeAfterLa.startedAt.getTime() === startedAt.getTime() &&
      timeAfterLa.endedAt.getTime() === endedAt.getTime(),
  );

  await updateBusinessTimeZoneOp(prisma, ownerA, { timezone: NY, confirmed: true });
  const afterNy = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("OWNER can explicitly save America/New_York", afterNy.timezone === NY);
  check(
    "Explicit Eastern is distinguishable from the original null fallback",
    afterNy.timezone === NY &&
      describeBusinessTimeZone(afterNy).isExplicit === true &&
      describeBusinessTimeZone(createdA).isExplicit === false &&
      businessTimeZoneDisplayLabel(afterNy) === `Business timezone: ${NY}` &&
      businessTimeZoneDisplayLabel(createdA) === BUSINESS_TIMEZONE_FALLBACK_LABEL,
  );

  const jobAfterNy = await prisma.job.findUnique({ where: { id: job.id } });
  const timeAfterNy = await prisma.timeEntry.findUnique({ where: { id: timeEntry.id } });
  check(
    "Explicit Eastern save still leaves Job.scheduledAt untouched",
    jobAfterNy.scheduledAt.getTime() === scheduledAt.getTime(),
  );
  check(
    "Explicit Eastern save still leaves TimeEntry timestamps untouched",
    timeAfterNy.startedAt.getTime() === startedAt.getTime() &&
      timeAfterNy.endedAt.getTime() === endedAt.getTime(),
  );

  const timezoneAudit = await prisma.settingsAuditLog.findMany({
    where: { businessId: businessA.id, settingKey: "timezone" },
    orderBy: { changedAt: "asc" },
  });
  check(
    "Timezone writes use the existing Settings audit convention",
    timezoneAudit.length === 2 &&
      timezoneAudit.every((row) => row.settingArea === "profile") &&
      timezoneAudit[0].previousValue === "null" &&
      timezoneAudit[0].newValue.includes(LA) &&
      timezoneAudit[1].previousValue.includes(LA) &&
      timezoneAudit[1].newValue.includes(NY) &&
      timezoneAudit.every((row) => row.changedByMembershipId === ownerMem.id),
  );

  console.log("\nDB — Authorization and tenant isolation");
  await expectError(
    "ADMIN cannot change timezone",
    () => updateBusinessTimeZoneOp(prisma, adminA, { timezone: LA, confirmed: true }),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "MEMBER cannot change timezone",
    () => updateBusinessTimeZoneOp(prisma, memberA, { timezone: LA, confirmed: true }),
    (error) => error instanceof ForbiddenError,
  );
  const afterDenied = await prisma.business.findUnique({ where: { id: businessA.id } });
  check("ADMIN/MEMBER denials left the explicit Eastern value in place", afterDenied.timezone === NY);

  await expectError(
    "Tenant A cannot target tenant B through a submitted businessId",
    () => {
      assertSettingsBusinessScope(ownerA, businessB.id);
    },
    (error) => error instanceof ForbiddenError,
  );
  await updateBusinessTimeZoneOp(prisma, ownerA, { timezone: LA, confirmed: true });
  const tenantA = await prisma.business.findUnique({ where: { id: businessA.id } });
  const tenantB = await prisma.business.findUnique({ where: { id: businessB.id } });
  check("Tenant A timezone write updates only tenant A", tenantA.timezone === LA);
  check("Tenant A cannot change tenant B timezone", tenantB.timezone === CHI);
  await updateBusinessTimeZoneOp(prisma, ownerB, { timezone: "Pacific/Honolulu", confirmed: true });
  const tenantAAfterB = await prisma.business.findUnique({ where: { id: businessA.id } });
  const tenantBAfterB = await prisma.business.findUnique({ where: { id: businessB.id } });
  check("Tenant B write stays on tenant B", tenantBAfterB.timezone === "Pacific/Honolulu");
  check("Tenant B write does not rewrite tenant A", tenantAAfterB.timezone === LA);

  console.log("\nUNIT — DST formatting after the Settings write");
  const resolvedAfterWrite = resolveBusinessTimeZone(tenantAAfterB);
  const beforeSpring = zonedCivilToUtc(2026, 3, 8, 0, 0, 0, resolvedAfterWrite);
  const afterSpring = addZonedCalendarDays(beforeSpring, 1, resolvedAfterWrite);
  const beforeFall = zonedCivilToUtc(2026, 11, 1, 0, 0, 0, resolvedAfterWrite);
  const afterFall = addZonedCalendarDays(beforeFall, 1, resolvedAfterWrite);
  check("Stored LA still resolves LA for DST formatting", resolvedAfterWrite === LA);
  check(
    "2026-03-08 00:00 America/Los_Angeles is PST (UTC-8)",
    beforeSpring.toISOString() === "2026-03-08T08:00:00.000Z",
  );
  check(
    "Adding one calendar day across LA spring-forward lands on PDT midnight",
    afterSpring.toISOString() === "2026-03-09T07:00:00.000Z" &&
      formatISODateInTimeZone(afterSpring, LA) === "2026-03-09" &&
      afterSpring.getTime() - beforeSpring.getTime() !== 24 * 60 * 60 * 1000,
  );
  check(
    "2026-11-01 00:00 America/Los_Angeles is PDT (UTC-7)",
    beforeFall.toISOString() === "2026-11-01T07:00:00.000Z",
  );
  check(
    "Adding one calendar day across LA fall-back lands on PST midnight",
    afterFall.toISOString() === "2026-11-02T08:00:00.000Z" &&
      formatISODateInTimeZone(afterFall, LA) === "2026-11-02" &&
      afterFall.getTime() - beforeFall.getTime() !== 24 * 60 * 60 * 1000,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nAll business-timezone Settings checks passed."
    : `\n${failures} business-timezone Settings check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
