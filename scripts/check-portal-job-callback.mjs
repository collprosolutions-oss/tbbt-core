/**
 * Customer Project Portal callback request against a completed job.
 *
 * Dedicated database: tbbt_portal_job_callback_test
 *
 * Proves token-only ownership, invalid-token refusal, wrong-tenant
 * isolation, duplicate/retry idempotency, concurrent submit, and the
 * bounded post-outcome portal cooldown on a dedicated local DB. Reuses
 * the existing OWNER JobCallback review path. OWNER can still record an
 * urgent callback during the portal cooldown. Does not create a job,
 * promise warranty coverage, or send a message.
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
  JOB_CALLBACK_PORTAL_COMPLETED_JOB_MESSAGE,
  JOB_CALLBACK_PORTAL_CONTACT_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE,
  JOB_CALLBACK_PORTAL_DESCRIPTION_REQUIRED_MESSAGE,
  JOB_CALLBACK_PORTAL_RECEIVED_MESSAGE,
  JOB_CALLBACK_PORTAL_UNAVAILABLE_MESSAGE,
  JOB_CALLBACK_PORTAL_WORKFLOW_MESSAGE,
  MAX_PORTAL_JOB_CALLBACK_DESCRIPTION_LENGTH,
  MAX_PORTAL_PROJECT_TOKEN_LENGTH,
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
const { loadPortalJobCallbackView } = await import("@/lib/portal-job-callback-data");
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
const actionSrc = read("src/app/actions/portal-job-callback.ts");
const formSrc = read("src/components/portal/request-job-callback-form.tsx");
const portalSrc = read("src/app/p/[token]/page.tsx");
const ownerActionSrc = read("src/app/actions/job-callback.ts");
const ownerOpsSrc = read("src/lib/job-callback-ops.ts");
const navSrc = read("src/lib/nav.ts");
const appShellSrc = read("src/components/app-shell.tsx");
const packageSrc = read("package.json");

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
  "Portal cooldown is a bounded 24 hours and OWNER record is not cooled down",
  PORTAL_JOB_CALLBACK_COOLDOWN_HOURS === 24 &&
    PORTAL_JOB_CALLBACK_COOLDOWN_MS === 24 * 60 * 60 * 1000 &&
    opsSrc.includes("isPortalJobCallbackCoolingDown") &&
    opsSrc.includes("JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE") &&
    dataSrc.includes('status: "cooldown"') &&
    portalSrc.includes("portalJobCallbackCooldownMessage") &&
    !ownerOpsSrc.includes("isPortalJobCallbackCoolingDown") &&
    !ownerOpsSrc.includes("PORTAL_JOB_CALLBACK_COOLDOWN") &&
    !ownerActionSrc.includes("isPortalJobCallbackCoolingDown"),
);
const cooldownNow = new Date("2026-10-02T12:00:00.000Z");
check(
  "Cooldown boundary is exclusive of the 24-hour mark",
  isPortalJobCallbackCoolingDown(
    new Date(cooldownNow.getTime() - PORTAL_JOB_CALLBACK_COOLDOWN_MS + 1),
    cooldownNow,
  ) === true &&
    isPortalJobCallbackCoolingDown(
      new Date(cooldownNow.getTime() - PORTAL_JOB_CALLBACK_COOLDOWN_MS),
      cooldownNow,
    ) === false &&
    isPortalJobCallbackCoolingDown(
      new Date(cooldownNow.getTime() - PORTAL_JOB_CALLBACK_COOLDOWN_MS - 1),
      cooldownNow,
    ) === false &&
    portalJobCallbackCooldownAvailableAt(cooldownNow).getTime() ===
      cooldownNow.getTime() + PORTAL_JOB_CALLBACK_COOLDOWN_MS,
);
check(
  "Cooldown copy states the 24-hour wait and does not promise a visit or warranty",
  JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("after 24 hours") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("not a warranty decision") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("does not promise coverage") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("does not schedule a visit") &&
    JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE.includes("does not send a message") &&
    portalJobCallbackCooldownMessage("Oct 3, 2026, 12:00 PM").includes(
      "Next available Oct 3, 2026, 12:00 PM",
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
    data: { name: "Alpha Portal Callback", slug: `alpha-pcb-${suffix}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Portal Callback", slug: `beta-pcb-${suffix}`, tradeCode: "CLEANING" },
  });

  const memOwnerA = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memOwnerB = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", memOwnerA.id, ownerUser.id);

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
        portalJobCallbackCooldownAvailableAt(outcome.callback.outcomeAt).getTime() &&
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
  const justInside = new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS + 60_000);
  await prisma.jobCallback.update({
    where: { id: laterFirst.callbackId },
    data: { outcomeAt: justInside },
  });
  const insideBoundary = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "Still inside the 24-hour wait",
    preferredContact: "PHONE",
  });
  const insideView = await loadPortalJobCallbackView(prisma, laterSeed.job.projectToken);
  check(
    "Sixty seconds inside the 24-hour mark still refuses a portal re-file",
    laterOutcome.callback.status === "OUTCOME_RECORDED" &&
      insideBoundary.ok === false &&
      insideBoundary.error === JOB_CALLBACK_PORTAL_COOLDOWN_MESSAGE &&
      insideView.status === "cooldown",
  );

  const atBoundary = new Date(Date.now() - PORTAL_JOB_CALLBACK_COOLDOWN_MS);
  await prisma.jobCallback.update({
    where: { id: laterFirst.callbackId },
    data: { outcomeAt: atBoundary },
  });
  const laterView = await loadPortalJobCallbackView(prisma, laterSeed.job.projectToken);
  const laterSecond = await submitPortalJobCallback(prisma, {
    token: laterSeed.job.projectToken,
    description: "Legitimate later request after the wait",
    preferredContact: "EMAIL",
  });
  const laterCount = await prisma.jobCallback.count({
    where: { businessId: businessA.id, jobId: laterSeed.job.id },
  });
  check(
    "A later portal request is accepted at the 24-hour boundary",
    laterView.status === "ready" &&
      laterSecond.ok === true &&
      laterSecond.alreadyExists === false &&
      laterSecond.callbackId !== laterFirst.callbackId &&
      laterCount === 2,
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
      (await countBusinessJobs(prisma, businessA.id)) === jobsBefore + 3 &&
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
