/**
 * Focused verification for Step 2 role/permission enforcement (see
 * src/lib/authorization.ts and every "use server" file under
 * src/app/actions/).
 *
 * This imports the REAL production `requireBusinessCapability` /
 * `CAPABILITIES` / `ForbiddenError` from src/lib/authorization.ts (that
 * module has no next/headers dependency, so it can run directly in a plain
 * Node script). The surrounding tenant-scoping shape (`access.scope`,
 * `access.assertOwned`) is re-implemented inline here, matching the
 * duplication already established in scripts/check-isolation.mjs and
 * scripts/check-estimate-versions.mjs, since the real `requireBusinessAccess()`
 * in src/lib/access.ts pulls in next/headers (request-scoped cookies) and
 * cannot be invoked outside a Next.js request.
 *
 * Runs against a disposable sibling Postgres database (created by
 * `prisma db push` and dropped afterward), matching the existing pattern.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-authorization.mjs
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  CAPABILITIES,
  ForbiddenError,
  requireBusinessCapability,
  roleHasCapability,
} from "../src/lib/authorization.ts";

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_authorization_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for authorization test database.");
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

async function expectAllowed(label, fn) {
  try {
    await fn();
    check(label, true);
  } catch (error) {
    console.error(`      -> unexpected error: ${error?.message ?? error}`);
    check(label, false);
  }
}

// Duplicated on purpose (matches scripts/check-isolation.mjs /
// scripts/check-estimate-versions.mjs): src/lib/access.ts pulls in
// next/headers and cannot run in a plain script. This mirrors
// `assertOwned`/`assertAttachable`'s exact behavior (throw a plain Error --
// NOT ForbiddenError -- on a cross-business record), so tests can tell a
// role rejection (ForbiddenError) apart from a tenant-isolation rejection
// (plain Error).
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

/** Mirrors src/app/actions/catalog.ts createServiceCatalogItem(). */
async function mirrorCreateServiceCatalogItem(access, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  return prisma.serviceCatalogItem.create({
    data: { businessId: access.businessId, ...data },
  });
}

/** Mirrors src/app/actions/catalog.ts updateServiceCatalogItem(). */
async function mirrorUpdateServiceCatalogItem(access, id, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CATALOG);
  const item = access.assertOwned(
    await prisma.serviceCatalogItem.findFirst({
      where: { id, ...access.scope },
    }),
  );
  return prisma.serviceCatalogItem.update({ where: { id: item.id }, data });
}

/** Mirrors src/app/actions/customer.ts updateCustomer(). */
async function mirrorUpdateCustomer(access, customerId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const customer = access.assertOwned(
    await prisma.customer.findFirst({
      where: { id: customerId, ...access.scope },
    }),
  );
  return prisma.customer.update({ where: { id: customer.id }, data });
}

/** Mirrors src/app/actions/property.ts addCustomerProperty(). */
async function mirrorAddCustomerProperty(access, customerId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const customer = access.assertOwned(
    await prisma.customer.findFirst({
      where: { id: customerId, ...access.scope },
    }),
  );
  return prisma.property.create({
    data: { businessId: access.businessId, customerId: customer.id, ...data },
  });
}

/** Mirrors src/app/actions/property.ts updateCustomerProperty(). */
async function mirrorUpdateCustomerProperty(access, propertyId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const property = access.assertOwned(
    await prisma.property.findFirst({
      where: { id: propertyId, ...access.scope },
    }),
  );
  return prisma.property.update({ where: { id: property.id }, data });
}

/** Mirrors src/app/actions/estimate.ts addCatalogLineItem() (guard shape only). */
async function mirrorAddCatalogLineItem(access, estimateId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  return access.assertOwned(
    await prisma.estimate.findFirst({ where: { id: estimateId, ...access.scope } }),
  );
}

