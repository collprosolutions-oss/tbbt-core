/**
 * P1-6: Core cross-tenant isolation harness.
 *
 * Proves one TBBT business cannot read, mutate, attach, or financially
 * affect another business's core records. Extends the original scoped
 * Customer / TimeEntry / Payroll proofs with two complete tenant fixtures
 * and production-shaped attachment / payment guards.
 *
 * Real production helpers imported here:
 *   - businessScope / belongsToBusiness / assertBusinessRecord
 *     from src/lib/access-scope.ts (same functions requireBusinessAccess
 *     uses; that module cannot run here because access.ts pulls
 *     next/headers via requireWorkspace)
 *   - persistDraftInvoiceFromCompletedJob from src/lib/invoice-carry-forward.ts
 *   - listProjectPayments / recordSucceededPayment / recordOwnerManualDeposit
 *     / attachEstimatePaymentsToInvoice / ProjectPaymentError
 *     from src/lib/project-payments.ts
 *   - requireBusinessCapability / CAPABILITIES from src/lib/authorization.ts
 *
 * Server actions that call requireBusinessAccess() cannot be invoked from
 * this Node script. Those cases mirror the exact findFirst + assertOwned
 * (or persist helper) query/guard shape and name the production function.
 *
 * Estimate.publicToken and Job.projectToken are customer-facing public
 * tokens, not workspace IDs. This harness proves authenticated
 * tenant/workspace isolation only.
 *
 * Run with:
 *   npm run test:isolation
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  assertBusinessRecord,
  belongsToBusiness,
  businessScope,
} = await import("@/lib/access-scope");
const { CAPABILITIES, requireBusinessCapability } = await import(
  "@/lib/authorization"
);
const { persistDraftInvoiceFromCompletedJob } = await import(
  "@/lib/invoice-carry-forward"
);
const { createOwnerLoggedLead } = await import("@/lib/owner-log-lead");
const {
  accountingExpensesCsv,
  accountingInvoicesCsv,
  accountingPaymentsCsv,
  loadAccountingExportSource,
} = await import("@/lib/accounting-export");
const { buildBusinessExportZip } = await import("@/lib/business-export");
const {
  PAYMENT_PURPOSE_INVOICE_BALANCE,
  PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
  ProjectPaymentError,
  attachEstimatePaymentsToInvoice,
  listProjectPayments,
  recordOwnerManualDeposit,
  recordSucceededPayment,
} = await import("@/lib/project-payments");
const { Prisma } = await import("@prisma/client");
const { loadGoLiveCenter } = await import("@/lib/go-live-data");
const { goLiveCardById } = await import("@/lib/go-live");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run the isolation check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_isolation_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for isolation test.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
let passed = 0;

function check(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${label}`);
  }
}

async function expectRejects(label, fn, isExpected = () => true) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

function makeAccess(businessId, role = "OWNER") {
  return {
    businessId,
    workspace: {
      role,
      business: { id: businessId, name: "Isolation Tenant" },
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

/**
 * Mirrors src/app/actions/customer.ts updateCustomer().
 * requireBusinessAccess() cannot run here; assertOwned + scope are the
 * production query/guard after requireBusinessCapability.
 */
async function mirrorUpdateCustomer(access, customerId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const customer = access.assertOwned(
    await prisma.customer.findFirst({
      where: { id: customerId, ...access.scope },
    }),
  );
  return prisma.customer.update({ where: { id: customer.id }, data });
}

/**
 * Mirrors src/app/actions/property.ts updateCustomerProperty().
 */
async function mirrorUpdateCustomerProperty(access, propertyId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const property = access.assertOwned(
    await prisma.property.findFirst({
      where: { id: propertyId, ...access.scope },
    }),
  );
  return prisma.property.update({ where: { id: property.id }, data });
}

/**
 * Mirrors src/app/actions/property.ts addCustomerProperty() attach of an
 * existing property is not a production create path (it always creates a
 * new row). Attaching Property A to Customer B is resolveManualEstimateProperty
 * in src/app/actions/estimate.ts.
 */
async function mirrorResolveManualEstimateProperty(access, customerId, propertyChoice) {
  const property = await prisma.property.findFirst({
    where: {
      id: propertyChoice,
      customerId,
      ...access.scope,
    },
  });
  if (!property) {
    return {
      ok: false,
      error: "That service address is not available for this customer.",
    };
  }
  access.assertOwned(property);
  return { ok: true, id: property.id };
}

/**
 * Mirrors src/app/actions/estimate.ts createManualEstimate() existing-customer
 * branch (assertOwned customer, then create estimate for access.businessId).
 */
async function mirrorCreateManualEstimate(access, customerId, propertyId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const customer = access.assertOwned(
    await prisma.customer.findFirst({
      where: { id: customerId, ...access.scope },
    }),
  );
  const property = await mirrorResolveManualEstimateProperty(
    access,
    customer.id,
    propertyId,
  );
  if (!property.ok) {
    throw new Error(property.error);
  }
  return prisma.estimate.create({
    data: {
      businessId: access.businessId,
      customerId: customer.id,
      propertyId: property.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
}

/**
 * Mirrors src/app/actions/estimate.ts createEstimate() ownership + convert.
 * Does not run the draft-line / redirect side effects.
 */
async function mirrorConvertServiceRequest(access, serviceRequestId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const request = access.assertOwned(
    await prisma.serviceRequest.findFirst({
      where: { id: serviceRequestId, ...access.scope },
    }),
  );
  if (request.status === "OPEN") {
    await prisma.serviceRequest.update({
      where: { id: request.id },
      data: { status: "CONVERTED" },
    });
  }
  return request;
}

/**
 * Mirrors src/app/actions/job.ts createJobFromEstimate() ownership lookup.
 */
async function mirrorCreateJobFromEstimate(access, estimateId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );
  if (estimate.status !== "APPROVED") {
    throw new Error("Only an approved estimate can become a job.");
  }
  return prisma.job.create({
    data: {
      businessId: access.businessId,
      customerId: estimate.customerId,
      propertyId: estimate.propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: estimate.approvedVersionId,
      projectToken: randomUUID(),
      status: "UNSCHEDULED",
    },
  });
}

/**
 * Mirrors src/app/actions/job.ts startJob() ownership lookup + scoped write.
 */
async function mirrorStartJob(access, jobId) {
  requireBusinessCapability(access, CAPABILITIES.OPERATE_JOBS);
  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
    }),
  );
  await prisma.job.updateMany({
    where: { id: job.id, ...access.scope },
    data: { status: "IN_PROGRESS" },
  });
  return job;
}

