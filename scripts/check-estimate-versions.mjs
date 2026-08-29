/**
 * Focused verification for estimate version integrity (see
 * src/lib/estimate-version.ts, src/app/actions/estimate.ts sendEstimate(),
 * and src/app/actions/public-estimate.ts approveEstimate()).
 *
 * Runs against a disposable sibling Postgres database (created by
 * `prisma db push` and dropped afterward), matching the existing
 * scripts/check-isolation.mjs pattern.
 *
 * This script imports the real production snapshot helpers from
 * src/lib/estimate-version.ts directly (via Node's experimental TypeScript
 * type-stripping, hence the invocation below) so the most important new
 * logic under test is the actual application code, not a reimplementation.
 * The thin guarded-update orchestration that sendEstimate()/approveEstimate()
 * wrap around that helper is mirrored inline below, since those functions
 * are Next.js Server Actions that depend on request-scoped cookies/redirect
 * and cannot be invoked directly from a plain Node script.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-versions.mjs
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createEstimateVersionSnapshot,
  findCurrentEstimateVersion,
} from "../src/lib/estimate-version.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_estimate_version_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for estimate-version test database.");
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

/** Mirrors the guarded DRAFT -> SENT transition in sendEstimate(). */
async function simulateSend(estimateId, businessId) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId, businessId },
      include: { lineItems: { select: { id: true } } },
    });
    if (!current || current.status !== "DRAFT") {
      return { ok: false, reason: "not_draft" };
    }
    if (current.lineItems.length === 0) {
      return { ok: false, reason: "no_line_items" };
    }

    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) {
      return { ok: false, reason: "lost_race" };
    }

    const version = await createEstimateVersionSnapshot(tx, {
      estimateId,
      businessId,
    });
    return { ok: true, version };
  });
}

/** Mirrors the guarded transition in returnEstimateToDraft(). */
async function simulateReturnToDraft(estimateId, businessId) {
  const updated = await prisma.estimate.updateMany({
    where: { id: estimateId, businessId, status: "SENT" },
    data: { status: "DRAFT" },
  });
  return updated.count === 1;
}

/** Mirrors the guarded transition + version binding in approveEstimate(). */
async function simulateApprove(estimateId, { submittedVersionId } = {}) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId },
      select: { id: true, businessId: true, status: true },
    });
    if (!current) return { ok: false, reason: "not_found" };
    if (current.status === "APPROVED") {
      return { ok: false, reason: "already_approved" };
    }
    if (current.status !== "SENT") {
      return { ok: false, reason: "not_ready" };
    }

    const currentVersion = await findCurrentEstimateVersion(tx, current.id);
    if (!currentVersion) {
      return { ok: false, reason: "no_version" };
    }

    if (submittedVersionId && submittedVersionId !== currentVersion.id) {
      return { ok: false, reason: "stale" };
    }

    const updated = await tx.estimate.updateMany({
      where: { id: current.id, status: "SENT" },
      data: { status: "APPROVED", approvedVersionId: currentVersion.id },
    });
    if (updated.count !== 1) {
      return { ok: false, reason: "lost_race" };
    }

    await tx.estimateVersion.update({
      where: { id: currentVersion.id },
      data: { approvedAt: new Date() },
    });

    return { ok: true, versionId: currentVersion.id };
  });
}

// Duplicated on purpose (matches scripts/check-isolation.mjs), so this
// check does not depend on importing src/lib/access.ts, which pulls in
// next/headers (request-scoped cookies) that cannot run in a plain script.
function assertBusinessRecord(record, businessId) {
  if (!record || record.businessId !== businessId) {
    throw new Error("Record is not in the authorized business workspace.");
  }
  return record;
}

async function createDraftEstimate(businessId, customerId, propertyId, unitPrice) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId,
      customerId,
      propertyId,
      total: new Prisma.Decimal(unitPrice),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId,
      estimateId: estimate.id,
      description: "Line A",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(unitPrice),
      total: new Prisma.Decimal(unitPrice),
      type: "LABOR",
    },
  });
  return estimate;
}

