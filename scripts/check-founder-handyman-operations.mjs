/**
 * Founder Handyman operational-readiness verifier.
 *
 * Drives one Handyman business, customer, and job through the canonical
 * owner / assigned-worker / customer-token operations on a disposable
 * local Postgres database:
 *   lead intake (photo + measurements) → estimate → customer approval →
 *   one job → schedule → customer confirmation → assignment → native
 *   start / time / job photo → materials purchase → additional work →
 *   change order → completion → original invoice (card) → supplemental
 *   invoice (Mark Paid) → customer history / profitability closeout.
 *
 * Does not contact Stripe, Twilio, Resend, or R2. Does not migrate
 * production. Reuses the shared disposable-database harness.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-founder-handyman-operations.mjs
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./estimate-options-test-loader.mjs", import.meta.url), import.meta.url);

process.env.TZ = process.env.TZ || "America/New_York";
process.env.TBBT_PAYMENTS_ADAPTER = "fake";
process.env.TBBT_SAAS_BILLING_ADAPTER = "fake";
process.env.TBBT_CUSTOMER_MESSAGING_ADAPTER = "fake";
process.env.NEXT_PUBLIC_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:43217";

const FAKE_READY_ACCOUNT = "acct_founder_handyman_operations";
process.env.TBBT_FAKE_PAYMENT_READY_ACCOUNTS = FAKE_READY_ACCOUNT;

const pngBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

let passed = 0;
let failed = 0;

function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
  return ok;
}

function demand(label, ok) {
  if (!check(label, ok)) {
    throw new Error(label);
  }
}

async function expectThrow(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function form(fields) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) data.set(key, String(value));
  }
  return data;
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function money(value) {
  if (value == null) return 0;
  const numeric = Number(value.toString?.() ?? value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function closeMoney(left, right) {
  return Math.abs(money(left) - money(right)) < 0.005;
}

/** Independently pinned business outcomes. Literals only — never derived from persisted Estimate/Invoice totals. */
const PINNED_ESTIMATE_TOTAL = 185;
const PINNED_FIELD_CHANGE_ORDER_TOTAL = 40;
const PINNED_ORIGINAL_INVOICE_TOTAL = 225;
const PINNED_SUPPLEMENTAL_INVOICE_TOTAL = 75;
const PINNED_BILLED_TOTAL = 300;
const PINNED_COLLECTED_TOTAL = 300;
const PINNED_MATERIALS = 25;
const PINNED_LABOR_HOURS = 1.5;
const PINNED_LABOR_WAGE = 45;
const PINNED_LABOR_COST = 67.5;
const PINNED_OUTSTANDING = 0;

async function followRedirect(fn) {
  try {
    const result = await fn();
    return { redirected: false, url: null, result };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) {
      return {
        redirected: true,
        url: error.message.slice("NEXT_REDIRECT:".length),
        result: null,
      };
    }
    throw error;
  }
}

/**
 * Reconciliation graph for one Handyman job. Every field is a real
 * relationship the owner, worker, or customer just wrote. Mutations
 * below flip one field so a vacuous checker cannot stay green.
 */
function operationsGraphHolds(state) {
  const invoices = state.invoices ?? [];
  const payments = state.payments ?? [];
  const original = invoices.find((invoice) => invoice.kind === "ORIGINAL");
  const supplemental = invoices.find((invoice) => invoice.kind === "SUPPLEMENTAL");
  if (!state.businessId || !state.customerId || !state.jobId) return false;
  if (!state.request || !state.estimate || !state.job) return false;
  if (!original || !supplemental) return false;
  if (invoices.length !== 2 || payments.length !== 2) return false;
  if (state.jobCount !== 1) return false;
  if (state.request.businessId !== state.businessId) return false;
  if (state.customer.businessId !== state.businessId) return false;
  if (state.estimate.businessId !== state.businessId) return false;
  if (state.job.businessId !== state.businessId) return false;
  if (state.estimate.serviceRequestId !== state.request.id) return false;
  if (state.estimate.customerId !== state.customerId) return false;
  if (state.estimate.status !== "APPROVED") return false;
  if (!closeMoney(state.estimate.total, PINNED_ESTIMATE_TOTAL)) return false;
  if (state.job.estimateId !== state.estimate.id) return false;
  if (state.job.customerId !== state.customerId) return false;
  if (state.job.status !== "COMPLETED") return false;
  if (state.job.assignedMembershipId !== state.workerMembershipId) return false;
  if (state.request.status !== "CONVERTED") return false;
  if (state.measurementCount !== 1 || state.requestPhotoCount !== 1) return false;
  if (state.jobPhotoCount !== 1 || state.jobPhotoJobId !== state.jobId) return false;
  if (!state.timeEntry || state.timeEntry.jobId !== state.jobId) return false;
  if (state.timeEntry.businessId !== state.businessId) return false;
  if (state.timeEntry.membershipId !== state.workerMembershipId) return false;
  if (state.timeEntry.status !== "APPROVED") return false;
  if (!closeMoney(state.timeEntry.approvedHours, PINNED_LABOR_HOURS)) return false;
  if (!closeMoney(state.approvedLaborCost, PINNED_LABOR_COST)) return false;
  if (!state.expense || state.expense.jobId !== state.jobId) return false;
  if (state.expense.businessId !== state.businessId) return false;
  if (state.expense.category !== "MATERIALS") return false;
  if (!closeMoney(state.expense.amount, PINNED_MATERIALS)) return false;
  if (!state.purchaseItem || state.purchaseItem.expenseId !== state.expense.id) return false;
  if (state.purchaseListJobId !== state.jobId) return false;
  if (!closeMoney(state.purchaseItem.actualCost, state.expense.amount)) return false;
  if (state.fieldRequest?.jobId !== state.jobId) return false;
  if (state.fieldRequest?.status !== "CONVERTED") return false;
  if (state.fieldRequest?.changeOrderId !== state.fieldChangeOrder?.id) return false;
  if (state.fieldChangeOrder?.jobId !== state.jobId) return false;
  if (state.fieldChangeOrder?.status !== "APPROVED") return false;
  if (!closeMoney(state.fieldChangeOrder?.total, PINNED_FIELD_CHANGE_ORDER_TOTAL)) return false;
  if (state.fieldChangeOrder?.invoiceId !== original.id) return false;
  if (state.customerRequest?.jobId !== state.jobId) return false;
  if (state.customerRequest?.status !== "CONVERTED") return false;
  if (state.customerRequest?.changeOrderId !== state.customerChangeOrder?.id) return false;
  if (state.customerChangeOrder?.status !== "APPROVED") return false;
  if (state.customerChangeOrder?.invoiceId !== supplemental.id) return false;
  if (original.jobId !== state.jobId || original.customerId !== state.customerId) return false;
  if (original.businessId !== state.businessId || original.status !== "PAID") return false;
  if (original.paymentMethod !== "STRIPE") return false;
  if (supplemental.jobId !== state.jobId || supplemental.status !== "PAID") return false;
  if (supplemental.paymentMethod !== "CASH") return false;
  if (!closeMoney(original.total, PINNED_ORIGINAL_INVOICE_TOTAL)) return false;
  if (!closeMoney(supplemental.total, PINNED_SUPPLEMENTAL_INVOICE_TOTAL)) return false;
  const stripe = payments.find((payment) => payment.method === "STRIPE");
  const cash = payments.find((payment) => payment.method === "CASH");
  if (!stripe || !cash) return false;
  if (stripe.invoiceId !== original.id || cash.invoiceId !== supplemental.id) return false;
  if (stripe.jobId !== state.jobId || cash.jobId !== state.jobId) return false;
  if (stripe.businessId !== state.businessId || cash.businessId !== state.businessId) return false;
  if (!closeMoney(stripe.amount, original.total)) return false;
  if (!closeMoney(cash.amount, supplemental.total)) return false;
  if (!state.closeout || state.closeout.jobId !== state.jobId) return false;
  if (state.closeout.businessId !== state.businessId) return false;
  if (!closeMoney(state.closeout.invoiceTotal, PINNED_BILLED_TOTAL)) return false;
  if (!closeMoney(state.closeout.recordedPayments, PINNED_COLLECTED_TOTAL)) return false;
  if (!closeMoney(state.closeout.outstandingBalance, PINNED_OUTSTANDING)) return false;
  if (!closeMoney(state.closeout.materialCost, PINNED_MATERIALS)) return false;
  if (!(state.approvedLaborCost > 0)) return false;
  if (!closeMoney(state.closeout.laborCost, PINNED_LABOR_COST)) return false;
  if (state.historyCustomerId !== state.customerId) return false;
  if (state.historyJobCount !== 1 || state.historyInvoiceCount !== 2) return false;
  if (state.historyRequestCount !== 1) return false;
  if (state.otherBusinessPaymentCount !== 0 || state.otherBusinessJobCount !== 0) return false;
  return true;
}