/** Mirrors src/app/actions/estimate.ts sendEstimate() (guarded transition only). */
async function mirrorSendEstimate(access, estimateId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({ where: { id: estimateId, ...access.scope } }),
  );
  if (estimate.status !== "DRAFT") {
    throw new Error("Only a draft estimate can be sent.");
  }
  await prisma.estimate.updateMany({
    where: { id: estimate.id, businessId: access.businessId, status: "DRAFT" },
    data: { status: "SENT" },
  });
}

/** Mirrors src/app/actions/estimate.ts returnEstimateToDraft(). */
async function mirrorReturnEstimateToDraft(access, estimateId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({ where: { id: estimateId, ...access.scope } }),
  );
  if (estimate.status !== "SENT") {
    throw new Error("Only a sent estimate can be returned to draft.");
  }
  await prisma.estimate.updateMany({
    where: { id: estimate.id, businessId: access.businessId, status: "SENT" },
    data: { status: "DRAFT" },
  });
}

/** Mirrors src/app/actions/invoice.ts createInvoiceFromJob() (guard shape only). */
async function mirrorCreateInvoiceFromJob(access, jobId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  return access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );
}

/** Mirrors src/app/actions/invoice.ts markInvoiceSent(). */
async function mirrorMarkInvoiceSent(access, invoiceId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({ where: { id: invoiceId, ...access.scope } }),
  );
  await prisma.invoice.updateMany({
    where: { id: invoice.id, businessId: access.businessId, status: "DRAFT" },
    data: { status: "SENT" },
  });
}

/** Mirrors src/app/actions/invoice.ts markInvoicePaid(). */
async function mirrorMarkInvoicePaid(access, invoiceId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({ where: { id: invoiceId, ...access.scope } }),
  );
  await prisma.invoice.updateMany({
    where: { id: invoice.id, businessId: access.businessId, status: "SENT" },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "CASH" },
  });
}

/** Mirrors src/app/actions/job.ts startJob() / markJobComplete() (guard shape only). */
async function mirrorOperateJob(access, jobId) {
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  return access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );
}

/** Mirrors src/app/actions/job.ts createJobFromEstimate() / scheduleJob() (guard shape only). */
async function mirrorManageJob(access, jobId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  return access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );
}

/** Mirrors src/app/actions/settings.ts updateLaborMinimumSettings() (guard shape only). */
async function mirrorUpdateSettings(access) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_SETTINGS);
  return prisma.business.update({
    where: { id: access.businessId },
    data: { laborMinimumEnabled: true, laborMinimumAmount: new Prisma.Decimal(50) },
  });
}