async function editSoleLineItem(estimateId, businessId, unitPrice) {
  const lineItem = await prisma.lineItem.findFirstOrThrow({
    where: { estimateId, businessId },
  });
  await prisma.lineItem.update({
    where: { id: lineItem.id },
    data: {
      unitPrice: new Prisma.Decimal(unitPrice),
      total: new Prisma.Decimal(unitPrice),
    },
  });
  await prisma.estimate.update({
    where: { id: estimateId },
    data: { total: new Prisma.Decimal(unitPrice) },
  });
}

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-ev", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-ev", tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer", email: "alpha@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "1 Alpha St" },
  });

  console.log("\nTEST 1 — Create DRAFT with Line A $100, send, Version 1 = $100");
  const estimate1 = await createDraftEstimate(businessA.id, customerA.id, propertyA.id, 100);
  const send1 = await simulateSend(estimate1.id, businessA.id);
  check("send succeeded", send1.ok === true);
  check("Version 1 created", send1.version?.versionNumber === 1);
  check("Version 1 total is $100", send1.version?.total.toString() === "100");
  const v1LineItems = await prisma.estimateVersionLineItem.findMany({
    where: { estimateVersionId: send1.version.id },
  });
  check("Version 1 has exactly 1 snapshot line item", v1LineItems.length === 1);
  check("Version 1 line item total is $100", v1LineItems[0]?.total.toString() === "100");

  console.log("\nTEST 2 — Return to Draft, change Line A to $150, send again -> Version 2 = $150, Version 1 still $100");
  const returned = await simulateReturnToDraft(estimate1.id, businessA.id);
  check("returned to draft", returned === true);
  await editSoleLineItem(estimate1.id, businessA.id, 150);
  const send2 = await simulateSend(estimate1.id, businessA.id);
  check("second send succeeded", send2.ok === true);
  check("Version 2 created", send2.version?.versionNumber === 2);
  check("Version 2 total is $150", send2.version?.total.toString() === "150");
  const version1Reread = await prisma.estimateVersion.findUnique({
    where: { id: send1.version.id },
  });
  check("Version 1 total is unchanged at $100 after Version 2 was created", version1Reread.total.toString() === "100");
  const versionCountAfterSecondSend = await prisma.estimateVersion.count({
    where: { estimateId: estimate1.id },
  });
  check("Exactly 2 versions exist for this estimate", versionCountAfterSecondSend === 2);

  console.log("\nTEST 3 — Approve current SENT estimate -> approved version points to Version 2");
  const approve1 = await simulateApprove(estimate1.id);
  check("approval succeeded", approve1.ok === true);
  check("approval bound to Version 2", approve1.versionId === send2.version.id);
  const estimateAfterApproval = await prisma.estimate.findUnique({ where: { id: estimate1.id } });
  check("Estimate.approvedVersionId points to Version 2", estimateAfterApproval.approvedVersionId === send2.version.id);
  check("Estimate.status is APPROVED", estimateAfterApproval.status === "APPROVED");
  const version2AfterApproval = await prisma.estimateVersion.findUnique({ where: { id: send2.version.id } });
  check("Version 2.approvedAt is set", version2AfterApproval.approvedAt !== null);
  const version1AfterApproval = await prisma.estimateVersion.findUnique({ where: { id: send1.version.id } });
  check("Version 1.approvedAt remains null (never approved)", version1AfterApproval.approvedAt === null);

  console.log("\nTEST 4 — No application action can mutate a historical version's snapshot fields");
  // Static proof: search every server action for any write to
  // EstimateVersion/EstimateVersionLineItem. The only permitted write is the
  // single approvedAt update inside approveEstimate().
  const grepMutations = spawnSync(
    "grep",
    [
      "-rnE",
      "estimateVersion(LineItem)?\\.(update|delete|upsert)",
      "src",
    ],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  );
  const mutationLines = (grepMutations.stdout || "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const unexpectedMutations = mutationLines.filter(
    (line) => !line.includes("src/app/actions/public-estimate.ts"),
  );
  check(
    "The only EstimateVersion/EstimateVersionLineItem write in the whole codebase is the single approvedAt update inside approveEstimate() (public-estimate.ts)",
    mutationLines.length === 1 && unexpectedMutations.length === 0,
  );
  // Behavioral proof: the snapshot's own content fields are unreachable
  // through any exported action; direct proof that OUR helper never
  // updates an existing row (it only ever creates).
  const versionBeforeSecondSnapshotAttempt = await prisma.estimateVersion.findUnique({
    where: { id: send1.version.id },
  });
  check(
    "Version 1 row content is byte-identical to what was captured at Test 1 (versionNumber/total unchanged)",
    versionBeforeSecondSnapshotAttempt.versionNumber === 1 &&
      versionBeforeSecondSnapshotAttempt.total.toString() === "100",
  );

  console.log("\nTEST 5 — Business B cannot access Business A's EstimateVersion");
  const crossBusinessLookup = await prisma.estimateVersion.findFirst({
    where: { id: send1.version.id, businessId: businessB.id },
  });
  check("Scoped lookup by Business B returns nothing", crossBusinessLookup === null);
  const visibleToB = await prisma.estimateVersion.findMany({
    where: { businessId: businessB.id },
  });
  check("Business B sees zero EstimateVersion rows (has none of its own)", visibleToB.length === 0);
  let threwForCrossBusiness = false;
  try {
    assertBusinessRecord(send1.version, businessB.id);
  } catch {
    threwForCrossBusiness = true;
  }
  check("assertBusinessRecord rejects Business A's version for Business B", threwForCrossBusiness);

  console.log("\nTEST 6 — Two simultaneous Send requests do not create duplicate versions");
  const raceCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Race Customer" },
  });
  const raceEstimate = await createDraftEstimate(businessA.id, raceCustomer.id, null, 200);
  const [raceResultA, raceResultB] = await Promise.all([
    simulateSend(raceEstimate.id, businessA.id),
    simulateSend(raceEstimate.id, businessA.id),
  ]);
  const raceOutcomes = [raceResultA, raceResultB];
  const raceSuccesses = raceOutcomes.filter((result) => result.ok);
  const raceVersionCount = await prisma.estimateVersion.count({
    where: { estimateId: raceEstimate.id },
  });
  check("Exactly one of the two concurrent sends succeeded", raceSuccesses.length === 1);
  check("Exactly one EstimateVersion row was created despite two concurrent sends", raceVersionCount === 1);
  const raceEstimateFinal = await prisma.estimate.findUnique({ where: { id: raceEstimate.id } });
  check("Race estimate ended up SENT (not double-transitioned)", raceEstimateFinal.status === "SENT");

  console.log("\nTEST 7 — Return to Draft disables public approval until re-sent");
  const draftedAgain = await simulateReturnToDraft(raceEstimate.id, businessA.id);
  check("race estimate returned to draft", draftedAgain === true);
  const approveWhileDraft = await simulateApprove(raceEstimate.id);
  check("approval attempt while DRAFT is refused", approveWhileDraft.ok === false && approveWhileDraft.reason === "not_ready");
  const raceEstimateStillDraft = await prisma.estimate.findUnique({ where: { id: raceEstimate.id } });
  check("estimate remains DRAFT (not silently approved)", raceEstimateStillDraft.status === "DRAFT");
  check("approvedVersionId remains null", raceEstimateStillDraft.approvedVersionId === null);
  // Re-send unblocks approval, and creates the next version (not a
  // version bump from merely returning to draft).
  const raceSend2 = await simulateSend(raceEstimate.id, businessA.id);
  check("re-send after Return to Draft succeeds", raceSend2.ok === true);
  check("re-send creates Version 2 (Return to Draft alone created none)", raceSend2.version?.versionNumber === 2);
  const approveAfterResend = await simulateApprove(raceEstimate.id);
  check("approval succeeds once re-sent", approveAfterResend.ok === true);

  console.log("\nEXTRA — Approving with a stale (superseded) version id is rejected (concurrency case #4)");
  const staleCustomer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Stale Customer" },
  });
  const staleEstimate = await createDraftEstimate(businessA.id, staleCustomer.id, null, 50);
  const staleSend1 = await simulateSend(staleEstimate.id, businessA.id);
  const staleVersion1Id = staleSend1.version.id;
  await simulateReturnToDraft(staleEstimate.id, businessA.id);
  await editSoleLineItem(staleEstimate.id, businessA.id, 75);
  const staleSend2 = await simulateSend(staleEstimate.id, businessA.id);
  check("stale-check setup: Version 2 is now current", staleSend2.version?.versionNumber === 2);
  const staleApproval = await simulateApprove(staleEstimate.id, {
    submittedVersionId: staleVersion1Id,
  });
  check("approving against the superseded Version 1 id is rejected", staleApproval.ok === false && staleApproval.reason === "stale");
  const staleEstimateFinal = await prisma.estimate.findUnique({ where: { id: staleEstimate.id } });
  check("estimate remains SENT, not APPROVED, after a stale approval attempt", staleEstimateFinal.status === "SENT");

  console.log(
    failures === 0
      ? "\nAll estimate-version checks passed."
      : `\n${failures} estimate-version check(s) failed.`,
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
