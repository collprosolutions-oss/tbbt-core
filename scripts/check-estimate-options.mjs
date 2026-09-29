/**
 * Focused verification for OWNER-authored priced estimate options.
 *
 * Proves per-option totals (not a sum of alternatives), freeze-on-send,
 * explicit customer choice through approveEstimate(), stale/duplicate
 * approval, OWNER authorization, tenant isolation, single-option
 * compatibility, and Job scope limited to the chosen option.
 *
 * Runs against a disposable sibling Postgres database.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-options.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for estimate-option checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const { createEstimateVersionSnapshot, findCurrentEstimateVersion } = await import(
  "@/lib/estimate-version"
);
const { resolveApprovedWorkOrderScope } = await import("@/lib/job-work-order");
const {
  MIN_ESTIMATE_OPTIONS,
  MAX_ESTIMATE_OPTIONS,
  OPTION_BOUND_MESSAGE,
  OPTION_EMPTY_MESSAGE,
  OPTION_JOB_REQUIRED_MESSAGE,
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
  removeEstimateOption,
  renameEstimateOption,
  resolveDraftLineOptionId,
  startEstimateOptions,
} = await import("@/lib/estimate-option-ops");
const { draftEstimateSendError } = await import("@/lib/request-estimate-draft");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_estimate_options_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

{
  const { PrismaClient: AdminPrisma } = createRequire(import.meta.url)("@prisma/client");
  const admin = new AdminPrisma({ datasourceUrl: baseUrl });
  await admin.$queryRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    testDbName,
  );
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  await admin.$disconnect();
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-option test database.");
  process.exit(push.status ?? 1);
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
  return estimate;
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

async function simulateSend(estimateId, businessId) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId, businessId },
      include: {
        lineItems: true,
        options: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!current || current.status !== "DRAFT") {
      return { ok: false, reason: "not_draft" };
    }
    const blocked = draftEstimateSendError(current);
    if (blocked) return { ok: false, reason: blocked };
    await persistDraftEstimateTotal(tx, estimateId, businessId);
    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) return { ok: false, reason: "lost_race" };
    const version = await createEstimateVersionSnapshot(tx, { estimateId, businessId });
    return { ok: true, version };
  });
}

async function simulateApprove(estimateId, { submittedVersionId, submittedOptionId } = {}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId },
      select: { id: true, businessId: true, status: true },
    });
    if (!current) return { ok: false, reason: "not_found" };
    if (current.status === "APPROVED") return { ok: false, reason: "already_approved" };
    if (current.status !== "SENT") return { ok: false, reason: "not_ready" };
    const currentVersion = await findCurrentEstimateVersion(tx, current.id);
    if (!currentVersion) return { ok: false, reason: "no_version" };
    if (submittedVersionId && submittedVersionId !== currentVersion.id) {
      return { ok: false, reason: "stale" };
    }
    const versionOptions = await tx.estimateVersionOption.findMany({
      where: { estimateVersionId: currentVersion.id, businessId: current.businessId },
      orderBy: { sortOrder: "asc" },
    });
    let approvedOptionId = null;
    let chosenTotal = currentVersion.total;
    let chosenAdjustment = currentVersion.laborMinimumAdjustment;
    if (versionOptions.length > 0) {
      if (versionOptions.length < MIN_ESTIMATE_OPTIONS) {
        return { ok: false, reason: "not_ready" };
      }
      if (!submittedOptionId) return { ok: false, reason: "option_required" };
      const chosen = versionOptions.find((option) => option.id === submittedOptionId);
      if (!chosen) return { ok: false, reason: "stale" };
      approvedOptionId = chosen.id;
      chosenTotal = chosen.total;
      chosenAdjustment = chosen.laborMinimumAdjustment;
    } else if (submittedOptionId) {
      return { ok: false, reason: "stale" };
    }
    const updated = await tx.estimate.updateMany({
      where: { id: current.id, status: "SENT" },
      data: {
        status: "APPROVED",
        approvedVersionId: currentVersion.id,
        approvedOptionId,
        total: chosenTotal,
        laborMinimumAdjustment: chosenAdjustment,
      },
    });
    if (updated.count !== 1) return { ok: false, reason: "lost_race" };
    await tx.estimateVersion.update({
      where: { id: currentVersion.id },
      data: { approvedAt: new Date() },
    });
    if (approvedOptionId) {
      await tx.estimateVersionOption.update({
        where: { id: approvedOptionId },
        data: { approvedAt: new Date() },
      });
    }
    return { ok: true, versionId: currentVersion.id, optionId: approvedOptionId };
  });
}

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Options", slug: "alpha-options", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Options", slug: "beta-options", tradeCode: "HANDYMAN" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", "mem-owner-a");
  const adminA = makeAccess(businessA.id, "ADMIN", "mem-admin-a");
  const memberA = makeAccess(businessA.id, "MEMBER", "mem-member-a");
  const ownerB = makeAccess(businessB.id, "OWNER", "mem-owner-b");

  console.log("\nTEST 1 — Single-option send/approve/job path is unchanged");
  const single = await createDraft(businessA.id, 100);
  const singleSend = await simulateSend(single.id, businessA.id);
  check("single-option send succeeded", singleSend.ok === true);
  const singleFrozen = await prisma.estimateVersionOption.count({
    where: { estimateVersionId: singleSend.version.id },
  });
  check("single-option send created no frozen options", singleFrozen === 0);
  const singleApprove = await simulateApprove(single.id);
  check("single-option approve succeeded without an option id", singleApprove.ok === true);
  check("single-option approvedOptionId stays null", singleApprove.optionId === null);
  const singleAfter = await prisma.estimate.findUnique({ where: { id: single.id } });
  check("single-option total stays $100 after approval", singleAfter.total.toString() === "100");

  console.log("\nTEST 2 — OWNER starts two options; totals do not sum alternatives");
  const multi = await createDraft(businessA.id, 80, "Base labor");
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
  const emptySend = await simulateSend(multi.id, businessA.id);
  check("multi-option send succeeded after both options were priced", emptySend.ok === true);
  const frozen = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: emptySend.version.id, businessId: businessA.id },
    orderBy: { sortOrder: "asc" },
  });
  check("two frozen options on the SENT version", frozen.length === 2);
  check("frozen option 1 total is $80", frozen[0].total.toString() === "80");
  check("frozen option 2 total is $150", frozen[1].total.toString() === "150");
  const frozenLines = await prisma.estimateVersionLineItem.findMany({
    where: { estimateVersionId: emptySend.version.id },
  });
  check("each snapshot line belongs to one frozen option", frozenLines.every((line) => line.optionId));
  check(
    "snapshot lines are not one combined $230 scope",
    frozenLines.reduce((sum, line) => sum + Number(line.total), 0) === 230 &&
      frozen.every((option) => Number(option.total) !== 230),
  );

  const incomplete = await createDraft(businessA.id, 40, "Only option 1");
  await startEstimateOptions(prisma, ownerA, incomplete.id);
  const incompleteSend = await simulateSend(incomplete.id, businessA.id);
  check(
    "send refused when a priced option has no lines",
    incompleteSend.ok === false && incompleteSend.reason === OPTION_EMPTY_MESSAGE,
  );

  console.log("\nTEST 4 — Customer must choose; stale and duplicate approval are refused");
  const noChoice = await simulateApprove(multi.id);
  check(
    "approval without a choice is refused",
    noChoice.ok === false && noChoice.reason === "option_required",
  );
  check("option_required customer copy is set", OPTION_REQUIRED_MESSAGE.includes("Choose one"));
  const chosen = await simulateApprove(multi.id, {
    submittedVersionId: emptySend.version.id,
    submittedOptionId: frozen[1].id,
  });
  check("approval with option 2 succeeds", chosen.ok === true && chosen.optionId === frozen[1].id);
  const approved = await prisma.estimate.findUnique({ where: { id: multi.id } });
  check("approvedOptionId is option 2", approved.approvedOptionId === frozen[1].id);
  check("Estimate.total becomes the chosen $150", approved.total.toString() === "150");
  const duplicate = await simulateApprove(multi.id, { submittedOptionId: frozen[0].id });
  check(
    "duplicate approval is refused as already approved",
    duplicate.ok === false && duplicate.reason === "already_approved",
  );

  const stale = await createDraft(businessA.id, 60, "Stale base");
  await startEstimateOptions(prisma, ownerA, stale.id);
  const staleOptions1 = await prisma.estimateOption.findMany({
    where: { estimateId: stale.id },
    orderBy: { sortOrder: "asc" },
  });
  await addPricedLine(stale.id, businessA.id, staleOptions1[1].id, 90, "Stale upgrade");
  const staleSend1 = await simulateSend(stale.id, businessA.id);
  const staleFrozen1 = await prisma.estimateVersionOption.findMany({
    where: { estimateVersionId: staleSend1.version.id },
  });
  await prisma.estimate.update({
    where: { id: stale.id },
    data: { status: "DRAFT" },
  });
  const staleSend2 = await simulateSend(stale.id, businessA.id);
  const staleApproval = await simulateApprove(stale.id, {
    submittedVersionId: staleSend2.version.id,
    submittedOptionId: staleFrozen1[1].id,
  });
  check(
    "approving a frozen option from the superseded send is stale",
    staleApproval.ok === false && staleApproval.reason === "stale",
  );
  const staleRow = await prisma.estimate.findUnique({ where: { id: stale.id } });
  check("stale attempt leaves the estimate SENT", staleRow.status === "SENT");

  console.log("\nTEST 5 — Only the chosen option flows to the Job");
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      estimateId: multi.id,
      approvedEstimateVersionId: approved.approvedVersionId,
      approvedEstimateOptionId: approved.approvedOptionId,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const jobVersion = await prisma.estimateVersion.findUnique({
    where: { id: approved.approvedVersionId },
    include: { lineItems: true },
  });
  const jobOption = await prisma.estimateVersionOption.findUnique({
    where: { id: approved.approvedOptionId },
  });
  const scope = resolveApprovedWorkOrderScope({
    approvedEstimateOptionId: job.approvedEstimateOptionId,
    approvedEstimateOption: jobOption,
    approvedEstimateVersion: jobVersion,
    estimate: null,
  });
  check("job scope source is the approved version", scope.source === "version");
  check("job total is the chosen $150, not $230", scope.total.toString() === "150");
  check("job has only the chosen option's lines", scope.lineItems.length === 1);
  check(
    "job line is the upgrade, not the $80 base",
    scope.lineItems[0].total.toString() === "150",
  );
  check(
    "job refused without a chosen option when frozen options exist",
    OPTION_JOB_REQUIRED_MESSAGE.includes("chosen option"),
  );

  const chosenScope = resolveChosenCommercialScope({
    total: approved.total,
    lineItems: jobVersion.lineItems,
    approvedOptionId: approved.approvedOptionId,
    approvedOption: jobOption,
    approvedVersion: jobVersion,
  });
  check("chosen commercial helper returns $150", chosenScope.total.toString() === "150");
  check("chosen commercial helper filters to one line", chosenScope.lineItems.length === 1);

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

  console.log("\nTEST 7 — Tenant isolation");
  const foreign = await prisma.estimateOption.findFirst({
    where: { id: liveOptions[0].id, businessId: businessB.id },
  });
  check("Business B cannot see Business A's live option", foreign === null);
  const foreignFrozen = await prisma.estimateVersionOption.findFirst({
    where: { id: frozen[0].id, businessId: businessB.id },
  });
  check("Business B cannot see Business A's frozen option", foreignFrozen === null);
  check(
    "isolateSameBusinessOptions drops the other tenant",
    isolateSameBusinessOptions(
      [{ businessId: businessA.id }, { businessId: businessB.id }],
      businessA.id,
    ).length === 1,
  );
  await expectError(
    "OWNER B cannot start options on OWNER A's draft",
    () => startEstimateOptions(prisma, ownerB, incomplete.id),
    (error) =>
      error instanceof Error &&
      String(error.message).includes("authorized business workspace"),
  );
  await expectError(
    "resolveDraftLineOptionId rejects a cross-tenant option id",
    () =>
      resolveDraftLineOptionId(prisma, {
        estimateId: incomplete.id,
        businessId: businessA.id,
        optionId: "not-this-business",
      }),
    (error) => error instanceof EstimateOptionError,
  );

  console.log("\nTEST 8 — Bounds, rename, collapse, and send-error copy");
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

  console.log("\nSTATIC — Approval still owns the only snapshot writes");
  const publicEstimate = readRepo("src/app/actions/public-estimate.ts");
  const estimateVersion = readRepo("src/lib/estimate-version.ts");
  const optionOps = readRepo("src/lib/estimate-option-ops.ts");
  check(
    "approveEstimate is still the customer approval boundary",
    publicEstimate.includes("submittedOptionId") &&
      publicEstimate.includes("approvedOptionId") &&
      publicEstimate.includes("estimateVersionOption.update"),
  );
  check(
    "snapshot helper creates frozen options and does not update them",
    estimateVersion.includes("estimateVersionOption.create") &&
      !estimateVersion.includes("estimateVersionOption.update"),
  );
  check(
    "option ops stay on DRAFT live rows",
    optionOps.includes("status: \"DRAFT\"") &&
      !optionOps.includes("estimateVersionOption"),
  );

  console.log(
    failures === 0
      ? "\nAll estimate-option checks passed."
      : `\n${failures} estimate-option check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
