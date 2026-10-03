/**
 * Customer Project Portal callback request against a completed job.
 *
 * Dedicated database: tbbt_portal_job_callback_test
 *
 * Proves token-only ownership, invalid-token refusal, wrong-tenant
 * isolation, duplicate/retry idempotency, concurrent submit, and the
 * bounded post-outcome portal cooldown on a dedicated local DB.
 * availableAt is max(resolvedAt + 24 elapsed hours, next
 * Business.timezone calendar day). Reuses the existing OWNER
 * JobCallback review path. OWNER can still record an urgent callback
 * during the portal cooldown. Does not create a job, promise warranty
 * coverage, or send a message.
 *
 * Run with:
 *   npm run test:portal-job-callback
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for portal job-callback checks.");
  process.exit(generateEarly.status ?? 1);
}

const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  addZonedCalendarDays,
  DEFAULT_BUSINESS_TIMEZONE,
  resolveBusinessTimeZone,
  startOfZonedDay,
  zonedCivilToUtc,
} = await import("@/lib/business-timezone");
const {
  JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE,
  JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE,
  JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE,
  MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH,
  MAX_PORTAL_PROJECT_TOKEN_LENGTH,
  PORTAL_JOB_CALLBACK_COOLDOWN_DAYS,
  PORTAL_JOB_CALLBACK_COOLDOWN_HOURS,
  PORTAL_JOB_CALLBACK_COOLDOWN_MS,
  formatPortalCallbackDescription,
  isPortalJobCallbackCoolingDown,
  parsePortalJobCallbackDescription,
  parsePortalJobCallbackPreferredContact,
  parsePortalProjectToken,
  portalJobCallbackCooldownAvailableAt,
  portalJobCallbackCooldownMessage,
} = await import("@/lib/job-callback");
const { loadJobCallbackReview } = await import("@/lib/job-callback-data");
const {
  recordCustomerReportedCallback,
  recordCustomerReportedCallbackOutcome,
  reviewCustomerReportedCallback,
} = await import("@/lib/job-callback-ops");
const {
  findLatestResolvedJobCallback,
  loadPortalJobCallbackView,
} = await import("@/lib/portal-job-callback-data");
const {
  countBusinessCommunications,
  countBusinessInvoices,
  countBusinessJobs,
  countBusinessPayments,
  submitPortalJobCallback,
} = await import("@/lib/portal-job-callback-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run the portal job-callback check.");
  process.exit(1);
}

const sourceUrl = new URL(baseUrl);
const databaseHost = sourceUrl.hostname.toLowerCase();
if (databaseHost !== "localhost" && databaseHost !== "127.0.0.1" && databaseHost !== "::1") {
  console.error(
    "Portal job-callback checks refuse a remote DATABASE_URL. Host must be localhost, 127.0.0.1, or ::1.",
  );
  process.exit(1);
}

const testDbName = "tbbt_portal_job_callback_test";
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

function createWriteBarrier(expected, timeoutMs) {
  let arrived = 0;
  let released = false;
  let release;
  let fail;
  const held = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => {
    if (!released) {
      fail(new Error(`Race barrier timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  return {
    async arriveAndWait() {
      arrived += 1;
      if (arrived >= expected) {
        released = true;
        clearTimeout(timer);
        release();
      }
      await held;
    },
  };
}

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

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
      business: { id: businessId, name: "Portal Callback Co" },
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

const featureFiles = [
  "src/lib/job-callback.ts",
  "src/lib/portal-job-callback-ops.ts",
  "src/lib/portal-job-callback-data.ts",
  "src/app/actions/portal-job-callback.ts",
  "src/components/portal/request-job-callback-form.tsx",
];
const opsSrc = read("src/lib/portal-job-callback-ops.ts");
const dataSrc = read("src/lib/portal-job-callback-data.ts");
const callbackSrc = read("src/lib/job-callback.ts");
const actionSrc = read("src/app/actions/portal-job-callback.ts");
const formSrc = read("src/components/portal/request-job-callback-form.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const ownerActionSrc = read("src/app/actions/job-callback.ts");
const ownerOpsSrc = read("src/lib/job-callback-ops.ts");
const navSrc = read("src/lib/nav.ts");
const appShellSrc = read("src/components/app-shell.tsx");
const packageSrc = read("package.json");
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const PHX = "America/Phoenix";
const AK = "Pacific/Auckland";
const HAVANA = "America/Havana";

function calendarDayOnlyAvailableAt(resolvedAt, timeZone) {
  return addZonedCalendarDays(resolvedAt, 1, timeZone);
}

function utcMidnightOnlyAvailableAt(resolvedAt) {
  return new Date(
    Date.UTC(
      resolvedAt.getUTCFullYear(),
      resolvedAt.getUTCMonth(),
      resolvedAt.getUTCDate() + 1,
    ),
  );
}

const DANGEROUS = /\beval\s*\(|new\s+Function\b|Function\s*\(|\$executeRawUnsafe/;

console.log("\nSTATIC — token-only portal request, existing review path, no job/message/warranty");
check(
  "Token-only ownership; browser businessId/customerId/jobId are never authorization",
  dataSrc.includes("findLiveJobByProjectToken") &&
    opsSrc.includes("findLiveJobByProjectToken") &&
    actionSrc.includes('readString(formData, "projectToken")') &&
    !actionSrc.includes('readString(formData, "businessId")') &&
    !actionSrc.includes('readString(formData, "customerId")') &&
    !actionSrc.includes('readString(formData, "jobId")') &&
    !opsSrc.includes("input.businessId") &&
    !opsSrc.includes("input.customerId") &&
    !opsSrc.includes("input.jobId") &&
    !formSrc.includes('name="businessId"') &&
    !formSrc.includes('name="jobId"') &&
    !formSrc.includes('name="customerId"'),
);
check(
  "Input and reads are bounded",
  dataSrc.includes("take: 1") &&
    opsSrc.includes("take: 1") &&
    opsSrc.includes("parsePortalProjectToken") &&
    opsSrc.includes("parsePortalJobCallbackDescription") &&
    formSrc.includes("MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH") &&
    parsePortalProjectToken("a".repeat(MAX_PORTAL_PROJECT_TOKEN_LENGTH + 1)) === null &&
    parsePortalJobCallbackDescription("x".repeat(600))?.length ===
      MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH,
);
check(
  "Retries stay idempotent and reuse the OWNER review path",
  opsSrc.includes("alreadyExists: true") &&
    opsSrc.includes('reportedVia: "PORTAL"') &&
    opsSrc.includes('status: "RECORDED"') &&
    ownerOpsSrc.includes("reviewCustomerReportedCallback") &&
    ownerActionSrc.includes("reviewJobCallbackAction") &&
    portalSrc.includes("RequestJobCallbackForm") &&
    !portalSrc.includes("JobCallbackPanel") &&
    !portalSrc.includes("recordJobCallbackAction"),
);
check(
  "Portal cooldown is max(elapsed 24h, next Business.timezone day) and OWNER record is not cooled down",
  PORTAL_JOB_CALLBACK_COOLDOWN_HOURS === 24 &&
    PORTAL_JOB_CALLBACK_COOLDOWN_MS === 24 * 60 * 60 * 1000 &&
    PORTAL_JOB_CALLBACK_COOLDOWN_DAYS === 1 &&
    callbackSrc.includes("resolvedAt.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS") &&
    callbackSrc.includes("Math.max") &&
    callbackSrc.includes("addZonedCalendarDays") &&
    opsSrc.includes("resolveBusinessTimeZone") &&
    dataSrc.includes("resolveBusinessTimeZone") &&
    opsSrc.includes("where: { id: locked.businessId }") &&
    opsSrc.includes("select: { timezone: true }") &&
    opsSrc.includes("isPortalJobCallbackCoolingDown") &&
    opsSrc.includes("JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE") &&
    dataSrc.includes('status: "cooldown"') &&
    portalSrc.includes("portalJobCallbackCooldownMessage") &&
    !opsSrc.includes("input.outcomeAt") &&
    !opsSrc.includes("input.timezone") &&
    !opsSrc.includes("input.resolvedAt") &&
    !opsSrc.includes("input.availableAt") &&
    !ownerOpsSrc.includes("isPortalJobCallbackCoolingDown") &&
    !ownerOpsSrc.includes("PORTAL_JOB_CALLBACK_COOLDOWN") &&
    !ownerActionSrc.includes("isPortalJobCallbackCoolingDown"),
);
const lateNy = zonedCivilToUtc(2026, 10, 2, 23, 59, 59, NY);
const lateNyNextMidnight = addZonedCalendarDays(lateNy, 1, NY);
const lateNyElapsed = new Date(lateNy.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
check(
  "Resolve at 23:59:59 local is not available until resolve+24h, after next midnight",
  lateNyElapsed.getTime() > lateNyNextMidnight.getTime() &&
    portalJobCallbackCooldownAvailableAt(lateNy, NY).getTime() === lateNyElapsed.getTime() &&
    isPortalJobCallbackCoolingDown(lateNy, NY, lateNyNextMidnight) === true &&
    isPortalJobCallbackCoolingDown(
      lateNy,
      NY,
      new Date(lateNyElapsed.getTime() - 1),
    ) === true &&
    isPortalJobCallbackCoolingDown(lateNy, NY, lateNyElapsed) === false,
);
const earlyNy = zonedCivilToUtc(2026, 10, 2, 0, 0, 1, NY);
const earlyNyNextMidnight = addZonedCalendarDays(earlyNy, 1, NY);
const earlyNyElapsed = new Date(earlyNy.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
check(
  "Resolve at 00:00:01 on a 24-hour New York day uses resolve+24h, one second after next midnight",
  earlyNyElapsed.getTime() > earlyNyNextMidnight.getTime() &&
    earlyNyElapsed.getTime() - earlyNyNextMidnight.getTime() === 1000 &&
    portalJobCallbackCooldownAvailableAt(earlyNy, NY).getTime() === earlyNyElapsed.getTime() &&
    isPortalJobCallbackCoolingDown(earlyNy, NY, earlyNyNextMidnight) === true &&
    isPortalJobCallbackCoolingDown(
      earlyNy,
      NY,
      new Date(earlyNyElapsed.getTime() - 1),
    ) === true &&
    isPortalJobCallbackCoolingDown(earlyNy, NY, earlyNyElapsed) === false,
);
const earlyFallNy = zonedCivilToUtc(2026, 11, 1, 0, 0, 1, NY);
const earlyFallNyNextMidnight = addZonedCalendarDays(earlyFallNy, 1, NY);
const earlyFallNyElapsed = new Date(earlyFallNy.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
check(
  "Resolve at 00:00:01 on the New York fall-back day uses next midnight, later than resolve+24h",
  earlyFallNyNextMidnight.getTime() > earlyFallNyElapsed.getTime() &&
    portalJobCallbackCooldownAvailableAt(earlyFallNy, NY).getTime() ===
      earlyFallNyNextMidnight.getTime() &&
    isPortalJobCallbackCoolingDown(earlyFallNy, NY, earlyFallNyElapsed) === true &&
    isPortalJobCallbackCoolingDown(
      earlyFallNy,
      NY,
      new Date(earlyFallNyNextMidnight.getTime() - 1),
    ) === true &&
    isPortalJobCallbackCoolingDown(earlyFallNy, NY, earlyFallNyNextMidnight) === false,
);
const springNy = zonedCivilToUtc(2026, 3, 8, 0, 0, 0, NY);
const springNyNextMidnight = addZonedCalendarDays(springNy, 1, NY);
const springNyElapsed = new Date(springNy.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
check(
  "Spring-forward New York day keeps the 24-hour elapsed floor past the 23-hour midnight",
  springNyNextMidnight.toISOString() === "2026-03-09T04:00:00.000Z" &&
    springNyElapsed.getTime() - springNy.getTime() === PORTAL_JOB_CALLBACK_COOLDOWN_MS &&
    springNyElapsed.getTime() > springNyNextMidnight.getTime() &&
    portalJobCallbackCooldownAvailableAt(springNy, NY).getTime() === springNyElapsed.getTime() &&
    isPortalJobCallbackCoolingDown(springNy, NY, springNyNextMidnight) === true &&
    isPortalJobCallbackCoolingDown(
      springNy,
      NY,
      new Date(springNyElapsed.getTime() - 1),
    ) === true &&
    isPortalJobCallbackCoolingDown(springNy, NY, springNyElapsed) === false,
);
const fallNy = zonedCivilToUtc(2026, 11, 1, 0, 0, 0, NY);
const fallNyNextMidnight = addZonedCalendarDays(fallNy, 1, NY);
const fallNyElapsed = new Date(fallNy.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
check(
  "Fall-back New York day waits until the 25-hour local midnight, not resolve+24h",
  fallNyNextMidnight.toISOString() === "2026-11-02T05:00:00.000Z" &&
    fallNyNextMidnight.getTime() - fallNy.getTime() === 25 * 60 * 60 * 1000 &&
    fallNyNextMidnight.getTime() > fallNyElapsed.getTime() &&
    portalJobCallbackCooldownAvailableAt(fallNy, NY).getTime() ===
      fallNyNextMidnight.getTime(),
);
const latePhx = zonedCivilToUtc(2026, 3, 8, 23, 59, 59, PHX);
const earlyPhx = zonedCivilToUtc(2026, 3, 8, 0, 0, 1, PHX);
const lateAk = zonedCivilToUtc(2026, 10, 2, 23, 59, 59, AK);
const earlyAk = zonedCivilToUtc(2026, 10, 2, 0, 0, 1, AK);
check(
  "Phoenix (no DST) and Auckland (far offset) still apply max(elapsed 24h, next local midnight)",
  portalJobCallbackCooldownAvailableAt(latePhx, PHX).getTime() ===
    latePhx.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS &&
    portalJobCallbackCooldownAvailableAt(earlyPhx, PHX).getTime() ===
      earlyPhx.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS &&
    portalJobCallbackCooldownAvailableAt(lateAk, AK).getTime() ===
      lateAk.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS &&
    portalJobCallbackCooldownAvailableAt(earlyAk, AK).getTime() ===
      earlyAk.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS &&
    isPortalJobCallbackCoolingDown(
      latePhx,
      PHX,
      addZonedCalendarDays(latePhx, 1, PHX),
    ) === true &&
    isPortalJobCallbackCoolingDown(
      lateAk,
      AK,
      addZonedCalendarDays(lateAk, 1, AK),
    ) === true,
);
const havanaEve = zonedCivilToUtc(2026, 3, 7, 23, 0, 0, HAVANA);
const havanaNextMidnight = addZonedCalendarDays(havanaEve, 1, HAVANA);
const havanaAvailable = portalJobCallbackCooldownAvailableAt(havanaEve, HAVANA);
const havanaElapsed = new Date(havanaEve.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS);
check(
  "Skipped Havana midnight (Mar 8 00:00) cannot represent next local day; 24h elapsed floor still holds",
  havanaNextMidnight.getTime() <= havanaEve.getTime() &&
    havanaAvailable.getTime() === havanaElapsed.getTime() &&
    isPortalJobCallbackCoolingDown(havanaEve, HAVANA, havanaNextMidnight) === true &&
    isPortalJobCallbackCoolingDown(
      havanaEve,
      HAVANA,
      new Date(havanaElapsed.getTime() - 1),
    ) === true &&
    isPortalJobCallbackCoolingDown(havanaEve, HAVANA, havanaElapsed) === false,
);
const utcResolved = new Date("2026-10-02T14:00:00.000Z");
check(
  "Mutation: calendar-day-only or UTC-midnight-only would expire too early",
  calendarDayOnlyAvailableAt(lateNy, NY).getTime() === lateNyNextMidnight.getTime() &&
    calendarDayOnlyAvailableAt(lateNy, NY).getTime() !==
      portalJobCallbackCooldownAvailableAt(lateNy, NY).getTime() &&
    isPortalJobCallbackCoolingDown(lateNy, NY, calendarDayOnlyAvailableAt(lateNy, NY)) ===
      true &&
    utcMidnightOnlyAvailableAt(utcResolved).toISOString() === "2026-10-03T00:00:00.000Z" &&
    isPortalJobCallbackCoolingDown(
      utcResolved,
      NY,
      utcMidnightOnlyAvailableAt(utcResolved),
    ) === true &&
    portalJobCallbackCooldownAvailableAt(utcResolved, NY).getTime() ===
      utcResolved.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS &&
    resolveBusinessTimeZone({ timezone: null }) === DEFAULT_BUSINESS_TIMEZONE &&
    DEFAULT_BUSINESS_TIMEZONE === NY,
);
const submitSrc = opsSrc.slice(opsSrc.indexOf("export async function submitPortalJobCallback"));
const liveIdx = submitSrc.indexOf("findLiveJobByProjectToken");
const lockIdx = submitSrc.indexOf("lockTenantOwnedJob");
const recheckIdx = submitSrc.indexOf("assertLiveLockedProjectToken");
const existingIdx = submitSrc.indexOf("findOpenPortalCallback");
const cooldownIdx = submitSrc.indexOf("isPortalJobCallbackCoolingDown");
const createIdx = submitSrc.indexOf("tx.jobCallback.create");
check(
  "Write order is live-token lookup, lock, post-lock re-check, existing callback, then cooldown",
  liveIdx >= 0 &&
    lockIdx > liveIdx &&
    recheckIdx > lockIdx &&
    existingIdx > recheckIdx &&
    cooldownIdx > existingIdx &&
    createIdx > cooldownIdx &&
    opsSrc.includes("portalJobCallbackTestHooks.afterJobLock") &&
    dataSrc.includes("findLiveJobByProjectToken"),
);
check(
  "Cooldown copy states the at-least-24-hour wait and does not promise a visit or warranty",
  JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("at least 24 hours") &&
    !JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("tomorrow") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("not a warranty decision") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("does not promise coverage") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("does not schedule a visit") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("does not send a message") &&
    portalJobCallbackCooldownMessage("Oct 3, 2026, 12:00 AM").includes(
      "Next available Oct 3, 2026, 12:00 AM",
    ) &&
    !JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("we will call"),
);
check(
  "Write path does not create a job, promise coverage, or send a message",
  !opsSrc.includes("job.create") &&
    !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("payment.create") &&
    !opsSrc.includes("notifyCustomer") &&
    !opsSrc.includes("sendCustomer") &&
    !opsSrc.includes("emitAndProcessBusinessEvent") &&
    !actionSrc.includes("notifyCustomer") &&
    !formSrc.includes("warranty coverage") &&
    !formSrc.includes("covered under") &&
    JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE.includes("does not promise coverage") &&
    JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE.includes("not a warranty decision"),
);
check(
  "Portal request stays off global nav and AppShell",
  !navSrc.includes("callback") &&
    !navSrc.includes("JobCallback") &&
    !appShellSrc.includes("RequestJobCallbackForm") &&
    !appShellSrc.includes("portal-job-callback") &&
    portalSrc.includes("outside the authenticated (app) layout/AppShell"),
);
check(
  "Read model is mutation-free and dedicated npm script exists",
  !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(dataSrc) &&
    packageSrc.includes("test:portal-job-callback") &&
    packageSrc.includes("check-portal-job-callback.mjs") &&
    parsePortalJobCallbackPreferredContact("phone") === "PHONE" &&
    formatPortalCallbackDescription("Paint chip", "TEXT").includes("Preferred contact: Text"),
);
check(
  "No eval, Function, or raw-unsafe SQL in the dedicated portal files",
  featureFiles.every((file) => !DANGEROUS.test(read(file))),
);

try {
  const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
    encoding: "utf8",
  });
  if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
    throw new Error(createDb.stderr || createDb.stdout || "Failed to create portal job-callback test database.");
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    throw new Error("Failed to push schema for portal job-callback test database.");
  }

  const prisma = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "JobCallback_open_job_key"
    ON "JobCallback"("businessId", "jobId")
    WHERE "status" IN ('RECORDED', 'UNDER_REVIEW')
  `);

  const suffix = randomUUID().slice(0, 8);
  const ownerUser = await prisma.user.create({
    data: { name: "Owen", email: `owner-pcb-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-pcb-${suffix}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Portal Callback",
      slug: `alpha-pcb-${suffix}`,
      tradeCode: "HANDYMAN",
      timezone: NY,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Portal Callback",
      slug: `beta-pcb-${suffix}`,
      tradeCode: "CLEANING",
      timezone: LA,
    },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", memOwnerB.id, ownerBUser.id);

  async function createJob(businessId, options = {}) {
    const { status = "COMPLETED" } = options;
    const customer = await prisma.customer.create({
      data: {
        businessId,
        name: "Portal Callback Customer",
        email: `pcb-${randomUUID().slice(0, 6)}@example.com`,
      },
    });
    return {
      customer,
      job: await prisma.job.create({
        data: {
          businessId,
          customerId: customer.id,
          status,
          projectToken: randomUUID(),
        },
      }),
    };
  }

  const completedA = await createJob(businessA.id);
  const inProgressA = await createJob(businessA.id, { status: "IN_PROGRESS" });
  const completedB = await createJob(businessB.id);

  const invoicesBefore = await countBusinessInvoices(prisma, businessA.id);
  const jobsBefore = await countBusinessJobs(prisma, businessA.id);
  const paymentsBefore = await countBusinessPayments(prisma, businessA.id);
  const commsBefore = await countBusinessCommunications(prisma, businessA.id);

  console.log("\nINVALID TOKEN — empty, unknown, and oversized tokens fail closed");
  const empty = await submitPortalJobCallback(prisma, {
    token: "   ",
    description: "Paint chip",
    preferredContact: "PHONE",
  });
  check(
    "Empty token is unavailable",
    empty.ok === false && empty.error === JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  );
  const unknown = await submitPortalJobCallback(prisma, {
    token: randomUUID(),
    description: "Paint chip",
    preferredContact: "PHONE",
  });
  check(
    "Unknown token is unavailable",
    unknown.ok === false && unknown.error === JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  );
  const oversized = await submitPortalJobCallback(prisma, {
    token: "a".repeat(MAX_PORTAL_PROJECT_TOKEN_LENGTH + 1),
    description: "Paint chip",
    preferredContact: "PHONE",
  });
  check(
    "Oversized token is refused without a lookup write",
    oversized.ok === false &&
      oversized.error === JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE &&
      parsePortalProjectToken("a".repeat(MAX_PORTAL_PROJECT_TOKEN_LENGTH + 1)) === null,
  );
  const missingDescription = await submitPortalJobCallback(prisma, {
    token: completedA.job.projectToken,
    description: "   ",
    preferredContact: "PHONE",
  });
  check(
    "Blank description is refused",
    missingDescription.ok === false &&
      missingDescription.error === JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE,
  );
  const missingContact = await submitPortalJobCallback(prisma, {
    token: completedA.job.projectToken,
    description: "Paint chip",
    preferredContact: "CARRIER_PIGEON",
  });
  check(
    "Unknown preferred contact is refused",
    missingContact.ok === false &&
      missingContact.error === JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE,
  );

  console.log("\nELIGIBILITY — completed same-token job only");
  const tooEarly = await submitPortalJobCallback(prisma, {
    token: inProgressA.job.projectToken,
    description: "Too early",
    preferredContact: "EMAIL",
  });
  check(
    "In-progress job token is refused",
    tooEarly.ok === false && tooEarly.error === JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  );
  const hiddenInProgress = await loadPortalJobCallbackView(prisma, inProgressA.job.projectToken);
  check("In-progress portal view stays hidden", hiddenInProgress.status === "hidden");

  console.log("\nWRONG TENANT — browser IDs from another business are ignored");
  const spoofed = {
    token: completedA.job.projectToken,
    description: "Door hardware is loose.",
    preferredContact: "TEXT",
    businessId: businessB.id,
    customerId: completedB.customer.id,
    jobId: completedB.job.id,
  };
  const first = await submitPortalJobCallback(prisma, spoofed);
  check("Valid token accepts the request", first.ok === true && first.alreadyExists === false);
  const alphaRows = await prisma.jobCallback.findMany({
    where: { businessId: businessA.id, jobId: completedA.job.id },
  });
  const betaRows = await prisma.jobCallback.findMany({
    where: { businessId: businessB.id, jobId: completedB.job.id },
  });
  check(
    "Spoofed Beta IDs never write a Beta callback",
    alphaRows.length === 1 &&
      alphaRows[0].id === first.callbackId &&
      alphaRows[0].jobId === completedA.job.id &&
      alphaRows[0].businessId === businessA.id &&
      alphaRows[0].customerId === completedA.customer.id &&
      alphaRows[0].reportedVia === "PORTAL" &&
      alphaRows[0].status === "RECORDED" &&
      alphaRows[0].description.includes("Preferred contact: Text") &&
      alphaRows[0].description.includes("Door hardware is loose.") &&
      betaRows.length === 0,
  );
  const betaSubmit = await submitPortalJobCallback(prisma, {
    token: completedB.job.projectToken,
    description: "Beta-only report",
    preferredContact: "PHONE",
  });
  const alphaSeesBeta = await prisma.jobCallback.findMany({
    where: { ...ownerA.scope, id: betaSubmit.ok ? betaSubmit.callbackId : "missing" },
  });
  check(
    "Beta token writes only Beta and stays hidden from Alpha scope",
    betaSubmit.ok === true &&
      betaSubmit.jobId === completedB.job.id &&
      alphaSeesBeta.length === 0,
  );

  console.log("\nDUPLICATE — retries stay idempotent");
  const retry = await submitPortalJobCallback(prisma, {
    token: completedA.job.projectToken,
    description: "A different later sentence.",
    preferredContact: "EMAIL",
  });
  const afterRetry = await prisma.jobCallback.count({
    where: { businessId: businessA.id, jobId: completedA.job.id },
  });
  check(
    "Second submit returns the same open callback without rewriting it",
    retry.ok === true &&
      retry.alreadyExists === true &&
      retry.callbackId === first.callbackId &&
      afterRetry === 1 &&
      (await prisma.jobCallback.findFirst({ where: { id: first.callbackId } }))
        ?.description.includes("Door hardware is loose.") === true,
  );
  const alreadyView = await loadPortalJobCallbackView(prisma, completedA.job.projectToken);
  check("Portal view reports the request already received", alreadyView.status === "already_requested");

  console.log("\nREVIEW PATH — OWNER can review the portal-created row");
  const review = await loadJobCallbackReview(prisma, ownerA, completedA.job.id);
  check(
    "Owner review loader sees the portal callback",
    review?.openCallbackId === first.callbackId &&
      review?.callbacks[0]?.reportedVia === "PORTAL" &&
      review?.callbacks[0]?.status === "RECORDED",
  );
  const reviewed = await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: first.callbackId,
  });
  check(
    "Existing review path moves the portal callback to UNDER_REVIEW",
    reviewed.callback.status === "UNDER_REVIEW" && reviewed.unchanged === false,
  );
  const stillIdempotent = await submitPortalJobCallback(prisma, {
    token: completedA.job.projectToken,
    description: "Retry after owner review",
    preferredContact: "PHONE",
  });
  check(
    "Retry after review still returns the same open callback",
    stillIdempotent.ok === true &&
      stillIdempotent.alreadyExists === true &&
      stillIdempotent.callbackId === first.callbackId,
  );

  console.log("\nCOOLDOWN — portal cannot re-file immediately after OWNER resolves");
  const isolationReady = await createJob(businessA.id);
  const laterSeed = await createJob(businessA.id);
  const outcome = await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: first.callbackId,
    outcome: "RECORDED_ONLY",
    outcomeNotes: "Operational close only.",
  });
  check(
    "Owner outcome closes the portal callback",
    outcome.callback.status === "OUTCOME_RECORDED" && outcome.unchanged === false,
  );
  const cooldownView = await loadPortalJobCallbackView(prisma, completedA.job.projectToken);
  const isolationView = await loadPortalJobCallbackView(
    prisma,
    isolationReady.job.projectToken,
  );
  const betaOpenView = await loadPortalJobCallbackView(prisma, completedB.job.projectToken);
  check(
    "Resolved token shows cooldown; other tokens stay isolated",
    cooldownView.status === "cooldown" &&
      cooldownView.jobId === completedA.job.id &&
      cooldownView.availableAt instanceof Date &&
      cooldownView.availableAt.getTime() ===
        portalJobCallbackCooldownAvailableAt(outcome.callback.outcomeAt, NY).getTime() &&
      isolationView.status === "ready" &&
      isolationView.jobId === isolationReady.job.id &&
      betaOpenView.status === "already_requested" &&
      betaOpenView.jobId === completedB.job.id,
  );
  const immediateRefile = await submitPortalJobCallback(prisma, {
    token: completedA.job.projectToken,
    description: "Trying again right away",
    preferredContact: "PHONE",
  });
  const isolationSubmit = await submitPortalJobCallback(prisma, {
    token: isolationReady.job.projectToken,
    description: "Different job, same business",
    preferredContact: "EMAIL",
  });
  const afterImmediate = await prisma.jobCallback.count({
    where: { businessId: businessA.id, jobId: completedA.job.id },
  });
  check(
    "Immediate portal re-file is refused; a different token is not blocked",
    immediateRefile.ok === false &&
      immediateRefile.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE &&
      afterImmediate === 1 &&
      isolationSubmit.ok === true &&
      isolationSubmit.alreadyExists === false &&
      isolationSubmit.jobId === isolationReady.job.id,
  );

  const cooldownRaceA = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const cooldownRaceB = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const cooldownBarrier = createWriteBarrier(2, 5000);
  const cooldownConcurrent = await Promise.allSettled([
    (async () => {
      await cooldownBarrier.arriveAndWait();
      return submitPortalJobCallback(cooldownRaceA, {
        token: completedA.job.projectToken,
        description: "Cooldown race A",
        preferredContact: "PHONE",
      });
    })(),
    (async () => {
      await cooldownBarrier.arriveAndWait();
      return submitPortalJobCallback(cooldownRaceB, {
        token: completedA.job.projectToken,
        description: "Cooldown race B",
        preferredContact: "TEXT",
      });
    })(),
  ]);
  const cooldownRefused = cooldownConcurrent.filter(
    (row) =>
      row.status === "fulfilled" &&
      row.value.ok === false &&
      row.value.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE,
  );
  check(
    "Concurrent portal re-files during cooldown are both refused",
    cooldownConcurrent.length === 2 &&
      cooldownRefused.length === 2 &&
      (await prisma.jobCallback.count({
        where: { businessId: businessA.id, jobId: completedA.job.id },
      })) === 1,
  );

  const ownerUrgent = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: completedA.job.id,
    description: "Owner recorded an urgent phone callback during the portal wait.",
    reportedVia: "PHONE",
  });
  const afterOwnerUrgent = await loadPortalJobCallbackView(
    prisma,
    completedA.job.projectToken,
  );
  check(
    "OWNER can record an urgent callback during the portal cooldown",
    ownerUrgent.status === "RECORDED" &&
      ownerUrgent.jobId === completedA.job.id &&
      ownerUrgent.reportedVia === "PHONE" &&
      afterOwnerUrgent.status === "already_requested",
  );

  const laterFirst = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "First later-job request",
    preferredContact: "TEXT",
  });
  if (!laterFirst.ok) {
    throw new Error(laterFirst.error);
  }
  await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: laterFirst.callbackId,
  });
  const laterOutcome = await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: laterFirst.callbackId,
    outcome: "RECORDED_ONLY",
  });
  const todayStartNy = startOfZonedDay(new Date(), NY);
  const stillTodayNy = new Date(todayStartNy.getTime() + 60_000);
  await prisma.jobCallback.update({
    where: { id: laterFirst.callbackId },
    data: { outcomeAt: stillTodayNy },
  });
  const insideBoundary = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "Still the same New York calendar day",
    preferredContact: "PHONE",
  });
  const insideView = await loadPortalJobCallbackView(prisma, laterSeed.job.projectToken);
  const forgedShorten = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "Forged timestamps must not shorten the wait",
    preferredContact: "PHONE",
    outcomeAt: new Date(0),
    timezone: "UTC",
    resolvedAt: new Date(0),
    availableAt: new Date(0),
    businessId: businessB.id,
    customerId: completedB.customer.id,
    jobId: completedB.job.id,
  });
  check(
    "A resolve earlier today in America/New_York still refuses a portal re-file",
    laterOutcome.callback.status === "OUTCOME_RECORDED" &&
      insideBoundary.ok === false &&
      insideBoundary.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE &&
      insideView.status === "cooldown",
  );
  check(
    "Forged customer outcomeAt/timezone fields cannot shorten the cooldown",
    forgedShorten.ok === false &&
      forgedShorten.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE &&
      (await prisma.jobCallback.count({
        where: { businessId: businessA.id, jobId: laterSeed.job.id },
      })) === 1 &&
      (await prisma.jobCallback.count({
        where: { businessId: businessB.id, jobId: completedB.job.id },
      })) === 1,
  );

  const justInsideElapsed = new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS + 1);
  await prisma.jobCallback.update({
    where: { id: laterFirst.callbackId },
    data: { outcomeAt: justInsideElapsed },
  });
  const oneMsInside = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "One millisecond inside the elapsed 24-hour floor",
    preferredContact: "TEXT",
  });
  check(
    "Exactly resolve+24h-1ms is still refused",
    oneMsInside.ok === false && oneMsInside.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE,
  );

  const atElapsedBoundary = new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS);
  await prisma.jobCallback.update({
    where: { id: laterFirst.callbackId },
    data: { outcomeAt: atElapsedBoundary },
  });
  const laterView = await loadPortalJobCallbackView(prisma, laterSeed.job.projectToken);
  const laterSecond = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "Legitimate later request after 24 elapsed hours",
    preferredContact: "EMAIL",
  });
  const laterCount = await prisma.jobCallback.count({
    where: { businessId: businessA.id, jobId: laterSeed.job.id },
  });
  check(
    "Exactly resolve+24h is accepted when that instant is not before next local midnight",
    laterView.status === "ready" &&
      laterSecond.ok === true &&
      laterSecond.alreadyExists === false &&
      laterSecond.callbackId !== laterFirst.callbackId &&
      laterCount === 2,
  );

  const newestSeed = await createJob(businessA.id);
  const oldestResolved = await submitPortalJobCallback(prisma, {
    token: newestSeed.job.projectToken,
    description: "Older resolved callback",
    preferredContact: "PHONE",
  });
  if (!oldestResolved.ok) {
    throw new Error(oldestResolved.error);
  }
  await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: oldestResolved.callbackId,
  });
  await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: oldestResolved.callbackId,
    outcome: "RECORDED_ONLY",
  });
  const newestResolved = await recordCustomerReportedCallback(prisma, ownerA, {
    jobId: newestSeed.job.id,
    description: "Newer resolved callback",
    reportedVia: "PHONE",
  });
  await reviewCustomerReportedCallback(prisma, ownerA, {
    callbackId: newestResolved.id,
  });
  await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: newestResolved.id,
    outcome: "RECORDED_ONLY",
  });
  const laterCreatedOutside = new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS * 2);
  const earlierCreatedInside = new Date(Date.now() - 60_000);
  await prisma.jobCallback.update({
    where: { id: oldestResolved.callbackId },
    data: { outcomeAt: earlierCreatedInside },
  });
  await prisma.jobCallback.update({
    where: { id: newestResolved.id },
    data: { outcomeAt: laterCreatedOutside },
  });
  const pickedInside = await findLatestResolvedJobCallback(
    prisma,
    businessA.id,
    newestSeed.job.id,
  );
  const newestInsideView = await loadPortalJobCallbackView(
    prisma,
    newestSeed.job.projectToken,
  );
  const newestInsideSubmit = await submitPortalJobCallback(prisma, {
    token: newestSeed.job.projectToken,
    description: "Should follow the newest outcomeAt, not createdAt",
    preferredContact: "EMAIL",
  });
  const earlierCreatedOutside = new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS);
  await prisma.jobCallback.update({
    where: { id: oldestResolved.callbackId },
    data: { outcomeAt: earlierCreatedOutside },
  });
  const pickedOutside = await findLatestResolvedJobCallback(
    prisma,
    businessA.id,
    newestSeed.job.id,
  );
  const newestOutsideView = await loadPortalJobCallbackView(
    prisma,
    newestSeed.job.projectToken,
  );
  const newestOutsideSubmit = await submitPortalJobCallback(prisma, {
    token: newestSeed.job.projectToken,
    description: "Newest outcomeAt is outside the wait",
    preferredContact: "TEXT",
  });
  check(
    "Newest resolved callback wins the elapsed-plus-calendar-day cooldown",
    pickedInside?.id === oldestResolved.callbackId &&
      newestInsideView.status === "cooldown" &&
      newestInsideSubmit.ok === false &&
      newestInsideSubmit.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE &&
      pickedOutside?.id === oldestResolved.callbackId &&
      newestOutsideView.status === "ready" &&
      newestOutsideSubmit.ok === true &&
      newestOutsideSubmit.alreadyExists === false &&
      newestOutsideSubmit.callbackId !== oldestResolved.callbackId &&
      newestOutsideSubmit.callbackId !== newestResolved.id,
  );

  console.log("\nTIMEZONE — each tenant uses its own Business.timezone calendar day");
  const tzNySeed = await createJob(businessA.id);
  const tzLaSeed = await createJob(businessB.id);
  const tzNyFirst = await submitPortalJobCallback(prisma, {
    token: tzNySeed.job.projectToken,
    description: "NY timezone cooldown seed",
    preferredContact: "PHONE",
  });
  const tzLaFirst = await submitPortalJobCallback(prisma, {
    token: tzLaSeed.job.projectToken,
    description: "LA timezone cooldown seed",
    preferredContact: "TEXT",
  });
  if (!tzNyFirst.ok || !tzLaFirst.ok) {
    throw new Error(tzNyFirst.ok ? tzLaFirst.error : tzNyFirst.error);
  }
  await reviewCustomerReportedCallback(prisma, ownerA, { callbackId: tzNyFirst.callbackId });
  await recordCustomerReportedCallbackOutcome(prisma, ownerA, {
    callbackId: tzNyFirst.callbackId,
    outcome: "RECORDED_ONLY",
  });
  await reviewCustomerReportedCallback(prisma, ownerB, { callbackId: tzLaFirst.callbackId });
  await recordCustomerReportedCallbackOutcome(prisma, ownerB, {
    callbackId: tzLaFirst.callbackId,
    outcome: "RECORDED_ONLY",
  });
  await prisma.jobCallback.update({
    where: { id: tzNyFirst.callbackId },
    data: { outcomeAt: new Date(Date.now() - 60_000) },
  });
  await prisma.jobCallback.update({
    where: { id: tzLaFirst.callbackId },
    data: { outcomeAt: new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS) },
  });
  const tzNyView = await loadPortalJobCallbackView(prisma, tzNySeed.job.projectToken);
  const tzLaView = await loadPortalJobCallbackView(prisma, tzLaSeed.job.projectToken);
  const tzNySubmit = await submitPortalJobCallback(prisma, {
    token: tzNySeed.job.projectToken,
    description: "NY should still be cooling down on its own calendar day",
    preferredContact: "EMAIL",
  });
  const tzLaSubmit = await submitPortalJobCallback(prisma, {
    token: tzLaSeed.job.projectToken,
    description: "LA previous calendar day should accept",
    preferredContact: "PHONE",
  });
  check(
    "New York still cooling down does not block a Los Angeles token whose 24-hour wait has elapsed",
    tzNyView.status === "cooldown" &&
      tzNyView.jobId === tzNySeed.job.id &&
      tzNySubmit.ok === false &&
      tzNySubmit.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE &&
      tzLaView.status === "ready" &&
      tzLaView.jobId === tzLaSeed.job.id &&
      tzLaSubmit.ok === true &&
      tzLaSubmit.alreadyExists === false &&
      tzLaSubmit.jobId === tzLaSeed.job.id &&
      (await prisma.jobCallback.count({
        where: { businessId: businessA.id, jobId: tzNySeed.job.id },
      })) === 1 &&
      (await prisma.jobCallback.count({
        where: { businessId: businessB.id, jobId: tzLaSeed.job.id },
      })) === 2,
  );

  console.log("\nCONCURRENT — two token submits create one open callback");
  const concurrentSeed = await createJob(businessA.id);
  const raceA = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const raceB = trackClient(new PrismaClient({ datasourceUrl: testUrl }));
  const barrier = createWriteBarrier(2, 5000);
  const concurrent = await Promise.allSettled([
    (async () => {
      await barrier.arriveAndWait();
      return submitPortalJobCallback(raceA, {
        token: concurrentSeed.job.projectToken,
        description: "Concurrent A",
        preferredContact: "PHONE",
      });
    })(),
    (async () => {
      await barrier.arriveAndWait();
      return submitPortalJobCallback(raceB, {
        token: concurrentSeed.job.projectToken,
        description: "Concurrent B",
        preferredContact: "TEXT",
      });
    })(),
  ]);
  const concurrentOk = concurrent.filter(
    (row) => row.status === "fulfilled" && row.value.ok === true,
  );
  const concurrentIds = new Set(concurrentOk.map((row) => row.value.callbackId));
  const concurrentCount = await prisma.jobCallback.count({
    where: { businessId: businessA.id, jobId: concurrentSeed.job.id },
  });
  check(
    "Concurrent portal submits create exactly one open callback and both succeed",
    concurrent.length === 2 &&
      concurrentOk.length === 2 &&
      concurrentIds.size === 1 &&
      concurrentCount === 1,
  );

  console.log("\nSIDE EFFECTS — no invoice, extra job, payment, or customer message");
  check(
    "Invoice / job / payment / communication counts stay honest",
    (await countBusinessInvoices(prisma, businessA.id)) === invoicesBefore &&
      (await countBusinessJobs(prisma, businessA.id)) === jobsBefore + 5 &&
      (await countBusinessPayments(prisma, businessA.id)) === paymentsBefore &&
      (await countBusinessCommunications(prisma, businessA.id)) === commsBefore,
  );
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  for (const client of clients) {
    try {
      await client.$disconnect();
    } catch {
      // Keep dropping the dedicated test database even if one disconnect fails.
    }
  }
  spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`],
    { encoding: "utf8" },
  );
}

console.log(
  failed === 0
    ? `\nAll portal job-callback checks passed (${passed}).`
    : `\n${failed} portal job-callback check(s) failed.`,
);
process.exitCode = failed === 0 ? 0 : 1;