/**
 * Mirrors src/app/actions/invoice.ts createInvoiceFromJob() ownership
 * lookup, then the real persistDraftInvoiceFromCompletedJob helper.
 */
async function mirrorCreateInvoiceFromJob(access, jobId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const job = access.assertOwned(
    await prisma.job.findFirst({
      where: { id: jobId, ...access.scope },
      select: { id: true, status: true, businessId: true },
    }),
  );
  return persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: access.businessId,
    jobId: job.id,
  });
}

/**
 * Mirrors src/app/actions/invoice.ts markInvoicePaid() ownership + scoped
 * payment + updateMany. Uses the real listProjectPayments /
 * recordSucceededPayment helpers.
 */
async function mirrorMarkInvoicePaid(access, invoiceId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_INVOICES);
  const invoice = access.assertOwned(
    await prisma.invoice.findFirst({
      where: { id: invoiceId, ...access.scope },
      include: { job: { select: { estimateId: true } } },
    }),
  );
  if (invoice.status === "PAID") return { alreadyPaid: true };
  if (invoice.status !== "SENT") {
    throw new Error("Send the invoice before marking it paid.");
  }
  const payments = await listProjectPayments(prisma, {
    businessId: access.businessId,
    invoiceId: invoice.id,
    jobId: invoice.jobId,
  });
  const recorded = payments.reduce(
    (sum, row) => sum.add(row.amount),
    new Prisma.Decimal(0),
  );
  const amountDue = invoice.total.sub(recorded);
  if (amountDue.gt(0)) {
    await recordSucceededPayment(prisma, {
      businessId: invoice.businessId,
      customerId: invoice.customerId,
      estimateId: invoice.job?.estimateId ?? null,
      jobId: invoice.jobId,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: amountDue,
      method: "CASH",
    });
  }
  return prisma.invoice.updateMany({
    where: {
      id: invoice.id,
      businessId: access.businessId,
      status: "SENT",
    },
    data: {
      status: "PAID",
      paidAt: new Date(),
      paymentMethod: "CASH",
    },
  });
}

async function seedTenant(label, slug) {
  const business = await prisma.business.create({
    data: { name: `${label} Handyman`, slug, tradeCode: "HANDYMAN" },
  });
  const trade = await prisma.businessTrade.create({
    data: {
      businessId: business.id,
      tradeCode: "HANDYMAN",
      status: "ACTIVE",
    },
  });
  const customer = await prisma.customer.create({
    data: {
      businessId: business.id,
      name: `${label} Customer`,
      email: `${slug}@example.com`,
    },
  });
  const property = await prisma.property.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      addressLine1: `${label} Street 1`,
      city: `${label} City`,
      region: "TX",
      postalCode: "75001",
    },
  });
  const request = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      status: "OPEN",
      summary: `${label} repair`,
    },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      serviceRequestId: request.id,
      status: "APPROVED",
      total: new Prisma.Decimal(250),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      description: `${label} labor`,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(250),
      total: new Prisma.Decimal(250),
      type: "LABOR",
    },
  });
  const version = await prisma.estimateVersion.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      versionNumber: 1,
      total: new Prisma.Decimal(250),
      laborMinimumWaived: false,
      laborMinimumAdjustment: new Prisma.Decimal(0),
      customerName: customer.name,
      propertyAddressLine1: property.addressLine1,
      approvedAt: new Date(),
      lineItems: {
        create: [
          {
            businessId: business.id,
            description: `${label} labor`,
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal(250),
            total: new Prisma.Decimal(250),
            type: "LABOR",
          },
        ],
      },
    },
  });
  await prisma.estimate.update({
    where: { id: estimate.id },
    data: { approvedVersionId: version.id },
  });
  const job = await prisma.job.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      propertyId: property.id,
      estimateId: estimate.id,
      approvedEstimateVersionId: version.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      jobId: job.id,
      status: "SENT",
      total: new Prisma.Decimal(250),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      invoiceId: invoice.id,
      description: `${label} labor`,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(250),
      total: new Prisma.Decimal(250),
      type: "LABOR",
    },
  });
  const payment = await prisma.payment.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      estimateId: estimate.id,
      jobId: job.id,
      invoiceId: invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal(50),
      method: "CASH",
    },
  });
  return {
    business,
    trade,
    customer,
    property,
    request,
    estimate,
    version,
    job,
    invoice,
    payment,
  };
}

const CORE_MODELS = [
  ["customer", "customer"],
  ["property", "property"],
  ["serviceRequest", "request"],
  ["estimate", "estimate"],
  ["job", "job"],
  ["invoice", "invoice"],
  ["payment", "payment"],
  ["businessTrade", "trade"],
];