try {
  console.log("\nSTATIC — Role/capability matrix matches the locked authority model");
  const allCapabilities = Object.values(CAPABILITIES);
  check(
    "OWNER has every currently-implemented capability",
    allCapabilities.every((capability) => roleHasCapability("OWNER", capability)),
  );
  check(
    "ADMIN has every currently-implemented ordinary business-management capability",
    allCapabilities.every((capability) => roleHasCapability("ADMIN", capability)),
  );
  check(
    "MEMBER has NO general owner/admin management capability (foundation only)",
    allCapabilities.every((capability) => !roleHasCapability("MEMBER", capability)),
  );

  const businessA = await prisma.business.create({
    data: { name: "Alpha Handyman", slug: "alpha-handyman-auth", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handyman", slug: "beta-handyman-auth", tradeCode: "HANDYMAN" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER");
  const adminA = makeAccess(businessA.id, "ADMIN");
  const memberA = makeAccess(businessA.id, "MEMBER");
  const memberB = makeAccess(businessB.id, "MEMBER");

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });

  console.log("\nTEST 1 — OWNER can perform existing owner management actions");
  await expectAllowed("OWNER can create a service catalog item", () =>
    mirrorCreateServiceCatalogItem(ownerA, {
      name: "Gutter cleaning",
      pricingMode: "FLAT_RATE",
      price: new Prisma.Decimal(120),
    }),
  );
  await expectAllowed("OWNER can update a customer", () =>
    mirrorUpdateCustomer(ownerA, customerA.id, { name: "Alpha Customer (Owner-edited)" }),
  );
  const ownerCustomer = await prisma.customer.findUnique({ where: { id: customerA.id } });
  check("Customer record reflects OWNER's edit", ownerCustomer.name === "Alpha Customer (Owner-edited)");

  const estimateForOwner = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      total: new Prisma.Decimal(100),
      publicToken: randomUUID(),
    },
  });
  await expectAllowed("OWNER can send a draft estimate", () =>
    mirrorSendEstimate(ownerA, estimateForOwner.id),
  );
  const jobForOwner = await prisma.job.create({
    data: { businessId: businessA.id, customerId: customerA.id, status: "COMPLETED" },
  });
  const invoiceForOwner = await prisma.invoice.create({
    data: { businessId: businessA.id, customerId: customerA.id, jobId: jobForOwner.id, total: new Prisma.Decimal(100), status: "SENT" },
  });
  await expectAllowed("OWNER can mark an invoice paid", () =>
    mirrorMarkInvoicePaid(ownerA, invoiceForOwner.id),
  );
  const paidByOwner = await prisma.invoice.findUnique({ where: { id: invoiceForOwner.id } });
  check("Invoice status is PAID after OWNER's action", paidByOwner.status === "PAID");

  console.log("\nTEST 2 — ADMIN can perform allowed ordinary management actions");
  await expectAllowed("ADMIN can create a service catalog item", () =>
    mirrorCreateServiceCatalogItem(adminA, {
      name: "Faucet repair",
      pricingMode: "FLAT_RATE",
      price: new Prisma.Decimal(75),
    }),
  );
  await expectAllowed("ADMIN can update a customer", () =>
    mirrorUpdateCustomer(adminA, customerA.id, { name: "Alpha Customer (Admin-edited)" }),
  );
  const adminCustomer = await prisma.customer.findUnique({ where: { id: customerA.id } });
  check("Customer record reflects ADMIN's edit", adminCustomer.name === "Alpha Customer (Admin-edited)");

  const estimateForAdmin = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      total: new Prisma.Decimal(200),
      publicToken: randomUUID(),
    },
  });
  await expectAllowed("ADMIN can send a draft estimate", () =>
    mirrorSendEstimate(adminA, estimateForAdmin.id),
  );
  await expectAllowed("ADMIN can return a sent estimate to draft", () =>
    mirrorReturnEstimateToDraft(adminA, estimateForAdmin.id),
  );
  const adminEstimate = await prisma.estimate.findUnique({ where: { id: estimateForAdmin.id } });
  check("Estimate is back in DRAFT after ADMIN's action", adminEstimate.status === "DRAFT");

  console.log("\nTEST 3 — MEMBER cannot modify service pricing/catalog");
  const catalogItem = await prisma.serviceCatalogItem.create({
    data: { businessId: businessA.id, name: "Drywall patch", pricingMode: "FLAT_RATE", price: new Prisma.Decimal(90) },
  });
  await expectForbidden("MEMBER cannot create a service catalog item", () =>
    mirrorCreateServiceCatalogItem(memberA, {
      name: "Unauthorized item",
      pricingMode: "FLAT_RATE",
      price: new Prisma.Decimal(1),
    }),
  );
  await expectForbidden("MEMBER cannot update a service catalog item's price", () =>
    mirrorUpdateServiceCatalogItem(memberA, catalogItem.id, { price: new Prisma.Decimal(9999) }),
  );
  const catalogItemAfter = await prisma.serviceCatalogItem.findUnique({ where: { id: catalogItem.id } });
  check("Catalog item price is unchanged after MEMBER's rejected attempt", catalogItemAfter.price.toString() === "90");

  console.log("\nTEST 4 — MEMBER cannot send/return-to-draft/manage estimates");
  const memberDraftEstimate = await prisma.estimate.create({
    data: { businessId: businessA.id, customerId: customerA.id, total: new Prisma.Decimal(50), publicToken: randomUUID() },
  });
  await expectForbidden("MEMBER cannot add a line item to an estimate", () =>
    mirrorAddCatalogLineItem(memberA, memberDraftEstimate.id),
  );
  await expectForbidden("MEMBER cannot send a draft estimate", () =>
    mirrorSendEstimate(memberA, memberDraftEstimate.id),
  );
  const estimateStillDraft = await prisma.estimate.findUnique({ where: { id: memberDraftEstimate.id } });
  check("Estimate remains DRAFT after MEMBER's rejected send", estimateStillDraft.status === "DRAFT");

  const memberSentEstimate = await prisma.estimate.create({
    data: { businessId: businessA.id, customerId: customerA.id, total: new Prisma.Decimal(50), publicToken: randomUUID(), status: "SENT" },
  });
  await expectForbidden("MEMBER cannot return a sent estimate to draft", () =>
    mirrorReturnEstimateToDraft(memberA, memberSentEstimate.id),
  );
  const estimateStillSent = await prisma.estimate.findUnique({ where: { id: memberSentEstimate.id } });
  check("Estimate remains SENT after MEMBER's rejected return-to-draft", estimateStillSent.status === "SENT");
  console.log(
    "  note - Approving an estimate (approveEstimate) is a PUBLIC customer action gated by\n" +
    "         publicToken + status, not a business Membership role; it is intentionally out of\n" +
    "         scope for requireBusinessCapability and is unaffected by this layer.",
  );

  console.log("\nTEST 5 — MEMBER cannot create/modify invoices or mark invoices paid");
  const memberJob = await prisma.job.create({
    data: { businessId: businessA.id, customerId: customerA.id, status: "COMPLETED" },
  });
  await expectForbidden("MEMBER cannot create an invoice from a completed job", () =>
    mirrorCreateInvoiceFromJob(memberA, memberJob.id),
  );
  const memberInvoice = await prisma.invoice.create({
    data: { businessId: businessA.id, customerId: customerA.id, total: new Prisma.Decimal(300), status: "DRAFT" },
  });
  await expectForbidden("MEMBER cannot mark an invoice sent", () =>
    mirrorMarkInvoiceSent(memberA, memberInvoice.id),
  );
  await prisma.invoice.update({ where: { id: memberInvoice.id }, data: { status: "SENT" } });
  await expectForbidden("MEMBER cannot mark an invoice paid", () =>
    mirrorMarkInvoicePaid(memberA, memberInvoice.id),
  );
  const memberInvoiceAfter = await prisma.invoice.findUnique({ where: { id: memberInvoice.id } });
  check("Invoice is not PAID after MEMBER's rejected attempts", memberInvoiceAfter.status === "SENT");

  console.log("\nTEST 6 — MEMBER cannot modify customers/properties through a direct server action");
  await expectForbidden("MEMBER cannot update a customer", () =>
    mirrorUpdateCustomer(memberA, customerA.id, { name: "Should not stick" }),
  );
  await expectForbidden("MEMBER cannot add a customer property", () =>
    mirrorAddCustomerProperty(memberA, customerA.id, { addressLine1: "123 Should Not Exist" }),
  );
  const propertyForMember = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "1 Real St" },
  });
  await expectForbidden("MEMBER cannot update a customer property", () =>
    mirrorUpdateCustomerProperty(memberA, propertyForMember.id, { addressLine1: "Tampered address" }),
  );
  const customerAfterMemberAttempt = await prisma.customer.findUnique({ where: { id: customerA.id } });
  const propertyAfterMemberAttempt = await prisma.property.findUnique({ where: { id: propertyForMember.id } });
  check("Customer name is unchanged after MEMBER's rejected attempt", customerAfterMemberAttempt.name !== "Should not stick");
  check("Property address is unchanged after MEMBER's rejected attempt", propertyAfterMemberAttempt.addressLine1 === "1 Real St");
  const propertyCountForCustomer = await prisma.property.count({ where: { customerId: customerA.id } });
  check("MEMBER's rejected addCustomerProperty created no new property row", propertyCountForCustomer === 1);

  console.log("\nTEST 7 — Business A MEMBER cannot access Business B records");
  await expectForbidden("MEMBER (Business A) cannot update Business B's customer", () =>
    mirrorUpdateCustomer(memberA, customerB.id, { name: "Cross-tenant tamper" }),
  );
  const customerBUnchanged = await prisma.customer.findUnique({ where: { id: customerB.id } });
  check("Business B's customer name is unchanged", customerBUnchanged.name === "Beta Customer");
  const scopedLookupByA = await prisma.customer.findFirst({
    where: { id: customerB.id, businessId: businessA.id },
  });
  check("A businessId-scoped lookup by Business A returns nothing for Business B's customer", scopedLookupByA === null);
  await expectForbidden("MEMBER (Business B) cannot create a service catalog item in their own business either", () =>
    mirrorCreateServiceCatalogItem(memberB, { name: "x", pricingMode: "FLAT_RATE", price: new Prisma.Decimal(1) }),
  );

  console.log("\nTEST 8 — Role checks do not weaken existing tenant isolation");
  // ADMIN of Business A has the MANAGE_CUSTOMERS capability (role check
  // passes), but must still be rejected when the record itself belongs to
  // a different business (tenant check fails). This proves the capability
  // layer is ADDITIVE to -- not a replacement for -- businessId scoping.
  let threwForCrossBusinessAdmin = false;
  let threwAsForbidden = false;
  try {
    await mirrorUpdateCustomer(adminA, customerB.id, { name: "Cross-tenant tamper by ADMIN" });
  } catch (error) {
    threwForCrossBusinessAdmin = true;
    threwAsForbidden = error instanceof ForbiddenError;
  }
  check("ADMIN of Business A is still rejected touching Business B's customer", threwForCrossBusinessAdmin);
  check(
    "...and the rejection is the tenant-isolation error (assertOwned), not a role/capability error -- proving capability passed but isolation still blocked it",
    threwForCrossBusinessAdmin && !threwAsForbidden,
  );
  const customerBUnchangedAfterAdmin = await prisma.customer.findUnique({ where: { id: customerB.id } });
  check("Business B's customer is still unchanged after ADMIN of Business A's rejected attempt", customerBUnchangedAfterAdmin.name === "Beta Customer");

  console.log(
    "\nBONUS — Job start/complete and job photo mutations are OWNER/ADMIN-only for now (no assigned-job model yet)",
  );
  const jobForOperate = await prisma.job.create({
    data: { businessId: businessA.id, customerId: customerA.id, status: "IN_PROGRESS" },
  });
  await expectForbidden("MEMBER cannot start/complete a job (OPERATE_JOBS)", () =>
    mirrorOperateJob(memberA, jobForOperate.id),
  );
  await expectForbidden("MEMBER cannot create/schedule a job (MANAGE_JOBS)", () =>
    mirrorManageJob(memberA, jobForOperate.id),
  );
  await expectAllowed("ADMIN CAN start/complete a job (OPERATE_JOBS) today", () =>
    mirrorOperateJob(adminA, jobForOperate.id),
  );
  await expectForbidden("MEMBER cannot change business settings (MANAGE_SETTINGS)", () =>
    mirrorUpdateSettings(memberA),
  );
  await expectAllowed("OWNER can change business settings (MANAGE_SETTINGS)", () =>
    mirrorUpdateSettings(ownerA),
  );

  console.log(
    failures === 0
      ? "\nAll authorization checks passed."
      : `\n${failures} authorization check(s) failed.`,
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
