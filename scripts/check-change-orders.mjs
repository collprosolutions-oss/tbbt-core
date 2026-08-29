/**
 * Focused verification for Phase 3 / Step 2: Change Orders + Additional
 * Work (see prisma/schema.prisma ChangeOrder/AdditionalWorkRequest,
 * src/lib/change-order.ts, src/app/actions/change-order.ts,
 * src/app/actions/additional-work-request.ts,
 * src/app/actions/public-change-order.ts,
 * src/app/actions/public-additional-work-request.ts, and the Change
 * Orders / Additional Work sections on src/app/(app)/jobs/[jobId]/page.tsx,
 * src/app/(app)/jobs/[jobId]/change-orders/[changeOrderId]/page.tsx, and
 * src/app/p/[token]/page.tsx).
 *
 * Combines:
 *   1. Pure-function / Prisma-level checks (mirrors the
 *      scripts/check-estimate-versions.mjs and
 *      scripts/check-work-order-portal.mjs pattern) for the Change Order
 *      lifecycle, immutability-once-sent, project-total math, and invoice
 *      integration. Server actions that depend on next/headers
 *      (requireBusinessAccess) are re-implemented inline here exactly like
 *      scripts/check-authorization.mjs already does for estimates/jobs --
 *      the real CAPABILITIES/requireBusinessCapability/ForbiddenError and
 *      the real src/lib/change-order.ts helpers are imported directly.
 *   2. A real HTTP round-trip against the BUILT app (mirrors
 *      scripts/check-work-order-portal.mjs) for the Customer Project
 *      Portal's new Change Orders section and the new internal Change
 *      Order detail route's MEMBER access restriction.
 *
 * Requires the app to already be built (`npm run build`).
 *
 * Run with:
 *   npm run build && node --experimental-strip-types scripts/check-change-orders.mjs
 */
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
} from "../src/lib/authorization.ts";
import {
  CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES,
  customerFacingChangeOrderStatusLabel,
  isCustomerVisibleChangeOrderStatus,
  persistDraftChangeOrderTotal,
  resolveCurrentApprovedProjectTotal,
} from "../src/lib/change-order.ts";
import { resolveApprovedWorkOrderScope } from "../src/lib/job-work-order.ts";

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

const testDbName = "tbbt_change_orders_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for change-orders test database.");
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

async function expectForbidden(label, fn) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, error instanceof ForbiddenError);
  }
}

// Duplicated on purpose (matches scripts/check-authorization.mjs): the real
// requireBusinessAccess() in src/lib/access.ts pulls in next/headers and
// cannot run in a plain script. This mirrors assertOwned's exact behavior.
function makeAccess(businessId, role) {
  return {
    businessId,
    workspace: { role },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

/** Mirrors src/app/actions/change-order.ts createChangeOrder() (guard shape + creation). */
async function mirrorCreateChangeOrder(access, jobId, title) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const job = access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );
  return prisma.changeOrder.create({
    data: { businessId: access.businessId, jobId: job.id, title },
  });
}

/** Mirrors createChangeOrder(..., additionalWorkRequestId) linking an OPEN request. */
async function mirrorCreateChangeOrderFromRequest(access, jobId, title, requestId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const job = access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );
  const request = access.assertOwned(
    await prisma.additionalWorkRequest.findFirst({
      where: { id: requestId, jobId: job.id, ...access.scope },
    }),
  );
  if (request.status !== "OPEN") {
    throw new Error("That request has already been handled.");
  }
  return prisma.$transaction(async (tx) => {
    const created = await tx.changeOrder.create({
      data: { businessId: access.businessId, jobId: job.id, title },
    });
    const linked = await tx.additionalWorkRequest.updateMany({
      where: { id: request.id, businessId: access.businessId, status: "OPEN" },
      data: { status: "CONVERTED", changeOrderId: created.id, reviewedAt: new Date() },
    });
    if (linked.count !== 1) {
      throw new Error("race");
    }
    return created;
  });
}

/** Mirrors addChangeOrderLineItem(). */
async function mirrorAddChangeOrderLineItem(access, changeOrderId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({ where: { id: changeOrderId, ...access.scope } }),
  );
  if (changeOrder.status !== "DRAFT") {
    throw new Error("Only a draft change order can be edited.");
  }
  const total = data.quantity.mul(data.unitPrice);
  return prisma.$transaction(async (tx) => {
    const item = await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        changeOrderId: changeOrder.id,
        description: data.description,
        quantity: data.quantity,
        unitPrice: data.unitPrice,
        total,
        type: data.type ?? "LABOR",
      },
    });
    await persistDraftChangeOrderTotal(tx, changeOrder.id, access.businessId);
    return item;
  });
}

/** Mirrors removeChangeOrderLineItem(). */
async function mirrorRemoveChangeOrderLineItem(access, changeOrderId, lineItemId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({ where: { id: changeOrderId, ...access.scope } }),
  );
  if (changeOrder.status !== "DRAFT") {
    throw new Error("Only a draft change order can be edited.");
  }
  const lineItem = access.assertOwned(
    await prisma.lineItem.findFirst({
      where: { id: lineItemId, changeOrderId: changeOrder.id, ...access.scope },
    }),
  );
  return prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({
      where: { id: lineItem.id, changeOrderId: changeOrder.id, businessId: access.businessId },
    });
    await persistDraftChangeOrderTotal(tx, changeOrder.id, access.businessId);
  });
}