async function proveCoreModelIsolation(model, recordA, recordB, accessA, accessB, label) {
  const listedA = await prisma[model].findMany({ where: accessA.scope });
  check(
    `${label}: A scoped list returns only A`,
    listedA.length === 1 && listedA[0].id === recordA.id && listedA.every((row) => row.businessId === accessA.businessId),
  );
  const listedB = await prisma[model].findMany({ where: accessB.scope });
  check(
    `${label}: B scoped list returns only B`,
    listedB.length === 1 && listedB[0].id === recordB.id && listedB.every((row) => row.businessId === accessB.businessId),
  );

  const aReadsA = await prisma[model].findFirst({
    where: { id: recordA.id, ...accessA.scope },
  });
  check(`${label}: A scoped read returns A's record`, aReadsA?.id === recordA.id);
  const bReadsB = await prisma[model].findFirst({
    where: { id: recordB.id, ...accessB.scope },
  });
  check(`${label}: B scoped read returns B's record`, bReadsB?.id === recordB.id);

  const bReadsA = await prisma[model].findFirst({
    where: { id: recordA.id, ...accessB.scope },
  });
  check(`${label}: B cannot load A's record by id`, bReadsA === null);
  const aReadsB = await prisma[model].findFirst({
    where: { id: recordB.id, ...accessA.scope },
  });
  check(`${label}: A cannot load B's record by id`, aReadsB === null);

  await expectRejects(`${label}: assertOwned(B) rejects A's record`, async () => {
    accessB.assertOwned(recordA);
  });
  await expectRejects(`${label}: assertOwned(A) rejects B's record`, async () => {
    accessA.assertOwned(recordB);
  });
  check(
    `${label}: belongsToBusiness rejects the foreign record`,
    !belongsToBusiness(recordA, accessB.businessId) &&
      !belongsToBusiness(recordB, accessA.businessId),
  );
}

