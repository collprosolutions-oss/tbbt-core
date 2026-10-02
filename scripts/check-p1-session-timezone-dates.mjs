/**
 * P1 session-timezone date binds.
 *
 * Proves NativeSignInThrottle writes/reads and time-card week locks stay
 * on UTC wall time when the Postgres session timezone is not UTC.
 * Creates its own disposable local database. Session timezone is set
 * per Prisma connection via libpq options — the login role is not left
 * changed. A final SHOW timezone on a default connection must be UTC.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-p1-session-timezone-dates.mjs
 */
import { createRequire, register } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";
import { showTimezoneValue } from "./lib/postgres-session-timezone.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  NATIVE_PASSWORD_MAX_ATTEMPTS,
  NATIVE_PASSWORD_PURPOSE,
  NATIVE_PASSWORD_WINDOW_MINUTES,
  clearNativePasswordThrottle,
  nativePasswordSubjectHash,
  nativePasswordThrottleIsLocked,
  recordNativePasswordFailure,
} = await import("@/lib/native-session-limits");
const { utcTimestampSql } = await import("@/lib/utc-timestamp-sql");
const { parseDateTimeInput, weekRange, WEEK_BOUNDARY_CROSSING_ERROR } = await import(
  "@/lib/time-cards"
);
const {
  approveTimesheetWeek,
  createManualTimeEntry,
  lockWorkerWeekTimeEntries,
  TimeCardError,
} = await import("@/lib/time-card-ops");

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const AUCKLAND = "Pacific/Auckland";
const PG_TIMEZONES = ["UTC", NY, LA, AUCKLAND];
const NODE_TIMEZONES = [NY, AUCKLAND];
const WORKER_FLAG = "P1_SESSION_TZ_WORKER";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function urlWithSessionTimezone(baseUrl, tz) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set("options", `-c TimeZone=${tz}`);
  parsed.searchParams.set("connection_limit", "1");
  return parsed.toString();
}

