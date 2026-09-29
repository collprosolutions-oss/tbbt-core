/**
 * Dynamic reproduction of P1-06 / P1-10 / P1-11 / P1-13 against the
 * current origin/main algorithms. Uses a disposable local Postgres
 * database, two separate Prisma clients, and deterministic barriers.
 *
 * This script does not change production behavior. It only proves whether
 * each finding is still reproducible.
 *
 * Run with:
 *   DATABASE_URL=postgresql://ubuntu:postgres@127.0.0.1:5432/ubuntu \
 *     node --experimental-strip-types scripts/repro-transactional-state-p1.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this reproduction.");
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

const testDbName = "tbbt_transactional_state_repro";
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

const findings = {
  "P1-06": { status: "PENDING", detail: "" },
  "P1-10": { status: "PENDING", detail: "" },
  "P1-11": { status: "PENDING", detail: "" },
  "P1-13": { status: "PENDING", detail: "" },
};

function mark(id, status, detail) {
  findings[id] = { status, detail };
  console.log(`\n=== ${id} ${status} ===`);
  console.log(detail);
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
      throw new Error("Failed to push schema for reproduction database.");
    }

    admin = new PrismaClient({ datasourceUrl: testUrl });
    clientA = new PrismaClient({ datasourceUrl: testUrl });
    clientB = new PrismaClient({ datasourceUrl: testUrl });

    const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
    const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
    const { applyParsedSaasBillingEvent } = await import("@/lib/saas-billing/ops");
    const { persistDraftInvoiceFromCompletedJob } = await import("@/lib/invoice-carry-forward");

    async function seedBusiness(name) {
      const business = await admin.business.create({
        data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}` },
      });
      const customer = await admin.customer.create({
        data: { businessId: business.id, name: `${name} Customer` },
      });
      return { business, customer };
    }

    async function seedApprovedEstimate(businessId, customerId, total = 100) {
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

    // ------------------------------------------------------------------
    // P1-06 — concurrent createJobFromEstimate (current main algorithm)
    // ------------------------------------------------------------------
    async function reproP106(label, withPurchaseList) {
      const { business, customer } = await seedBusiness(`P106 ${label}`);
      const estimate = await seedApprovedEstimate(business.id, customer.id, 250);
      if (withPurchaseList) {
        await admin.materialPurchaseList.create({
          data: { businessId: business.id, estimateId: estimate.id },
        });
      }

      const barrier = createCommitBarrier();
      let reachedBoundary = 0;

      async function convertLikeCreateJobFromEstimate(db) {
        const existing = await db.job.findFirst({
          where: { businessId: business.id, estimateId: estimate.id },
          select: { id: true },
        });
        reachedBoundary += 1;
        await barrier.wait();
        if (existing) return existing;
        return db.job.create({
          data: {
            businessId: business.id,
            customerId: customer.id,
            estimateId: estimate.id,
            approvedEstimateVersionId: estimate.approvedVersionId,
            projectToken: randomUUID(),
            status: "UNSCHEDULED",
          },
        });
      }

      const first = convertLikeCreateJobFromEstimate(clientA);
      await barrier.arrived;
      const second = convertLikeCreateJobFromEstimate(clientB);
      const bothReached = await (async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (reachedBoundary >= 2) return true;
          await sleep(10);
        }
        return reachedBoundary >= 2;
      })();
      barrier.release();
      const [a, b] = await Promise.all([
        withTimeout(first, 8000, "P1-06 worker A"),
        withTimeout(second, 8000, "P1-06 worker B"),
      ]);

      const jobs = await admin.job.findMany({
        where: { businessId: business.id, estimateId: estimate.id },
        select: { id: true, projectToken: true },
      });

      for (const job of jobs) {
        await admin.job.update({
          where: { id: job.id },
          data: { status: "COMPLETED" },
        });
        await persistDraftInvoiceFromCompletedJob(admin, {
          businessId: business.id,
          jobId: job.id,
        });
      }
      const invoices = await admin.invoice.findMany({
        where: { businessId: business.id, kind: "ORIGINAL" },
        select: { id: true, jobId: true },
      });
      const lists = await admin.materialPurchaseList.findMany({
        where: { businessId: business.id, estimateId: estimate.id },
      });

      return {
        bothReached,
        jobCount: jobs.length,
        tokenCount: new Set(jobs.map((row) => row.projectToken)).size,
        invoiceCount: invoices.length,
        listJobIds: lists.map((row) => row.jobId),
        createdIds: [a.id, b.id],
      };
    }

    const withoutList = await reproP106("no list", false);
    const withList = await reproP106("with list", true);
    const p106Dup =
      withoutList.bothReached &&
      withoutList.jobCount === 2 &&
      withoutList.tokenCount === 2 &&
      withoutList.invoiceCount === 2 &&
      withList.bothReached &&
      withList.jobCount === 2;
    mark(
      "P1-06",
      p106Dup ? "REPRODUCED" : withoutList.jobCount === 1 && withList.jobCount === 1 ? "DISPROVED" : "REPRODUCED",
      [
        `without purchase list: jobs=${withoutList.jobCount} tokens=${withoutList.tokenCount} originals=${withoutList.invoiceCount} bothReached=${withoutList.bothReached}`,
        `with purchase list: jobs=${withList.jobCount} tokens=${withList.tokenCount} originals=${withList.invoiceCount} bothReached=${withList.bothReached} listJobIds=${JSON.stringify(withList.listJobIds)}`,
        "Algorithm: findFirst existing job, barrier, then job.create (src/app/actions/job.ts createJobFromEstimate).",
      ].join("\n"),
    );

    // ------------------------------------------------------------------
    // P1-10 — draft line write vs sendEstimate (current main algorithm)
    // ------------------------------------------------------------------
    {
      const { business } = await seedBusiness("P110");
      const estimate = await admin.estimate.create({
        data: {
          businessId: business.id,
          status: "DRAFT",
          total: new Prisma.Decimal(10),
          publicToken: randomUUID(),
        },
      });
      const line = await admin.lineItem.create({
        data: {
          businessId: business.id,
          estimateId: estimate.id,
          description: "Custom quote (custom quote — enter price)",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
          type: "LABOR",
        },
      });
      await persistDraftEstimateTotal(admin, estimate.id, business.id);

      const barrier = createCommitBarrier();
      let mutationSawDraft = false;
      let sendLocked = false;

      const mutation = (async () => {
        const pre = await clientA.estimate.findFirst({
          where: { id: estimate.id, businessId: business.id },
          select: { status: true },
        });
        if (pre?.status !== "DRAFT") throw new Error("P1-10 precheck expected DRAFT");
        mutationSawDraft = true;
        return clientA.$transaction(async (tx) => {
          await barrier.wait();
          await tx.lineItem.update({
            where: { id: line.id },
            data: {
              unitPrice: new Prisma.Decimal(999),
              total: new Prisma.Decimal(999),
              description: "STALE DRAFT WRITE AFTER SEND",
            },
          });
          await persistDraftEstimateTotal(tx, estimate.id, business.id);
          return "mutated";
        });
      })();

      await barrier.arrived;
      if (!mutationSawDraft) throw new Error("P1-10 mutation never reached DRAFT precheck");

      const send = clientB.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "Estimate"
          WHERE id = ${estimate.id} AND "businessId" = ${business.id}
          FOR UPDATE
        `;
        sendLocked = true;
        const updated = await tx.estimate.updateMany({
          where: { id: estimate.id, businessId: business.id, status: "DRAFT" },
          data: { status: "SENT" },
        });
        if (updated.count !== 1) throw new Error("P1-10 send did not claim DRAFT");
        await createEstimateVersionSnapshot(tx, {
          estimateId: estimate.id,
          businessId: business.id,
        });
        return "sent";
      });

      const sendResult = await withTimeout(send, 8000, "P1-10 send");
      barrier.release();
      const mutationResult = await withTimeout(mutation, 8000, "P1-10 mutation");

      const after = await admin.estimate.findUniqueOrThrow({
        where: { id: estimate.id },
        include: {
          lineItems: true,
          versions: { include: { lineItems: true } },
        },
      });
      const live = after.lineItems[0];
      const snap = after.versions[0]?.lineItems[0];
      const staleCommitted =
        after.status === "SENT" &&
        live.description === "STALE DRAFT WRITE AFTER SEND" &&
        Number(live.unitPrice) === 999 &&
        Number(snap?.unitPrice ?? 0) === 0;
      mark(
        "P1-10",
        staleCommitted ? "REPRODUCED" : "DISPROVED",
        [
          `send=${sendResult} mutation=${mutationResult} sendLocked=${sendLocked} mutationSawDraft=${mutationSawDraft}`,
          `status=${after.status} livePrice=${live.unitPrice} liveDesc=${live.description}`,
          `snapshotPrice=${snap?.unitPrice} snapshotDesc=${snap?.description}`,
          "Algorithm: priceDraftEstimateLine pre-checks DRAFT then writes LineItem with no in-tx claim; sendEstimate FOR UPDATE + SENT + snapshot.",
        ].join("\n"),
      );
    }

    // ------------------------------------------------------------------
    // P1-11 — concurrent createEstimate (current main algorithm)
    // ------------------------------------------------------------------
    {
      const { business, customer } = await seedBusiness("P111");
      const request = await admin.serviceRequest.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          status: "OPEN",
          summary: "Fence repair",
        },
      });
      const barrier = createCommitBarrier();
      let reachedBoundary = 0;

      async function convertLikeCreateEstimate(db) {
        const raced = await db.estimate.findFirst({
          where: { businessId: business.id, serviceRequestId: request.id },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        reachedBoundary += 1;
        await barrier.wait();
        if (raced) return raced;
        return db.$transaction(async (tx) => {
          const again = await tx.estimate.findFirst({
            where: { businessId: business.id, serviceRequestId: request.id },
            select: { id: true },
          });
          if (again) return again;
          return tx.estimate.create({
            data: {
              businessId: business.id,
              serviceRequestId: request.id,
              customerId: customer.id,
              total: new Prisma.Decimal(0),
              publicToken: randomUUID(),
            },
          });
        });
      }

      const first = convertLikeCreateEstimate(clientA);
      await barrier.arrived;
      const second = convertLikeCreateEstimate(clientB);
      const bothReached = await (async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (reachedBoundary >= 2) return true;
          await sleep(10);
        }
        return reachedBoundary >= 2;
      })();
      barrier.release();
      await Promise.all([
        withTimeout(first, 8000, "P1-11 worker A"),
        withTimeout(second, 8000, "P1-11 worker B"),
      ]);
      const estimates = await admin.estimate.findMany({
        where: { businessId: business.id, serviceRequestId: request.id },
      });
      mark(
        "P1-11",
        estimates.length > 1 ? "REPRODUCED" : "DISPROVED",
        [
          `bothReached=${bothReached} estimateCount=${estimates.length} ids=${estimates.map((row) => row.id).join(",")}`,
          "Algorithm: createEstimate findFirst + in-tx findFirst then create (no ServiceRequest FOR UPDATE, no unique index).",
          "Product semantics: createEstimate redirects if one exists, request UI hides Create when estimates.length>0, but schema is Estimate[], pipeline pickPrimaryEstimate handles multiples, reports copy says \"A request with two estimates still counts once\", and createDraftEstimateWithOptionalTemplate can attach serviceRequestId without uniqueness.",
          "Uniqueness is NOT a conclusive product rule — founder decision required before a unique index.",
        ].join("\n"),
      );
    }

    // ------------------------------------------------------------------
    // P1-13 — reverse-commit SaaS webhooks (current main algorithm)
    // ------------------------------------------------------------------
    {
      const { business } = await seedBusiness("P113");
      await admin.businessSaasSubscription.create({
        data: {
          businessId: business.id,
          status: "none",
          stripeCustomerId: "cus_p113",
          stripeSubscriptionId: "sub_p113",
        },
      });

      const newerActive = {
        stripeEventId: "evt_newer_active",
        eventType: "customer.subscription.updated",
        businessId: business.id,
        stripeEventCreatedAt: new Date("2026-09-29T16:00:00.000Z"),
        snapshot: {
          stripeCustomerId: "cus_p113",
          stripeSubscriptionId: "sub_p113",
          stripePriceId: "price_saas_test",
          status: "active",
          currentPeriodEnd: new Date("2026-10-29T16:00:00.000Z"),
          cancelAtPeriodEnd: false,
        },
      };
      const olderCancel = {
        stripeEventId: "evt_older_cancel",
        eventType: "customer.subscription.deleted",
        businessId: business.id,
        stripeEventCreatedAt: new Date("2026-09-29T15:00:00.000Z"),
        snapshot: {
          stripeCustomerId: "cus_p113",
          stripeSubscriptionId: "sub_p113",
          stripePriceId: "price_saas_test",
          status: "canceled",
          currentPeriodEnd: new Date("2026-09-29T15:00:00.000Z"),
          cancelAtPeriodEnd: false,
        },
      };

      const barrier = createCommitBarrier();
      let cancelReadCurrent = null;
      let activeApplied = false;

      const cancelWorker = (async () => {
        const existingEvent = await clientA.saasBillingWebhookEvent.findUnique({
          where: { stripeEventId: olderCancel.stripeEventId },
        });
        if (existingEvent) return { applied: false, reason: "already_processed" };
        const current = await clientA.businessSaasSubscription.findUnique({
          where: { businessId: business.id },
        });
        cancelReadCurrent = current?.status ?? null;
        await barrier.wait();
        await clientA.businessSaasSubscription.update({
          where: { businessId: business.id },
          data: {
            status: "canceled",
            lastStripeEventCreatedAt: olderCancel.stripeEventCreatedAt,
          },
        });
        await clientA.saasBillingWebhookEvent.create({
          data: {
            stripeEventId: olderCancel.stripeEventId,
            eventType: olderCancel.eventType,
            businessId: business.id,
            stripeEventCreatedAt: olderCancel.stripeEventCreatedAt,
          },
        });
        return { applied: true, reason: "updated-stale-read" };
      })();

      await barrier.arrived;
      const activeResult = await applyParsedSaasBillingEvent(clientB, newerActive);
      activeApplied = activeResult.applied === true;
      barrier.release();
      await withTimeout(cancelWorker, 8000, "P1-13 older cancel");

      const row = await admin.businessSaasSubscription.findUniqueOrThrow({
        where: { businessId: business.id },
      });
      const events = await admin.saasBillingWebhookEvent.findMany({
        where: { businessId: business.id },
        orderBy: { processedAt: "asc" },
      });
      const regressed = row.status === "canceled";
      mark(
        "P1-13",
        regressed ? "REPRODUCED" : "DISPROVED",
        [
          `cancelReadCurrent=${cancelReadCurrent} activeApplied=${activeApplied} finalStatus=${row.status} lastEvent=${row.lastStripeEventCreatedAt?.toISOString()}`,
          `events=${events.map((row) => `${row.eventType}:${row.stripeEventId}`).join(", ")}`,
          "Forced reverse commit: newer ACTIVE snapshot committed first; older CANCEL/CANCELED committed second from a stale pre-lock read.",
          "applyParsedSaasBillingEvent has a sequential stale guard but no per-Business lock and no atomic event+snapshot transaction.",
        ].join("\n"),
      );
    }
  } catch (error) {
    console.error(error);
    for (const [id, finding] of Object.entries(findings)) {
      if (finding.status === "PENDING") {
        findings[id] = { status: "ERROR", detail: String(error?.message ?? error) };
      }
    }
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([clientA?.$disconnect(), clientB?.$disconnect(), admin?.$disconnect()]);
    await dropTestDatabase();
    const reportPath = "/tmp/tbbt-p1-repro-report.json";
    writeFileSync(reportPath, JSON.stringify({ baseline: "fc9b8955d52870bc353e98e2347f12a00c6e06b6", findings }, null, 2));
    console.log(`\nWrote ${reportPath}`);
    console.log(JSON.stringify(findings, null, 2));
  }
})();
