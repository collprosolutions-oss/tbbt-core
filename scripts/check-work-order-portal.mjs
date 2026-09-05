/**
 * Focused verification for Phase 3 / Step 1: Job/Work Order foundation +
 * Customer Project Portal (see src/lib/job-work-order.ts,
 * src/lib/project-progress.ts, src/app/actions/job.ts
 * createJobFromEstimate(), and src/app/p/[token]/page.tsx).
 *
 * Combines:
 *   1. Pure-function / Prisma-level checks (mirrors the
 *      scripts/check-estimate-versions.mjs pattern) for approved-scope
 *      binding, legacy fallback, and progress-step mapping.
 *   2. A real HTTP round-trip against the BUILT app (mirrors
 *      scripts/check-management-console-access.mjs) for the Customer
 *      Project Portal route (/p/[token]) specifically, since that route's
 *      entire security model -- "only this token, only this job, nothing
 *      else" -- has to be proven against the raw response body, not just
 *      the Prisma query shape.
 *
 * Requires the app to already be built (`npm run build`) so `next start`
 * has a `.next` directory to serve.
 *
 * Run with:
 *   npm run build && node --experimental-strip-types scripts/check-work-order-portal.mjs
 */
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createEstimateVersionSnapshot,
  findCurrentEstimateVersion,
} from "../src/lib/estimate-version.ts";
import { resolveApprovedWorkOrderScope } from "../src/lib/job-work-order.ts";
import {
  customerFacingJobStatusLabel,
  resolveProjectProgressStep,
} from "../src/lib/project-progress.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;

if (!existsSync(`${repoRoot}.next`)) {
  console.error(
    "No .next build output found. Run `npm run build` before this check (see script header).",
  );
  process.exit(1);
}

const testDbName = "tbbt_work_order_portal_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for work-order-portal test database.");
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

async function simulateReturnToDraft(estimateId, businessId) {
  const updated = await prisma.estimate.updateMany({
    where: { id: estimateId, businessId, status: "SENT" },
    data: { status: "DRAFT" },
  });
  return updated.count === 1;
}

/** Mirrors the guarded transition + version binding in approveEstimate(). */
async function simulateApprove(estimateId) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId },
      select: { id: true, businessId: true, status: true },
    });
    if (!current || current.status !== "SENT") {
      return { ok: false };
    }
    const currentVersion = await findCurrentEstimateVersion(tx, current.id);
    if (!currentVersion) {
      return { ok: false };
    }
    const updated = await tx.estimate.updateMany({
      where: { id: current.id, status: "SENT" },
      data: { status: "APPROVED", approvedVersionId: currentVersion.id },
    });
    if (updated.count !== 1) {
      return { ok: false };
    }
    await tx.estimateVersion.update({
      where: { id: currentVersion.id },
      data: { approvedAt: new Date() },
    });
    return { ok: true, versionId: currentVersion.id };
  });
}