function makeAccess(businessId, membershipId, timezone) {
  return {
    businessId,
    workspace: { role: "OWNER", membership: { id: membershipId }, business: { timezone } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function civil(date, time, zone) {
  const value = parseDateTimeInput(date, time, zone);
  if (!value) throw new Error(`Invalid civil time ${date} ${time} ${zone}`);
  return value;
}

async function connectWithSessionTimezone(testUrl, tz) {
  const prisma = new PrismaClient({ datasourceUrl: urlWithSessionTimezone(testUrl, tz) });
  await prisma.$executeRawUnsafe(`SET timezone = ${JSON.stringify(tz)}`);
  const shown = showTimezoneValue(await prisma.$queryRawUnsafe("SHOW timezone"));
  if (shown !== tz) {
    await prisma.$disconnect();
    throw new Error(`SHOW timezone is ${JSON.stringify(shown)}, expected ${tz}`);
  }
  return prisma;
}

async function showDefaultTimezone(databaseUrl) {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    return showTimezoneValue(await prisma.$queryRawUnsafe("SHOW timezone"));
  } finally {
    await prisma.$disconnect();
  }
}

async function runThrottleCell(prisma, nodeTz, pgTz) {
  const prefix = `throttle ${nodeTz} / ${pgTz}`;
  const seqEmail = `seq-${randomUUID()}@example.com`;
  const burstEmail = `burst-${randomUUID()}@example.com`;
  const expiryEmail = `exp-${randomUUID()}@example.com`;

  for (let attempt = 0; attempt < NATIVE_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
    await recordNativePasswordFailure(prisma, seqEmail);
  }
  const seqLocked = await nativePasswordThrottleIsLocked(prisma, seqEmail);
  const seqRow = await prisma.nativeSignInThrottle.findUnique({
    where: {
      subjectHash_purpose: {
        subjectHash: nativePasswordSubjectHash(seqEmail),
        purpose: NATIVE_PASSWORD_PURPOSE,
      },
    },
  });
  check(
    `${prefix} — five failed native sign-ins lock and nativePasswordThrottleIsLocked is true`,
    seqLocked === true && seqRow?.failedAttemptCount === NATIVE_PASSWORD_MAX_ATTEMPTS,
  );

  await Promise.all(
    Array.from({ length: NATIVE_PASSWORD_MAX_ATTEMPTS }, () =>
      recordNativePasswordFailure(prisma, burstEmail),
    ),
  );
  const burstLocked = await nativePasswordThrottleIsLocked(prisma, burstEmail);
  const burstRow = await prisma.nativeSignInThrottle.findUnique({
    where: {
      subjectHash_purpose: {
        subjectHash: nativePasswordSubjectHash(burstEmail),
        purpose: NATIVE_PASSWORD_PURPOSE,
      },
    },
  });
  check(
    `${prefix} — five simultaneous wrong passwords lock the next try`,
    burstLocked === true && burstRow?.failedAttemptCount === NATIVE_PASSWORD_MAX_ATTEMPTS,
  );

  const now = new Date("2026-10-02T12:00:00.000Z");
  for (let attempt = 0; attempt < NATIVE_PASSWORD_MAX_ATTEMPTS; attempt += 1) {
    await recordNativePasswordFailure(prisma, expiryEmail, {
      now,
      windowMinutes: NATIVE_PASSWORD_WINDOW_MINUTES,
    });
  }
  const expiryRow = await prisma.nativeSignInThrottle.findUnique({
    where: {
      subjectHash_purpose: {
        subjectHash: nativePasswordSubjectHash(expiryEmail),
        purpose: NATIVE_PASSWORD_PURPOSE,
      },
    },
  });
  const offsetMs = expiryRow.expiresAt.getTime() - now.getTime();
  const expectedMs = NATIVE_PASSWORD_WINDOW_MINUTES * 60 * 1000;
  const raw = await prisma.$queryRaw`
    SELECT "expiresAt"::text AS expires_text, "windowStartedAt"::text AS window_text
    FROM "NativeSignInThrottle"
    WHERE "subjectHash" = ${nativePasswordSubjectHash(expiryEmail)}
      AND "purpose" = ${NATIVE_PASSWORD_PURPOSE}
  `;
  check(
    `${prefix} — stored expiresAt is now+${NATIVE_PASSWORD_WINDOW_MINUTES}min UTC wall (no 13-hour/negative offset)`,
    Boolean(expiryRow) &&
      Math.abs(offsetMs - expectedMs) < 60 * 1000 &&
      expiryRow.expiresAt.toISOString() === "2026-10-02T12:10:00.000Z" &&
      expiryRow.windowStartedAt.toISOString() === "2026-10-02T12:00:00.000Z" &&
      String(raw[0]?.expires_text).startsWith("2026-10-02 12:10:00") &&
      String(raw[0]?.window_text).startsWith("2026-10-02 12:00:00"),
  );
  check(
    `${prefix} — locked before expiry and unlocked after (controlled clock)`,
    (await nativePasswordThrottleIsLocked(prisma, expiryEmail, now)) === true &&
      (await nativePasswordThrottleIsLocked(
        prisma,
        expiryEmail,
        new Date(expiryRow.expiresAt.getTime() - 1000),
      )) === true &&
      (await nativePasswordThrottleIsLocked(prisma, expiryEmail, expiryRow.expiresAt)) === false &&
      (await nativePasswordThrottleIsLocked(
        prisma,
        expiryEmail,
        new Date(expiryRow.expiresAt.getTime() + 1000),
      )) === false,
  );

  await clearNativePasswordThrottle(prisma, seqEmail);
  await clearNativePasswordThrottle(prisma, burstEmail);
  await clearNativePasswordThrottle(prisma, expiryEmail);
}

async function seedCrossingFixture(prisma, timezone, startCivil, endCivil, label) {
  const user = await prisma.user.create({
    data: {
      name: `${label} Owner`,
      email: `${label}-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  const business = await prisma.business.create({
    data: {
      name: `${label} Shop`,
      slug: `${label}-${randomUUID()}`,
      timezone,
      tradeCode: "HANDYMAN",
    },
  });
  const membership = await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER", hourlyWage: 25, active: true },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${label} Customer` },
  });
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      status: "SCHEDULED",
      projectToken: randomUUID(),
      assignedMembershipId: membership.id,
    },
  });
  const access = makeAccess(business.id, membership.id, timezone);
  const startedAt = civil(startCivil.date, startCivil.time, timezone);
  const endedAt = civil(endCivil.date, endCivil.time, timezone);
  const crossing = await createManualTimeEntry(prisma, access, {
    membershipId: membership.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt,
    endedAt,
    note: `${label} crossing`,
    timeZone: timezone,
  });
  const saturdayWeek = weekRange(civil(startCivil.date, "12:00", timezone), timezone);
  const prevWeek = weekRange(
    new Date(saturdayWeek.start.getTime() - 24 * 60 * 60 * 1000),
    timezone,
  );
  const nextWeek = weekRange(saturdayWeek.end, timezone);
  const prevEntry = await createManualTimeEntry(prisma, access, {
    membershipId: membership.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt: new Date(prevWeek.start.getTime() + 10 * 60 * 60 * 1000),
    endedAt: new Date(prevWeek.start.getTime() + 12 * 60 * 60 * 1000),
    note: `${label} previous week`,
    timeZone: timezone,
  });
  const nextEntry = await createManualTimeEntry(prisma, access, {
    membershipId: membership.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt: new Date(nextWeek.start.getTime() + 10 * 60 * 60 * 1000),
    endedAt: new Date(nextWeek.start.getTime() + 12 * 60 * 60 * 1000),
    note: `${label} next week`,
    timeZone: timezone,
  });
  return { access, membership, crossing, prevEntry, nextEntry, saturdayWeek };
}

