/**
 * Real-concurrency proofs for P1-06 / P1-10 / P1-11 / P1-13.
 *
 * Separate Prisma clients, deterministic barriers, and pg_stat_activity
 * lock-wait proof. Does not use Promise.all as a substitute for a barrier.
 *
 * Run with:
 *   DATABASE_URL=postgresql://ubuntu:postgres@127.0.0.1:5432/ubuntu \
 *     node --experimental-strip-types scripts/check-transactional-state-races.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

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

const testDbName = "tbbt_transactional_state_races_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client.");
  process.exit(generateEarly.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

const CONVERSION_UNIQUE_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS "Job_estimateId_conversion_unique"
  ON "Job" ("estimateId")
  WHERE "estimateId" IS NOT NULL
    AND "recurrenceSourceJobId" IS NULL
    AND "nextBookingSourceJobId" IS NULL
    AND "correctiveCleanSourceJobId" IS NULL
`;

function createCommitBarrier() {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  return {
    wait: async () => {
      arrived();
      await held;
    },
    arrived: waiting,
    release: () => release(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function dropTestDatabase() {
  assertLocalTestDatabase(baseUrl, "DROP DATABASE");
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
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

async function waitUntilTestDbHasLockWait(admin, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const rows = await admin.$queryRaw`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = ${testDbName}
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `;
    if (Array.isArray(rows) && rows.length > 0) {
      return rows;
    }
    await sleep(25);
  }
  throw new Error(`${label}: no pg_stat_activity Lock wait in ${testDbName} after 4000ms`);
}

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
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

await (async () => {
  let admin = null;
  let clientA = null;
  let clientB = null;
  try {
    await dropTestDatabase();
    const push = spawnSync(
      "npx",
      ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
      { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
    );
    if (push.status !== 0) {
      throw new Error("Failed to push schema for race test database.");
    }

    process.env.DATABASE_URL = testUrl;
    admin = new PrismaClient({ datasourceUrl: testUrl });
    clientA = new PrismaClient({ datasourceUrl: testUrl });
    clientB = new PrismaClient({ datasourceUrl: testUrl });
    await admin.$executeRawUnsafe(CONVERSION_UNIQUE_SQL);

    const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
    const { persistDraftInvoiceFromCompletedJob } = await import("@/lib/invoice-carry-forward");
    const {
      createJobFromApprovedEstimate,
      isJobEstimateConversionUniqueViolation,
      jobFromEstimateTestHooks,
    } = await import("@/lib/job-from-estimate");
    const { createEstimateFromServiceRequest, estimateFromRequestTestHooks } = await import(
      "@/lib/estimate-from-request"
    );
    const { updateDraftEstimateLineIncludedWork, EstimateLineError } = await import(
      "@/lib/estimate-line-ops"
    );
    const { sendEstimate, estimateSendTestHooks, createEstimate } = await import(
      "@/app/actions/estimate"
    );
    const { createJobFromEstimate } = await import("@/app/actions/job");
    const { applyParsedSaasBillingEvent, saasBillingTestHooks } = await import(
      "@/lib/saas-billing/ops"
    );
    const { setTestAccess } = await import("./estimate-options-test-access.mjs");

    async function seedWorkspace(name) {
      const business = await admin.business.create({
        data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}` },
      });
      const ownerUser = await admin.user.create({
        data: {
          email: `owner-${randomUUID()}@example.com`,
          passwordHash: "x",
          name: `${name} Owner`,
        },
      });
      const owner = await admin.membership.create({
        data: { userId: ownerUser.id, businessId: business.id, role: "OWNER" },
      });
      const customer = await admin.customer.create({
        data: { businessId: business.id, name: `${name} Customer` },
      });
      await admin.businessSaasSubscription.create({
        data: {
          businessId: business.id,
          status: "none",
          legacyExempt: true,
          planCode: "FOUNDER",
        },
      });
      const access = makeAccess(business, "OWNER", owner.id);
      return { business, customer, owner, access };
    }

    async function seedApprovedEstimate(businessId, customerId, total = 250) {
      const estimate = await admin.estimate.create({
        data: {
          businessId,
          customerId,
          status: "APPROVED",
          total: new Prisma.Decimal(total),
          publicToken: randomUUID(),
        },
      });
      await admin.lineItem.create({
        data: {
          businessId,
          estimateId: estimate.id,
          description: "Approved labor",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(total),
          total: new Prisma.Decimal(total),
          type: "LABOR",
        },
      });
      const version = await admin.estimateVersion.create({
        data: {
          businessId,
          estimateId: estimate.id,
          versionNumber: 1,
          total: new Prisma.Decimal(total),
          laborMinimumWaived: false,
          laborMinimumAdjustment: new Prisma.Decimal(0),
        },
      });
      await admin.estimateVersionLineItem.create({
        data: {
          businessId,
          estimateVersionId: version.id,
          description: "Approved labor",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(total),
          total: new Prisma.Decimal(total),
          type: "LABOR",
        },
      });
      await admin.estimate.update({
        where: { id: estimate.id },
        data: { approvedVersionId: version.id },
      });
      return admin.estimate.findUniqueOrThrow({ where: { id: estimate.id } });
    }

    async function seedPricedDraft(businessId) {
      const estimate = await admin.estimate.create({
        data: {
          businessId,
          status: "DRAFT",
          total: new Prisma.Decimal(80),
          publicToken: randomUUID(),
        },
      });
      const line = await admin.lineItem.create({
        data: {
          businessId,
          estimateId: estimate.id,
          description: "Priced labor",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(80),
          total: new Prisma.Decimal(80),
          type: "LABOR",
        },
      });
      await persistDraftEstimateTotal(admin, estimate.id, businessId);
      return { estimate, line };
    }

    // ------------------------------------------------------------------
    // Static — P1-11 uniqueness is not a conclusive product rule
    // ------------------------------------------------------------------
    console.log("\nSTATIC — P1-11 uniqueness requires founder confirmation");
    const reportsSrc = readRepo("src/components/reports/reports-workspace.tsx");
    const pipelineSrc = readRepo("src/lib/pipeline-data.ts");
    const schemaSrc = readRepo("prisma/schema.prisma");
    const templateSrc = readRepo("src/lib/estimate-line-template-ops.ts");
    const requestConvertSrc = readRepo("src/lib/estimate-from-request.ts");
    check(
      "Reports copy allows a request with two estimates",
      reportsSrc.includes("A request with two estimates still counts once."),
    );
    check(
      "Pipeline picks a primary estimate among multiples",
      pipelineSrc.includes("pickPrimaryEstimate"),
    );
    check(
      "Schema keeps Estimate.serviceRequestId non-unique",
      schemaSrc.includes("serviceRequestId       String?") &&
        !schemaSrc.includes("@@unique([serviceRequestId])"),
    );
    check(
      "Template drafts can attach serviceRequestId without uniqueness",
      templateSrc.includes("serviceRequestId: input.serviceRequestId ?? undefined"),
    );
    check(
      "createEstimate conversion locks and re-reads without a unique index",
      requestConvertSrc.includes("FOR UPDATE") &&
        requestConvertSrc.includes("if (existing)") &&
        requestConvertSrc.includes("does not impose a global one-estimate-per-request"),
    );

    // ------------------------------------------------------------------
    // P1-06
    // ------------------------------------------------------------------
    async function raceJobConversion(label, withPurchaseList) {
      const workspace = await seedWorkspace(`P106 ${label}`);
      const estimate = await seedApprovedEstimate(workspace.business.id, workspace.customer.id);
      if (withPurchaseList) {
        await admin.materialPurchaseList.create({
          data: { businessId: workspace.business.id, estimateId: estimate.id },
        });
      }

      const hold = createCommitBarrier();
      let afterLockCount = 0;
      jobFromEstimateTestHooks.afterEstimateLock = async () => {
        afterLockCount += 1;
        if (afterLockCount === 1) await hold.wait();
      };

      const first = createJobFromApprovedEstimate(clientA, workspace.access, estimate.id);
      await hold.arrived;
      const second = createJobFromApprovedEstimate(clientB, workspace.access, estimate.id);
      await waitUntilTestDbHasLockWait(admin, `P1-06 ${label}`);
      check(`P1-06 ${label}: first converter reached the Estimate lock once before release`, afterLockCount === 1);
      hold.release();
      const [a, b] = await Promise.all([
        withTimeout(first, 8000, `P1-06 ${label} A`),
        withTimeout(second, 8000, `P1-06 ${label} B`),
      ]);
      jobFromEstimateTestHooks.afterEstimateLock = undefined;

      const jobs = await admin.job.findMany({
        where: {
          businessId: workspace.business.id,
          estimateId: estimate.id,
          recurrenceSourceJobId: null,
          nextBookingSourceJobId: null,
          correctiveCleanSourceJobId: null,
        },
      });
      check(`P1-06 ${label}: both converters succeeded`, a.ok === true && b.ok === true);
      check(`P1-06 ${label}: exactly one conversion job`, jobs.length === 1);
      check(
        `P1-06 ${label}: both callers returned the same job id`,
        a.ok && b.ok && a.jobId === b.jobId && a.jobId === jobs[0].id,
      );
      check(`P1-06 ${label}: exactly one project token`, new Set(jobs.map((row) => row.projectToken)).size === 1);

      if (withPurchaseList) {
        const list = await admin.materialPurchaseList.findFirst({
          where: { businessId: workspace.business.id, estimateId: estimate.id },
        });
        check(`P1-06 ${label}: purchase list attached to the winner`, list?.jobId === jobs[0].id);
      }

      await admin.job.update({ where: { id: jobs[0].id }, data: { status: "COMPLETED" } });
      const invoice = await persistDraftInvoiceFromCompletedJob(admin, {
        businessId: workspace.business.id,
        jobId: jobs[0].id,
      });
      const originals = await admin.invoice.findMany({
        where: { businessId: workspace.business.id, jobId: jobs[0].id, kind: "ORIGINAL" },
      });
      check(
        `P1-06 ${label}: original intended invoice is the single ORIGINAL`,
        invoice.ok === true && originals.length === 1,
      );
      return { workspace, estimate, job: jobs[0] };
    }

    console.log("\nTEST — P1-06 concurrent approved-estimate conversion without purchase list");
    await raceJobConversion("no list", false);

    console.log("\nTEST — P1-06 concurrent approved-estimate conversion with purchase list");
    await raceJobConversion("with list", true);

    console.log("\nTEST — P1-06 unique backstop rejects a second conversion insert; loser re-reads");
    {
      const workspace = await seedWorkspace("P106 unique loser");
      const estimate = await seedApprovedEstimate(workspace.business.id, workspace.customer.id);
      const winner = await clientA.job.create({
        data: {
          businessId: workspace.business.id,
          customerId: workspace.customer.id,
          estimateId: estimate.id,
          approvedEstimateVersionId: estimate.approvedVersionId,
          projectToken: randomUUID(),
          status: "UNSCHEDULED",
        },
      });
      let uniqueRejected = false;
      try {
        await clientB.job.create({
          data: {
            businessId: workspace.business.id,
            customerId: workspace.customer.id,
            estimateId: estimate.id,
            approvedEstimateVersionId: estimate.approvedVersionId,
            projectToken: randomUUID(),
            status: "UNSCHEDULED",
          },
        });
      } catch (error) {
        uniqueRejected = isJobEstimateConversionUniqueViolation(error);
      }
      const result = await createJobFromApprovedEstimate(clientA, workspace.access, estimate.id);
      const jobs = await admin.job.findMany({
        where: { businessId: workspace.business.id, estimateId: estimate.id },
      });
      check("partial unique index rejects a second conversion job", uniqueRejected === true);
      check(
        "converter re-reads the existing winner instead of inserting",
        result.ok === true && result.reused === true && result.jobId === winner.id,
      );
      check("unique backstop leaves exactly one conversion job", jobs.length === 1);
      const uniqueError = new Prisma.PrismaClientKnownRequestError(
        `Unique constraint failed on the constraint: \`Job_estimateId_conversion_unique\``,
        {
          code: "P2002",
          clientVersion: "6.19.3",
          meta: { modelName: "Job", target: "Job_estimateId_conversion_unique" },
        },
      );
      check(
        "isJobEstimateConversionUniqueViolation recognizes the conversion index",
        isJobEstimateConversionUniqueViolation(uniqueError) === true,
      );
    }

    console.log("\nTEST — P1-06 createJobFromEstimate action still redirects to the winner");
    {
      const workspace = await seedWorkspace("P106 action");
      setTestAccess(workspace.access);
      const estimate = await seedApprovedEstimate(workspace.business.id, workspace.customer.id);
      const first = await createJobFromApprovedEstimate(admin, workspace.access, estimate.id);
      let redirectedTo = null;
      try {
        await createJobFromEstimate({}, form({ estimateId: estimate.id }));
      } catch (error) {
        redirectedTo = String(error?.message ?? error);
      }
      check(
        "second createJobFromEstimate redirects to the existing job",
        first.ok === true && redirectedTo?.includes(`/jobs/${first.jobId}`) === true,
      );
    }

    // ------------------------------------------------------------------
    // P1-10
    // ------------------------------------------------------------------
    console.log("\nTEST — P1-10 SENT wins; stale draft-line mutation cannot commit");
    {
      const workspace = await seedWorkspace("P110");
      setTestAccess(workspace.access);
      const { estimate, line } = await seedPricedDraft(workspace.business.id);
      const sendHold = createCommitBarrier();
      estimateSendTestHooks.afterEstimateLock = async () => {
        await sendHold.wait();
      };

      const send = sendEstimate({}, form({ estimateId: estimate.id }));
      await sendHold.arrived;
      const mutation = updateDraftEstimateLineIncludedWork(clientA, workspace.access, {
        estimateId: estimate.id,
        lineItemId: line.id,
        includedWork: "STALE SCOPE AFTER SEND",
      }).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      await waitUntilTestDbHasLockWait(admin, "P1-10 send vs line mutation");
      sendHold.release();
      const sendResult = await withTimeout(send, 8000, "P1-10 send");
      const mutationResult = await withTimeout(mutation, 8000, "P1-10 mutation");
      const mutationError = mutationResult.ok ? null : mutationResult.error;
      estimateSendTestHooks.afterEstimateLock = undefined;

      const after = await admin.estimate.findUniqueOrThrow({
        where: { id: estimate.id },
        include: {
          lineItems: true,
          versions: { include: { lineItems: true } },
        },
      });
      check("sendEstimate committed SENT", !sendResult?.error && after.status === "SENT");
      check(
        "stale draft mutation failed the DRAFT claim",
        mutationError instanceof EstimateLineError ||
          mutationError?.name === "EstimateLineError" ||
          String(mutationError?.message ?? "").includes("Only a draft estimate"),
      );
      check(
        "live line still matches the SENT snapshot",
        Boolean(after.versions[0]?.lineItems[0]) &&
          after.lineItems[0].description === after.versions[0].lineItems[0].description &&
          !after.lineItems[0].description.includes("STALE SCOPE AFTER SEND"),
      );
    }

    console.log("\nSTATIC — P1-10 draft mutations claim DRAFT inside the write boundary");
    const lineOpsSrc = readRepo("src/lib/estimate-line-ops.ts");
    const takeoffSrc = readRepo("src/lib/material-takeoff/ops.ts");
    const depositSrc = readRepo("src/lib/material-deposit.ts");
    const materialsTotalSrc = readRepo("src/lib/customer-materials-total.ts");
    const estimateActionSrc = readRepo("src/app/actions/estimate.ts");
    const claimOpsSrc = readRepo("src/lib/estimate-option-ops.ts");
    check(
      "claimDraftEstimate locks the Estimate before the DRAFT updateMany",
      claimOpsSrc.includes("FOR UPDATE") && claimOpsSrc.includes("status: \"DRAFT\""),
    );
    check(
      "priced / scope / material / calculator / override writes claim DRAFT",
      lineOpsSrc.includes("await requireClaimedDraftEstimate(tx, access, estimate.id)") &&
        lineOpsSrc.includes("Only a draft estimate can be recalculated."),
    );
    check(
      "takeoff, deposit, materials-total, remove, and clear claim DRAFT",
      takeoffSrc.includes("requireClaimedDraftEstimate") &&
        depositSrc.includes("requireClaimedDraftEstimate") &&
        materialsTotalSrc.includes("requireClaimedDraftEstimate") &&
        estimateActionSrc.includes("claimDraftEstimate(tx, access, estimate.id"),
    );

    // ------------------------------------------------------------------
    // P1-11
    // ------------------------------------------------------------------
    console.log("\nTEST — P1-11 concurrent ServiceRequest conversion converges on one estimate");
    {
      const workspace = await seedWorkspace("P111");
      const request = await admin.serviceRequest.create({
        data: {
          businessId: workspace.business.id,
          customerId: workspace.customer.id,
          status: "OPEN",
          summary: "Fence repair",
        },
      });
      const hold = createCommitBarrier();
      let afterLockCount = 0;
      estimateFromRequestTestHooks.afterRequestLock = async () => {
        afterLockCount += 1;
        if (afterLockCount === 1) await hold.wait();
      };
      const input = {
        serviceRequestId: request.id,
        customerId: workspace.customer.id,
        propertyId: null,
        status: "OPEN",
        leadSource: null,
        campaignId: null,
        sourceItems: [],
        measurements: [],
      };
      const first = createEstimateFromServiceRequest(clientA, workspace.access, input);
      await hold.arrived;
      const second = createEstimateFromServiceRequest(clientB, workspace.access, input);
      await waitUntilTestDbHasLockWait(admin, "P1-11 request conversion");
      check("P1-11 first converter reached the ServiceRequest lock once before release", afterLockCount === 1);
      hold.release();
      const [a, b] = await Promise.all([
        withTimeout(first, 8000, "P1-11 A"),
        withTimeout(second, 8000, "P1-11 B"),
      ]);
      estimateFromRequestTestHooks.afterRequestLock = undefined;
      const estimates = await admin.estimate.findMany({
        where: { businessId: workspace.business.id, serviceRequestId: request.id },
      });
      const converted = await admin.serviceRequest.findUniqueOrThrow({ where: { id: request.id } });
      check("P1-11 both converters returned the same estimate", a.id === b.id && estimates.length === 1 && estimates[0].id === a.id);
      check("P1-11 exactly one converter created the row", (a.created ? 1 : 0) + (b.created ? 1 : 0) === 1);
      check("P1-11 OPEN request became CONVERTED once", converted.status === "CONVERTED");
    }

    console.log("\nTEST — P1-11 createEstimate action redirects to the existing estimate");
    {
      const workspace = await seedWorkspace("P111 action");
      setTestAccess(workspace.access);
      const request = await admin.serviceRequest.create({
        data: {
          businessId: workspace.business.id,
          customerId: workspace.customer.id,
          status: "OPEN",
          summary: "Deck",
        },
      });
      const created = await createEstimateFromServiceRequest(admin, workspace.access, {
        serviceRequestId: request.id,
        customerId: workspace.customer.id,
        propertyId: null,
        status: "OPEN",
        leadSource: null,
        campaignId: null,
        sourceItems: [],
        measurements: [],
      });
      let redirectedTo = null;
      try {
        await createEstimate(request.id);
      } catch (error) {
        redirectedTo = String(error?.message ?? error);
      }
      check(
        "second createEstimate redirects to the existing estimate",
        redirectedTo?.includes(`/estimates/${created.id}`) === true,
      );
    }

    // ------------------------------------------------------------------
    // P1-13
    // ------------------------------------------------------------------
    function saasParsed(input) {
      return {
        stripeEventId: input.id,
        eventType: input.eventType,
        businessId: input.businessId,
        stripeEventCreatedAt: input.created,
        snapshot: {
          stripeCustomerId: input.customerId,
          stripeSubscriptionId: input.subscriptionId,
          stripePriceId: "price_saas_test",
          status: input.status,
          currentPeriodEnd: input.periodEnd ?? new Date("2026-10-29T16:00:00.000Z"),
          cancelAtPeriodEnd: input.cancelAtPeriodEnd === true,
        },
      };
    }

    async function seedSaasShop(name) {
      const workspace = await seedWorkspace(name);
      await admin.businessSaasSubscription.update({
        where: { businessId: workspace.business.id },
        data: {
          stripeCustomerId: `cus_${workspace.business.id.slice(0, 8)}`,
          stripeSubscriptionId: `sub_${workspace.business.id.slice(0, 8)}`,
        },
      });
      return workspace;
    }

    console.log("\nTEST — P1-13 older CANCEL commits first; newer ACTIVE still wins");
    {
      const workspace = await seedSaasShop("P113 cancel-first");
      const sub = await admin.businessSaasSubscription.findUniqueOrThrow({
        where: { businessId: workspace.business.id },
      });
      const hold = createCommitBarrier();
      let afterLockCount = 0;
      saasBillingTestHooks.afterBusinessLock = async () => {
        afterLockCount += 1;
        if (afterLockCount === 1) await hold.wait();
      };
      const older = applyParsedSaasBillingEvent(
        clientA,
        saasParsed({
          id: "evt_older_cancel_first",
          eventType: "customer.subscription.deleted",
          businessId: workspace.business.id,
          customerId: sub.stripeCustomerId,
          subscriptionId: sub.stripeSubscriptionId,
          status: "canceled",
          created: new Date("2026-09-29T15:00:00.000Z"),
        }),
      );
      await hold.arrived;
      const newer = applyParsedSaasBillingEvent(
        clientB,
        saasParsed({
          id: "evt_newer_active_second",
          eventType: "customer.subscription.updated",
          businessId: workspace.business.id,
          customerId: sub.stripeCustomerId,
          subscriptionId: sub.stripeSubscriptionId,
          status: "active",
          created: new Date("2026-09-29T16:00:00.000Z"),
        }),
      );
      await waitUntilTestDbHasLockWait(admin, "P1-13 cancel-first");
      check("P1-13 cancel-first: older event held the Business lock once", afterLockCount === 1);
      hold.release();
      const [olderResult, newerResult] = await Promise.all([
        withTimeout(older, 8000, "P1-13 older"),
        withTimeout(newer, 8000, "P1-13 newer"),
      ]);
      saasBillingTestHooks.afterBusinessLock = undefined;
      const row = await admin.businessSaasSubscription.findUniqueOrThrow({
        where: { businessId: workspace.business.id },
      });
      const events = await admin.saasBillingWebhookEvent.findMany({
        where: { businessId: workspace.business.id },
      });
      check("older CANCEL applied then newer ACTIVE applied", olderResult.applied === true && newerResult.applied === true);
      check("final subscription status stays ACTIVE", row.status === "active");
      check(
        "lastStripeEventCreatedAt is the newer snapshot",
        row.lastStripeEventCreatedAt?.toISOString() === "2026-09-29T16:00:00.000Z",
      );
      check("both webhook events were recorded", events.length === 2);
    }

    console.log("\nTEST — P1-13 newer ACTIVE commits first; older CANCEL is stale");
    {
      const workspace = await seedSaasShop("P113 active-first");
      const sub = await admin.businessSaasSubscription.findUniqueOrThrow({
        where: { businessId: workspace.business.id },
      });
      const hold = createCommitBarrier();
      let afterLockCount = 0;
      saasBillingTestHooks.afterBusinessLock = async () => {
        afterLockCount += 1;
        if (afterLockCount === 1) await hold.wait();
      };
      const newer = applyParsedSaasBillingEvent(
        clientA,
        saasParsed({
          id: "evt_newer_active_first",
          eventType: "customer.subscription.updated",
          businessId: workspace.business.id,
          customerId: sub.stripeCustomerId,
          subscriptionId: sub.stripeSubscriptionId,
          status: "active",
          created: new Date("2026-09-29T16:00:00.000Z"),
        }),
      );
      await hold.arrived;
      const older = applyParsedSaasBillingEvent(
        clientB,
        saasParsed({
          id: "evt_older_cancel_second",
          eventType: "customer.subscription.deleted",
          businessId: workspace.business.id,
          customerId: sub.stripeCustomerId,
          subscriptionId: sub.stripeSubscriptionId,
          status: "canceled",
          created: new Date("2026-09-29T15:00:00.000Z"),
        }),
      );
      await waitUntilTestDbHasLockWait(admin, "P1-13 active-first");
      check("P1-13 active-first: newer event held the Business lock once", afterLockCount === 1);
      hold.release();
      const [newerResult, olderResult] = await Promise.all([
        withTimeout(newer, 8000, "P1-13 newer first"),
        withTimeout(older, 8000, "P1-13 older second"),
      ]);
      saasBillingTestHooks.afterBusinessLock = undefined;
      const row = await admin.businessSaasSubscription.findUniqueOrThrow({
        where: { businessId: workspace.business.id },
      });
      const events = await admin.saasBillingWebhookEvent.findMany({
        where: { businessId: workspace.business.id },
        orderBy: { processedAt: "asc" },
      });
      check("newer ACTIVE applied", newerResult.applied === true && newerResult.reason === "updated");
      check("older CANCEL rejected as stale_event", olderResult.applied === false && olderResult.reason === "stale_event");
      check("final subscription status remains ACTIVE", row.status === "active");
      check(
        "lastStripeEventCreatedAt stays the newer timestamp",
        row.lastStripeEventCreatedAt?.toISOString() === "2026-09-29T16:00:00.000Z",
      );
      check(
        "both events are in the audit log",
        events.length === 2 &&
          events.some((row) => row.stripeEventId === "evt_newer_active_first") &&
          events.some((row) => row.stripeEventId === "evt_older_cancel_second"),
      );
    }

    console.log("\nSTATIC — P1-13 event acceptance and snapshot update are atomic");
    const saasOpsSrc = readRepo("src/lib/saas-billing/ops.ts");
    check(
      "SaaS webhook apply uses a per-Business advisory lock inside a transaction",
      saasOpsSrc.includes("pg_advisory_xact_lock") &&
        saasOpsSrc.includes("saasBillingLockKey") &&
        saasOpsSrc.includes("$transaction"),
    );
    const applyFn = saasOpsSrc.slice(saasOpsSrc.indexOf("export async function applyParsedSaasBillingEvent"));
    check(
      "stale re-check happens after the lock and before upsert",
      applyFn.indexOf("pg_advisory_xact_lock") > -1 &&
        applyFn.indexOf("pg_advisory_xact_lock") < applyFn.indexOf("isStaleSaasStripeEvent") &&
        applyFn.indexOf("isStaleSaasStripeEvent") < applyFn.lastIndexOf("upsertRow"),
    );
  } catch (error) {
    console.error(error);
    failures += 1;
  } finally {
    await Promise.allSettled([clientA?.$disconnect(), clientB?.$disconnect(), admin?.$disconnect()]);
    await dropTestDatabase();
  }
})();

if (failures > 0) {
  console.error(`\n${failures} transactional-state race check(s) failed.`);
  process.exit(1);
}
console.log("\nAll transactional-state race checks passed.");