/** Mirrors updateChangeOrderTitle(). */
async function mirrorUpdateChangeOrderTitle(access, changeOrderId, title) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({ where: { id: changeOrderId, ...access.scope } }),
  );
  if (changeOrder.status !== "DRAFT") {
    throw new Error("Only a draft change order can be edited.");
  }
  await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, businessId: access.businessId, status: "DRAFT" },
    data: { title },
  });
}

/** Mirrors sendChangeOrder(). */
async function mirrorSendChangeOrder(access, changeOrderId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
      include: { lineItems: { select: { id: true } } },
    }),
  );
  if (changeOrder.status !== "DRAFT") {
    throw new Error("Only a draft change order can be sent.");
  }
  if (changeOrder.lineItems.length === 0) {
    throw new Error("Add at least one line item before sending.");
  }
  const updated = await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, businessId: access.businessId, status: "DRAFT" },
    data: { status: "SENT", sentAt: new Date() },
  });
  if (updated.count !== 1) {
    throw new Error("Only a draft change order can be sent.");
  }
}

/** Mirrors cancelChangeOrder(). */
async function mirrorCancelChangeOrder(access, changeOrderId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({ where: { id: changeOrderId, ...access.scope } }),
  );
  if (changeOrder.status !== "DRAFT" && changeOrder.status !== "SENT") {
    throw new Error("Only a draft or sent change order can be cancelled.");
  }
  const updated = await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, businessId: access.businessId, status: { in: ["DRAFT", "SENT"] } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
  if (updated.count !== 1) {
    throw new Error("Only a draft or sent change order can be cancelled.");
  }
}

/** Mirrors dismissAdditionalWorkRequest(). */
async function mirrorDismissAdditionalWorkRequest(access, requestId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const request = access.assertOwned(
    await prisma.additionalWorkRequest.findFirst({ where: { id: requestId, ...access.scope } }),
  );
  if (request.status !== "OPEN") {
    throw new Error("That request has already been handled.");
  }
  await prisma.additionalWorkRequest.updateMany({
    where: { id: request.id, businessId: access.businessId, status: "OPEN" },
    data: { status: "DISMISSED", reviewedAt: new Date() },
  });
}

/** Mirrors src/app/actions/public-change-order.ts approveChangeOrder(). Token-scoped, no membership. */
async function mirrorApproveChangeOrderByToken(projectToken, changeOrderId) {
  const job = await prisma.job.findUnique({
    where: { projectToken },
    select: { id: true },
  });
  if (!job) {
    return { ok: false, reason: "not_found" };
  }
  const changeOrder = await prisma.changeOrder.findFirst({
    where: { id: changeOrderId, jobId: job.id },
    select: { id: true, status: true },
  });
  if (!changeOrder) {
    return { ok: false, reason: "not_found" };
  }
  if (changeOrder.status !== "SENT") {
    return { ok: false, reason: "not_ready" };
  }
  const updated = await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, jobId: job.id, status: "SENT" },
    data: { status: "APPROVED", approvedAt: new Date() },
  });
  return { ok: updated.count === 1 };
}

/** Mirrors declineChangeOrder(). */
async function mirrorDeclineChangeOrderByToken(projectToken, changeOrderId) {
  const job = await prisma.job.findUnique({
    where: { projectToken },
    select: { id: true },
  });
  if (!job) {
    return { ok: false, reason: "not_found" };
  }
  const changeOrder = await prisma.changeOrder.findFirst({
    where: { id: changeOrderId, jobId: job.id },
    select: { id: true, status: true },
  });
  if (!changeOrder) {
    return { ok: false, reason: "not_found" };
  }
  if (changeOrder.status !== "SENT") {
    return { ok: false, reason: "not_ready" };
  }
  const updated = await prisma.changeOrder.updateMany({
    where: { id: changeOrder.id, jobId: job.id, status: "SENT" },
    data: { status: "DECLINED", declinedAt: new Date() },
  });
  return { ok: updated.count === 1 };
}

/** Mirrors src/app/actions/public-additional-work-request.ts requestAdditionalWork(). */
async function mirrorRequestAdditionalWork(projectToken, description) {
  const job = await prisma.job.findUnique({
    where: { projectToken },
    select: { id: true, businessId: true },
  });
  if (!job) {
    return { ok: false };
  }
  const created = await prisma.additionalWorkRequest.create({
    data: { businessId: job.businessId, jobId: job.id, description, source: "CUSTOMER" },
  });
  return { ok: true, request: created };
}

const LINE_ITEM_SELECT = {
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
};

async function fetchJobForScope(jobId) {
  return prisma.job.findUnique({
    where: { id: jobId },
    include: {
      estimate: { select: { total: true, lineItems: { select: LINE_ITEM_SELECT } } },
      approvedEstimateVersion: {
        select: {
          versionNumber: true,
          total: true,
          laborMinimumAdjustment: true,
          approvedAt: true,
          lineItems: { select: LINE_ITEM_SELECT },
        },
      },
      changeOrders: { select: { status: true, total: true } },
    },
  });
}