try {
  console.log("\nSTATIC — Production helpers and unchanged field/photo rules");
  const accessSrc = readFileSync(new URL("../src/lib/access.ts", import.meta.url), "utf8");
  const accessScopeSrc = readFileSync(
    new URL("../src/lib/access-scope.ts", import.meta.url),
    "utf8",
  );
  const fieldAccessSrc = readFileSync(
    new URL("../src/lib/field-access.ts", import.meta.url),
    "utf8",
  );
  const privateServeSrc = readFileSync(
    new URL("../src/lib/business-storage/private-serve.ts", import.meta.url),
    "utf8",
  );
  const projectPaymentsSrc = readFileSync(
    new URL("../src/lib/project-payments.ts", import.meta.url),
    "utf8",
  );
  const ownerTodaySrc = readFileSync(
    new URL("../src/lib/owner-today.ts", import.meta.url),
    "utf8",
  );
  const todayPageSrc = readFileSync(
    new URL("../src/app/(app)/today/page.tsx", import.meta.url),
    "utf8",
  );
  check(
    "access.ts re-exports the pure access-scope helpers used by this harness",
    accessSrc.includes('from "@/lib/access-scope"') &&
      accessSrc.includes("scope: businessScope(businessId)") &&
      accessSrc.includes("return assertBusinessRecord(record, businessId)"),
  );
  check(
    "access-scope helpers reject a missing or foreign businessId",
    accessScopeSrc.includes("Record is not in the authorized business workspace.") &&
      !accessScopeSrc.includes("next/headers") &&
      !accessScopeSrc.includes("next/navigation"),
  );
  check(
    "assignedJobWhere still requires businessId + assignedMembershipId (MEMBER assigned-only)",
    /function assignedJobWhere[\s\S]*businessId: field\.businessId[\s\S]*assignedMembershipId: field\.membershipId/.test(
      fieldAccessSrc,
    ),
  );
  check(
    "Owner Today stays tenant-scoped and does not loosen assignedJobWhere",
    todayPageSrc.includes("...access.scope") &&
      todayPageSrc.includes("requireManagementPageAccess()") &&
      ownerTodaySrc.includes("if (job.businessId !== businessId) return null") &&
      ownerTodaySrc.includes("if (job.businessId !== options.businessId) continue") &&
      !todayPageSrc.includes("assignedJobWhere("),
  );
  check(
    "private R2 reads still 404 non-management viewers who are not assigned to the JOB_PHOTO",
    privateServeSrc.includes("canAccessManagementConsole(viewer.role)") &&
      privateServeSrc.includes("memberCanReadAssignedJobPhoto") &&
      privateServeSrc.includes('status: 404, body: "Not found"') &&
      privateServeSrc.includes("authorizePrivateStoredAssetDownload") &&
      !privateServeSrc.includes("Buffer.from"),
  );
  check(
    "recordSucceededPayment and attachEstimatePaymentsToInvoice share the related-record ownership guard",
    projectPaymentsSrc.includes("assertRelatedPaymentRecordsOwned") &&
      projectPaymentsSrc.includes("That payment could not be recorded.") &&
      /export async function attachEstimatePaymentsToInvoice[\s\S]*await assertRelatedPaymentRecordsOwned\(db, input\);[\s\S]*updateMany/.test(
        projectPaymentsSrc,
      ),
  );
  check(
    "publicToken / projectToken are not treated as workspace IDs in access.ts",
    !accessSrc.includes("publicToken") && !accessSrc.includes("projectToken"),
  );

  const tenantA = await seedTenant("Alpha", "alpha-handyman-iso");
  const tenantB = await seedTenant("Beta", "beta-handyman-iso");
  const accessA = makeAccess(tenantA.business.id, "OWNER");
  const accessB = makeAccess(tenantB.business.id, "OWNER");

  console.log("\nFIXTURES — Two complete tenants with production relationships");
  for (const [name, key] of [
    ["Customer", "customer"],
    ["Property", "property"],
    ["ServiceRequest", "request"],
    ["Estimate", "estimate"],
    ["EstimateVersion", "version"],
    ["Job", "job"],
    ["Invoice", "invoice"],
    ["Payment", "payment"],
  ]) {
    check(
      `${name} A belongs to Business A and not B`,
      tenantA[key].businessId === tenantA.business.id &&
        tenantA[key].businessId !== tenantB.business.id,
    );
    check(
      `${name} B belongs to Business B and not A`,
      tenantB[key].businessId === tenantB.business.id &&
        tenantB[key].businessId !== tenantA.business.id,
    );
  }
  check(
    "Estimate A is bound to Customer/Property/ServiceRequest A",
    tenantA.estimate.customerId === tenantA.customer.id &&
      tenantA.estimate.propertyId === tenantA.property.id &&
      tenantA.estimate.serviceRequestId === tenantA.request.id,
  );
  check(
    "Job A is bound to Estimate/Property/Customer A and the approved version",
    tenantA.job.estimateId === tenantA.estimate.id &&
      tenantA.job.customerId === tenantA.customer.id &&
      tenantA.job.propertyId === tenantA.property.id &&
      tenantA.job.approvedEstimateVersionId === tenantA.version.id,
  );
  check(
    "Invoice A is bound to Job/Customer A",
    tenantA.invoice.jobId === tenantA.job.id &&
      tenantA.invoice.customerId === tenantA.customer.id,
  );
  check(
    "Payment A carries businessId and points at Invoice/Job/Estimate/Customer A",
    tenantA.payment.businessId === tenantA.business.id &&
      tenantA.payment.invoiceId === tenantA.invoice.id &&
      tenantA.payment.jobId === tenantA.job.id &&
      tenantA.payment.estimateId === tenantA.estimate.id &&
      tenantA.payment.customerId === tenantA.customer.id,
  );
  check(
    "Estimate.publicToken and Job.projectToken are unique per tenant, not workspace IDs",
    tenantA.estimate.publicToken !== tenantB.estimate.publicToken &&
      tenantA.job.projectToken !== tenantB.job.projectToken &&
      tenantA.estimate.publicToken !== tenantA.business.id &&
      tenantA.job.projectToken !== tenantA.business.id,
  );

  console.log("\nCORE MODELS — Scoped list/read/foreign-id/assertOwned");
  for (const [model, key] of CORE_MODELS) {
    await proveCoreModelIsolation(
      model,
      tenantA[key],
      tenantB[key],
      accessA,
      accessB,
      model[0].toUpperCase() + model.slice(1),
    );
  }

  console.log("\nMUTATE — Foreign IDs cannot mutate the other tenant");
  await expectRejects(
    "B cannot update Customer A (updateCustomer)",
    () => mirrorUpdateCustomer(accessB, tenantA.customer.id, { name: "Hijacked" }),
  );
  const customerAAfter = await prisma.customer.findUnique({
    where: { id: tenantA.customer.id },
  });
  check("Customer A name is unchanged after B's rejected update", customerAAfter.name === "Alpha Customer");

  await expectRejects(
    "A cannot update Customer B (updateCustomer)",
    () => mirrorUpdateCustomer(accessA, tenantB.customer.id, { name: "Hijacked" }),
  );

  await expectRejects(
    "B cannot update Property A (updateCustomerProperty)",
    () =>
      mirrorUpdateCustomerProperty(accessB, tenantA.property.id, {
        addressLine1: "Hijacked Street",
      }),
  );
  const propertyAAfter = await prisma.property.findUnique({
    where: { id: tenantA.property.id },
  });
  check(
    "Property A address is unchanged after B's rejected update",
    propertyAAfter.addressLine1 === "Alpha Street 1",
  );

  const convertedByB = await prisma.serviceRequest.updateMany({
    where: { id: tenantA.request.id, ...accessB.scope },
    data: { status: "CONVERTED" },
  });
  check(
    "B scoped updateMany cannot convert ServiceRequest A",
    convertedByB.count === 0,
  );
  const requestAAfterScope = await prisma.serviceRequest.findUnique({
    where: { id: tenantA.request.id },
  });
  check("ServiceRequest A is still OPEN after B's scoped write", requestAAfterScope.status === "OPEN");

  const estimateMutateB = await prisma.estimate.updateMany({
    where: { id: tenantA.estimate.id, ...accessB.scope },
    data: { status: "DRAFT" },
  });
  check("B scoped updateMany cannot mutate Estimate A", estimateMutateB.count === 0);

  const jobMutateB = await prisma.job.updateMany({
    where: { id: tenantA.job.id, ...accessB.scope },
    data: { status: "UNSCHEDULED" },
  });
  check("B scoped updateMany cannot mutate Job A", jobMutateB.count === 0);

  const invoiceMutateB = await prisma.invoice.updateMany({
    where: { id: tenantA.invoice.id, ...accessB.scope, status: "SENT" },
    data: { status: "PAID", paidAt: new Date(), paymentMethod: "CASH" },
  });
  check("B scoped updateMany cannot mark Invoice A paid", invoiceMutateB.count === 0);
  const invoiceAStillSent = await prisma.invoice.findUnique({
    where: { id: tenantA.invoice.id },
  });
  check("Invoice A remains SENT after B's scoped write", invoiceAStillSent.status === "SENT");

  const paymentMutateB = await prisma.payment.updateMany({
    where: { id: tenantA.payment.id, ...accessB.scope },
    data: { amount: new Prisma.Decimal(999) },
  });
  check("B scoped updateMany cannot credit/alter Payment A", paymentMutateB.count === 0);
  const paymentAAfter = await prisma.payment.findUnique({
    where: { id: tenantA.payment.id },
  });
  check("Payment A amount is unchanged", paymentAAfter.amount.toString() === "50");

  console.log("\nPOSITIVE — Same-tenant production guards still succeed");
  await mirrorUpdateCustomer(accessA, tenantA.customer.id, { name: "Alpha Customer" });
  check("A can update Customer A (updateCustomer)", true);
  const persistA = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: accessA.businessId,
    jobId: tenantA.job.id,
  });
  check(
    "persistDraftInvoiceFromCompletedJob(A, Job A) reuses A's invoice",
    persistA.ok === true && persistA.reused === true,
  );

  console.log("\nATTACH — Relation isolation (FKs alone are not enough)");
  await expectRejects(
    "B cannot create an Estimate using Customer A (createManualEstimate)",
    () => mirrorCreateManualEstimate(accessB, tenantA.customer.id, tenantB.property.id),
  );
  await expectRejects(
    "B cannot convert ServiceRequest A (createEstimate)",
    () => mirrorConvertServiceRequest(accessB, tenantA.request.id),
  );
  const requestAUnconverted = await prisma.serviceRequest.findUnique({
    where: { id: tenantA.request.id },
  });
  check("ServiceRequest A is still OPEN after B's convert attempt", requestAUnconverted.status === "OPEN");

  const attachPropertyToCustomerB = await mirrorResolveManualEstimateProperty(
    accessB,
    tenantB.customer.id,
    tenantA.property.id,
  );
  check(
    "B cannot attach Property A to Customer B (resolveManualEstimateProperty)",
    attachPropertyToCustomerB.ok === false,
  );
  const attachPropertyToEstimateB = await prisma.estimate.updateMany({
    where: { id: tenantB.estimate.id, ...accessB.scope },
    data: { propertyId: tenantA.property.id },
  });
  // Scoped write on B's own estimate is allowed by the where clause, but
  // production resolveManualEstimateProperty never supplies a foreign
  // propertyId. Prove the attach guard, then restore if Prisma accepted it.
  if (attachPropertyToEstimateB.count === 1) {
    const resolved = await mirrorResolveManualEstimateProperty(
      accessB,
      tenantB.customer.id,
      tenantA.property.id,
    );
    check(
      "Production property attach guard still rejects Property A on Customer/Estimate B",
      resolved.ok === false,
    );
    await prisma.estimate.update({
      where: { id: tenantB.estimate.id },
      data: { propertyId: tenantB.property.id },
    });
  } else {
    check(
      "B scoped estimate write did not attach Property A (or was a no-op)",
      true,
    );
  }

  const bCustomersBeforeLead = await prisma.customer.count({
    where: { businessId: accessB.businessId },
  });
  const bRequestsBeforeLead = await prisma.serviceRequest.count({
    where: { businessId: accessB.businessId },
  });
  const bPropertiesBeforeLead = await prisma.property.count({
    where: { businessId: accessB.businessId },
  });
  const hijackCustomer = await createOwnerLoggedLead(prisma, accessB, {
    mode: "existing",
    customerId: tenantA.customer.id,
    summary: "Hijack customer",
    channel: "PHONE",
    submissionId: "iso-cust-a",
  });
  const hijackProperty = await createOwnerLoggedLead(prisma, accessB, {
    mode: "existing",
    customerId: tenantB.customer.id,
    propertyChoice: tenantA.property.id,
    summary: "Hijack property",
    channel: "WALK_IN",
    submissionId: "iso-prop-a",
  });
  check(
    "B cannot attach Customer A to an owner-logged lead",
    hijackCustomer.ok === false,
  );
  check(
    "B cannot attach Property A to an owner-logged lead",
    hijackProperty.ok === false,
  );
  check(
    "Rejected log-lead foreign IDs create no partial rows on B",
    (await prisma.customer.count({ where: { businessId: accessB.businessId } })) ===
      bCustomersBeforeLead &&
      (await prisma.serviceRequest.count({ where: { businessId: accessB.businessId } })) ===
        bRequestsBeforeLead &&
      (await prisma.property.count({ where: { businessId: accessB.businessId } })) ===
        bPropertiesBeforeLead,
  );

  await expectRejects(
    "B cannot create a Job from Estimate A (createJobFromEstimate)",
    () => mirrorCreateJobFromEstimate(accessB, tenantA.estimate.id),
  );
  await expectRejects(
    "B cannot operate Job A (startJob)",
    () => mirrorStartJob(accessB, tenantA.job.id),
  );
  const jobAAfterOperate = await prisma.job.findUnique({
    where: { id: tenantA.job.id },
  });
  check("Job A remains COMPLETED after B's operate attempt", jobAAfterOperate.status === "COMPLETED");

  await expectRejects(
    "B cannot create an Invoice from Job A (createInvoiceFromJob assertOwned)",
    () => mirrorCreateInvoiceFromJob(accessB, tenantA.job.id),
  );
  const persistAsB = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: accessB.businessId,
    jobId: tenantA.job.id,
  });
  check(
    "persistDraftInvoiceFromCompletedJob(B, Job A) does not find or invoice Job A",
    persistAsB.ok === false && persistAsB.error === "That job could not be found.",
  );
  const invoicesOnJobA = await prisma.invoice.findMany({
    where: { jobId: tenantA.job.id },
  });
  check(
    "Job A still has only its own Business A invoice",
    invoicesOnJobA.length === 1 && invoicesOnJobA[0].businessId === tenantA.business.id,
  );

  await expectRejects(
    "B cannot mark Invoice A paid (markInvoicePaid assertOwned)",
    () => mirrorMarkInvoicePaid(accessB, tenantA.invoice.id),
  );
  const invoiceAAfterMark = await prisma.invoice.findUnique({
    where: { id: tenantA.invoice.id },
  });
  check("Invoice A remains SENT after B's mark-paid attempt", invoiceAAfterMark.status === "SENT");

  console.log("\nPAYMENTS — Payment.businessId + related-record ownership");
  const paymentsListedB = await listProjectPayments(prisma, {
    businessId: accessB.businessId,
    invoiceId: tenantA.invoice.id,
    jobId: tenantA.job.id,
    estimateId: tenantA.estimate.id,
  });
  check(
    "listProjectPayments(B, Invoice/Job/Estimate A) returns no rows",
    paymentsListedB.length === 0,
  );
  const paymentsListedA = await listProjectPayments(prisma, {
    businessId: accessA.businessId,
    invoiceId: tenantA.invoice.id,
    jobId: tenantA.job.id,
    estimateId: tenantA.estimate.id,
  });
  check(
    "listProjectPayments(A) returns only Payment A",
    paymentsListedA.length === 1 && paymentsListedA[0].id === tenantA.payment.id,
  );

  const foreignPaymentLookup = await prisma.payment.findFirst({
    where: { id: tenantA.payment.id, ...accessB.scope },
  });
  check("B cannot load Payment A by scoped id", foreignPaymentLookup === null);

  await expectRejects(
    "recordSucceededPayment(B, Invoice A) is rejected",
    () =>
      recordSucceededPayment(prisma, {
        businessId: accessB.businessId,
        customerId: tenantA.customer.id,
        estimateId: tenantA.estimate.id,
        jobId: tenantA.job.id,
        invoiceId: tenantA.invoice.id,
        purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
        amount: new Prisma.Decimal(25),
        method: "CASH",
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message === "That payment could not be recorded.",
  );
  await expectRejects(
    "recordSucceededPayment(B, Job A) is rejected",
    () =>
      recordSucceededPayment(prisma, {
        businessId: accessB.businessId,
        jobId: tenantA.job.id,
        purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
        amount: new Prisma.Decimal(25),
        method: "CASH",
      }),
    (error) => error instanceof ProjectPaymentError,
  );
  await expectRejects(
    "recordSucceededPayment(B, Estimate A) is rejected",
    () =>
      recordSucceededPayment(prisma, {
        businessId: accessB.businessId,
        estimateId: tenantA.estimate.id,
        purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
        amount: new Prisma.Decimal(25),
        method: "CASH",
      }),
    (error) => error instanceof ProjectPaymentError,
  );

  await expectRejects(
    "recordOwnerManualDeposit(B, Estimate A) is rejected (assertOwned)",
    () =>
      recordOwnerManualDeposit(prisma, accessB, {
        estimateId: tenantA.estimate.id,
        amount: "25",
        method: "CASH",
      }),
  );

  await expectRejects(
    "attachEstimatePaymentsToInvoice(B, Estimate/Job A → Invoice B) is rejected",
    () =>
      attachEstimatePaymentsToInvoice(prisma, {
        businessId: accessB.businessId,
        estimateId: tenantA.estimate.id,
        jobId: tenantA.job.id,
        invoiceId: tenantB.invoice.id,
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message === "That payment could not be recorded.",
  );

  const unattachedA = await prisma.payment.create({
    data: {
      businessId: tenantA.business.id,
      customerId: tenantA.customer.id,
      estimateId: tenantA.estimate.id,
      purpose: PAYMENT_PURPOSE_MATERIAL_DEPOSIT,
      amount: new Prisma.Decimal(20),
      method: "CASH",
    },
  });
  check(
    "Unattached Payment A is ready to be claimed by same-tenant attach",
    unattachedA.invoiceId === null && unattachedA.jobId === null,
  );

  await expectRejects(
    "Payment A / Estimate A → Invoice B is rejected",
    () =>
      attachEstimatePaymentsToInvoice(prisma, {
        businessId: accessA.businessId,
        estimateId: tenantA.estimate.id,
        invoiceId: tenantB.invoice.id,
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message === "That payment could not be recorded.",
  );
  await expectRejects(
    "Payment A / Estimate A → Job B is rejected",
    () =>
      attachEstimatePaymentsToInvoice(prisma, {
        businessId: accessA.businessId,
        estimateId: tenantA.estimate.id,
        jobId: tenantB.job.id,
        invoiceId: tenantA.invoice.id,
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message === "That payment could not be recorded.",
  );
  await expectRejects(
    "Payment A → Invoice B + Job B is rejected",
    () =>
      attachEstimatePaymentsToInvoice(prisma, {
        businessId: accessA.businessId,
        estimateId: tenantA.estimate.id,
        jobId: tenantB.job.id,
        invoiceId: tenantB.invoice.id,
      }),
    (error) =>
      error instanceof ProjectPaymentError &&
      error.message === "That payment could not be recorded.",
  );

  const paymentAUnmoved = await prisma.payment.findUnique({
    where: { id: tenantA.payment.id },
  });
  const unattachedAfterReject = await prisma.payment.findUnique({
    where: { id: unattachedA.id },
  });
  check(
    "Payment A remains attached only to A records after rejected attach",
    paymentAUnmoved.invoiceId === tenantA.invoice.id &&
      paymentAUnmoved.jobId === tenantA.job.id &&
      paymentAUnmoved.estimateId === tenantA.estimate.id &&
      paymentAUnmoved.businessId === tenantA.business.id,
  );
  check(
    "Unattached Payment A was not mutated by the rejected foreign attach",
    unattachedAfterReject.invoiceId === null &&
      unattachedAfterReject.jobId === null &&
      unattachedAfterReject.estimateId === tenantA.estimate.id &&
      unattachedAfterReject.businessId === tenantA.business.id,
  );

  const attachedSameTenant = await attachEstimatePaymentsToInvoice(prisma, {
    businessId: accessA.businessId,
    estimateId: tenantA.estimate.id,
    jobId: tenantA.job.id,
    invoiceId: tenantA.invoice.id,
  });
  check(
    "attachEstimatePaymentsToInvoice(A → A) still succeeds",
    attachedSameTenant === 1,
  );
  const attachedNow = await prisma.payment.findUnique({
    where: { id: unattachedA.id },
  });
  check(
    "Same-tenant attach writes Invoice A and Job A onto the unattached Payment A",
    attachedNow.invoiceId === tenantA.invoice.id &&
      attachedNow.jobId === tenantA.job.id &&
      attachedNow.businessId === tenantA.business.id,
  );

  const prismaLeak = await prisma.payment.create({
    data: {
      businessId: tenantB.business.id,
      invoiceId: tenantA.invoice.id,
      purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
      amount: new Prisma.Decimal(1),
      method: "CASH",
    },
  });
  check(
    "Prisma FKs alone still allow Payment(B) → Invoice(A) (schema is not the guard)",
    prismaLeak.businessId === tenantB.business.id &&
      prismaLeak.invoiceId === tenantA.invoice.id,
  );
  await prisma.payment.delete({ where: { id: prismaLeak.id } });
  const aPaymentsAfterLeakProbe = await listProjectPayments(prisma, {
    businessId: accessA.businessId,
    invoiceId: tenantA.invoice.id,
  });
  check(
    "A's financial query is unchanged after the Prisma leak probe was deleted",
    aPaymentsAfterLeakProbe.length === 2 &&
      aPaymentsAfterLeakProbe.every((row) =>
        [tenantA.payment.id, unattachedA.id].includes(row.id),
      ),
  );

  const ownPayment = await recordSucceededPayment(prisma, {
    businessId: accessA.businessId,
    customerId: tenantA.customer.id,
    estimateId: tenantA.estimate.id,
    jobId: tenantA.job.id,
    invoiceId: tenantA.invoice.id,
    purpose: PAYMENT_PURPOSE_INVOICE_BALANCE,
    amount: new Prisma.Decimal(10),
    method: "CASH",
  });
  check("recordSucceededPayment accepts same-tenant Invoice/Job/Estimate A", ownPayment.created === true);
  const bSeesNewPayment = await listProjectPayments(prisma, {
    businessId: accessB.businessId,
    invoiceId: tenantA.invoice.id,
  });
  check("B still cannot see A's newly recorded payment", bSeesNewPayment.length === 0);

  console.log("\nPUBLIC TOKENS — Not workspace IDs");
  const estimateByPublicTokenB = await prisma.estimate.findFirst({
    where: { publicToken: tenantA.estimate.publicToken, ...accessB.scope },
  });
  check(
    "B scoped lookup by Estimate A publicToken returns nothing",
    estimateByPublicTokenB === null,
  );
  const jobByProjectTokenB = await prisma.job.findFirst({
    where: { projectToken: tenantA.job.projectToken, ...accessB.scope },
  });
  check(
    "B scoped lookup by Job A projectToken returns nothing",
    jobByProjectTokenB === null,
  );
  const estimateByPublicTokenA = await prisma.estimate.findFirst({
    where: { publicToken: tenantA.estimate.publicToken, ...accessA.scope },
  });
  check(
    "A can still load its own estimate when publicToken is combined with workspace scope",
    estimateByPublicTokenA?.id === tenantA.estimate.id,
  );

  console.log("\nTIME / PAYROLL — Existing scoped proofs retained");
  const memberA = await prisma.user.create({
    data: { name: "Alpha Worker", email: "alpha-iso-time@example.com", passwordHash: "x" },
  });
  const memberB = await prisma.user.create({
    data: { name: "Beta Worker", email: "beta-iso-time@example.com", passwordHash: "x" },
  });
  const membershipA = await prisma.membership.create({
    data: { userId: memberA.id, businessId: tenantA.business.id, role: "MEMBER" },
  });
  const membershipB = await prisma.membership.create({
    data: { userId: memberB.id, businessId: tenantB.business.id, role: "MEMBER" },
  });
  const entryA = await prisma.timeEntry.create({
    data: {
      businessId: tenantA.business.id,
      membershipId: membershipA.id,
      activityType: "TRAVEL",
      status: "READY",
      startedAt: new Date(),
      endedAt: new Date(),
      source: "CLOCK",
    },
  });
  await prisma.timeEntry.create({
    data: {
      businessId: tenantB.business.id,
      membershipId: membershipB.id,
      activityType: "BREAK",
      status: "READY",
      startedAt: new Date(),
      endedAt: new Date(),
      source: "CLOCK",
    },
  });
  const visibleEntries = await prisma.timeEntry.findMany({
    where: businessScope(tenantA.business.id),
  });
  check(
    "Scoped time-entry query does not leak B",
    visibleEntries.length === 1 && visibleEntries[0].id === entryA.id,
  );
  const foreignEntry = await prisma.timeEntry.findFirst({
    where: { id: entryA.id, ...businessScope(tenantB.business.id) },
  });
  check("B cannot load A's time entry by id", foreignEntry === null);

  const weekA = await prisma.timesheetWeek.create({
    data: {
      businessId: tenantA.business.id,
      membershipId: membershipA.id,
      weekStartedAt: new Date("2026-08-23T00:00:00.000Z"),
      status: "APPROVED",
      approvedHours: 8,
      approvedHourlyWage: 20,
      approvedLaborCost: 160,
    },
  });
  const runA = await prisma.payrollRun.create({
    data: {
      businessId: tenantA.business.id,
      payPeriodStart: new Date("2026-08-23T00:00:00.000Z"),
      payPeriodEnd: new Date("2026-08-30T00:00:00.000Z"),
      status: "DRAFT",
    },
  });
  await prisma.payrollRun.create({
    data: {
      businessId: tenantB.business.id,
      payPeriodStart: new Date("2026-08-23T00:00:00.000Z"),
      payPeriodEnd: new Date("2026-08-30T00:00:00.000Z"),
      status: "DRAFT",
    },
  });
  await prisma.payrollRunItem.create({
    data: {
      businessId: tenantA.business.id,
      payrollRunId: runA.id,
      membershipId: membershipA.id,
      timesheetWeekId: weekA.id,
      weekStartedAt: weekA.weekStartedAt,
      regularHours: 8,
      overtimeHours: 0,
      approvedHours: 8,
      approvedHourlyWage: 20,
      grossLaborAmount: 160,
      readiness: "READY",
    },
  });
  const visibleRuns = await prisma.payrollRun.findMany({
    where: businessScope(tenantA.business.id),
  });
  check(
    "Scoped payroll-run query does not leak B",
    visibleRuns.length === 1 && visibleRuns[0].id === runA.id,
  );
  const foreignRun = await prisma.payrollRun.findFirst({
    where: { id: runA.id, ...businessScope(tenantB.business.id) },
  });
  check("B cannot load A's payroll run by id", foreignRun === null);

  const assignedJob = await prisma.job.findFirst({
    where: {
      id: tenantA.job.id,
      businessId: tenantA.business.id,
      assignedMembershipId: membershipA.id,
    },
  });
  check(
    "MEMBER assignedJobWhere (businessId + assignedMembershipId) does not match an unassigned Job A",
    assignedJob === null,
  );
  await prisma.job.update({
    where: { id: tenantA.job.id },
    data: { assignedMembershipId: membershipA.id },
  });
  const assignedToA = await prisma.job.findFirst({
    where: {
      id: tenantA.job.id,
      businessId: tenantA.business.id,
      assignedMembershipId: membershipA.id,
    },
  });
  const assignedToB = await prisma.job.findFirst({
    where: {
      id: tenantA.job.id,
      businessId: tenantB.business.id,
      assignedMembershipId: membershipB.id,
    },
  });
  check("MEMBER A assignedJobWhere finds Job A after assignment", assignedToA?.id === tenantA.job.id);
  check("MEMBER B assignedJobWhere cannot see Job A", assignedToB === null);

  console.log("\nAccounting CSV export isolation");
  await prisma.expense.create({
    data: {
      businessId: tenantA.business.id,
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      description: "Alpha only paint",
      amount: new Prisma.Decimal("12.50"),
      category: "MATERIALS",
      customerId: tenantA.customer.id,
      jobId: tenantA.job.id,
    },
  });
  await prisma.expense.create({
    data: {
      businessId: tenantB.business.id,
      occurredOn: new Date("2026-09-01T00:00:00.000Z"),
      description: "Beta only fuel",
      amount: new Prisma.Decimal("9.00"),
      category: "GAS_FUEL",
      customerId: tenantB.customer.id,
      jobId: tenantB.job.id,
    },
  });
  const exportA = await loadAccountingExportSource(prisma, tenantA.business.id);
  const exportB = await loadAccountingExportSource(prisma, tenantB.business.id);
  const invoicesA = accountingInvoicesCsv(exportA);
  const paymentsA = accountingPaymentsCsv(exportA);
  const expensesA = accountingExpensesCsv(exportA);
  const invoicesB = accountingInvoicesCsv(exportB);
  const paymentsB = accountingPaymentsCsv(exportB);
  const expensesB = accountingExpensesCsv(exportB);
  check(
    "Accounting invoices for A never include B's customer or invoice",
    invoicesA.includes(tenantA.customer.name) &&
      invoicesA.includes(tenantA.invoice.id) &&
      !invoicesA.includes(tenantB.customer.name) &&
      !invoicesA.includes(tenantB.invoice.id),
  );
  check(
    "Accounting payments for A are recorded Payment rows for A only",
    paymentsA.includes(tenantA.payment.id) &&
      paymentsA.includes("50.00") &&
      !paymentsA.includes(tenantB.payment.id),
  );
  check(
    "Accounting expenses for A omit B and stay business-scoped",
    expensesA.includes("Alpha only paint") && !expensesA.includes("Beta only fuel"),
  );
  check(
    "Accounting export for B never includes A's invoices, payments, or expenses",
    invoicesB.includes(tenantB.customer.name) &&
      !invoicesB.includes(tenantA.customer.name) &&
      paymentsB.includes(tenantB.payment.id) &&
      !paymentsB.includes(tenantA.payment.id) &&
      expensesB.includes("Beta only fuel") &&
      !expensesB.includes("Alpha only paint"),
  );
  const zipA = await buildBusinessExportZip(prisma, tenantA.business.id);
  const zipB = await buildBusinessExportZip(prisma, tenantB.business.id);
  check(
    "Business ZIP for A excludes B financial records",
    zipA.bytes.toString("utf8").includes(tenantA.payment.id) &&
      !zipA.bytes.toString("utf8").includes(tenantB.payment.id) &&
      !zipA.bytes.toString("utf8").includes("Beta only fuel"),
  );
  check(
    "Business ZIP for B excludes A financial records",
    zipB.bytes.toString("utf8").includes(tenantB.payment.id) &&
      !zipB.bytes.toString("utf8").includes(tenantA.payment.id) &&
      !zipB.bytes.toString("utf8").includes("Alpha only paint"),
  );

  await prisma.websiteHostBinding.create({
    data: {
      businessId: tenantA.business.id,
      hostname: "alpha-iso.example.test",
      status: "VERIFIED",
    },
  });
  await prisma.websiteHostBinding.create({
    data: {
      businessId: tenantB.business.id,
      hostname: "beta-iso.example.test",
      status: "UNVERIFIED",
    },
  });
  const goLiveA = await loadGoLiveCenter(prisma, accessA);
  const goLiveB = await loadGoLiveCenter(prisma, accessB);
  check(
    "Go-live for A includes only A's verified host",
    goLiveCardById(goLiveA, "custom_domain")?.status === "LIVE" &&
      JSON.stringify(goLiveA).includes("alpha-iso.example.test") &&
      !JSON.stringify(goLiveA).includes("beta-iso.example.test"),
  );
  check(
    "Go-live for B includes only B's unverified host",
    goLiveCardById(goLiveB, "custom_domain")?.status === "PARTIAL" &&
      JSON.stringify(goLiveB).includes("beta-iso.example.test") &&
      !JSON.stringify(goLiveB).includes("alpha-iso.example.test"),
  );

  console.log(`\nIsolation cases: ${passed} passed, ${failures} failed.`);
  if (failures > 0) {
    throw new Error(`Isolation check failed (${failures} case(s)).`);
  }
  console.log("Isolation check passed: business-scoped queries and production guards do not cross workspaces.");
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}
