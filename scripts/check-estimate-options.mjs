/**
 * Focused verification for OWNER-authored priced estimate options.
 *
 * Calls the real sendEstimate, approveEstimate, and createJobFromEstimate
 * production functions against a disposable sibling Postgres database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-options.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for estimate-option checks.");
  process.exit(generateEarly.status ?? 1);
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

function assertLocalTestDatabase(url, action) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`Refusing to ${action}: DATABASE_URL is not a valid URL.`);
    process.exit(1);
  }
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(
      `Refusing to ${action} unless DATABASE_URL host is localhost or 127.0.0.1 (got ${host}).`,
    );
    process.exit(1);
  }
}

assertLocalTestDatabase(baseUrl, "pg_terminate_backend / DROP DATABASE");

const testDbName = "tbbt_estimate_options_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const raceWorkerPath = fileURLToPath(new URL("./estimate-options-race-worker.mjs", import.meta.url));

let failures = 0;
let prisma = null;

async function dropTestDatabase() {
  assertLocalTestDatabase(baseUrl, "DROP DATABASE");
  const { PrismaClient: CleanupPrisma } = createRequire(import.meta.url)("@prisma/client");
  const cleanup = new CleanupPrisma({ datasourceUrl: baseUrl });
  try {
    await cleanup.$queryRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      testDbName,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

await (async () => {
try {
  await dropTestDatabase();

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    console.error("Failed to push schema for estimate-option test database.");
    failures += 1;
    return;
  }

  process.env.DATABASE_URL = testUrl;

  const { ForbiddenError } = await import("@/lib/authorization");
  const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
  const { findCurrentEstimateVersion } = await import("@/lib/estimate-version");
  const { resolveApprovedWorkOrderScope } = await import("@/lib/job-work-order");
  const { persistDraftInvoiceFromCompletedJob } = await import("@/lib/invoice-carry-forward");
  const {
  MAX_ESTIMATE_OPTIONS,
  OPTION_BOUND_MESSAGE,
  OPTION_EMPTY_MESSAGE,
  OPTION_MINIMUM_MESSAGE,
  OPTION_REQUIRED_MESSAGE,
  OPTION_UNASSIGNED_LINE_MESSAGE,
  assertCanManageEstimateOptions,
  canManageEstimateOptions,
  computeOptionCommercials,
  draftEstimateOptionsSendError,
  isolateSameBusinessOptions,
  resolveChosenCommercialScope,
} = await import("@/lib/estimate-options");
const {
  EstimateOptionError,
  addEstimateOption,
  collapseEstimateOptions,
  renameEstimateOption,
  resolveDraftLineOptionId,
  startEstimateOptions,
} = await import("@/lib/estimate-option-ops");
const { sendEstimate, returnEstimateToDraft } = await import("@/app/actions/estimate");
const { approveEstimate } = await import("@/app/actions/public-estimate");
const { createJobFromEstimate } = await import("@/app/actions/job");
({ prisma } = await import("@/lib/prisma"));
const { setTestAccess } = await import("./estimate-options-test-access.mjs");
const { Prisma } = createRequire(import.meta.url)("@prisma/client");

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

function makeAccess(business, role, membershipId) {
  return {
    businessId: business.id,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: business.id, name: business.name, slug: business.slug },
    },
    scope: { businessId: business.id },
    assertOwned(record) {
      if (!record || record.businessId !== business.id) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== business.id) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) data.set(key, String(value));
  }
  return data;
}

function jobIdFromRedirect(error) {
  const message = String(error?.message ?? error);
  const digest = String(error?.digest ?? "");
  const match = `${message} ${digest}`.match(/\/jobs\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? null;
}

async function callCreateJob(estimateId) {
  try {
    const result = await createJobFromEstimate({}, form({ estimateId }));
    return { ok: !result?.error, error: result?.error ?? null, jobId: null };
  } catch (error) {
    const jobId = jobIdFromRedirect(error);
    if (jobId) return { ok: true, error: null, jobId };
    throw error;
  }
}

async function seedOperating(businessId) {
  await prisma.businessSaasSubscription.create({
    data: {
      businessId,
      status: "none",
      legacyExempt: true,
      planCode: "FOUNDER",
    },
  });
}

async function createDraft(businessId, unitPrice, description = "Line A") {
  const estimate = await prisma.estimate.create({
    data: {
      businessId,
      total: new Prisma.Decimal(unitPrice),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId,
      estimateId: estimate.id,
      description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(unitPrice),
      total: new Prisma.Decimal(unitPrice),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, estimate.id, businessId);
  return prisma.estimate.findUnique({ where: { id: estimate.id } });
}

async function addPricedLine(estimateId, businessId, optionId, unitPrice, description) {
  await prisma.lineItem.create({
    data: {
      businessId,
      estimateId,
      optionId,
      description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(unitPrice),
      total: new Prisma.Decimal(unitPrice),
      type: "LABOR",
    },
  });
}

function accessPayload(access) {
  return {
    businessId: access.businessId,
    role: access.workspace.role,
    membershipId: access.workspace.membership.id,
    businessName: access.workspace.business.name,
    businessSlug: access.workspace.business.slug,
  };
}

function spawnRaceWorker(mode, payload) {
  let child = null;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child = spawn(process.execPath, ["--experimental-strip-types", raceWorkerPath], {
      env: {
        ...process.env,
        DATABASE_URL: testUrl,
        RACE_MODE: mode,
        RACE_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ ok: false, error: "worker timeout" });
    }, 30_000);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const last = out
          .trim()
          .split("\n")
          .filter(Boolean)
          .pop();
        finish(JSON.parse(last));
      } catch {
        finish({ ok: false, error: `worker exit ${code}: ${out}` });
      }
    });
  });
  return {
    promise,
    kill() {
      child?.kill("SIGKILL");
    },
  };
}

async function waitForBlockedContenders(observer, minCount, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw`
      SELECT DISTINCT a.pid
      FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid
      WHERE a.datname = current_database()
        AND NOT l.granted
        AND a.pid <> pg_backend_pid()
    `;
    if (rows.length >= minCount) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${minCount} blocked contenders`);
}

async function runEstimateRace(estimateId, startContenders) {
  const { PrismaClient: LockPrisma } = createRequire(import.meta.url)("@prisma/client");
  const locker = new LockPrisma({ datasourceUrl: testUrl });
  const observer = new LockPrisma({ datasourceUrl: testUrl });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let lockAcquired;
  const acquired = new Promise((resolve) => {
    lockAcquired = resolve;
  });
  const hold = locker.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Estimate" WHERE id = ${estimateId} FOR UPDATE
      `;
      lockAcquired();
      await released;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await acquired;
  const workers = startContenders();
  let blocked = [];
  try {
    blocked = await waitForBlockedContenders(observer, 2);
  } catch (error) {
    for (const worker of workers) worker.kill();
    release();
    await Promise.allSettled([hold, ...workers.map((worker) => worker.promise)]);
    await observer.$disconnect();
    await locker.$disconnect();
    throw error;
  }
  release();
  const outcomes = await Promise.all(workers.map((worker) => worker.promise));
  await hold;
  await observer.$disconnect();
  await locker.$disconnect();
  return { outcomes, blockedCount: blocked.length };
}

  const businessA = await prisma.business.create({
    data: { name: "Alpha Options", slug: "alpha-options", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Options", slug: "beta-options", tradeCode: "HANDYMAN" },
  });
  await seedOperating(businessA.id);
  await seedOperating(businessB.id);
  const ownerA = makeAccess(businessA, "OWNER", "mem-owner-a");
  const adminA = makeAccess(businessA, "ADMIN", "mem-admin-a");
  const memberA = makeAccess(businessA, "MEMBER", "mem-member-a");
  const ownerB = makeAccess(businessB, "OWNER", "mem-owner-b");

  console.log("\nTEST 1 — Single-option send/approve/job path is unchanged");
  const single = await createDraft(businessA.id, 100);
  setTestAccess(ownerA);
  const singleSend = await sendEstimate({}, form({ estimateId: single.id }));
  check("single-option sendEstimate succeeded", !singleSend.error);
  const singleVersion = await findCurrentEstimateVersion(prisma, single.id);
  const singleFrozen = await prisma.estimateVersionOption.count({
    where: { estimateVersionId: singleVersion.id },
  });
  check("single-option send created no frozen options", singleFrozen === 0);
  const singleApprove = await approveEstimate(
    {},
    form({ publicToken: single.publicToken, estimateVersionId: singleVersion.id }),
  );
  check("single-option approveEstimate succeeded without an option id", singleApprove.status === "APPROVED");
  const singleAfter = await prisma.estimate.findUnique({ where: { id: single.id } });
  check("single-option approvedOptionId stays null", singleAfter.approvedOptionId === null);
  check("single-option total stays $100 after approval", singleAfter.total.toString() === "100");
  const singleJob = await callCreateJob(single.id);
  check("single-option createJobFromEstimate succeeded", singleJob.ok === true && Boolean(singleJob.jobId));

  console.log("\nTEST 2 — OWNER starts two options; totals do not sum alternatives");
  const multi = await createDraft(businessA.id, 80, "Base labor");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, multi.id);
  const liveOptions = await prisma.estimateOption.findMany({
    where: { estimateId: multi.id, businessId: businessA.id },
    orderBy: { sortOrder: "asc" },
  });
  check("exactly two live options", liveOptions.length === 2);
  const assigned = await prisma.lineItem.findMany({ where: { estimateId: multi.id } });
  check(
    "existing lines moved onto option 1",
    assigned.length === 1 && assigned[0].optionId === liveOptions[0].id,
  );
  await addPricedLine(multi.id, businessA.id, liveOptions[1].id, 150, "Upgrade labor");
  await persistDraftEstimateTotal(prisma, multi.id, businessA.id);
  const multiDraft = await prisma.estimate.findUnique({ where: { id: multi.id } });
  check(
    "live Estimate.total is not the $230 sum of both options",
    multiDraft.total.toString() === "0",
  );
  const optionTotals = liveOptions.map((option) =>
    computeOptionCommercials(
      [
        ...assigned.filter((line) => line.optionId === option.id),
        ...(option.id === liveOptions[1].id
          ? [{ type: "LABOR", total: new Prisma.Decimal(150) }]
          : []),
      ],
      { enabled: false, amount: null, waived: false },
    ).total.toString(),
  );
  check("option 1 total is $80", optionTotals[0] === "80");
  check("option 2 total is $150", optionTotals[1] === "150");

  console.log("\nTEST 3 — Send freezes options; empty option cannot send");
  setTestAccess(ownerA);
  const emptySend = await sendEstimate({}, form({ estimateId: multi.id }));
  check("multi-option sendEstimate succeeded after both options were priced", !emptySend.error);
  const multiVersion = await findCurrentEstimateVersion(prisma, multi.id);
  const frozen = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: multiVersion.id, businessId: businessA.id },
    orderBy: { sortOrder: "asc" },
  });
  check("two frozen options on the SENT version", frozen.length === 2);
  check("frozen option 1 total is $80", frozen[0].total.toString() === "80");
  check("frozen option 2 total is $150", frozen[1].total.toString() === "150");
  const frozenLines = await prisma.estimateVersionLineItem.findMany({
    where: { estimateVersionId: multiVersion.id },
  });
  check("each snapshot line belongs to one frozen option", frozenLines.every((line) => line.optionId));
  check(
    "snapshot lines are not one combined $230 scope",
    frozenLines.reduce((sum, line) => sum + Number(line.total), 0) === 230 &&
      frozen.every((option) => Number(option.total) !== 230),
  );

  const incomplete = await createDraft(businessA.id, 40, "Only option 1");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, incomplete.id);
  const incompleteSend = await sendEstimate({}, form({ estimateId: incomplete.id }));
  check(
    "sendEstimate refused when a priced option has no lines",
    Boolean(incompleteSend.error) && incompleteSend.error === OPTION_EMPTY_MESSAGE,
  );

  console.log("\nTEST 4 — Customer must choose; stale and duplicate approval are refused");
  const noChoice = await approveEstimate(
    {},
    form({ publicToken: multi.publicToken, estimateVersionId: multiVersion.id }),
  );
  check(
    "approval without a choice is refused",
    Boolean(noChoice.error) && noChoice.error === OPTION_REQUIRED_MESSAGE,
  );
  const chosen = await approveEstimate(
    {},
    form({
      publicToken: multi.publicToken,
      estimateVersionId: multiVersion.id,
      estimateOptionId: frozen[1].id,
    }),
  );
  check("approval with option 2 succeeds", chosen.status === "APPROVED");
  const approved = await prisma.estimate.findUnique({ where: { id: multi.id } });
  check("approvedOptionId is option 2", approved.approvedOptionId === frozen[1].id);
  check("Estimate.total becomes the chosen $150", approved.total.toString() === "150");
  const duplicate = await approveEstimate(
    {},
    form({
      publicToken: multi.publicToken,
      estimateVersionId: multiVersion.id,
      estimateOptionId: frozen[0].id,
    }),
  );
  check(
    "duplicate approval of a different option is refused",
    Boolean(duplicate.error) && String(duplicate.error).includes(frozen[1].name),
  );
  const stillChosen = await prisma.estimate.findUnique({ where: { id: multi.id } });
  check("duplicate approval does not change the chosen option", stillChosen.approvedOptionId === frozen[1].id);

  const stale = await createDraft(businessA.id, 60, "Stale base");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, stale.id);
  const staleOptions1 = await prisma.estimateOption.findMany({
    where: { estimateId: stale.id },
    orderBy: { sortOrder: "asc" },
  });
  await addPricedLine(stale.id, businessA.id, staleOptions1[1].id, 90, "Stale upgrade");
  const staleSend1 = await sendEstimate({}, form({ estimateId: stale.id }));
  check("first stale send succeeded", !staleSend1.error);
  const staleVersion1 = await findCurrentEstimateVersion(prisma, stale.id);
  const staleFrozen1 = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: staleVersion1.id },
  });
  const returned = await returnEstimateToDraft({}, form({ estimateId: stale.id }));
  check("returnEstimateToDraft succeeded", !returned.error);
  const staleSend2 = await sendEstimate({}, form({ estimateId: stale.id }));
  check("re-send after return-to-draft succeeded", !staleSend2.error);
  const staleVersion2 = await findCurrentEstimateVersion(prisma, stale.id);
  const staleApproval = await approveEstimate(
    {},
    form({
      publicToken: stale.publicToken,
      estimateVersionId: staleVersion2.id,
      estimateOptionId: staleFrozen1[1].id,
    }),
  );
  check(
    "approving a frozen option from the superseded send is stale",
    Boolean(staleApproval.error) && staleApproval.error.includes("updated since you opened"),
  );
  const staleRow = await prisma.estimate.findUnique({ where: { id: stale.id } });
  check("stale attempt leaves the estimate SENT", staleRow.status === "SENT");

  console.log("\nTEST 5 — Only the chosen option flows to the Job and invoice");
  setTestAccess(ownerA);
  const jobCreate = await callCreateJob(multi.id);
  check("createJobFromEstimate succeeded for the chosen option", jobCreate.ok === true && Boolean(jobCreate.jobId));
  const job = await prisma.job.findUnique({
    where: { id: jobCreate.jobId },
    include: {
      approvedEstimateOption: true,
      approvedEstimateVersion: { include: { lineItems: true } },
    },
  });
  check("job binds approvedEstimateOptionId", job.approvedEstimateOptionId === approved.approvedOptionId);
  const scope = resolveApprovedWorkOrderScope({
    approvedEstimateOptionId: job.approvedEstimateOptionId,
    approvedEstimateOption: job.approvedEstimateOption,
    approvedEstimateVersion: job.approvedEstimateVersion,
    estimate: null,
  });
  check("job scope source is the approved version", scope.source === "version");
  check("job total is the chosen $150, not $230", scope.total.toString() === "150");
  check("job has only the chosen option's lines", scope.lineItems.length === 1);
  check(
    "job line is the upgrade, not the $80 base",
    scope.lineItems[0].total.toString() === "150",
  );

  const chosenScope = resolveChosenCommercialScope({
    total: approved.total,
    lineItems: job.approvedEstimateVersion.lineItems,
    approvedOptionId: approved.approvedOptionId,
    approvedOption: job.approvedEstimateOption,
    approvedVersion: job.approvedEstimateVersion,
  });
  check("chosen commercial helper returns $150", chosenScope.total.toString() === "150");
  check("chosen commercial helper filters to one line", chosenScope.lineItems.length === 1);

  await prisma.job.update({
    where: { id: job.id },
    data: { status: "COMPLETED" },
  });
  const invoiced = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId: job.id,
  });
  check("multi-option completed job can be invoiced", invoiced.ok === true);
  const invoice = await prisma.invoice.findFirst({
    where: { jobId: job.id, businessId: businessA.id },
    include: { lineItems: true },
  });
  check("invoice total is the chosen $150, not $0 or $230", invoice?.total.toString() === "150");
  const invoiceWorkLines = (invoice?.lineItems ?? []).filter((line) => line.type !== "OTHER");
  check(
    "invoice has only the chosen option's work lines",
    invoiceWorkLines.some((line) => line.total.toString() === "150") &&
      !invoiceWorkLines.some((line) => line.total.toString() === "80") &&
      !invoiceWorkLines.some((line) => line.description === "Base labor"),
  );

  const unchosen = await createDraft(businessA.id, 70, "Unchosen base");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, unchosen.id);
  const unchosenOptions = await prisma.estimateOption.findMany({
    where: { estimateId: unchosen.id },
    orderBy: { sortOrder: "asc" },
  });
  await addPricedLine(unchosen.id, businessA.id, unchosenOptions[1].id, 110, "Unchosen upgrade");
  const unchosenSend = await sendEstimate({}, form({ estimateId: unchosen.id }));
  check("unchosen multi-option send succeeded", !unchosenSend.error);
  const unchosenJob = await callCreateJob(unchosen.id);
  check(
    "createJobFromEstimate refuses a SENT multi-option estimate with no choice",
    unchosenJob.ok === false && Boolean(unchosenJob.error),
  );

  console.log("\nTEST 6 — OWNER authorization; ADMIN/MEMBER cannot prepare options");
  check("OWNER can manage options", canManageEstimateOptions("OWNER") === true);
  check("ADMIN cannot manage options", canManageEstimateOptions("ADMIN") === false);
  check("MEMBER cannot manage options", canManageEstimateOptions("MEMBER") === false);
  check("assert OWNER succeeds", (() => {
    try {
      assertCanManageEstimateOptions(ownerA);
      return true;
    } catch {
      return false;
    }
  })());
  await expectError("ADMIN start options is forbidden", () => startEstimateOptions(prisma, adminA, incomplete.id), (error) => error instanceof ForbiddenError);
  await expectError("MEMBER start options is forbidden", () => startEstimateOptions(prisma, memberA, incomplete.id), (error) => error instanceof ForbiddenError);

  console.log("\nTEST 7 — Tenant isolation through real functions");
  setTestAccess(ownerB);
  await expectError(
    "OWNER B cannot sendEstimate OWNER A's draft",
    () => sendEstimate({}, form({ estimateId: incomplete.id })),
    (error) =>
      error instanceof Error &&
      String(error.message).includes("authorized business workspace"),
  );
  await expectError(
    "OWNER B cannot createJobFromEstimate on OWNER A's approved estimate",
    () => callCreateJob(multi.id),
    (error) =>
      error instanceof Error &&
      String(error.message).includes("authorized business workspace"),
  );
  await expectError(
    "OWNER B cannot start options on OWNER A's draft",
    () => startEstimateOptions(prisma, ownerB, incomplete.id),
    (error) =>
      error instanceof Error &&
      String(error.message).includes("authorized business workspace"),
  );
  const foreignDraft = await createDraft(businessB.id, 25, "Foreign base");
  setTestAccess(ownerB);
  await startEstimateOptions(prisma, ownerB, foreignDraft.id);
  const foreignOptions = await prisma.estimateOption.findMany({
    where: { estimateId: foreignDraft.id, businessId: businessB.id },
    orderBy: { sortOrder: "asc" },
  });
  await expectError(
    "resolveDraftLineOptionId rejects a cross-tenant option id",
    () =>
      resolveDraftLineOptionId(prisma, {
        estimateId: incomplete.id,
        businessId: businessA.id,
        optionId: foreignOptions[0].id,
      }),
    (error) => error instanceof EstimateOptionError,
  );
  check(
    "isolateSameBusinessOptions drops the other tenant",
    isolateSameBusinessOptions(
      [{ businessId: businessA.id }, { businessId: businessB.id }],
      businessA.id,
    ).length === 1,
  );

  console.log("\nTEST 8 — Bounds, rename, collapse, and send-error copy");
  setTestAccess(ownerA);
  await addEstimateOption(prisma, ownerA, incomplete.id);
  const three = await prisma.estimateOption.count({
    where: { estimateId: incomplete.id, businessId: businessA.id },
  });
  check("third option can be added", three === MAX_ESTIMATE_OPTIONS);
  await expectError(
    "a fourth option is refused",
    () => addEstimateOption(prisma, ownerA, incomplete.id),
    (error) => error instanceof EstimateOptionError && error.message === OPTION_BOUND_MESSAGE,
  );
  await renameEstimateOption(prisma, ownerA, {
    estimateId: incomplete.id,
    optionId: (await prisma.estimateOption.findFirst({
      where: { estimateId: incomplete.id, sortOrder: 1 },
    })).id,
    name: "Good",
  });
  const renamed = await prisma.estimateOption.findFirst({
    where: { estimateId: incomplete.id, sortOrder: 1 },
  });
  check("option renamed to Good", renamed.name === "Good");
  const sentForRename = await createDraft(businessA.id, 55, "Rename lock");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, sentForRename.id);
  const sentRenameOptions = await prisma.estimateOption.findMany({
    where: { estimateId: sentForRename.id },
    orderBy: { sortOrder: "asc" },
  });
  await addPricedLine(sentForRename.id, businessA.id, sentRenameOptions[1].id, 65, "Rename upgrade");
  const sentRename = await sendEstimate({}, form({ estimateId: sentForRename.id }));
  check("rename-lock send succeeded", !sentRename.error);
  await expectError(
    "renameEstimateOption refuses after send",
    () =>
      renameEstimateOption(prisma, ownerA, {
        estimateId: sentForRename.id,
        optionId: sentRenameOptions[0].id,
        name: "Should not stick",
      }),
    (error) => error instanceof EstimateOptionError,
  );
  await collapseEstimateOptions(prisma, ownerA, incomplete.id);
  const collapsed = await prisma.estimateOption.count({
    where: { estimateId: incomplete.id },
  });
  const collapsedLines = await prisma.lineItem.findMany({
    where: { estimateId: incomplete.id },
  });
  check("collapse removes all option rows", collapsed === 0);
  check(
    "collapse clears line option assignments",
    collapsedLines.every((line) => line.optionId === null),
  );
  check(
    "one leftover option is a send error",
    draftEstimateOptionsSendError({
      lineItems: [{ optionId: "only" }],
      options: [{ id: "only", name: "Only", sortOrder: 1 }],
    }) === OPTION_MINIMUM_MESSAGE,
  );
  check(
    "unassigned lines on a multi-option draft are a send error",
    draftEstimateOptionsSendError({
      lineItems: [{ optionId: null }],
      options: [
        { id: "a", name: "A", sortOrder: 1 },
        { id: "b", name: "B", sortOrder: 2 },
      ],
    }) === OPTION_UNASSIGNED_LINE_MESSAGE,
  );

  // Verifies the combined guards — Estimate FOR UPDATE plus the
  // conditional updateMany in approveEstimate (public-estimate.ts
  // status SENT + approvedVersionId null) — not the row lock alone.
  console.log("\nTEST 9 — Concurrent approvals: exactly one option wins");
  const raceApprove = await createDraft(businessA.id, 40, "Race base");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, raceApprove.id);
  const raceOptions = await prisma.estimateOption.findMany({
    where: { estimateId: raceApprove.id },
    orderBy: { sortOrder: "asc" },
  });
  await addPricedLine(raceApprove.id, businessA.id, raceOptions[1].id, 95, "Race upgrade");
  const raceSend = await sendEstimate({}, form({ estimateId: raceApprove.id }));
  check("race-approve send succeeded", !raceSend.error);
  const raceVersion = await findCurrentEstimateVersion(prisma, raceApprove.id);
  const raceFrozen = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: raceVersion.id },
    orderBy: { sortOrder: "asc" },
  });
  const accessA = accessPayload(ownerA);
  let raceApproveBlocked = 0;
  let approveOutcomes = [];
  try {
    const raced = await runEstimateRace(raceApprove.id, () => [
      spawnRaceWorker("approve", {
        access: accessA,
        approve: {
          publicToken: raceApprove.publicToken,
          estimateVersionId: raceVersion.id,
          estimateOptionId: raceFrozen[0].id,
        },
      }),
      spawnRaceWorker("approve", {
        access: accessA,
        approve: {
          publicToken: raceApprove.publicToken,
          estimateVersionId: raceVersion.id,
          estimateOptionId: raceFrozen[1].id,
        },
      }),
    ]);
    raceApproveBlocked = raced.blockedCount;
    approveOutcomes = raced.outcomes;
  } catch (error) {
    console.error("FAIL - TEST 9 barrier", error);
    failures += 1;
  }
  check("both approval contenders were blocked on the Estimate row", raceApproveBlocked >= 2);
  const approveWins = approveOutcomes.filter((outcome) => outcome.ok);
  const approveLosses = approveOutcomes.filter((outcome) => !outcome.ok && outcome.error);
  check("exactly one approval succeeded", approveWins.length === 1);
  check("the other approval returned an error", approveLosses.length === 1);
  const raceRow = await prisma.estimate.findUnique({ where: { id: raceApprove.id } });
  const winnerIds = new Set([raceFrozen[0].id, raceFrozen[1].id]);
  check("estimate is APPROVED after the race", raceRow.status === "APPROVED");
  check("exactly one frozen option is bound", winnerIds.has(raceRow.approvedOptionId));
  const approvedFrozen = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: raceVersion.id, approvedAt: { not: null } },
  });
  check("exactly one frozen option has approvedAt", approvedFrozen.length === 1);
  check(
    "bound option matches the stamped approvedAt option",
    approvedFrozen[0]?.id === raceRow.approvedOptionId,
  );

  console.log("\nTEST 10 — Approval racing return-to-draft plus re-send");
  const raceResend = await createDraft(businessA.id, 45, "Resend race base");
  setTestAccess(ownerA);
  await startEstimateOptions(prisma, ownerA, raceResend.id);
  const resendOptions = await prisma.estimateOption.findMany({
    where: { estimateId: raceResend.id },
    orderBy: { sortOrder: "asc" },
  });
  await addPricedLine(raceResend.id, businessA.id, resendOptions[1].id, 85, "Resend race upgrade");
  const firstResendSend = await sendEstimate({}, form({ estimateId: raceResend.id }));
  check("resend-race first send succeeded", !firstResendSend.error);
  const firstResendVersion = await findCurrentEstimateVersion(prisma, raceResend.id);
  const firstResendFrozen = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: firstResendVersion.id },
    orderBy: { sortOrder: "asc" },
  });
  let resendBlocked = 0;
  let approveOutcome = { ok: false, error: "barrier did not run" };
  let resendOutcome = { ok: false, error: "barrier did not run" };
  try {
    const raced = await runEstimateRace(raceResend.id, () => [
      spawnRaceWorker("approve", {
        access: accessA,
        approve: {
          publicToken: raceResend.publicToken,
          estimateVersionId: firstResendVersion.id,
          estimateOptionId: firstResendFrozen[1].id,
        },
      }),
      spawnRaceWorker("return_resend", {
        access: accessA,
        estimateId: raceResend.id,
      }),
    ]);
    resendBlocked = raced.blockedCount;
    [approveOutcome, resendOutcome] = raced.outcomes;
  } catch (error) {
    console.error("FAIL - TEST 10 barrier", error);
    failures += 1;
  }
  check("both return/approve contenders were blocked on the Estimate row", resendBlocked >= 2);
  const afterRace = await prisma.estimate.findUnique({
    where: { id: raceResend.id },
    include: { versions: { orderBy: { versionNumber: "asc" } } },
  });
  const approveWon = approveOutcome.ok === true;
  const resendWon = resendOutcome.ok === true;
  check("exactly one TEST 10 contender succeeded", approveWon !== resendWon);
  if (approveWon) {
    check("winning approval left the estimate APPROVED", afterRace.status === "APPROVED");
    check(
      "winning approval binds V1",
      afterRace.approvedVersionId === firstResendVersion.id,
    );
    check("winning approval created no second version", afterRace.versions.length === 1);
    check(
      "winning approval bound the submitted option",
      afterRace.approvedOptionId === firstResendFrozen[1].id,
    );
    check("losing return/re-send returned an error", Boolean(resendOutcome.error));
  } else if (resendWon) {
    check("winning return/re-send left the estimate SENT", afterRace.status === "SENT");
    check("winning return/re-send cleared approvedVersionId", afterRace.approvedVersionId === null);
    check("winning return/re-send created Version 2", afterRace.versions.length === 2);
    check("losing approval returned an error", Boolean(approveOutcome.error));
  }

  console.log(
    failures === 0
      ? "\nAll estimate-option checks passed."
      : `\n${failures} estimate-option check(s) failed.`,
  );
} finally {
  if (prisma) {
    await prisma.$disconnect().catch(() => {});
  }
  await dropTestDatabase();
}
})();

process.exit(failures === 0 ? 0 : 1);