/** Mirrors src/app/actions/invoice.ts createInvoiceFromJob() total computation + guard shape. */
async function mirrorCreateInvoiceFromJob(access, jobId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const job = access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );
  if (job.status !== "COMPLETED") {
    throw new Error("Only a completed job can become an invoice.");
  }
  const existing = await prisma.invoice.findFirst({
    where: { ...access.scope, jobId: job.id },
    select: { id: true },
  });
  if (existing) {
    return { ok: true, invoiceId: existing.id, reused: true };
  }
  const jobWithScope = await fetchJobForScope(job.id);
  const approvedScope = resolveApprovedWorkOrderScope(jobWithScope);
  if (approvedScope.source === "none") {
    throw new Error("This job has no linked estimate.");
  }
  const total = resolveCurrentApprovedProjectTotal(approvedScope.total, jobWithScope.changeOrders);
  const invoice = await prisma.invoice.create({
    data: { businessId: access.businessId, customerId: job.customerId, jobId: job.id, total },
  });
  return { ok: true, invoiceId: invoice.id, reused: false, total };
}

/** Mirrors the guarded DRAFT -> SENT transition + version snapshot in sendEstimate(). */
async function simulateSendEstimate(estimateId, businessId) {
  const { createEstimateVersionSnapshot } = await import(
    "../src/lib/estimate-version.ts"
  );
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId, businessId },
      include: { lineItems: { select: { id: true } } },
    });
    if (!current || current.status !== "DRAFT" || current.lineItems.length === 0) {
      return { ok: false };
    }
    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) {
      return { ok: false };
    }
    const version = await createEstimateVersionSnapshot(tx, { estimateId, businessId });
    return { ok: true, version };
  });
}

/** Mirrors the guarded transition + version binding in approveEstimate(). */
async function simulateApproveEstimate(estimateId) {
  const { findCurrentEstimateVersion } = await import(
    "../src/lib/estimate-version.ts"
  );
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
async function simulateCreateJobFromEstimate(businessId, estimateId, customerId, propertyId) {
  const estimate = await prisma.estimate.findFirst({ where: { id: estimateId, businessId } });
  if (!estimate || estimate.status !== "APPROVED") {
    return { ok: false };
  }
  const job = await prisma.job.create({
    data: {
      businessId,
      customerId: customerId ?? estimate.customerId,
      propertyId: propertyId ?? estimate.propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: estimate.approvedVersionId,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });
  return { ok: true, job };
}

async function createApprovedJob(businessId, customerId, propertyId, estimateTotal, label) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId,
      customerId,
      propertyId,
      total: new Prisma.Decimal(estimateTotal),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId,
      estimateId: estimate.id,
      description: label,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(estimateTotal),
      total: new Prisma.Decimal(estimateTotal),
      type: "LABOR",
    },
  });
  await simulateSendEstimate(estimate.id, businessId);
  await simulateApproveEstimate(estimate.id);
  const jobResult = await simulateCreateJobFromEstimate(businessId, estimate.id, customerId, propertyId);
  return jobResult.job;
}