async function runWeekCell(prisma, nodeTz, pgTz) {
  const prefix = `week ${nodeTz} / ${pgTz}`;
  const fixtures = [
    {
      timezone: NY,
      label: "ny-sat",
      start: { date: "2026-09-19", time: "22:00" },
      end: { date: "2026-09-20", time: "02:00" },
    },
    {
      timezone: LA,
      label: "la-sat",
      start: { date: "2026-09-19", time: "22:00" },
      end: { date: "2026-09-20", time: "02:00" },
    },
    {
      timezone: NY,
      label: "ny-dst-spring",
      start: { date: "2026-03-07", time: "22:00" },
      end: { date: "2026-03-08", time: "03:30" },
    },
    {
      timezone: LA,
      label: "la-dst-spring",
      start: { date: "2026-03-07", time: "22:00" },
      end: { date: "2026-03-08", time: "03:30" },
    },
    {
      timezone: NY,
      label: "ny-dst-fall",
      start: { date: "2026-10-31", time: "22:00" },
      end: { date: "2026-11-01", time: "01:30" },
    },
    {
      timezone: LA,
      label: "la-dst-fall",
      start: { date: "2026-10-31", time: "22:00" },
      end: { date: "2026-11-01", time: "01:30" },
    },
  ];

  for (const fixture of fixtures) {
    const seeded = await seedCrossingFixture(
      prisma,
      fixture.timezone,
      fixture.start,
      fixture.end,
      `${fixture.label}-${randomUUID().slice(0, 8)}`,
    );
    const locked = await prisma.$transaction((tx) =>
      lockWorkerWeekTimeEntries(
        tx,
        seeded.access.businessId,
        seeded.membership.id,
        seeded.saturdayWeek.start,
        seeded.saturdayWeek.end,
      ),
    );
    const lockedIds = new Set(locked.map((row) => row.id));
    check(
      `${prefix} — ${fixture.label} crossing is in the Saturday-week lock set`,
      lockedIds.has(seeded.crossing.id),
    );
    check(
      `${prefix} — ${fixture.label} neighbouring-week entries are not locked`,
      !lockedIds.has(seeded.prevEntry.id) && !lockedIds.has(seeded.nextEntry.id),
    );
    let approveError = null;
    try {
      await approveTimesheetWeek(prisma, seeded.access, {
        membershipId: seeded.membership.id,
        weekStartedAt: seeded.saturdayWeek.start,
        timeZone: fixture.timezone,
      });
    } catch (error) {
      approveError = error instanceof TimeCardError ? error.message : String(error);
    }
    check(
      `${prefix} — ${fixture.label} Saturday-week approval is refused while the crossing remains`,
      approveError === WEEK_BOUNDARY_CROSSING_ERROR,
    );
  }
}

async function runWorker(testUrl) {
  const nodeTz = process.env.TZ || "(unset)";
  for (const pgTz of PG_TIMEZONES) {
    console.log(`\nCELL — Node TZ=${nodeTz} Postgres session=${pgTz}`);
    const prisma = await connectWithSessionTimezone(testUrl, pgTz);
    try {
      await runThrottleCell(prisma, nodeTz, pgTz);
      await runWeekCell(prisma, nodeTz, pgTz);
    } finally {
      await prisma.$disconnect();
    }
  }
}