console.log("\nSTATIC — operations verifier uses canonical modules and the shared harness");
const selfSrc = readRepo("scripts/check-founder-handyman-operations.mjs");
check(
  "Verifier reuses the disposable harness and local-database guard",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);
check(
  "Pinned $185/$225/$300 are literals, not estimate-plus-invoice arithmetic",
  selfSrc.includes("const PINNED_ESTIMATE_TOTAL = 185") &&
    selfSrc.includes("const PINNED_ORIGINAL_INVOICE_TOTAL = 225") &&
    selfSrc.includes("const PINNED_BILLED_TOTAL = 300") &&
    !selfSrc.includes(`money(${"approvedEstimate"}.total) + money(${"fieldChangeOrder"}.total)`) &&
    !selfSrc.includes(`money(${"original"}.total) + money(${"supplemental"}.total)`),
);
check(
  "Pinned labor is 1.5 hours at $45 = $67.50",
  selfSrc.includes("const PINNED_LABOR_HOURS = 1.5") &&
    selfSrc.includes("const PINNED_LABOR_WAGE = 45") &&
    selfSrc.includes("const PINNED_LABOR_COST = 67.5") &&
    closeMoney(PINNED_LABOR_HOURS * PINNED_LABOR_WAGE, PINNED_LABOR_COST),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "founder-handyman-operations disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_founder_handyman_operations",
  setProcessEnv: true,
});

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { ForbiddenError } = await import("@/lib/authorization");
  const { createPublicServiceRequest } = await import("@/lib/public-intake");
  const { toStoredIntakeMeasurement } = await import("@/lib/intake-quote-handoff");
  const { createEstimateFromServiceRequest } = await import("@/lib/estimate-from-request");
  const { findCurrentEstimateVersion } = await import("@/lib/estimate-version");
  const { sendEstimate } = await import("@/app/actions/estimate");
  const { approveEstimate } = await import("@/app/actions/public-estimate");
  const { createJobFromEstimate, scheduleJob, assignJobMember } = await import(
    "@/app/actions/job"
  );
  const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
  const { confirmAppointment } = await import("@/app/actions/public-appointment");
  const { issueNativeSession, resolveNativeFieldAccess } = await import("@/lib/native-session");
  const {
    startNativeAssignedJob,
    stopNativeAssignedJobRunningTime,
    completeNativeAssignedJob,
  } = await import("@/lib/native-field-ops");
  const { TimeCardError, approveTimesheetWeek, correctTimeEntry } = await import(
    "@/lib/time-card-ops"
  );
  const { putPublicRequestPhotoFromBytes } = await import("@/lib/business-storage/request-photos");
  const { putAssignedFieldJobPhotoFromBytes } = await import(
    "@/lib/business-storage/field-job-photos"
  );
  const { StorageAccessError } = await import("@/lib/business-storage/types");
  const { MemoryStorageProvider } = await import("@/lib/business-storage/memory-provider");
  const { addPurchaseListItem, ensurePurchaseList } = await import("@/lib/materials/purchase");
  const { recordPurchaseOperation } = await import("@/lib/materials/expense-link");
  const { MaterialsError } = await import("@/lib/materials/errors");
  const { requestAssignedJobAdditionalWork } = await import("@/lib/field-job-ops");
  const { createCustomerAdditionalWorkRequest } = await import("@/lib/additional-work-request");
  const { createChangeOrder, addChangeOrderLineItem, sendChangeOrder } = await import(
    "@/app/actions/change-order"
  );
  const { approveChangeOrder } = await import("@/app/actions/public-change-order");
  const { completeJobAndSendInvoice, sendDraftInvoiceIfNeeded } = await import(
    "@/lib/complete-job-invoice"
  );
  const { createInvoiceFromJob, markInvoicePaid } = await import("@/app/actions/invoice");
  const { persistDraftInvoiceFromCompletedJob } = await import("@/lib/invoice-carry-forward");
  const {
    PaymentError,
    createCustomerInvoiceCheckout,
    applyVerifiedCheckoutPayment,
    getBusinessPaymentStatus,
  } = await import("@/lib/payments/service");
  const { createFakePaymentProvider } = await import("@/lib/payments/fake");
  const { PAYMENT_PROVIDER_STRIPE } = await import("@/lib/payments/types");
  const { invoiceAmountDue } = await import("@/lib/invoice-document");
  const { invoiceAmountToCents } = await import("@/lib/payments/money");
  const { shouldShowPayInvoice } = await import("@/lib/payments/service");
  const { loadJobProfitabilityCloseout } = await import("@/lib/job-profitability-closeout-data");
  const { customerInvoiceHistoryContext } = await import("@/lib/customer-invoice-history");
  const { ensurePrimaryBusinessTrade } = await import("@/lib/business-trades");
  const { setTestAccess } = await import("./estimate-options-test-access.mjs");
  const { prisma } = await import("@/lib/prisma");
  const { Prisma } = await import("@prisma/client");

  function makeAccess(business, role, membership) {
    return {
      businessId: business.id,
      workspace: {
        role,
        membership: { id: membership.id },
        user: { id: membership.userId },
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          tradeCode: business.tradeCode,
          timezone: "America/New_York",
        },
      },
      scope: businessScope(business.id),
      assertOwned(record) {
        return assertBusinessRecord(record, business.id);
      },
      assertAttachable(record) {
        return assertBusinessRecord(record, business.id);
      },
    };
  }

  async function scheduleWithAck(jobId, fields) {
    let result = await scheduleJob({}, form({ jobId, ...fields }));
    if (result?.warning && result.conflictAck) {
      result = await scheduleJob(
        {},
        form({ jobId, ...fields, confirmOverlapAck: result.conflictAck }),
      );
    }
    return result;
  }

  async function loadRequestForEstimate(access, requestId) {
    return access.assertOwned(
      await prisma.serviceRequest.findFirst({
        where: { id: requestId, ...access.scope },
        include: {
          measurements: { include: { serviceRequestItem: true } },
          items: {
            orderBy: { sortOrder: "asc" },
            include: {
              serviceCatalogItem: {
                select: {
                  id: true,
                  name: true,
                  pricingMode: true,
                  price: true,
                  description: true,
                },
              },
            },
          },
        },
      }),
    );
  }

  const suffix = randomUUID().slice(0, 8);
  const slugA = `ops-handyman-${suffix}`;
  const slugB = `ops-other-${suffix}`;
  const provider = createFakePaymentProvider();
  const storage = new MemoryStorageProvider();
  const storageDeps = {
    db: prisma,
    provider: storage,
    bucketName: "tbbt-handyman-operations",
    defaultLimitBytes: 50 * 1024 * 1024,
  };

  const businessA = await prisma.business.create({
    data: {
      name: "Founder Handyman Operations",
      slug: slugA,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Other Tenant Handyman",
      slug: slugB,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, businessA.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, businessB.id, "HANDYMAN");
  for (const businessId of [businessA.id, businessB.id]) {
    await prisma.businessSaasSubscription.create({
      data: {
        businessId,
        status: "none",
        legacyExempt: true,
        planCode: "FOUNDER",
      },
    });
  }

  const ownerUser = await prisma.user.create({
    data: { name: "Dana Owner", email: `owner-${suffix}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Riley Worker", email: `worker-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerBUser = await prisma.user.create({
    data: { name: "Other Owner", email: `owner-b-${suffix}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: {
      userId: memberUser.id,
      businessId: businessA.id,
      role: "MEMBER",
      hourlyWage: new Prisma.Decimal(45),
    },
  });
  const ownerBMem = await prisma.membership.create({
    data: { userId: ownerBUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA, "OWNER", ownerMem);
  const memberA = makeAccess(businessA, "MEMBER", memberMem);
  const ownerB = makeAccess(businessB, "OWNER", ownerBMem);

  const blind = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Window Blind Installation",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(185),
      active: true,
      tradeCode: "HANDYMAN",
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });
  const patch = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Drywall Patch",
      category: "Repairs",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(75),
      active: true,
      tradeCode: "HANDYMAN",
    },
  });
  const foreignCatalog = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Foreign Shelf",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(40),
      active: true,
      tradeCode: "HANDYMAN",
    },
  });
  await prisma.businessPaymentAccount.create({
    data: {
      businessId: businessA.id,
      provider: PAYMENT_PROVIDER_STRIPE,
      stripeAccountId: FAKE_READY_ACCOUNT,
    },
  });

  console.log("\nINTAKE — customer lead, photo, and measurements");
  const uploaded = await putPublicRequestPhotoFromBytes(storageDeps, slugA, {
    originalFilename: "window.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const foreignPhoto = await putPublicRequestPhotoFromBytes(storageDeps, slugB, {
    originalFilename: "other.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const intake = await createPublicServiceRequest(prisma, {
    slug: slugA,
    businessId: businessB.id,
    name: "Jordan Customer",
    email: `jordan-${suffix}@example.com`,
    phone: "555-0148",
    address: "",
    streetAddress: "12 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Install the hallway blinds.",
    catalogItemIds: [blind.id],
    includeOther: false,
    otherDescription: "",
    photoAssetIds: [uploaded.id, foreignPhoto.id],
    measurements: [{ catalogItemId: blind.id, width: "36", height: "60", unit: "IN" }],
    leadSource: "PUBLIC_REQUEST",
    smsOptIn: false,
  });
  demand("Public intake created the Handyman lead", intake.ok === true);
  const request = await prisma.serviceRequest.findUnique({
    where: { id: intake.requestId },
    include: {
      customer: true,
      photos: true,
      measurements: { include: { serviceRequestItem: true } },
    },
  });
  demand("Intake ignored a browser-supplied other-tenant business id", request?.businessId === businessA.id);
  demand(
    "Intake stored the customer measurement on this request",
    request?.measurements.length === 1 &&
      money(request.measurements[0].width) === 36 &&
      money(request.measurements[0].height) === 60 &&
      request.measurements[0].unit === "IN" &&
      request.measurements[0].source === "CUSTOMER_REPORTED" &&
      request.measurements[0].businessId === businessA.id,
  );
  demand(
    "Intake kept only this business's request photo",
    request?.photos.length === 1 && request.photos[0].businessId === businessA.id,
  );
  const foreignAttached = await prisma.serviceRequestPhoto.count({
    where: { storedAssetId: foreignPhoto.id },
  });
  check("Another tenant's photo asset was not attached to this request", foreignAttached === 0);

  console.log("\nESTIMATE — owner prices the request; customer approves");
  setTestAccess(ownerA);
  const requestForEstimate = await loadRequestForEstimate(ownerA, request.id);
  const estimateCreate = await createEstimateFromServiceRequest(prisma, ownerA, {
    serviceRequestId: requestForEstimate.id,
    customerId: requestForEstimate.customerId,
    propertyId: requestForEstimate.propertyId,
    status: requestForEstimate.status,
    leadSource: requestForEstimate.leadSource,
    campaignId: requestForEstimate.campaignId,
    sourceItems: requestForEstimate.items,
    measurements: requestForEstimate.measurements.map(toStoredIntakeMeasurement),
  });
  demand("Request converted to one draft estimate", estimateCreate.created === true);
  const replayEstimate = await createEstimateFromServiceRequest(prisma, ownerA, {
    serviceRequestId: requestForEstimate.id,
    customerId: requestForEstimate.customerId,
    propertyId: requestForEstimate.propertyId,
    status: "CONVERTED",
    leadSource: requestForEstimate.leadSource,
    campaignId: requestForEstimate.campaignId,
    sourceItems: requestForEstimate.items,
    measurements: [],
  });
  check(
    "Replayed conversion reuses the same estimate",
    replayEstimate.created === false && replayEstimate.id === estimateCreate.id,
  );
  const measurementsAfterEstimate = await prisma.serviceRequestMeasurement.count({
    where: { serviceRequestId: request.id, businessId: businessA.id },
  });
  check("Conversion left the intake measurement on the same request", measurementsAfterEstimate === 1);

  setTestAccess(memberA);
  await expectThrow(
    "MEMBER cannot send the estimate",
    () => sendEstimate({}, form({ estimateId: estimateCreate.id })),
    (error) => error instanceof ForbiddenError,
  );
  setTestAccess(ownerB);
  await expectThrow(
    "Tenant B cannot send tenant A's estimate",
    () => sendEstimate({}, form({ estimateId: estimateCreate.id })),
    (error) => error instanceof Error,
  );
  setTestAccess(ownerA);
  const sent = await sendEstimate({}, form({ estimateId: estimateCreate.id }));
  demand("OWNER sent the estimate", !sent?.error);
  const sentEstimate = await prisma.estimate.findUnique({ where: { id: estimateCreate.id } });
  const version = await findCurrentEstimateVersion(prisma, estimateCreate.id);
  demand("Send bound a current version", Boolean(version?.id) && sentEstimate?.status === "SENT");
  const jobsBeforeApproval = await prisma.job.count({
    where: { businessId: businessA.id, estimateId: estimateCreate.id },
  });
  check("Sending an estimate does not create a job", jobsBeforeApproval === 0);

  const approved = await approveEstimate(
    {},
    form({ publicToken: sentEstimate.publicToken, estimateVersionId: version.id }),
  );
  demand("Customer token approved the estimate", approved.status === "APPROVED");
  const approvedEstimateTotal = await prisma.estimate.findUnique({
    where: { id: estimateCreate.id },
    select: { total: true, status: true },
  });
  demand(
    "Approved estimate total is independently $185",
    approvedEstimateTotal?.status === "APPROVED" &&
      closeMoney(approvedEstimateTotal.total, PINNED_ESTIMATE_TOTAL),
  );
  const jobsAfterApproval = await prisma.job.count({
    where: {
      businessId: businessA.id,
      estimateId: estimateCreate.id,
      recurrenceSourceJobId: null,
      nextBookingSourceJobId: null,
      correctiveCleanSourceJobId: null,
    },
  });
  check("Customer approval does not itself insert a job", jobsAfterApproval === 0);

  console.log("\nJOB — one conversion, then schedule and customer confirmation");
  setTestAccess(ownerB);
  await expectThrow(
    "Tenant B cannot convert tenant A's approved estimate",
    () => createJobFromEstimate({}, form({ estimateId: estimateCreate.id })),
    (error) => error instanceof Error && /authorized business workspace/i.test(error.message),
  );
  setTestAccess(memberA);
  await expectThrow(
    "MEMBER cannot convert the approved estimate into a job",
    () => createJobFromEstimate({}, form({ estimateId: estimateCreate.id })),
    (error) => error instanceof ForbiddenError,
  );
  setTestAccess(ownerA);
  const createdJob = await followRedirect(() =>
    createJobFromEstimate({}, form({ estimateId: estimateCreate.id })),
  );
  demand(
    "OWNER create-job action opened the new job",
    createdJob.redirected === true && createdJob.url?.startsWith("/jobs/"),
  );
  const jobId = createdJob.url.split("/").pop();
  const replayJob = await createJobFromApprovedEstimate(prisma, ownerA, estimateCreate.id);
  check(
    "Replayed conversion reuses that job",
    replayJob.ok === true && replayJob.reused === true && replayJob.jobId === jobId,
  );
  const jobCount = await prisma.job.count({
    where: {
      businessId: businessA.id,
      estimateId: estimateCreate.id,
      recurrenceSourceJobId: null,
      nextBookingSourceJobId: null,
      correctiveCleanSourceJobId: null,
    },
  });
  demand("Exactly one job exists after approval and conversion", jobCount === 1);
  const unscheduled = await prisma.job.findUnique({ where: { id: jobId } });
  demand(
    "The new job is UNSCHEDULED and bound to the approved estimate and customer",
    unscheduled?.status === "UNSCHEDULED" &&
      unscheduled.estimateId === estimateCreate.id &&
      unscheduled.customerId === request.customerId &&
      Boolean(unscheduled.projectToken),
  );

  const scheduled = await scheduleWithAck(jobId, {
    date: "2027-06-15",
    time: "10:00",
    durationPreset: "120",
  });
  demand("OWNER scheduled the job", !scheduled?.error);
  const scheduledJob = await prisma.job.findUnique({ where: { id: jobId } });
  demand("Job is SCHEDULED with an appointment proposal", scheduledJob?.status === "SCHEDULED" && scheduledJob.appointmentProposalId != null);

  setTestAccess(ownerB);
  await expectThrow(
    "Tenant B cannot reschedule tenant A's job",
    () => scheduleJob({}, form({ jobId, date: "2027-06-16", time: "11:00", durationPreset: "60" })),
    (error) => error instanceof Error && /authorized business workspace/i.test(error.message),
  );
  setTestAccess(ownerA);

  setTestAccess(ownerA);
  const assigned = await assignJobMember({}, form({ jobId, membershipId: memberMem.id }));
  demand("OWNER assigned the worker", !assigned?.error);

  const workerSession = await issueNativeSession(prisma, memberUser.id, {
    userAgent: "operations-verifier",
  });
  const workerAccess = await resolveNativeFieldAccess(prisma, { token: workerSession.token });
  demand("Assigned worker native session resolves", workerAccess.ok === true);
  const blockedNative = await startNativeAssignedJob(prisma, workerAccess.access, jobId);
  check(
    "Native start before customer confirmation is refused",
    blockedNative.ok === false && blockedNative.status === 409,
  );
  const stillScheduled = await prisma.job.findUnique({ where: { id: jobId } });
  check("Refused native start left the job SCHEDULED", stillScheduled?.status === "SCHEDULED");

  const badConfirm = await confirmAppointment(
    {},
    form({
      projectToken: randomUUID(),
      appointmentProposalId: String(scheduledJob.appointmentProposalId),
      accessMethod: "CUSTOMER_PRESENT",
    }),
  );
  check("Unknown project token cannot confirm the appointment", Boolean(badConfirm?.error));
  const confirmed = await confirmAppointment(
    {},
    form({
      projectToken: scheduledJob.projectToken,
      appointmentProposalId: String(scheduledJob.appointmentProposalId),
      accessMethod: "CUSTOMER_PRESENT",
    }),
  );
  demand("Customer token confirmed the appointment", confirmed.status === "CONFIRMED");

  const ownerBSession = await issueNativeSession(prisma, ownerBUser.id, {
    userAgent: "operations-verifier",
  });
  const ownerBNative = await resolveNativeFieldAccess(prisma, { token: ownerBSession.token });
  const foreignNative = await startNativeAssignedJob(prisma, ownerBNative.access, jobId);
  check("Tenant B native session cannot start tenant A's job", foreignNative.ok === false);

  console.log("\nFIELD — native start, time card, and job photo");
  const started = await startNativeAssignedJob(prisma, workerAccess.access, jobId);
  demand("Assigned worker native start opened the job", started.ok === true && started.alreadyStarted === false);
  const running = await prisma.timeEntry.findMany({
    where: { businessId: businessA.id, jobId, status: "RUNNING" },
  });
  demand(
    "Native start opened one RUNNING time card on this job for the assigned worker",
    running.length === 1 && running[0].membershipId === memberMem.id,
  );
  const replayStart = await startNativeAssignedJob(prisma, workerAccess.access, jobId);
  check("Replayed native start does not open a second time card", replayStart.ok === true && replayStart.alreadyStarted === true);
  const runningAfterReplay = await prisma.timeEntry.count({
    where: { businessId: businessA.id, membershipId: memberMem.id, status: "RUNNING" },
  });
  check("Worker still has exactly one RUNNING entry", runningAfterReplay === 1);

  const inProgress = await prisma.job.findUnique({ where: { id: jobId } });
  check("Job is IN_PROGRESS", inProgress?.status === "IN_PROGRESS");

  const jobPhoto = await putAssignedFieldJobPhotoFromBytes(
    storageDeps,
    { businessId: businessA.id, membershipId: memberMem.id },
    {
      jobId,
      originalFilename: "during.png",
      mimeType: "image/png",
      body: pngBytes,
      stage: "DURING",
      caption: "Blinds going in",
    },
  );
  demand(
    "Assigned worker stored a job photo on this job",
    jobPhoto.photo.jobId === jobId && jobPhoto.photo.businessId === businessA.id,
  );
  await expectThrow(
    "Tenant B cannot store a photo on tenant A's job",
    () =>
      putAssignedFieldJobPhotoFromBytes(
        storageDeps,
        { businessId: businessB.id, membershipId: ownerBMem.id },
        {
          jobId,
          originalFilename: "nope.png",
          mimeType: "image/png",
          body: pngBytes,
          stage: "DURING",
        },
      ),
    (error) => error instanceof StorageAccessError,
  );

  const stopped = await stopNativeAssignedJobRunningTime(prisma, workerAccess.access, jobId);
  demand("Assigned worker stopped the running time card", stopped.ok === true);
  const clockedOut = await prisma.timeEntry.findFirst({
    where: { id: running[0].id, businessId: businessA.id },
  });
  check(
    "Stopped time card stayed on this job",
    clockedOut?.jobId === jobId && clockedOut.status !== "RUNNING",
  );

  const correctedStart = new Date("2026-09-29T10:00:00");
  const correctedEnd = new Date("2026-09-29T11:30:00");
  setTestAccess(ownerB);
  await expectThrow(
    "Tenant B cannot correct tenant A's time card",
    () =>
      correctTimeEntry(prisma, ownerB, {
        timeEntryId: running[0].id,
        startedAt: correctedStart,
        endedAt: correctedEnd,
        reason: "Cross-tenant edit",
        timeZone: "America/New_York",
      }),
    (error) => error instanceof TimeCardError,
  );
  setTestAccess(ownerA);
  await correctTimeEntry(prisma, ownerA, {
    timeEntryId: running[0].id,
    startedAt: correctedStart,
    endedAt: correctedEnd,
    jobId,
    reason: "Record the on-site blind installation",
    timeZone: "America/New_York",
  });
  await approveTimesheetWeek(prisma, ownerA, {
    membershipId: memberMem.id,
    weekStartedAt: correctedStart,
    timeZone: "America/New_York",
  });
  const approvedTime = await prisma.timeEntry.findFirst({
    where: { id: running[0].id, businessId: businessA.id },
  });
  demand(
    "OWNER approved 1.5 hours of worker time on this job at the $45 wage",
    approvedTime?.status === "APPROVED" &&
      approvedTime.jobId === jobId &&
      closeMoney(approvedTime.approvedHours, PINNED_LABOR_HOURS) &&
      closeMoney(memberMem.hourlyWage, PINNED_LABOR_WAGE) &&
      closeMoney(approvedTime.approvedLaborCost, PINNED_LABOR_COST),
  );
  setTestAccess(memberA);
  await expectThrow(
    "MEMBER cannot approve the timesheet week",
    () =>
      approveTimesheetWeek(prisma, memberA, {
        membershipId: memberMem.id,
        weekStartedAt: clockedOut.startedAt,
        timeZone: "America/New_York",
      }),
    (error) => error instanceof ForbiddenError,
  );

  console.log("\nMATERIALS — purchase actuals become one job expense");
  setTestAccess(ownerA);
  const purchaseList = await ensurePurchaseList(prisma, ownerA, { jobId });
  demand("Job has one purchase list", purchaseList.jobId === jobId && purchaseList.businessId === businessA.id);
  const purchaseItem = await addPurchaseListItem(prisma, ownerA, {
    purchaseListId: purchaseList.id,
    name: "Blind brackets",
    quantityNeeded: "2",
    unit: "ea",
  });
  const purchaseAttempt = randomUUID();
  const purchased = await recordPurchaseOperation(prisma, ownerA, {
    attemptKey: purchaseAttempt,
    itemId: purchaseItem.id,
    quantityPurchased: "2",
    actualUnitCost: "12.50",
    createExpense: true,
    occurredOn: "2027-06-15",
  });
  demand(
    "Purchase recorded one materials expense on this job",
    purchased.expenseId && closeMoney(purchased.actualCost, PINNED_MATERIALS),
  );
  const materialExpense = await prisma.expense.findUnique({ where: { id: purchased.expenseId } });
  demand(
    "Materials expense is tenant-A and job-linked",
    materialExpense?.businessId === businessA.id &&
      materialExpense.jobId === jobId &&
      materialExpense.category === "MATERIALS" &&
      closeMoney(materialExpense.amount, PINNED_MATERIALS),
  );
  const replayPurchase = await recordPurchaseOperation(prisma, ownerA, {
    attemptKey: purchaseAttempt,
    itemId: purchaseItem.id,
    quantityPurchased: "2",
    actualUnitCost: "12.50",
    createExpense: true,
    occurredOn: "2027-06-15",
  });
  await expectThrow(
    "A second purchase attempt cannot link another expense to the same item",
    () =>
      recordPurchaseOperation(prisma, ownerA, {
        attemptKey: randomUUID(),
        itemId: purchaseItem.id,
        quantityPurchased: "2",
        actualUnitCost: "12.50",
        createExpense: true,
        occurredOn: "2027-06-15",
      }),
    (error) => error instanceof MaterialsError,
  );
  const materialExpenseCount = await prisma.expense.count({
    where: { businessId: businessA.id, jobId, category: "MATERIALS", voidedAt: null },
  });
  check(
    "Replayed purchase does not create a second materials expense",
    replayPurchase.expenseId === purchased.expenseId && materialExpenseCount === 1,
  );
  await expectThrow(
    "Tenant B cannot record a purchase on tenant A's item",
    () =>
      recordPurchaseOperation(prisma, ownerB, {
        attemptKey: randomUUID(),
        itemId: purchaseItem.id,
        quantityPurchased: "1",
        actualUnitCost: "99",
        createExpense: true,
        occurredOn: "2027-06-15",
      }),
    (error) => error instanceof MaterialsError || error instanceof Error,
  );

  console.log("\nCHANGE ORDER — field additional work before completion");
  const fieldWork = await requestAssignedJobAdditionalWork(prisma, {
    businessId: businessA.id,
    membershipId: memberMem.id,
  }, {
    jobId,
    description: "Patch the nail holes beside the window.",
  });
  demand("Assigned worker filed additional work on this job", fieldWork.ok === true && fieldWork.request.jobId === jobId);
  const foreignFieldWork = await requestAssignedJobAdditionalWork(prisma, {
    businessId: businessB.id,
    membershipId: ownerBMem.id,
  }, {
    jobId,
    description: "Cross-tenant extra work",
  });
  check("Tenant B cannot file additional work on tenant A's job", foreignFieldWork.ok === false);

  setTestAccess(ownerA);
  const fieldChange = await followRedirect(() =>
    createChangeOrder(
      {},
      form({
        jobId,
        title: "Nail-hole patch",
        additionalWorkRequestId: fieldWork.request.id,
      }),
    ),
  );
  demand(
    "OWNER converted the field request into a draft change order",
    fieldChange.redirected === true && fieldChange.url?.includes(`/jobs/${jobId}/change-orders/`),
  );
  const fieldChangeOrderId = fieldChange.url.split("/").pop();
  const fieldRequestAfter = await prisma.additionalWorkRequest.findUnique({
    where: { id: fieldWork.request.id },
  });
  check(
    "Field request is CONVERTED onto that change order",
    fieldRequestAfter?.status === "CONVERTED" && fieldRequestAfter.changeOrderId === fieldChangeOrderId,
  );
  const priced = await addChangeOrderLineItem(
    {},
    form({
      changeOrderId: fieldChangeOrderId,
      description: "Patch nail holes",
      quantity: "1",
      unitPrice: "40",
      type: "LABOR",
    }),
  );
  demand("OWNER priced the draft change order", !priced?.error);
  const fieldSent = await sendChangeOrder({}, form({ changeOrderId: fieldChangeOrderId }));
  demand("OWNER sent the change order", !fieldSent?.error);
  const wrongTokenChange = await approveChangeOrder(
    {},
    form({ projectToken: randomUUID(), changeOrderId: fieldChangeOrderId }),
  );
  check("Unknown project token cannot approve the change order", Boolean(wrongTokenChange?.error));
  const fieldApproved = await approveChangeOrder(
    {},
    form({ projectToken: scheduledJob.projectToken, changeOrderId: fieldChangeOrderId }),
  );
  demand("Customer token approved the change order", fieldApproved.status === "APPROVED");
  const jobsAfterChange = await prisma.job.count({ where: { businessId: businessA.id, customerId: request.customerId } });
  check("Approving the change order did not create another job", jobsAfterChange === 1);

  console.log("\nCOMPLETE — worker finishes the visit; owner invoices once");
  const workerDone = await completeNativeAssignedJob(prisma, workerAccess.access, jobId);
  demand("Assigned worker completed the field visit", workerDone.ok === true);
  const invoicesAfterFieldComplete = await prisma.invoice.count({
    where: { businessId: businessA.id, jobId },
  });
  check("Worker completion did not create an invoice", invoicesAfterFieldComplete === 0);
  const foreignComplete = await completeNativeAssignedJob(prisma, ownerBNative.access, jobId);
  check("Tenant B cannot complete tenant A's job", foreignComplete.ok === false);

  const completed = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  demand(
    "OWNER complete created a draft original invoice",
    completed.ok === true &&
      completed.invoiceCreated === true &&
      completed.invoiceStatus === "DRAFT" &&
      completed.newlySent === false,
  );
  const sentOriginal = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessA.id,
    invoiceId: completed.invoiceId,
    businessName: businessA.name,
  });
  demand("OWNER explicitly sent the original invoice", sentOriginal.ok === true && sentOriginal.newlySent === true);
  const originalInvoice = await prisma.invoice.findUnique({ where: { id: completed.invoiceId } });
  const fieldChangeOrder = await prisma.changeOrder.findUnique({ where: { id: fieldChangeOrderId } });
  const approvedEstimate = await prisma.estimate.findUnique({ where: { id: estimateCreate.id } });
  demand(
    "Original invoice is SENT on this job and claims the approved change order",
    originalInvoice?.status === "SENT" &&
      originalInvoice.kind === "ORIGINAL" &&
      originalInvoice.jobId === jobId &&
      originalInvoice.customerId === request.customerId &&
      fieldChangeOrder?.invoiceId === originalInvoice.id,
  );
  demand(
    "Approved estimate, field change order, and original invoice totals are independently pinned",
    closeMoney(approvedEstimate.total, PINNED_ESTIMATE_TOTAL) &&
      closeMoney(fieldChangeOrder.total, PINNED_FIELD_CHANGE_ORDER_TOTAL) &&
      closeMoney(originalInvoice.total, PINNED_ORIGINAL_INVOICE_TOTAL),
  );
  const replayComplete = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  const invoiceCountAfterReplay = await prisma.invoice.count({
    where: { businessId: businessA.id, jobId },
  });
  check(
    "Replayed owner complete reuses the invoice",
    replayComplete.ok === true && replayComplete.invoiceReused === true && invoiceCountAfterReplay === 1,
  );

  console.log("\nCARD — fake checkout pays the original invoice");
  const paymentStatus = await getBusinessPaymentStatus(prisma, businessA.id);
  const amountDueCents = invoiceAmountToCents(
    invoiceAmountDue(originalInvoice.status, originalInvoice.total),
  );
  demand(
    "Listed fake Connect account is card-payment-ready",
    paymentStatus.paymentReady === true && amountDueCents > 0,
  );
  check(
    "Pay button is shown only while the invoice is payable",
    shouldShowPayInvoice({
      invoiceStatus: originalInvoice.status,
      amountDueCents,
      paymentReady: true,
      appUrlConfigured: true,
    }) === true &&
      shouldShowPayInvoice({
        invoiceStatus: originalInvoice.status,
        amountDueCents,
        paymentReady: false,
        appUrlConfigured: true,
      }) === false,
  );
  await expectThrow(
    "Unknown project token cannot start checkout",
    () =>
      createCustomerInvoiceCheckout(prisma, randomUUID(), provider, {
        appUrl: "http://127.0.0.1:43217",
      }),
    (error) => error instanceof PaymentError,
  );
  const checkout = await createCustomerInvoiceCheckout(prisma, scheduledJob.projectToken, provider, {
    appUrl: "http://127.0.0.1:43217",
  });
  demand(
    "Customer token checkout matches the original amount due",
    checkout.amountCents === amountDueCents && checkout.id.startsWith("cs_test_"),
  );
  provider.completeCheckout(checkout.id);
  const verified = await provider.findPaidInvoiceCheckout({
    connectedAccountId: FAKE_READY_ACCOUNT,
    invoiceId: originalInvoice.id,
    businessId: businessA.id,
    amountCents: amountDueCents,
    checkoutSessionId: checkout.id,
  });
  demand("Fake provider returned the paid checkout without calling Stripe", Boolean(verified));
  const wrongBusiness = await applyVerifiedCheckoutPayment(prisma, {
    ...verified,
    businessId: businessB.id,
  });
  check(
    "Checkout payment with the other tenant id is refused",
    wrongBusiness.applied === false && wrongBusiness.reason === "business_mismatch",
  );
  const applied = await applyVerifiedCheckoutPayment(prisma, verified);
  demand("Card payment applied to the original invoice", applied.applied === true && applied.reason === "paid");
  const appliedAgain = await applyVerifiedCheckoutPayment(prisma, verified);
  check("Replayed card payment does not apply twice", appliedAgain.applied === false);
  const paidOriginal = await prisma.invoice.findUnique({ where: { id: originalInvoice.id } });
  const stripePayments = await prisma.payment.findMany({
    where: { businessId: businessA.id, invoiceId: originalInvoice.id },
  });
  demand(
    "Original invoice is PAID by one STRIPE payment for the same total",
    paidOriginal?.status === "PAID" &&
      paidOriginal.paymentMethod === "STRIPE" &&
      stripePayments.length === 1 &&
      stripePayments[0].method === "STRIPE" &&
      stripePayments[0].jobId === jobId &&
      closeMoney(stripePayments[0].amount, paidOriginal.total),
  );

  console.log("\nMARK PAID — later approved work bills a supplemental invoice");
  const laterWork = await createCustomerAdditionalWorkRequest(prisma, {
    token: scheduledJob.projectToken,
    catalogItemIds: [patch.id],
    notes: "Please patch the drywall we found behind the blind.",
  });
  demand("Customer token requested additional catalog work on this job", laterWork.ok === true && laterWork.jobId === jobId);
  const spoofedLater = await createCustomerAdditionalWorkRequest(prisma, {
    token: scheduledJob.projectToken,
    catalogItemIds: [foreignCatalog.id],
  });
  check("Customer token cannot request another tenant's catalog item", spoofedLater.ok === false);

  setTestAccess(ownerA);
  const laterChange = await followRedirect(() =>
    createChangeOrder(
      {},
      form({
        jobId,
        title: "Drywall patch",
        additionalWorkRequestId: laterWork.requestId,
      }),
    ),
  );
  demand("OWNER converted the later request into a change order", laterChange.redirected === true);
  const laterChangeOrderId = laterChange.url.split("/").pop();
  const laterDraft = await prisma.changeOrder.findUnique({
    where: { id: laterChangeOrderId },
    include: { lineItems: true },
  });
  demand(
    "Later change order inherited the catalog price on this job",
    laterDraft?.jobId === jobId &&
      laterDraft.lineItems.length === 1 &&
      closeMoney(laterDraft.total, PINNED_SUPPLEMENTAL_INVOICE_TOTAL),
  );
  const laterSent = await sendChangeOrder({}, form({ changeOrderId: laterChangeOrderId }));
  demand("OWNER sent the later change order", !laterSent?.error);
  const laterApproved = await approveChangeOrder(
    {},
    form({ projectToken: scheduledJob.projectToken, changeOrderId: laterChangeOrderId }),
  );
  demand("Customer token approved the later change order", laterApproved.status === "APPROVED");
  const originalUntouched = await prisma.invoice.findUnique({ where: { id: originalInvoice.id } });
  check(
    "Approving later work did not rewrite the original invoice",
    closeMoney(originalUntouched.total, paidOriginal.total) && originalUntouched.status === "PAID",
  );

  const supplementalDraft = await persistDraftInvoiceFromCompletedJob(prisma, {
    businessId: businessA.id,
    jobId,
  });
  demand(
    "Completed job billed the unbilled change order on a new supplemental invoice",
    supplementalDraft.ok === true &&
      supplementalDraft.reused === false &&
      supplementalDraft.kind === "SUPPLEMENTAL" &&
      supplementalDraft.invoiceId !== originalInvoice.id,
  );
  setTestAccess(ownerA);
  const supplementalSend = await followRedirect(() => createInvoiceFromJob(jobId));
  demand(
    "OWNER invoice action sent that supplemental invoice",
    supplementalSend.redirected === true &&
      supplementalSend.url === `/invoices/${supplementalDraft.invoiceId}`,
  );
  const supplemental = await prisma.invoice.findUnique({ where: { id: supplementalDraft.invoiceId } });
  const laterChangeOrder = await prisma.changeOrder.findUnique({ where: { id: laterChangeOrderId } });
  demand(
    "Supplemental invoice is SENT for the later change order only",
    supplemental?.status === "SENT" &&
      supplemental.kind === "SUPPLEMENTAL" &&
      supplemental.jobId === jobId &&
      closeMoney(supplemental.total, PINNED_SUPPLEMENTAL_INVOICE_TOTAL) &&
      laterChangeOrder?.invoiceId === supplemental.id,
  );
  const invoiceCount = await prisma.invoice.count({ where: { businessId: businessA.id, jobId } });
  check("The job has the original invoice and one supplemental invoice", invoiceCount === 2);

  const supplementalDue = invoiceAmountToCents(invoiceAmountDue(supplemental.status, supplemental.total));
  const supplementalCheckout = await createCustomerInvoiceCheckout(
    prisma,
    scheduledJob.projectToken,
    provider,
    { appUrl: "http://127.0.0.1:43217" },
  );
  check(
    "Supplemental invoice is card-payment-ready before Mark Paid",
    supplementalCheckout.amountCents === supplementalDue &&
      shouldShowPayInvoice({
        invoiceStatus: supplemental.status,
        amountDueCents: supplementalDue,
        paymentReady: paymentStatus.paymentReady,
        appUrlConfigured: true,
      }) === true,
  );

  setTestAccess(memberA);
  await expectThrow(
    "MEMBER cannot Mark Paid",
    () =>
      markInvoicePaid(
        {},
        form({
          invoiceId: supplemental.id,
          paymentMethod: "CASH",
          amount: supplemental.total.toString(),
        }),
      ),
    (error) => error instanceof ForbiddenError,
  );
  setTestAccess(ownerB);
  await expectThrow(
    "Tenant B cannot Mark Paid tenant A's invoice",
    () =>
      markInvoicePaid(
        {},
        form({
          invoiceId: supplemental.id,
          paymentMethod: "CASH",
          amount: supplemental.total.toString(),
        }),
      ),
    (error) => error instanceof Error,
  );
  setTestAccess(ownerA);
  const marked = await markInvoicePaid(
    {},
    form({
      invoiceId: supplemental.id,
      paymentMethod: "CASH",
      amount: supplemental.total.toString(),
      paymentReference: "cash-on-site",
    }),
  );
  demand("OWNER Mark Paid the supplemental invoice", !marked?.error);
  const markedAgain = await markInvoicePaid(
    {},
    form({
      invoiceId: supplemental.id,
      paymentMethod: "CHECK",
      amount: supplemental.total.toString(),
    }),
  );
  check("Replayed Mark Paid does not return an error", !markedAgain?.error);
  provider.completeCheckout(supplementalCheckout.id);
  const staleCard = await provider.findPaidInvoiceCheckout({
    connectedAccountId: FAKE_READY_ACCOUNT,
    invoiceId: supplemental.id,
    businessId: businessA.id,
    amountCents: supplementalDue,
    checkoutSessionId: supplementalCheckout.id,
  });
  const staleApplied = await applyVerifiedCheckoutPayment(prisma, staleCard);
  check(
    "A card checkout completed after Mark Paid does not create a second payment",
    staleApplied.applied === false && staleApplied.reason === "already_paid",
  );

  const paidSupplemental = await prisma.invoice.findUnique({ where: { id: supplemental.id } });
  const cashPayments = await prisma.payment.findMany({
    where: { businessId: businessA.id, invoiceId: supplemental.id },
  });
  demand(
    "Supplemental invoice is PAID by one CASH payment",
    paidSupplemental?.status === "PAID" &&
      paidSupplemental.paymentMethod === "CASH" &&
      cashPayments.length === 1 &&
      cashPayments[0].method === "CASH" &&
      cashPayments[0].jobId === jobId &&
      closeMoney(cashPayments[0].amount, paidSupplemental.total),
  );

  console.log("\nCLOSEOUT — customer history and profitability use the same records");
  const history = await prisma.customer.findFirst({
    where: { id: request.customerId, ...ownerA.scope },
    include: {
      serviceRequests: true,
      estimates: true,
      jobs: true,
      invoices: { orderBy: { createdAt: "asc" } },
    },
  });
  const historyContext = history.invoices.map(customerInvoiceHistoryContext);
  check(
    "Customer history lists this request, estimate, job, and both paid invoices",
    history?.id === request.customerId &&
      history.serviceRequests.length === 1 &&
      history.estimates.length === 1 &&
      history.jobs.length === 1 &&
      history.jobs[0].id === jobId &&
      history.invoices.length === 2 &&
      historyContext.every((row) => row.status === "PAID" && row.paidAt && row.paymentMethodLabel),
  );
  check(
    "Customer history payment labels match the card and Mark Paid methods",
    historyContext.some((row) => row.paymentMethod === "STRIPE" && row.paymentMethodLabel === "Card (Stripe)") &&
      historyContext.some((row) => row.paymentMethod === "CASH" && row.paymentMethodLabel === "Cash"),
  );
  const hiddenHistory = await prisma.customer.findFirst({
    where: { id: request.customerId, ...ownerB.scope },
  });
  check("Tenant B customer scope cannot read tenant A's customer", hiddenHistory == null);

  const closeout = await loadJobProfitabilityCloseout(prisma, ownerA, jobId);
  demand("OWNER closeout loads this job", closeout != null && closeout.jobId === jobId);
  demand(
    "Closeout billed, collected, materials, labor, and outstanding are independently pinned",
    closeMoney(closeout.billing.invoiceTotal, PINNED_BILLED_TOTAL) &&
      closeMoney(closeout.billing.recordedPayments, PINNED_COLLECTED_TOTAL) &&
      closeMoney(closeout.billing.outstandingBalance, PINNED_OUTSTANDING) &&
      closeMoney(closeout.actualWork.materialCost.amount, PINNED_MATERIALS) &&
      closeMoney(closeout.actualWork.laborCost.amount, PINNED_LABOR_COST),
  );
  await expectThrow(
    "MEMBER cannot read profitability closeout",
    () => loadJobProfitabilityCloseout(prisma, memberA, jobId),
    (error) => error instanceof ForbiddenError,
  );
  const foreignCloseout = await loadJobProfitabilityCloseout(prisma, ownerB, jobId);
  check("Tenant B closeout does not load tenant A's job", foreignCloseout == null);

  const payments = await prisma.payment.findMany({
    where: { businessId: businessA.id, jobId },
    orderBy: { receivedAt: "asc" },
  });
  const otherPayments = await prisma.payment.count({ where: { businessId: businessB.id } });
  const otherJobs = await prisma.job.count({ where: { businessId: businessB.id } });
  const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
  const finalRequest = await prisma.serviceRequest.findUnique({ where: { id: request.id } });
  const customerChange = await prisma.additionalWorkRequest.findUnique({
    where: { id: laterWork.requestId },
  });

  const graph = {
    businessId: businessA.id,
    customerId: request.customerId,
    jobId,
    workerMembershipId: memberMem.id,
    request: finalRequest,
    customer: history,
    estimate: approvedEstimate,
    job: finalJob,
    jobCount,
    measurementCount: measurementsAfterEstimate,
    requestPhotoCount: request.photos.length,
    jobPhotoCount: 1,
    jobPhotoJobId: jobPhoto.photo.jobId,
    timeEntry: approvedTime,
    expense: materialExpense,
    purchaseItem: purchased,
    purchaseListJobId: purchaseList.jobId,
    fieldRequest: fieldRequestAfter,
    fieldChangeOrder,
    customerRequest: customerChange,
    customerChangeOrder: laterChangeOrder,
    invoices: [paidOriginal, paidSupplemental],
    payments,
    closeout: {
      jobId: closeout.jobId,
      businessId: closeout.businessId,
      invoiceTotal: closeout.billing.invoiceTotal,
      recordedPayments: closeout.billing.recordedPayments,
      outstandingBalance: closeout.billing.outstandingBalance,
      materialCost: closeout.actualWork.materialCost.amount,
      laborCost: closeout.actualWork.laborCost.amount,
    },
    approvedLaborCost: money(approvedTime.approvedLaborCost),
    historyCustomerId: history.id,
    historyJobCount: history.jobs.length,
    historyInvoiceCount: history.invoices.length,
    historyRequestCount: history.serviceRequests.length,
    otherBusinessPaymentCount: otherPayments,
    otherBusinessJobCount: otherJobs,
  };
  demand("Customer, invoice, payment, and closeout records reconcile", operationsGraphHolds(graph));
  demand(
    "Closeout labor cost is the approved time card on this job",
    closeMoney(closeout.actualWork.laborCost.amount, approvedTime.approvedLaborCost),
  );

  console.log("\nMUTATION — each reconciliation rule fails when its fact is wrong");
  const mutations = [
    ["poisoned invoice job", { invoices: graph.invoices.map((invoice) => ({ ...invoice, jobId: "poison" })) }],
    ["missing supplemental invoice", { invoices: [paidOriginal] }],
    ["second conversion job", { jobCount: 2 }],
    ["estimate still DRAFT", { estimate: { ...approvedEstimate, status: "DRAFT" } }],
    ["job left IN_PROGRESS", { job: { ...finalJob, status: "IN_PROGRESS" } }],
    ["time card on another job", { timeEntry: { ...approvedTime, jobId: "other-job" } }],
    ["unapproved time card", { timeEntry: { ...approvedTime, status: "PENDING" } }],
    ["expense on another job", { expense: { ...materialExpense, jobId: "other-job" } }],
    ["purchase not linked to the expense", { purchaseItem: { ...purchased, expenseId: "other" } }],
    ["purchase list on another job", { purchaseListJobId: "other-job" }],
    ["field change order left SENT", { fieldChangeOrder: { ...fieldChangeOrder, status: "SENT" } }],
    ["field change order billed on the supplemental", { fieldChangeOrder: { ...fieldChangeOrder, invoiceId: paidSupplemental.id } }],
    ["original invoice marked CASH", { invoices: [{ ...paidOriginal, paymentMethod: "CASH" }, paidSupplemental] }],
    ["supplemental invoice left SENT", { invoices: [paidOriginal, { ...paidSupplemental, status: "SENT" }] }],
    ["card payment attached to the supplemental invoice", { payments: payments.map((payment) => payment.method === "STRIPE" ? { ...payment, invoiceId: paidSupplemental.id } : payment) }],
    ["closeout outstanding balance", { closeout: { ...graph.closeout, outstandingBalance: 10 } }],
    ["closeout material cost doubled", { closeout: { ...graph.closeout, materialCost: 50 } }],
    ["closeout labor cost zeroed", { closeout: { ...graph.closeout, laborCost: 0 } }],
    ["closeout billed a different total", { closeout: { ...graph.closeout, invoiceTotal: 1 } }],
    ["customer history dropped the job", { historyJobCount: 0 }],
    ["other tenant received a payment", { otherBusinessPaymentCount: 1 }],
    [
      "estimate/catalog amount becomes $0 while change order remains $40",
      { estimate: { ...approvedEstimate, total: 0 } },
    ],
    [
      "original invoice becomes $40",
      { invoices: [{ ...paidOriginal, total: 40 }, paidSupplemental] },
    ],
    [
      "original invoice becomes $185 and drops the change order",
      {
        invoices: [{ ...paidOriginal, total: 185 }, paidSupplemental],
        fieldChangeOrder: { ...fieldChangeOrder, invoiceId: null },
      },
    ],
    [
      "billed/collected total is not $300",
      { closeout: { ...graph.closeout, invoiceTotal: 115, recordedPayments: 115 } },
    ],
    ["empty graph", {}],
  ];
  for (const [label, patch] of mutations) {
    const poisoned = { ...graph, ...patch };
    if (label === "empty graph") {
      check(`MUTATION — ${label} is not consistent`, operationsGraphHolds({}) === false);
    } else {
      check(`MUTATION — ${label} is not consistent`, operationsGraphHolds(poisoned) === false);
    }
  }

  console.log("\nIDs");
  console.log(`  business      ${businessA.id}`);
  console.log(`  request       ${request.id}`);
  console.log(`  customer      ${request.customerId}`);
  console.log(`  estimate      ${estimateCreate.id}`);
  console.log(`  job           ${jobId}  status=${finalJob.status}`);
  console.log(`  original      ${paidOriginal.id}  ${paidOriginal.status}  ${money(paidOriginal.total)}`);
  console.log(`  supplemental  ${paidSupplemental.id}  ${paidSupplemental.status}  ${money(paidSupplemental.total)}`);
  console.log(`  expense       ${materialExpense.id}  ${money(materialExpense.amount)}`);
  console.log(`  time          ${approvedTime.id}  ${approvedTime.status}`);
} catch (error) {
  failed += 1;
  console.error("FAIL - founder-handyman-operations proofs crashed");
  console.error(error);
} finally {
  await session.cleanup();
}

console.log(
  failed === 0
    ? `\nAll founder-handyman-operations checks passed (${passed}).`
    : `\n${failed} founder-handyman-operations check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
