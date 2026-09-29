/**
 * OWNER warranty statements and customer-reported callbacks.
 *
 * Proves OWNER-only access, unauthenticated denial, tenant isolation
 * (including guessed ids), completed-job eligibility, warranty display of
 * only recorded terms, and that recording or resolving a callback does not
 * create a job, invoice, or message.
 *
 * Uses a dedicated disposable database. Refuses a non-local DATABASE_URL.
 *
 * Run with:
 *   npm run test:warranty-callbacks
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for warranty callback checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const {
  NO_WARRANTY_TERMS_RECORDED_MESSAGE,
  WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE,
  WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE,
  WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE,
  WARRANTY_CALLBACK_NOT_FOUND_MESSAGE,
  WARRANTY_CALLBACK_OUTCOME_REQUIRED_MESSAGE,
  WARRANTY_CALLBACK_OWNER_ONLY_MESSAGE,
  WARRANTY_CALLBACK_REPORT_REQUIRED_MESSAGE,
  WARRANTY_CALLBACK_REVIEW_FIRST_MESSAGE,
  WARRANTY_CALLBACK_UNAUTHENTICATED_MESSAGE,
  WARRANTY_STATEMENT_REQUIRED_MESSAGE,
  WARRANTY_TERMS_ONLY_RECORDED_MESSAGE,
  assertWarrantyCallbackActor,
  canAccessWarrantyCallbacks,
  displayRecordedWarrantyTerms,
  warrantyDisplayHasInventedDuration,
} = await import("@/lib/warranty-callback");
const {
  WarrantyCallbackError,
  countWarrantyCallbackSideEffects,
  loadJobWarrantyCallbackReview,
  recordCustomerWarrantyCallback,
  recordJobWarrantyTerm,
  recordWarrantyCallbackOutcome,
  reviewWarrantyCallback,
} = await import("@/lib/warranty-callback-ops");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const parsedBase = new URL(baseUrl);
const localHost =
  parsedBase.hostname === "localhost" ||
  parsedBase.hostname === "127.0.0.1" ||
  parsedBase.hostname === "::1";
if (!localHost) {
  console.error(
    "Refusing to run warranty callback checks against a non-local database.",
  );
  process.exit(1);
}

const testDbName = "tbbt_warranty_callback_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
if (parsed.pathname === parsedBase.pathname) {
  console.error("Refusing to use the shared DATABASE_URL database for warranty callback checks.");
  process.exit(1);
}

{
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  await admin.$queryRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    testDbName,
  );
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDbName}"`);
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for warranty callback test database.");
  process.exit(push.status ?? 1);
}

const migrationPath = new URL(
  "../prisma/migrations/20260929003117_warranty_and_callback_records/migration.sql",
  import.meta.url,
);
const psqlUrl = new URL(testUrl);
psqlUrl.search = "";
const applyMigration = spawnSync(
  "psql",
  [psqlUrl.toString(), "-v", "ON_ERROR_STOP=1", "-f", migrationPath.pathname],
  { encoding: "utf8" },
);
if (applyMigration.status !== 0) {
  console.error(applyMigration.stderr || applyMigration.stdout);
  console.error("Failed to apply the warranty callback migration on the disposable database.");
  process.exit(applyMigration.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

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
    console.error(`FAIL - ${label} (no error thrown)`);
    failures += 1;
  } catch (error) {
    if (predicate(error)) {
      console.log(`  ok  - ${label}`);
    } else {
      console.error(`FAIL - ${label}`, error);
      failures += 1;
    }
  }
}

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function sameCounts(left, right) {
  return (
    left.jobs === right.jobs &&
    left.invoices === right.invoices &&
    left.communications === right.communications &&
    left.threads === right.threads &&
    left.phoneInteractions === right.phoneInteractions
  );
}

const BETA_CALLBACK = "BETA-ONLY-CALLBACK-77f3";
const BETA_WARRANTY = "BETA-ONLY-WARRANTY-written-by-beta";
const VAULT_PHRASE = "VAULT-90-DAY-WARRANTY-NOT-JOB-COVERAGE";
const LINE_PHRASE = "LINE-1-YEAR-WORKMANSHIP-NOT-A-RECORDED-TERM";
const OWNER_STATEMENT = "Replace a loose hinge only if the signed paperwork says so.";

console.log("\nSTATIC — OWNER gate, no global nav, no invented coverage");
const navSrc = readRepo("src/lib/nav.ts");
const pageSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const actionSrc = readRepo("src/app/actions/warranty-callback.ts");
const opsSrc = readRepo("src/lib/warranty-callback-ops.ts");
const domainSrc = readRepo("src/lib/warranty-callback.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const customerBlock = schemaSrc.slice(
  schemaSrc.indexOf("model Customer {"),
  schemaSrc.indexOf("model CommunicationThread {"),
);

check("Global nav has no warranty callback destination", !/warranty/i.test(navSrc));
check(
  "Job page is the entry point and loads callbacks only for OWNER",
  pageSrc.includes("Warranty and callbacks") &&
    pageSrc.includes('access.workspace.role === "OWNER"') &&
    pageSrc.includes("loadJobWarrantyCallbackReview") &&
    pageSrc.includes("requireManagementPageAccess"),
);
check(
  "Callback actions authenticate before any write",
  ["recordWarrantyTermAction", "recordWarrantyCallbackAction", "reviewWarrantyCallbackAction", "recordWarrantyCallbackOutcomeAction"].every(
    (name) => {
      const start = actionSrc.indexOf(`export async function ${name}`);
      const next = actionSrc.indexOf("export async function", start + 20);
      const body = actionSrc.slice(start, next === -1 ? undefined : next);
      const gate = body.indexOf("requireOperatingBusinessAccessForForm");
      const write = body.search(/await (record|review)/);
      return gate !== -1 && write !== -1 && gate < write;
    },
  ),
);
check(
  "Ops stay trade-neutral and do not create jobs, invoices, or messages",
  !opsSrc.includes("CLEANING") &&
    !opsSrc.includes("tradeCode") &&
    !opsSrc.includes("job.create") &&
    !opsSrc.includes("invoice.create") &&
    !opsSrc.includes("customerCommunication") &&
    !opsSrc.includes("phoneInteraction.create") &&
    !domainSrc.includes("365") &&
    !domainSrc.includes("90 days") &&
    !domainSrc.includes("one year"),
);
check(
  "Customer model is unchanged by this feature",
  !customerBlock.includes("JobWarrantyCallback") && !customerBlock.includes("JobWarrantyTerm"),
);

const blankDisplay = displayRecordedWarrantyTerms([
  { id: "blank", statement: "   ", createdAt: new Date() },
]);
check(
  "Blank stored text is not turned into coverage",
  blankDisplay.recorded === false &&
    blankDisplay.emptyMessage === NO_WARRANTY_TERMS_RECORDED_MESSAGE &&
    blankDisplay.statements.length === 0 &&
    !warrantyDisplayHasInventedDuration(blankDisplay) &&
    !/\b(\d+|day|days|month|months|year|years)\b/i.test(blankDisplay.emptyMessage),
);
check("OWNER is the only role that can open warranty callbacks", canAccessWarrantyCallbacks("OWNER"));
check("ADMIN cannot open warranty callbacks", !canAccessWarrantyCallbacks("ADMIN"));
check("MEMBER cannot open warranty callbacks", !canAccessWarrantyCallbacks("MEMBER"));
check("Missing role cannot open warranty callbacks", !canAccessWarrantyCallbacks(null));

try {
  console.log("\nLIVE — disposable database");
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-wcb-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery Admin", email: `admin-wcb-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-wcb-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Blair Owner", email: `beta-wcb-${randomUUID()}@example.com`, passwordHash: "x" },
  });

  const businessA = await prisma.business.create({
    data: { name: "Alpha Warranty", slug: `alpha-wcb-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Warranty", slug: `beta-wcb-${randomUUID().slice(0, 8)}`, tradeCode: "CLEANING" },
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
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id);

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Customer" },
  });
  const otherCustomerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Other Customer" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Bea Customer" },
  });

  async function createJob(businessId, status, customerId) {
    return prisma.job.create({
      data: {
        businessId,
        customerId: customerId ?? null,
        projectToken: randomUUID(),
        status,
      },
    });
  }

  const completedA = await createJob(businessA.id, "COMPLETED", customerA.id);
  const scheduledA = await createJob(businessA.id, "SCHEDULED", customerA.id);
  const unscheduledA = await createJob(businessA.id, "UNSCHEDULED", customerA.id);
  const inProgressA = await createJob(businessA.id, "IN_PROGRESS", customerA.id);
  const completedNoCustomer = await createJob(businessA.id, "COMPLETED", null);
  const completedB = await createJob(businessB.id, "COMPLETED", customerB.id);

  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      jobId: completedA.id,
      description: LINE_PHRASE,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "OTHER",
    },
  });
  await prisma.businessVaultRecord.create({
    data: {
      businessId: businessA.id,
      title: "Company warranty file",
      category: "WARRANTY",
      notes: VAULT_PHRASE,
      createdByMembershipId: ownerMem.id,
    },
  });

  await expectError(
    "Unauthenticated caller is denied",
    () => assertWarrantyCallbackActor(null),
    (error) => error instanceof ForbiddenError && error.message === WARRANTY_CALLBACK_UNAUTHENTICATED_MESSAGE,
  );
  await expectError(
    "Access without a membership is denied",
    () => assertWarrantyCallbackActor({ businessId: businessA.id, workspace: { role: "OWNER" } }),
    (error) => error instanceof ForbiddenError && error.message === WARRANTY_CALLBACK_UNAUTHENTICATED_MESSAGE,
  );
  await expectError(
    "ADMIN cannot record a callback",
    () => recordCustomerWarrantyCallback(prisma, adminA, { jobId: completedA.id, report: "Door sticks" }),
    (error) => error instanceof ForbiddenError && error.message === WARRANTY_CALLBACK_OWNER_ONLY_MESSAGE,
  );
  await expectError(
    "MEMBER cannot record a callback",
    () => recordCustomerWarrantyCallback(prisma, memberA, { jobId: completedA.id, report: "Door sticks" }),
    (error) => error instanceof ForbiddenError && error.message === WARRANTY_CALLBACK_OWNER_ONLY_MESSAGE,
  );
  await expectError(
    "ADMIN cannot read callbacks",
    () => loadJobWarrantyCallbackReview(prisma, adminA, completedA.id),
    (error) => error instanceof ForbiddenError,
  );
  await expectError(
    "Unauthenticated read is denied",
    () => loadJobWarrantyCallbackReview(prisma, null, completedA.id),
    (error) => error instanceof ForbiddenError && error.message === WARRANTY_CALLBACK_UNAUTHENTICATED_MESSAGE,
  );

  const deniedCount = await prisma.jobWarrantyCallback.count();
  check("Denied roles created no callback rows", deniedCount === 0);

  for (const job of [scheduledA, unscheduledA, inProgressA]) {
    await expectError(
      `${job.status} job is rejected`,
      () => recordCustomerWarrantyCallback(prisma, ownerA, { jobId: job.id, report: "Customer called" }),
      (error) =>
        error instanceof WarrantyCallbackError &&
        error.message === WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE,
    );
  }
  check(
    "Rejected jobs created no callback rows",
    (await prisma.jobWarrantyCallback.count()) === 0,
  );

  const before = await countWarrantyCallbackSideEffects(prisma);
  const jobBefore = await prisma.job.findUnique({ where: { id: completedA.id } });

  const emptyReview = await loadJobWarrantyCallbackReview(prisma, ownerA, completedA.id);
  check(
    "A completed job with no recorded terms says so plainly",
    emptyReview?.completed === true &&
      emptyReview.warranty.recorded === false &&
      emptyReview.warranty.emptyMessage === NO_WARRANTY_TERMS_RECORDED_MESSAGE &&
      emptyReview.warranty.statements.length === 0 &&
      !warrantyDisplayHasInventedDuration(emptyReview.warranty) &&
      !JSON.stringify(emptyReview).includes(LINE_PHRASE) &&
      !JSON.stringify(emptyReview).includes(VAULT_PHRASE) &&
      emptyReview.callbacks.length === 0,
  );
  check(
    "Display copy does not invent coverage",
    WARRANTY_TERMS_ONLY_RECORDED_MESSAGE.includes("does not add coverage or a duration"),
  );

  await expectError(
    "Empty warranty statement is rejected",
    () => recordJobWarrantyTerm(prisma, ownerA, { jobId: completedA.id, statement: "  " }),
    (error) => error instanceof WarrantyCallbackError && error.message === WARRANTY_STATEMENT_REQUIRED_MESSAGE,
  );
  await expectError(
    "Empty customer report is rejected",
    () => recordCustomerWarrantyCallback(prisma, ownerA, { jobId: completedA.id, report: " " }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_REPORT_REQUIRED_MESSAGE,
  );

  const term = await recordJobWarrantyTerm(prisma, ownerA, {
    jobId: completedA.id,
    statement: OWNER_STATEMENT,
  });
  check(
    "Recorded warranty statement is stored exactly",
    term.statement === OWNER_STATEMENT && term.businessId === businessA.id && term.jobId === completedA.id,
  );

  const recordedReview = await loadJobWarrantyCallbackReview(prisma, ownerA, completedA.id);
  check(
    "Review shows only the recorded statement",
    recordedReview?.warranty.recorded === true &&
      recordedReview.warranty.statements.length === 1 &&
      recordedReview.warranty.statements[0].statement === OWNER_STATEMENT &&
      recordedReview.warranty.emptyMessage === null &&
      !warrantyDisplayHasInventedDuration(recordedReview.warranty) &&
      !JSON.stringify(recordedReview.warranty).includes(LINE_PHRASE) &&
      !JSON.stringify(recordedReview.warranty).includes(VAULT_PHRASE),
  );

  const callback = await recordCustomerWarrantyCallback(prisma, ownerA, {
    jobId: completedA.id,
    report: "The hinge came loose after the visit.",
  });
  check(
    "Callback snapshots the same-business customer and stays reported",
    callback.status === "REPORTED" &&
      callback.customerId === customerA.id &&
      callback.customerId !== otherCustomerA.id &&
      callback.businessId === businessA.id &&
      callback.jobId === completedA.id &&
      callback.report === "The hinge came loose after the visit.",
  );

  const noCustomerCallback = await recordCustomerWarrantyCallback(prisma, ownerA, {
    jobId: completedNoCustomer.id,
    report: "Customer called about a completed job with no customer row.",
  });
  check("A completed job without a customer can still record a callback", noCustomerCallback.customerId === null);

  const cleaningTradeCallback = await recordCustomerWarrantyCallback(prisma, ownerB, {
    jobId: completedB.id,
    report: BETA_CALLBACK,
  });
  const betaTerm = await recordJobWarrantyTerm(prisma, ownerB, {
    jobId: completedB.id,
    statement: BETA_WARRANTY,
  });
  check(
    "A Cleaning-trade business uses the same completed-job callback path",
    cleaningTradeCallback.businessId === businessB.id && betaTerm.statement === BETA_WARRANTY,
  );

  await expectError(
    "Guessing another business job id cannot attach a callback",
    () =>
      recordCustomerWarrantyCallback(prisma, ownerA, {
        jobId: completedB.id,
        report: "Should not attach",
      }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE &&
      !String(error.message).includes(BETA_CALLBACK) &&
      !String(error.message).includes(BETA_WARRANTY),
  );
  await expectError(
    "A random job id cannot attach a callback",
    () =>
      recordCustomerWarrantyCallback(prisma, ownerA, {
        jobId: `guessed-${randomUUID()}`,
        report: "Should not attach",
      }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_JOB_NOT_FOUND_MESSAGE,
  );

  const guessedReview = await loadJobWarrantyCallbackReview(prisma, ownerA, completedB.id);
  const randomReview = await loadJobWarrantyCallbackReview(prisma, ownerA, `guessed-${randomUUID()}`);
  check(
    "Guessing another business job id returns no callback or warranty text",
    guessedReview === null && randomReview === null,
  );
  const ownAfterGuess = await loadJobWarrantyCallbackReview(prisma, ownerA, completedA.id);
  check(
    "Own review does not include the other business records",
    ownAfterGuess != null &&
      !JSON.stringify(ownAfterGuess).includes(BETA_CALLBACK) &&
      !JSON.stringify(ownAfterGuess).includes(BETA_WARRANTY),
  );

  await expectError(
    "Guessing another business callback id cannot review it",
    () => reviewWarrantyCallback(prisma, ownerA, { callbackId: cleaningTradeCallback.id, reviewNote: "nope" }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_NOT_FOUND_MESSAGE &&
      !String(error.message).includes(BETA_CALLBACK),
  );
  const betaStillReported = await prisma.jobWarrantyCallback.findUnique({
    where: { id: cleaningTradeCallback.id },
  });
  check("The other business callback stays reported", betaStillReported?.status === "REPORTED");

  await expectError(
    "Outcome before review is rejected",
    () =>
      recordWarrantyCallbackOutcome(prisma, ownerA, {
        callbackId: callback.id,
        outcomeNote: "Noted in the file.",
      }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_REVIEW_FIRST_MESSAGE,
  );

  const reviewed = await reviewWarrantyCallback(prisma, ownerA, {
    callbackId: callback.id,
    reviewNote: "Looked at the completed visit notes.",
  });
  check(
    "Review records the note and does not invent an outcome",
    reviewed.status === "REVIEWED" &&
      reviewed.reviewNote === "Looked at the completed visit notes." &&
      reviewed.reviewedByMembershipId === ownerMem.id &&
      reviewed.outcomeNote === null,
  );

  await expectError(
    "Empty outcome is rejected",
    () => recordWarrantyCallbackOutcome(prisma, ownerA, { callbackId: callback.id, outcomeNote: "  " }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_OUTCOME_REQUIRED_MESSAGE,
  );

  const resolved = await recordWarrantyCallbackOutcome(prisma, ownerA, {
    callbackId: callback.id,
    outcomeNote: "Customer asked us to leave it as recorded. No further entry.",
  });
  check(
    "Outcome is the owner's words on the same callback",
    resolved.status === "OUTCOME_RECORDED" &&
      resolved.outcomeNote === "Customer asked us to leave it as recorded. No further entry." &&
      resolved.resolvedByMembershipId === ownerMem.id &&
      resolved.jobId === completedA.id,
  );

  await expectError(
    "A second outcome is rejected",
    () =>
      recordWarrantyCallbackOutcome(prisma, ownerA, {
        callbackId: callback.id,
        outcomeNote: "Again",
      }),
    (error) =>
      error instanceof WarrantyCallbackError &&
      error.message === WARRANTY_CALLBACK_ALREADY_RESOLVED_MESSAGE,
  );

  const after = await countWarrantyCallbackSideEffects(prisma);
  const jobAfter = await prisma.job.findUnique({ where: { id: completedA.id } });
  check("Recording and resolving created no job, invoice, or message", sameCounts(before, after));
  check(
    "The completed job itself was not rewritten",
    jobAfter?.status === "COMPLETED" &&
      jobAfter.updatedAt.getTime() === jobBefore.updatedAt.getTime() &&
      jobAfter.customerId === customerA.id,
  );
  check(
    "Only warranty and callback rows were added",
    (await prisma.jobWarrantyTerm.count()) === 2 &&
      (await prisma.jobWarrantyCallback.count()) === 3,
  );

  const betaCallbacks = await prisma.jobWarrantyCallback.count({ where: { businessId: businessB.id } });
  const alphaOnBetaJob = await prisma.jobWarrantyCallback.count({
    where: { businessId: businessA.id, jobId: completedB.id },
  });
  check(
    "No callback was attached across businesses",
    betaCallbacks === 1 && alphaOnBetaJob === 0,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - live warranty callback proofs crashed");
  console.error(error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nAll warranty callback checks passed."
    : `\n${failures} warranty callback check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