/** Mirrors createJobFromEstimate() in src/app/actions/job.ts. */
async function simulateCreateJobFromEstimate(businessId, estimateId) {
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, businessId },
  });
  if (!estimate || estimate.status !== "APPROVED") {
    return { ok: false };
  }
  const job = await prisma.job.create({
    data: {
      businessId,
      customerId: estimate.customerId,
      propertyId: estimate.propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: estimate.approvedVersionId,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  return { ok: true, job };
}

/** Mirrors scheduleJob()'s guarded UNSCHEDULED -> SCHEDULED transition. */
async function simulateSchedule(jobId, businessId) {
  const job = await prisma.job.findFirst({ where: { id: jobId, businessId } });
  await prisma.job.update({
    where: { id: job.id },
    data: {
      scheduledAt: new Date(),
      scheduledDurationMinutes: 60,
      ...(job.status === "UNSCHEDULED" ? { status: "SCHEDULED" } : {}),
    },
  });
}

async function simulateStart(jobId) {
  await prisma.job.update({ where: { id: jobId }, data: { status: "IN_PROGRESS" } });
}

async function simulateComplete(jobId) {
  await prisma.job.update({ where: { id: jobId }, data: { status: "COMPLETED" } });
}

const LINE_ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
};

/** Mirrors the Prisma `include` shape used by the Work Order page + portal. */
async function fetchJobForScope(jobId) {
  return prisma.job.findUnique({
    where: { id: jobId },
    include: {
      estimate: {
        select: { total: true, lineItems: { select: LINE_ITEM_SELECT } },
      },
      approvedEstimateVersion: {
        select: {
          versionNumber: true,
          total: true,
          laborMinimumAdjustment: true,
          approvedAt: true,
          lineItems: { select: LINE_ITEM_SELECT },
        },
      },
    },
  });
}

const PORT = 43821;
const APP_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_URL}/sign-in`, { redirect: "manual" });
      if (res.status < 500) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

let serverProcess;

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-wop", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-wop", tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer", email: "alpha@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "1 Alpha St" },
  });

  console.log(
    "\nTEST 1 — Creating a Job from an APPROVED estimate binds the Job to the exact approved EstimateVersion",
  );
  const estimate1 = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      total: new Prisma.Decimal(100),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate1.id,
      description: "Faucet repair",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(100),
      total: new Prisma.Decimal(100),
      type: "LABOR",
    },
  });
  const send1 = await simulateSend(estimate1.id, businessA.id);
  check("estimate sent (Version 1 created)", send1.ok === true);
  const approve1 = await simulateApprove(estimate1.id);
  check("estimate approved, bound to Version 1", approve1.ok === true);

  const jobResult1 = await simulateCreateJobFromEstimate(businessA.id, estimate1.id);
  check("job created from approved estimate", jobResult1.ok === true);
  check(
    "Job.approvedEstimateVersionId is set to the exact approved EstimateVersion id",
    jobResult1.job.approvedEstimateVersionId === approve1.versionId,
  );
  check(
    "Job.projectToken is a non-empty, unique-looking token",
    typeof jobResult1.job.projectToken === "string" && jobResult1.job.projectToken.length > 10,
  );

  console.log(
    "\nTEST 2 — Version 1 sent, then Version 2 sent/approved -> Job shows Version 2 scope, never Version 1 and never mutable Draft data",
  );
  const estimate2 = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      propertyId: propertyA.id,
      total: new Prisma.Decimal(100),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate2.id,
      description: "Drywall patch",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(100),
      total: new Prisma.Decimal(100),
      type: "LABOR",
    },
  });
  const est2Send1 = await simulateSend(estimate2.id, businessA.id);
  check("Version 1 sent for estimate 2", est2Send1.version?.versionNumber === 1);
  const est2Returned = await simulateReturnToDraft(estimate2.id, businessA.id);
  check("returned to draft before editing", est2Returned === true);
  const soleLineItem = await prisma.lineItem.findFirstOrThrow({
    where: { estimateId: estimate2.id },
  });
  await prisma.lineItem.update({
    where: { id: soleLineItem.id },
    data: { unitPrice: new Prisma.Decimal(250), total: new Prisma.Decimal(250) },
  });
  await prisma.estimate.update({
    where: { id: estimate2.id },
    data: { total: new Prisma.Decimal(250) },
  });
  const est2Send2 = await simulateSend(estimate2.id, businessA.id);
  check("Version 2 sent for estimate 2", est2Send2.version?.versionNumber === 2);
  const est2Approve = await simulateApprove(estimate2.id);
  check("estimate 2 approved, bound to Version 2", est2Approve.ok === true && est2Approve.versionId === est2Send2.version.id);

  // Simulate a further live edit AFTER approval is impossible through the
  // real app (approved estimates can't return to draft), but the Job/portal
  // must read from the bound version regardless of what the live Estimate
  // row says -- prove that directly by pointing the live Estimate at a
  // different (larger) total than either real version, and confirming
  // resolveApprovedWorkOrderScope() still reports Version 2, not this
  // tampered live total and not Version 1.
  await prisma.estimate.update({
    where: { id: estimate2.id },
    data: { total: new Prisma.Decimal(999) },
  });

  const jobResult2 = await simulateCreateJobFromEstimate(businessA.id, estimate2.id);
  check("job created from the re-approved estimate", jobResult2.ok === true);
  check(
    "Job.approvedEstimateVersionId points at Version 2, not Version 1",
    jobResult2.job.approvedEstimateVersionId === est2Send2.version.id &&
      jobResult2.job.approvedEstimateVersionId !== send1.version?.id,
  );

  const jobWithScope = await fetchJobForScope(jobResult2.job.id);
  const scope2 = resolveApprovedWorkOrderScope(jobWithScope);
  check("resolved scope source is the bound version, not the legacy-estimate fallback", scope2.source === "version");
  check("resolved scope reports Version 2", scope2.versionNumber === 2);
  check("resolved scope total is Version 2's $250, never Version 1's $100", scope2.total.toString() === "250");
  check(
    "resolved scope total is NEVER the tampered live Estimate total ($999)",
    scope2.total.toString() !== "999",
  );
  check(
    "resolved scope line item is Version 2's $250 line, not Version 1's $100 line",
    scope2.lineItems.length === 1 && scope2.lineItems[0].total.toString() === "250",
  );

  console.log(
    "\nEXTRA — Legacy Job with no bound EstimateVersion falls back safely to the live Estimate, and is never fabricated",
  );
  const legacyEstimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      total: new Prisma.Decimal(60),
      publicToken: randomUUID(),
      status: "APPROVED",
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: legacyEstimate.id,
      description: "Legacy line",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(60),
      total: new Prisma.Decimal(60),
      type: "LABOR",
    },
  });
  const legacyJob = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      estimateId: legacyEstimate.id,
      // Deliberately NOT setting approvedEstimateVersionId, simulating a
      // Job created before this feature existed (or from a pre-versioning
      // approved estimate) -- application code must never backfill this.
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
  const legacyJobWithScope = await fetchJobForScope(legacyJob.id);
  const legacyScope = resolveApprovedWorkOrderScope(legacyJobWithScope);
  check("legacy job with no bound version falls back to source 'legacy-estimate'", legacyScope.source === "legacy-estimate");
  check("legacy fallback shows the live estimate's real total ($60), not a fabricated version", legacyScope.total.toString() === "60");
  const noEstimateJob = await prisma.job.create({
    data: { businessId: businessA.id, customerId: customerA.id, projectToken: randomUUID(), status: "UNSCHEDULED" },
  });
  const noEstimateScope = resolveApprovedWorkOrderScope(
    await fetchJobForScope(noEstimateJob.id),
  );
  check("job with no linked estimate at all resolves to source 'none'", noEstimateScope.source === "none");

  console.log("\nTEST 3 — Existing Job lifecycle still works: UNSCHEDULED -> SCHEDULED -> IN_PROGRESS -> COMPLETED");
  const lifecycleJob = jobResult1.job;
  check("new job starts UNSCHEDULED", lifecycleJob.status === "UNSCHEDULED");
  await simulateSchedule(lifecycleJob.id, businessA.id);
  const afterSchedule = await prisma.job.findUnique({ where: { id: lifecycleJob.id } });
  check("job moves to SCHEDULED once scheduled", afterSchedule.status === "SCHEDULED");
  await simulateStart(lifecycleJob.id);
  const afterStart = await prisma.job.findUnique({ where: { id: lifecycleJob.id } });
  check("job moves to IN_PROGRESS", afterStart.status === "IN_PROGRESS");
  await simulateComplete(lifecycleJob.id);
  const afterComplete = await prisma.job.findUnique({ where: { id: lifecycleJob.id } });
  check("job moves to COMPLETED", afterComplete.status === "COMPLETED");
  check(
    "Job.approvedEstimateVersionId is untouched by the lifecycle transitions",
    afterComplete.approvedEstimateVersionId === approve1.versionId,
  );

  console.log("\nTEST 10 — Project progress step mapping is derived from real Job/Invoice status only");
  check("UNSCHEDULED with no invoice -> ESTIMATE_APPROVED", resolveProjectProgressStep({ status: "UNSCHEDULED" }, null) === "ESTIMATE_APPROVED");
  check("SCHEDULED with no invoice -> SCHEDULED", resolveProjectProgressStep({ status: "SCHEDULED" }, null) === "SCHEDULED");
  check("IN_PROGRESS with no invoice -> WORK_IN_PROGRESS", resolveProjectProgressStep({ status: "IN_PROGRESS" }, null) === "WORK_IN_PROGRESS");
  check("COMPLETED with no invoice -> COMPLETED", resolveProjectProgressStep({ status: "COMPLETED" }, null) === "COMPLETED");
  check("COMPLETED with a DRAFT/SENT invoice -> INVOICE_RECEIPT", resolveProjectProgressStep({ status: "COMPLETED" }, { status: "SENT" }) === "INVOICE_RECEIPT");
  check("COMPLETED with a PAID invoice -> INVOICE_RECEIPT", resolveProjectProgressStep({ status: "COMPLETED" }, { status: "PAID" }) === "INVOICE_RECEIPT");
  check(
    "customerFacingJobStatusLabel maps every real status to a customer-friendly label",
    customerFacingJobStatusLabel("UNSCHEDULED") === "Awaiting Scheduling" &&
      customerFacingJobStatusLabel("SCHEDULED") === "Scheduled" &&
      customerFacingJobStatusLabel("IN_PROGRESS") === "Work In Progress" &&
      customerFacingJobStatusLabel("COMPLETED") === "Completed",
  );

  console.log(
    "\nSTATIC — The Customer Project Portal route never reads a client-supplied businessId",
  );
  const grepBusinessIdFromClient = spawnSync(
    "grep",
    ["-n", "businessId", "src/app/p/[token]/page.tsx"],
    { cwd: repoRoot.replace(/\/$/, ""), encoding: "utf8" },
  );
  const businessIdCodeLines = (grepBusinessIdFromClient.stdout || "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    // Exclude the security doc-comment above the page component, which
    // mentions "businessId" in prose to explain what is NOT accepted.
    .filter((line) => {
      const afterColon = line.replace(/^\d+:/, "").trim();
      return !afterColon.startsWith("*") && !afterColon.startsWith("//");
    });
  check(
    "src/app/p/[token]/page.tsx has no CODE reference to businessId at all (the lookup is scoped by token alone)",
    businessIdCodeLines.length === 0,
  );

  // --- HTTP-level checks against the built, running app ---------------
  console.log(`\nStarting built app on ${APP_URL} against the test database...`);

  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Canary Customer Q7z" },
  });
  const propertyB = await prisma.property.create({
    data: { businessId: businessB.id, customerId: customerB.id, addressLine1: "9 Beta Canary Ln" },
  });
  const estimateB = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      total: new Prisma.Decimal(500),
      publicToken: randomUUID(),
      status: "APPROVED",
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessB.id,
      estimateId: estimateB.id,
      description: "Beta canary line item",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(500),
      total: new Prisma.Decimal(500),
      type: "LABOR",
    },
  });
  const jobB = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      propertyId: propertyB.id,
      estimateId: estimateB.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      jobId: jobB.id,
      total: new Prisma.Decimal(500),
      status: "PAID",
      paidAt: new Date(),
      paymentMethod: "ZELLE_BANK_TRANSFER",
      paymentReference: "SECRET-OWNER-ONLY-REF-9182",
    },
  });
  await prisma.jobPhoto.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      stage: "BEFORE",
      url: "https://blob.example.com/SECRET-PRIVATE-PHOTO-URL.jpg",
      caption: "SECRET-PRIVATE-PHOTO-CAPTION",
    },
  });

  await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessB.id,
      provider: "stripe",
      stripeAccountId: "acct_test_portal_ready",
    },
  });
  const customerPay = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Sue Bosse Pay Test" },
  });
  const propertyPay = await prisma.property.create({
    data: {
      businessId: businessB.id,
      customerId: customerPay.id,
      addressLine1: "12 Payable Ln",
    },
  });
  const jobPay = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerPay.id,
      propertyId: propertyPay.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });
  await prisma.invoice.create({
    data: {
      businessId: businessB.id,
      customerId: customerPay.id,
      jobId: jobPay.id,
      total: new Prisma.Decimal("300.00"),
      status: "SENT",
    },
  });

  serverProcess = spawn(
    "node_modules/.bin/next",
    ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: repoRoot.replace(/\/$/, ""),
      env: {
        ...process.env,
        DATABASE_URL: testUrl,
        NODE_ENV: "production",
        TBBT_PAYMENTS_ADAPTER: "fake",
        TBBT_PAYMENTS_FAKE_READY: "1",
      },
      stdio: "pipe",
    },
  );
  let serverOutput = "";
  serverProcess.stdout.on("data", (chunk) => (serverOutput += chunk.toString()));
  serverProcess.stderr.on("data", (chunk) => (serverOutput += chunk.toString()));

  const up = await waitForServer(30_000);
  if (!up) {
    console.error("Server did not start in time. Output so far:\n" + serverOutput);
    process.exit(1);
  }

  console.log("\nTEST 7 — Customer project token opens only the correct Job");
  const validRes = await fetch(`${APP_URL}/p/${jobB.projectToken}`, { redirect: "manual" });
  const validBody = await validRes.text();
  check("valid token returns 200", validRes.status === 200);
  check("valid token's page shows this job's own business name", validBody.includes("Beta Handyman"));
  check("valid token's page shows Your Project", validBody.includes("Your Project"));
  check("valid token's page shows this job's own customer name", validBody.includes("Beta Canary Customer Q7z"));
  check(
    "non-CollPro tenant page does not hardcode the CollPro logo asset",
    !validBody.includes("/brand/collpro-logo"),
  );
  check("valid token's page shows the approved total ($500.00)", validBody.includes("500.00"));
  check("valid token's page shows the invoice as Paid", validBody.includes("Paid"));
  check("paid invoice does not offer Pay Invoice", !validBody.includes("Pay Invoice"));

  console.log("\nTEST 8 — A different/invalid project token reveals no other business/customer data");
  const invalidRes = await fetch(`${APP_URL}/p/${randomUUID()}`, { redirect: "manual" });
  const invalidBody = await invalidRes.text();
  check("invalid token still returns 200 (a safe 'unavailable' page, not an error leak)", invalidRes.status === 200);
  check("invalid token's page does NOT show the Beta business name", !invalidBody.includes("Beta Handyman"));
  check("invalid token's page does NOT show the Beta customer name", !invalidBody.includes("Beta Canary Customer Q7z"));
  check("invalid token's page does NOT show any approved total", !invalidBody.includes("500.00"));
  check("invalid token's page contains no management nav (no AppShell)", !invalidBody.includes("Schedule / Jobs"));

  // Also prove Business A's own valid job cannot be reached by Business B's
  // token or vice versa -- there is no cross-token/cross-business leak path.
  const jobAWithToken = await prisma.job.findUnique({ where: { id: jobResult1.job.id } });
  const crossRes = await fetch(`${APP_URL}/p/${jobAWithToken.projectToken}`, { redirect: "manual" });
  const crossBody = await crossRes.text();
  check("Business A's own token never shows Business B's canary data", !crossBody.includes("Beta Canary Customer Q7z") && !crossBody.includes("SECRET-OWNER-ONLY-REF-9182"));

  console.log("\nTEST 9 — Customer portal never includes internal/private Job Photos by default");
  check("valid token's page does not include the private photo URL", !validBody.includes("SECRET-PRIVATE-PHOTO-URL"));
  check("valid token's page does not include the private photo caption", !validBody.includes("SECRET-PRIVATE-PHOTO-CAPTION"));

  console.log("\nEXTRA — Customer portal never includes owner-only invoice metadata");
  check("valid token's page does not include the payment method value", !validBody.includes("ZELLE_BANK_TRANSFER"));
  check("valid token's page does not include the payment reference", !validBody.includes("SECRET-OWNER-ONLY-REF-9182"));

  console.log("\nTEST 10 (portal render) — Progress bar reflects a COMPLETED + PAID job as fully progressed");
  check("portal page highlights the Invoice / Receipt step for this completed+paid job", validBody.includes("Invoice / Receipt"));

  console.log("\nTEST — Outstanding payable invoice exposes Pay Invoice; paid invoice does not");
  const payableRes = await fetch(`${APP_URL}/p/${jobPay.projectToken}`, { redirect: "manual" });
  const payableBody = await payableRes.text();
  check("SENT payable portal returns 200", payableRes.status === 200);
  check(
    "SENT payable portal shows Pay Invoice — $300.00",
    payableBody.includes("Pay Invoice — $300.00"),
  );
  check(
    "SENT payable portal posts only the token pay route",
    payableBody.includes(`action="/p/${jobPay.projectToken}/pay"`),
  );
  check(
    "SENT payable portal does not include a client amount field",
    !payableBody.includes('name="amount"'),
  );
  const payableInvoiceRes = await fetch(`${APP_URL}/p/${jobPay.projectToken}/invoice`, {
    redirect: "manual",
  });
  const payableInvoiceBody = await payableInvoiceRes.text();
  check("SENT payable invoice page returns 200", payableInvoiceRes.status === 200);
  check(
    "SENT payable invoice page shows Pay Invoice — $300.00",
    payableInvoiceBody.includes("Pay Invoice — $300.00"),
  );
  const paidInvoiceRes = await fetch(`${APP_URL}/p/${jobB.projectToken}/invoice`, {
    redirect: "manual",
  });
  const paidInvoiceBody = await paidInvoiceRes.text();
  check(
    "PAID invoice page does not offer Pay Invoice",
    !paidInvoiceBody.includes("Pay Invoice"),
  );

  console.log(
    failures === 0
      ? "\nAll work-order/portal checks passed."
      : `\n${failures} work-order/portal check(s) failed.`,
  );
} finally {
  if (serverProcess) {
    serverProcess.kill("SIGKILL");
  }
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