console.log("\nSTATIC — UTC timestamp binds and helper");
const limitsSrc = readRepo("src/lib/native-session-limits.ts");
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");
const helperSrc = readRepo("src/lib/utc-timestamp-sql.ts");
const billingSrc = readRepo("src/lib/saas-billing/schema.ts");
const boundHelper = utcTimestampSql(new Date("2026-10-02T12:00:00.000Z"));
check(
  "utcTimestampSql casts ISO instants through timestamptz AT TIME ZONE UTC",
  helperSrc.includes("value.toISOString()") &&
    helperSrc.includes("::timestamptz AT TIME ZONE 'UTC'") &&
    JSON.stringify(boundHelper).includes("2026-10-02T12:00:00.000Z"),
);
check(
  "Native throttle INSERT binds window/expiry through utcTimestampSql",
  limitsSrc.includes("utcTimestampSql(now)") &&
    limitsSrc.includes("utcTimestampSql(expiresAt)") &&
    !/VALUES \(\s*\$\{randomUUID\(\)\},\s*\$\{subjectHash\},\s*\$\{NATIVE_PASSWORD_PURPOSE\},\s*1,\s*\$\{now\}/.test(
      limitsSrc,
    ),
);
check(
  "Native throttle lock compare uses utcTimestampSql(now), not wall-clock Date",
  limitsSrc.includes('"expiresAt" > ${utcTimestampSql(now)}') &&
    !limitsSrc.includes("row.expiresAt <= new Date()"),
);
check(
  "Week lock bounds use utcTimestampSql(end) and utcTimestampSql(start)",
  timeCardOpsSrc.includes("utcTimestampSql(end)") &&
    timeCardOpsSrc.includes("utcTimestampSql(start)") &&
    !timeCardOpsSrc.includes('"startedAt" < ${end}') &&
    !timeCardOpsSrc.includes('"endedAt" > ${start}'),
);
check(
  "SaaS billing CURRENT_TIMESTAMP backfill left unchanged (not trivially safe)",
  billingSrc.includes("CURRENT_TIMESTAMP") &&
    !billingSrc.includes("AT TIME ZONE 'UTC'") &&
    billingSrc.includes("saasFounderTrialBackfilledAt"),
);
const leftoverRawDateBind =
  /\$queryRaw[\s\S]{0,500}\$\{(now|start|end|expiresAt|startedAt|endedAt)\}/;
check(
  "No leftover raw JS Date binds in the two TIMESTAMP(3) write sites",
  !leftoverRawDateBind.test(limitsSrc) && !leftoverRawDateBind.test(timeCardOpsSrc),
);

if (process.env[WORKER_FLAG] === "1") {
  const workerUrl = process.env.DATABASE_URL;
  if (!workerUrl) {
    console.error("DATABASE_URL must be set for the session-timezone worker.");
    process.exit(1);
  }
  assertLocalDatabaseUrl(workerUrl, "session-timezone worker DATABASE_URL");
  await runWorker(workerUrl);
  console.log(
    failed === 0
      ? `\nSession-timezone worker passed (${passed}).`
      : `\n${failed} session-timezone worker check(s) failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "session-timezone-dates disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_p1_session_tz",
});

const scriptPath = fileURLToPath(import.meta.url);
try {
  const beforeRoleTz = await showDefaultTimezone(baseUrl);
  const beforeDisposableTz = await showDefaultTimezone(session.testUrl);
  check("Login-role SHOW timezone is UTC before the matrix", beforeRoleTz === "UTC");
  check("Disposable default SHOW timezone is UTC before the matrix", beforeDisposableTz === "UTC");

  for (const nodeTz of NODE_TIMEZONES) {
    console.log(`\nWORKER — Node TZ=${nodeTz}`);
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", scriptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TZ: nodeTz,
          DATABASE_URL: session.testUrl,
          [WORKER_FLAG]: "1",
        },
      },
    );
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    check(`Worker Node TZ=${nodeTz} exited 0`, child.status === 0);
  }

  const afterRoleTz = await showDefaultTimezone(baseUrl);
  const afterDisposableTz = await showDefaultTimezone(session.testUrl);
  check("Login-role SHOW timezone is UTC after the matrix", afterRoleTz === "UTC");
  check("Disposable default SHOW timezone is UTC after the matrix", afterDisposableTz === "UTC");
} finally {
  await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll session-timezone date checks passed (${passed}).`
    : `\n${failed} session-timezone date check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