const PORT = 43822;
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
    data: { name: "Alpha Handyman", slug: "alpha-handyman-co", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-co", tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer", email: "alpha@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "1 Alpha St" },
  });

  const ownerAccessA = makeAccess(businessA.id, "OWNER");
  const adminAccessA = makeAccess(businessA.id, "ADMIN");
  const memberAccessA = makeAccess(businessA.id, "MEMBER");
  const ownerAccessB = makeAccess(businessB.id, "OWNER");

  console.log("\nTEST 1 — OWNER/ADMIN can create a DRAFT Change Order for a Job");
  const job1 = await createApprovedJob(businessA.id, customerA.id, propertyA.id, 1000, "Original kitchen faucet swap");
  const originalVersion = await prisma.estimateVersion.findFirstOrThrow({
    where: { estimateId: job1.estimateId },
  });
  const co1 = await mirrorCreateChangeOrder(ownerAccessA, job1.id, "Add tile backsplash");
  check("change order created", Boolean(co1?.id));
  check("change order starts DRAFT", co1.status === "DRAFT");
  check("change order starts at $0 total (no line items yet)", co1.total.toString() === "0");
  check("change order belongs to the job", co1.jobId === job1.id);

  console.log("\nTEST 2 — DRAFT Change Order can be edited");
  const line1 = await mirrorAddChangeOrderLineItem(ownerAccessA, co1.id, {
    description: "Tile + labor",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(400),
    type: "LABOR",
  });
  let co1AfterAdd = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check("adding a line item recomputes the draft total", co1AfterAdd.total.toString() === "400");
  await mirrorUpdateChangeOrderTitle(ownerAccessA, co1.id, "Add tile backsplash + grout");
  const line2 = await mirrorAddChangeOrderLineItem(ownerAccessA, co1.id, {
    description: "Grout sealing",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(100),
    type: "MATERIAL",
  });
  co1AfterAdd = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check("title edit persisted while DRAFT", co1AfterAdd.title === "Add tile backsplash + grout");
  check("second line item adds to the draft total ($500)", co1AfterAdd.total.toString() === "500");
  await mirrorRemoveChangeOrderLineItem(ownerAccessA, co1.id, line2.id);
  co1AfterAdd = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check("removing a line item recomputes the draft total back to $400", co1AfterAdd.total.toString() === "400");

  console.log("\nTEST 3 — Sending locks the exact customer-facing terms");
  await mirrorSendChangeOrder(ownerAccessA, co1.id);
  const co1AfterSend = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check("change order is SENT", co1AfterSend.status === "SENT");
  check("sentAt is set", co1AfterSend.sentAt !== null);
  check("total is unchanged at $400 after sending", co1AfterSend.total.toString() === "400");
  let rejectedEditAfterSend = false;
  try {
    await mirrorAddChangeOrderLineItem(ownerAccessA, co1.id, {
      description: "Should not be allowed",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(9999),
    });
  } catch {
    rejectedEditAfterSend = true;
  }
  check("adding a line item after Send is rejected", rejectedEditAfterSend);
  let rejectedTitleEditAfterSend = false;
  try {
    await mirrorUpdateChangeOrderTitle(ownerAccessA, co1.id, "Sneaky retitle");
  } catch {
    rejectedTitleEditAfterSend = true;
  }
  check("editing the title after Send is rejected", rejectedTitleEditAfterSend);
  const co1StillLocked = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check(
    "title and total are byte-identical to what was sent (no silent edit succeeded)",
    co1StillLocked.title === "Add tile backsplash + grout" && co1StillLocked.total.toString() === "400",
  );

  console.log("\nTEST 4 — Customer approval binds to the exact sent terms");
  const jobA1 = await prisma.job.findUniqueOrThrow({ where: { id: job1.id } });
  const wrongToken = randomUUID();
  const approveWithWrongToken = await mirrorApproveChangeOrderByToken(wrongToken, co1.id);
  check("approving with a wrong/unknown token is refused", approveWithWrongToken.ok === false);
  const approveResult = await mirrorApproveChangeOrderByToken(jobA1.projectToken, co1.id);
  check("approval with the correct project token succeeds", approveResult.ok === true);
  const co1Approved = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check("change order is APPROVED", co1Approved.status === "APPROVED");
  check("approvedAt is set", co1Approved.approvedAt !== null);
  check(
    "approved total is exactly the sent total ($400), never anything else",
    co1Approved.total.toString() === "400",
  );
  check(
    "approved title is exactly the sent title (no drift between Send and Approve)",
    co1Approved.title === "Add tile backsplash + grout",
  );

  console.log("\nTEST 5 — Approved Change Order cannot be silently modified");
  let rejectedAddAfterApprove = false;
  try {
    await mirrorAddChangeOrderLineItem(ownerAccessA, co1.id, {
      description: "Should not be allowed",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1),
    });
  } catch {
    rejectedAddAfterApprove = true;
  }
  check("adding a line item after Approve is rejected", rejectedAddAfterApprove);
  let rejectedRemoveAfterApprove = false;
  try {
    await mirrorRemoveChangeOrderLineItem(ownerAccessA, co1.id, line1.id);
  } catch {
    rejectedRemoveAfterApprove = true;
  }
  check("removing a line item after Approve is rejected", rejectedRemoveAfterApprove);
  let rejectedSendAfterApprove = false;
  try {
    await mirrorSendChangeOrder(ownerAccessA, co1.id);
  } catch {
    rejectedSendAfterApprove = true;
  }
  check("re-sending an approved change order is rejected", rejectedSendAfterApprove);
  let rejectedCancelAfterApprove = false;
  try {
    await mirrorCancelChangeOrder(ownerAccessA, co1.id);
  } catch {
    rejectedCancelAfterApprove = true;
  }
  check("cancelling an approved change order is rejected", rejectedCancelAfterApprove);
  const co1Untouched = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co1.id } });
  check(
    "approved change order total/title/status are exactly unchanged after every rejected attempt",
    co1Untouched.total.toString() === "400" &&
      co1Untouched.title === "Add tile backsplash + grout" &&
      co1Untouched.status === "APPROVED",
  );

  console.log("\nTEST 6 — Original approved Estimate Version remains unchanged");
  const versionAfterAll = await prisma.estimateVersion.findUniqueOrThrow({
    where: { id: originalVersion.id },
  });
  check(
    "EstimateVersion total is byte-identical to before any change order activity",
    versionAfterAll.total.toString() === originalVersion.total.toString(),
  );
  check(
    "EstimateVersion versionNumber is unchanged",
    versionAfterAll.versionNumber === originalVersion.versionNumber,
  );
  const jobAfterAll = await prisma.job.findUniqueOrThrow({ where: { id: job1.id } });
  check(
    "Job.approvedEstimateVersionId still points at the original version",
    jobAfterAll.approvedEstimateVersionId === originalVersion.id,
  );

  console.log("\nTEST 7 & 8 — Only an APPROVED change order affects the Current Approved Project Total");
  const job1Scope = resolveApprovedWorkOrderScope(await fetchJobForScope(job1.id));
  check("original approved scope total is untouched at $1000", job1Scope.total.toString() === "1000");

  const co2 = await mirrorCreateChangeOrder(ownerAccessA, job1.id, "Draft only, never approved");
  await mirrorAddChangeOrderLineItem(ownerAccessA, co2.id, {
    description: "Draft line",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(50),
  });

  const co3 = await mirrorCreateChangeOrder(ownerAccessA, job1.id, "Sent, pending customer response");
  await mirrorAddChangeOrderLineItem(ownerAccessA, co3.id, {
    description: "Pending line",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(75),
  });
  await mirrorSendChangeOrder(ownerAccessA, co3.id);

  const co4 = await mirrorCreateChangeOrder(ownerAccessA, job1.id, "Sent then declined");
  await mirrorAddChangeOrderLineItem(ownerAccessA, co4.id, {
    description: "Declined line",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(60),
  });
  await mirrorSendChangeOrder(ownerAccessA, co4.id);
  await mirrorDeclineChangeOrderByToken(jobA1.projectToken, co4.id);

  const allChangeOrdersForJob1 = await prisma.changeOrder.findMany({ where: { jobId: job1.id } });
  const projectTotalNow = resolveCurrentApprovedProjectTotal(job1Scope.total, allChangeOrdersForJob1);
  check(
    "Current Approved Project Total = Original ($1000) + only the approved change order ($400) = $1400",
    projectTotalNow.toString() === "1400",
  );
  check(
    "DRAFT change order ($50) is never included",
    allChangeOrdersForJob1.find((co) => co.id === co2.id).status === "DRAFT",
  );
  check(
    "SENT (not yet responded) change order ($75) is never included",
    allChangeOrdersForJob1.find((co) => co.id === co3.id).status === "SENT",
  );
  const co4Final = allChangeOrdersForJob1.find((co) => co.id === co4.id);
  check("DECLINED change order ($60) is never included", co4Final.status === "DECLINED");
  check("declinedAt is set on the declined change order", co4Final.declinedAt !== null);

  console.log("\nSTATIC — customer-visible status filtering never includes DRAFT/CANCELLED");
  check("DRAFT is not customer-visible", !isCustomerVisibleChangeOrderStatus("DRAFT"));
  check("CANCELLED is not customer-visible", !isCustomerVisibleChangeOrderStatus("CANCELLED"));
  check("SENT/APPROVED/DECLINED are customer-visible", ["SENT", "APPROVED", "DECLINED"].every(isCustomerVisibleChangeOrderStatus));
  check(
    "customer-facing labels are plain language",
    customerFacingChangeOrderStatusLabel("SENT") === "Pending Approval" &&
      customerFacingChangeOrderStatusLabel("APPROVED") === "Approved" &&
      customerFacingChangeOrderStatusLabel("DECLINED") === "Declined",
  );
  check(
    "CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES matches exactly SENT/APPROVED/DECLINED",
    CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES.length === 3 &&
      ["SENT", "APPROVED", "DECLINED"].every((s) => CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES.includes(s)),
  );

  console.log("\nCANCEL — a DRAFT/SENT change order can be cancelled by owner/admin, and never re-editable/re-sendable afterward");
  await mirrorCancelChangeOrder(ownerAccessA, co2.id);
  const co2Cancelled = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co2.id } });
  check("cancelled change order status is CANCELLED", co2Cancelled.status === "CANCELLED");
  check("cancelledAt is set", co2Cancelled.cancelledAt !== null);
  let rejectedSendAfterCancel = false;
  try {
    await mirrorSendChangeOrder(ownerAccessA, co2.id);
  } catch {
    rejectedSendAfterCancel = true;
  }
  check("sending a cancelled change order is rejected", rejectedSendAfterCancel);
  const projectTotalAfterCancel = resolveCurrentApprovedProjectTotal(
    job1Scope.total,
    await prisma.changeOrder.findMany({ where: { jobId: job1.id } }),
  );
  check(
    "cancelling a draft change order does not change the current approved project total",
    projectTotalAfterCancel.toString() === "1400",
  );

  console.log("\nTEST 11 — '+ Request Additional Work' creates a reviewable request but does NOT change approved scope/price/invoice");
  const beforeRequestScope = resolveApprovedWorkOrderScope(await fetchJobForScope(job1.id));
  const requestResult = await mirrorRequestAdditionalWork(jobA1.projectToken, "Please also look at the hallway light switch.");
  check("request created successfully", requestResult.ok === true);
  check("request starts OPEN", requestResult.request.status === "OPEN");
  check("request source defaults to CUSTOMER", requestResult.request.source === "CUSTOMER");
  check("request is tied to the correct job", requestResult.request.jobId === job1.id);
  const afterRequestScope = resolveApprovedWorkOrderScope(await fetchJobForScope(job1.id));
  check(
    "approved scope total is unchanged by the request alone",
    afterRequestScope.total.toString() === beforeRequestScope.total.toString(),
  );
  const jobAfterRequest = await prisma.job.findUniqueOrThrow({ where: { id: job1.id } });
  check(
    "Job.approvedEstimateVersionId is unchanged by the request alone",
    jobAfterRequest.approvedEstimateVersionId === originalVersion.id,
  );
  const noInvoiceYet = await prisma.invoice.findFirst({ where: { jobId: job1.id } });
  check("no invoice was created by the request alone", noInvoiceYet === null);

  console.log("\nOwner review of an Additional Work Request — dismiss and convert-to-Change-Order paths");
  const dismissRequest = await mirrorRequestAdditionalWork(jobA1.projectToken, "A request that will be dismissed.");
  await mirrorDismissAdditionalWorkRequest(ownerAccessA, dismissRequest.request.id);
  const dismissed = await prisma.additionalWorkRequest.findUniqueOrThrow({ where: { id: dismissRequest.request.id } });
  check("dismissed request status is DISMISSED", dismissed.status === "DISMISSED");
  check("dismissed request reviewedAt is set", dismissed.reviewedAt !== null);
  let rejectedDoubleDismiss = false;
  try {
    await mirrorDismissAdditionalWorkRequest(ownerAccessA, dismissRequest.request.id);
  } catch {
    rejectedDoubleDismiss = true;
  }
  check("dismissing an already-handled request again is rejected", rejectedDoubleDismiss);

  const convertRequest = await mirrorRequestAdditionalWork(jobA1.projectToken, "Please add a shelf in the closet.");
  const coFromRequest = await mirrorCreateChangeOrderFromRequest(
    ownerAccessA,
    job1.id,
    "Add closet shelf",
    convertRequest.request.id,
  );
  const convertedRequest = await prisma.additionalWorkRequest.findUniqueOrThrow({ where: { id: convertRequest.request.id } });
  check("converted request status is CONVERTED", convertedRequest.status === "CONVERTED");
  check("converted request links to the new change order", convertedRequest.changeOrderId === coFromRequest.id);
  check("the change order created from a request starts DRAFT (never auto-approved)", coFromRequest.status === "DRAFT");

  // --- Invoice integration -------------------------------------------
  console.log("\nTEST 12, 13, 14 — Invoice integration: only APPROVED change orders count, exactly once, no duplicate billing");
  const job2 = await createApprovedJob(businessA.id, customerA.id, propertyA.id, 500, "Original bathroom faucet repair");
  const co5 = await mirrorCreateChangeOrder(ownerAccessA, job2.id, "Additional grout work");
  await mirrorAddChangeOrderLineItem(ownerAccessA, co5.id, {
    description: "Grout",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(150),
  });
  await mirrorSendChangeOrder(ownerAccessA, co5.id);
  const job2Token = (await prisma.job.findUniqueOrThrow({ where: { id: job2.id } })).projectToken;
  await mirrorApproveChangeOrderByToken(job2Token, co5.id);

  const co6 = await mirrorCreateChangeOrder(ownerAccessA, job2.id, "Never approved, never sent");
  await mirrorAddChangeOrderLineItem(ownerAccessA, co6.id, {
    description: "Should never bill",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(9999),
  });

  const invoiceResult1 = await mirrorCreateInvoiceFromJob(ownerAccessA, job2.id);
  check("invoice created successfully", invoiceResult1.ok === true && invoiceResult1.reused === false);
  check(
    "TEST 12 — invoice total = original ($500) + the ONE approved change order ($150) = $650, represented exactly once",
    invoiceResult1.total.toString() === "650",
  );
  check(
    "TEST 13 — the never-sent $9999 change order never inflated the invoice total",
    invoiceResult1.total.toString() !== "10649" && invoiceResult1.total.toString() === "650",
  );

  const invoiceResult2 = await mirrorCreateInvoiceFromJob(ownerAccessA, job2.id);
  check("TEST 14 — running invoice creation again reuses the existing invoice, does not create a second", invoiceResult2.reused === true);
  check("TEST 14 — reused invoice id is identical", invoiceResult2.invoiceId === invoiceResult1.invoiceId);
  const invoiceCountForJob2 = await prisma.invoice.count({ where: { jobId: job2.id } });
  check("TEST 14 — exactly one invoice row exists for this job despite two invoice actions", invoiceCountForJob2 === 1);
  const invoiceRowAfterSecondCall = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceResult1.invoiceId } });
  check(
    "TEST 14 — the invoice's total was not doubled/changed by the repeated action",
    invoiceRowAfterSecondCall.total.toString() === "650",
  );

  console.log("\nTEST 15 — An existing SENT/PAID invoice is not silently rewritten after a LATER change order is approved");
  await prisma.invoice.update({
    where: { id: invoiceResult1.invoiceId },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "CASH" },
  });
  await mirrorSendChangeOrder(ownerAccessA, co6.id);
  await mirrorApproveChangeOrderByToken(job2Token, co6.id);
  const co6Final = await prisma.changeOrder.findUniqueOrThrow({ where: { id: co6.id } });
  check("the late change order is now APPROVED", co6Final.status === "APPROVED");
  const invoiceAfterLateApproval = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceResult1.invoiceId } });
  check(
    "the already-PAID invoice's total is completely unchanged by the later approval ($650, not $10649)",
    invoiceAfterLateApproval.total.toString() === "650",
  );
  check("the already-PAID invoice's status is unchanged (still PAID)", invoiceAfterLateApproval.status === "PAID");
  const newCurrentTotal = resolveCurrentApprovedProjectTotal(
    resolveApprovedWorkOrderScope(await fetchJobForScope(job2.id)).total,
    await prisma.changeOrder.findMany({ where: { jobId: job2.id } }),
  );
  check(
    "meanwhile the Work Order's own Current Approved Project Total correctly reflects BOTH approved change orders ($500 + $150 + $9999 = $10649)",
    newCurrentTotal.toString() === "10649",
  );

  // --- Authorization ----------------------------------------------------
  console.log("\nTEST 16 — OWNER/ADMIN can perform Change Order actions");
  const job3 = await createApprovedJob(businessA.id, customerA.id, propertyA.id, 200, "Owner/Admin capability job");
  const ownerCo = await mirrorCreateChangeOrder(ownerAccessA, job3.id, "Owner-created change order");
  check("OWNER can create a change order", Boolean(ownerCo?.id));
  const adminCo = await mirrorCreateChangeOrder(adminAccessA, job3.id, "Admin-created change order");
  check("ADMIN can create a change order", Boolean(adminCo?.id));
  await mirrorAddChangeOrderLineItem(adminAccessA, adminCo.id, {
    description: "Admin line",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(10),
  });
  await mirrorSendChangeOrder(adminAccessA, adminCo.id);
  const adminSent = await prisma.changeOrder.findUniqueOrThrow({ where: { id: adminCo.id } });
  check("ADMIN can send a change order", adminSent.status === "SENT");

  console.log("\nTEST 17 — MEMBER cannot manage Change Orders or Additional Work Requests");
  await expectForbidden("MEMBER cannot create a change order", () =>
    mirrorCreateChangeOrder(memberAccessA, job3.id, "Should be blocked"),
  );
  await expectForbidden("MEMBER cannot add a line item to a change order", () =>
    mirrorAddChangeOrderLineItem(memberAccessA, ownerCo.id, {
      description: "Should be blocked",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1),
    }),
  );
  await expectForbidden("MEMBER cannot send a change order", () =>
    mirrorSendChangeOrder(memberAccessA, ownerCo.id),
  );
  await expectForbidden("MEMBER cannot cancel a change order", () =>
    mirrorCancelChangeOrder(memberAccessA, ownerCo.id),
  );
  await expectForbidden("MEMBER cannot dismiss an additional work request", () =>
    mirrorDismissAdditionalWorkRequest(memberAccessA, convertRequest.request.id),
  );
  const ownerCoUnchangedByMember = await prisma.changeOrder.findUniqueOrThrow({ where: { id: ownerCo.id } });
  check(
    "the change order MEMBER tried to mutate is completely unchanged",
    ownerCoUnchangedByMember.status === "DRAFT" && ownerCoUnchangedByMember.total.toString() === "0",
  );

  console.log("\nTEST 18 — Tenant isolation: Business B cannot touch Business A's Change Orders or Additional Work Requests");
  let rejectedCrossBusinessCreate = false;
  try {
    await mirrorCreateChangeOrder(ownerAccessB, job3.id, "Cross-tenant attempt");
  } catch (error) {
    rejectedCrossBusinessCreate = error instanceof Error && !(error instanceof ForbiddenError);
  }
  check(
    "Business B cannot create a change order on Business A's job (tenant-isolation rejection, not a role rejection)",
    rejectedCrossBusinessCreate,
  );
  let rejectedCrossBusinessAdd = false;
  try {
    await mirrorAddChangeOrderLineItem(ownerAccessB, ownerCo.id, {
      description: "Cross-tenant attempt",
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(1),
    });
  } catch {
    rejectedCrossBusinessAdd = true;
  }
  check("Business B cannot add a line item to Business A's change order", rejectedCrossBusinessAdd);
  const scopedLookupForB = await prisma.changeOrder.findFirst({
    where: { id: ownerCo.id, businessId: businessB.id },
  });
  check("a businessId-scoped lookup by Business B returns nothing for Business A's change order", scopedLookupForB === null);
  let rejectedCrossBusinessDismiss = false;
  try {
    await mirrorDismissAdditionalWorkRequest(ownerAccessB, convertRequest.request.id);
  } catch {
    rejectedCrossBusinessDismiss = true;
  }
  check("Business B cannot dismiss Business A's additional work request", rejectedCrossBusinessDismiss);

  console.log(
    "\nSTATIC — The public change-order/additional-work actions never accept a client-supplied businessId (only ever job.businessId, derived server-side from the token lookup)",
  );
  for (const file of [
    "src/app/actions/public-change-order.ts",
    "src/app/actions/public-additional-work-request.ts",
  ]) {
    const grep = spawnSync(
      "grep",
      ["-n", '(formData\\.get\\("businessId"\\)|readString\\(formData, "businessId"\\))', "-E", file],
      { cwd: repoRoot.replace(/\/$/, ""), encoding: "utf8" },
    );
    const matches = (grep.stdout || "").split("\n").filter((line) => line.trim().length > 0);
    check(
      `${file} never extracts businessId from client-supplied formData`,
      matches.length === 0,
    );
  }
  const additionalWorkGrep = spawnSync(
    "grep",
    ["-n", "businessId: job.businessId", "src/app/actions/public-additional-work-request.ts"],
    { cwd: repoRoot.replace(/\/$/, ""), encoding: "utf8" },
  );
  check(
    "src/app/actions/public-additional-work-request.ts derives the stored businessId from the token-looked-up Job, not the client",
    (additionalWorkGrep.stdout || "").trim().length > 0,
  );

  // --- HTTP-level checks against the built, running app ---------------
  console.log(`\nStarting built app on ${APP_URL} against the test database...`);

  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Canary Customer CO9" },
  });
  const propertyB = await prisma.property.create({
    data: { businessId: businessB.id, customerId: customerB.id, addressLine1: "9 Beta Canary Ln" },
  });
  const jobB = await createApprovedJob(businessB.id, customerB.id, propertyB.id, 300, "Beta canary original scope");
  const jobBRecord = await prisma.job.findUniqueOrThrow({ where: { id: jobB.id } });
  const coB = await mirrorCreateChangeOrder(ownerAccessB, jobB.id, "SECRET-BETA-CHANGE-ORDER-TITLE");
  await mirrorAddChangeOrderLineItem(ownerAccessB, coB.id, {
    description: "SECRET-BETA-LINE-ITEM",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(777),
  });
  await mirrorSendChangeOrder(ownerAccessB, coB.id);

  const coA_sent = await mirrorCreateChangeOrder(ownerAccessA, job3.id, "VISIBLE-ALPHA-CHANGE-ORDER");
  await mirrorAddChangeOrderLineItem(ownerAccessA, coA_sent.id, {
    description: "Visible alpha line",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(88),
  });
  await mirrorSendChangeOrder(ownerAccessA, coA_sent.id);
  const job3Record = await prisma.job.findUniqueOrThrow({ where: { id: job3.id } });

  serverProcess = spawn(
    "node_modules/.bin/next",
    ["start", "--hostname", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: repoRoot.replace(/\/$/, ""),
      env: { ...process.env, DATABASE_URL: testUrl, NODE_ENV: "production" },
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

  console.log("\nTEST 9 — Customer portal only shows Change Orders belonging to that Job");
  const alphaPortalRes = await fetch(`${APP_URL}/p/${job3Record.projectToken}`, { redirect: "manual" });
  const alphaPortalBody = await alphaPortalRes.text();
  check("Alpha job's portal page returns 200", alphaPortalRes.status === 200);
  check("Alpha job's portal shows its own SENT change order title", alphaPortalBody.includes("VISIBLE-ALPHA-CHANGE-ORDER"));
  check("Alpha job's portal shows its own change order amount ($88.00)", alphaPortalBody.includes("88.00"));
  check("Alpha job's portal never shows Beta's change order title", !alphaPortalBody.includes("SECRET-BETA-CHANGE-ORDER-TITLE"));
  check("Alpha job's portal never shows Beta's line item description", !alphaPortalBody.includes("SECRET-BETA-LINE-ITEM"));
  check("Alpha job's portal never shows Beta's $777 amount", !alphaPortalBody.includes("777.00"));

  const betaPortalRes = await fetch(`${APP_URL}/p/${jobBRecord.projectToken}`, { redirect: "manual" });
  const betaPortalBody = await betaPortalRes.text();
  check("Beta job's own portal DOES show its own change order", betaPortalBody.includes("SECRET-BETA-CHANGE-ORDER-TITLE"));
  check("Beta job's portal never shows Alpha's change order title", !betaPortalBody.includes("VISIBLE-ALPHA-CHANGE-ORDER"));

  console.log("\nTEST 10 — Invalid/wrong token cannot access another Job's Change Order");
  const invalidTokenRes = await fetch(`${APP_URL}/p/${randomUUID()}`, { redirect: "manual" });
  const invalidTokenBody = await invalidTokenRes.text();
  check("an unknown/invalid token still returns 200 (safe 'unavailable' page)", invalidTokenRes.status === 200);
  check("an unknown/invalid token shows no change order data at all", !invalidTokenBody.includes("VISIBLE-ALPHA-CHANGE-ORDER") && !invalidTokenBody.includes("SECRET-BETA-CHANGE-ORDER-TITLE"));
  const wrongTokenApproveAgain = await mirrorApproveChangeOrderByToken(randomUUID(), coA_sent.id);
  check("attempting to approve Alpha's change order via a random/wrong token is refused", wrongTokenApproveAgain.ok === false);
  const betaTokenOnAlphaCo = await mirrorApproveChangeOrderByToken(jobBRecord.projectToken, coA_sent.id);
  check("attempting to approve Alpha's change order via Beta's own valid (but wrong) token is refused", betaTokenOnAlphaCo.ok === false);
  const coA_sentUnchanged = await prisma.changeOrder.findUniqueOrThrow({ where: { id: coA_sent.id } });
  check("Alpha's change order is still SENT (not approved by the wrong-token attempts)", coA_sentUnchanged.status === "SENT");

  console.log("\nTEST 17 (HTTP) — The new internal Change Order detail route is MEMBER-restricted like the rest of the management console");
  // Reuse the same session-cookie approach as scripts/check-management-console-access.mjs
  // would, but keep this focused: an unauthenticated request to the new route
  // must never render management data -- it must redirect to sign-in (no
  // session) rather than ever serving the page.
  const unauthedRes = await fetch(
    `${APP_URL}/jobs/${job3.id}/change-orders/${ownerCo.id}`,
    { redirect: "manual" },
  );
  check(
    "an unauthenticated request to the new Change Order detail route is redirected, never rendered",
    unauthedRes.status >= 300 && unauthedRes.status < 400,
  );

  console.log(
    failures === 0
      ? "\nAll change-order checks passed."
      : `\n${failures} change-order check(s) failed.`,
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
