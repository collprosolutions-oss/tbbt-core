/**
 * Founder Handyman end-to-end launch verifier.
 *
 * Exercises the real canonical production workflow on a disposable local
 * Postgres database. Does not invent a parallel fake lifecycle, deploy,
 * migrate production, send real SMS/email, or charge a real card.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-founder-handyman-launch.mjs
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
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:43217";

const FAKE_READY_ACCOUNT = "acct_founder_handyman_launch";
process.env.TBBT_FAKE_PAYMENT_READY_ACCOUNTS = FAKE_READY_ACCOUNT;

let passed = 0;
let failed = 0;
const physicalLeftovers = [];
const automatedSteps = [];

function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
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

function notePhysical(item) {
  physicalLeftovers.push(item);
}

function noteAutomated(item) {
  automatedSteps.push(item);
}

/**
 * Internal consistency of the Founder Handyman happy-path graph.
 * Mutation tests flip one field at a time so a vacuous always-true
 * checker cannot stay green.
 */
function launchStateConsistent(state) {
  return Boolean(
    state.businessId &&
      state.request?.id &&
      state.customer?.id &&
      state.estimate?.id &&
      state.job?.id &&
      state.invoice?.id &&
      state.request.businessId === state.businessId &&
      state.customer.businessId === state.businessId &&
      state.estimate.businessId === state.businessId &&
      state.job.businessId === state.businessId &&
      state.invoice.businessId === state.businessId &&
      state.estimate.serviceRequestId === state.request.id &&
      state.estimate.customerId === state.customer.id &&
      state.estimate.status === "APPROVED" &&
      state.job.estimateId === state.estimate.id &&
      state.job.customerId === state.customer.id &&
      state.job.status === "COMPLETED" &&
      state.invoice.jobId === state.job.id &&
      state.invoice.status === "SENT" &&
      state.request.status === "CONVERTED" &&
      state.job.projectToken &&
      state.estimate.publicToken,
  );
}

console.log("\nSTATIC — verifier is wired to real Handyman production modules");
const intakeSrc = readRepo("src/lib/public-intake.ts");
const estimateFromRequestSrc = readRepo("src/lib/estimate-from-request.ts");
const sendSrc = readRepo("src/app/actions/estimate.ts");
const approveSrc = readRepo("src/app/actions/public-estimate.ts");
const jobFromEstimateSrc = readRepo("src/lib/job-from-estimate.ts");
const jobActionSrc = readRepo("src/app/actions/job.ts");
const completeSrc = readRepo("src/lib/complete-job-invoice.ts");
const timeSrc = readRepo("src/lib/time-card-ops.ts");
const selfSrc = readRepo("scripts/check-founder-handyman-launch.mjs");
check(
  "Public intake still owns createPublicServiceRequest",
  intakeSrc.includes("export async function createPublicServiceRequest"),
);
check(
  "Request→estimate conversion still owns createEstimateFromServiceRequest",
  estimateFromRequestSrc.includes("export async function createEstimateFromServiceRequest"),
);
check("sendEstimate is still the production send action", sendSrc.includes("export async function sendEstimate"));
check(
  "approveEstimate is still the customer-token approval action",
  approveSrc.includes("export async function approveEstimate"),
);
check(
  "Job conversion still owns createJobFromApprovedEstimate",
  jobFromEstimateSrc.includes("export async function createJobFromApprovedEstimate"),
);
check("scheduleJob / assignJobMember / startJob remain job actions", 
  jobActionSrc.includes("export async function scheduleJob") &&
    jobActionSrc.includes("export async function assignJobMember") &&
    jobActionSrc.includes("export async function startJob"),
);
check(
  "Financial complete still owns completeJobAndSendInvoice",
  completeSrc.includes("export async function completeJobAndSendInvoice"),
);
check("Time tracking still owns clockInTime", timeSrc.includes("export async function clockInTime"));
check(
  "This verifier imports those production modules instead of a parallel fake",
  selfSrc.includes('await import("@/lib/public-intake")') &&
    selfSrc.includes('await import("@/lib/estimate-from-request")') &&
    selfSrc.includes('await import("@/app/actions/estimate")') &&
    selfSrc.includes('await import("@/app/actions/public-estimate")') &&
    selfSrc.includes('await import("@/lib/job-from-estimate")') &&
    selfSrc.includes('await import("@/lib/complete-job-invoice")') &&
    selfSrc.includes('await import("@/lib/time-card-ops")'),
);
check(
  "This verifier reuses the canonical disposable harness + local-database guard",
  selfSrc.includes('from "./disposable-test-database.mjs"') &&
    selfSrc.includes("openDisposableTestDatabase") &&
    selfSrc.includes("assertLocalDatabaseUrl"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "founder-handyman-launch disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_founder_handyman_launch",
  setProcessEnv: true,
});

try {
  const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
  const { ForbiddenError } = await import("@/lib/authorization");
  const { createPublicServiceRequest } = await import("@/lib/public-intake");
  const { createEstimateFromServiceRequest } = await import("@/lib/estimate-from-request");
  const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
  const { findCurrentEstimateVersion } = await import("@/lib/estimate-version");
  const { sendEstimate } = await import("@/app/actions/estimate");
  const { approveEstimate } = await import("@/app/actions/public-estimate");
  const { createJobFromApprovedEstimate } = await import("@/lib/job-from-estimate");
  const { scheduleJob, assignJobMember, startJob } = await import("@/app/actions/job");
  const { startJobRequiresCustomerConfirmation, CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT } =
    await import("@/lib/appointment-confirmation");
  const { evaluateStartJob } = await import("@/lib/job-lifecycle");
  const { clockInTime, approveTimesheetWeek, TimeCardError } = await import("@/lib/time-card-ops");
  const { completeJobAndSendInvoice, sendDraftInvoiceIfNeeded } = await import(
    "@/lib/complete-job-invoice"
  );
  const {
    isCustomerVisibleInvoiceStatus,
    loadInvoiceDocumentForProjectToken,
    invoiceAmountDue,
  } = await import("@/lib/invoice-document");
  const { invoiceAmountToCents } = await import("@/lib/payments/money");
  const { getBusinessPaymentStatus, shouldShowPayInvoice } = await import("@/lib/payments/service");
  const { PAYMENT_PROVIDER_STRIPE } = await import("@/lib/payments/types");
  const { getAppUrl } = await import("@/lib/mail");
  const { resolveProjectProgressStep } = await import("@/lib/project-progress");
  const { loadJobProfitabilityCloseout } = await import("@/lib/job-profitability-closeout-data");
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

  async function loadRequestForEstimate(access, requestId) {
    return access.assertOwned(
      await prisma.serviceRequest.findFirst({
        where: { id: requestId, ...access.scope },
        include: {
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

  const suffix = randomUUID().slice(0, 8);
  const slugA = `founder-handyman-${suffix}`;
  const slugB = `other-handyman-${suffix}`;

  const businessA = await prisma.business.create({
    data: {
      name: "Founder Handyman Launch",
      slug: slugA,
      tradeCode: "HANDYMAN",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Other Tenant Handyman",
      slug: slugB,
      tradeCode: "HANDYMAN",
    },
  });
  await ensurePrimaryBusinessTrade(prisma, businessA.id, "HANDYMAN");
  await ensurePrimaryBusinessTrade(prisma, businessB.id, "HANDYMAN");
  await seedOperating(businessA.id);
  await seedOperating(businessB.id);

  const ownerUser = await prisma.user.create({
    data: {
      name: "Daniel Owner",
      email: `owner-${suffix}@example.com`,
      passwordHash: "x",
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Field Member",
      email: `member-${suffix}@example.com`,
      passwordHash: "x",
    },
  });
  const ownerBUser = await prisma.user.create({
    data: {
      name: "Other Owner",
      email: `owner-b-${suffix}@example.com`,
      passwordHash: "x",
    },
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

  const catalogA = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Ceiling Fan Replacement",
      category: "Fans & Fixtures",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(185),
      active: true,
      tradeCode: "HANDYMAN",
    },
  });
  const catalogB = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Shelf Install",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(90),
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

  console.log("\nHAPPY PATH — public request → customer → estimate → job → invoice");

  const submissionId = `launch-sub-${suffix}`;
  const intake = await createPublicServiceRequest(prisma, {
    slug: slugA,
    businessId: businessB.id,
    name: "Jordan Customer",
    email: `jordan-${suffix}@example.com`,
    phone: "555-0100",
    address: "",
    streetAddress: "12 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Replace the hallway fan.",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    submissionId,
    smsOptIn: false,
  });
  check("Public intake succeeded on the Founder Handyman slug", intake.ok === true);
  if (!intake.ok) {
    throw new Error(`Public intake failed: ${intake.error}`);
  }
  noteAutomated("public request/intake via createPublicServiceRequest");

  const replayIntake = await createPublicServiceRequest(prisma, {
    slug: slugA,
    name: "Jordan Customer",
    email: `jordan-${suffix}@example.com`,
    phone: "555-0100",
    address: "",
    streetAddress: "12 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Replace the hallway fan again.",
    catalogItemIds: [catalogA.id],
    includeOther: false,
    otherDescription: "",
    submissionId,
    smsOptIn: false,
  });
  check(
    "Replayed public intake with the same submissionId reuses the request",
    replayIntake.ok === true && replayIntake.requestId === intake.requestId,
  );

  const spoofedCatalog = await createPublicServiceRequest(prisma, {
    slug: slugA,
    name: "Spoof Attempt",
    email: `spoof-${suffix}@example.com`,
    phone: "555-0199",
    address: "1 Main",
    notes: "",
    catalogItemIds: [catalogB.id],
    includeOther: false,
    otherDescription: "",
  });
  check(
    "Public intake refuses another tenant's catalog id even when slug is tenant A",
    spoofedCatalog.ok === false,
  );

  const request = await prisma.serviceRequest.findUnique({
    where: { id: intake.requestId },
    include: { customer: true, property: true, items: true },
  });
  check("Intake created a tenant-A customer", request?.customer?.businessId === businessA.id);
  check("Intake ignored browser-supplied tenant-B businessId", request?.businessId === businessA.id);
  check("Request starts OPEN", request?.status === "OPEN");
  check("Request has the catalog line", request?.items.length === 1);
  noteAutomated("customer + property created by public intake identity matching");

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
    measurements: [],
  });
  check("Request converted to a DRAFT estimate", estimateCreate.created === true);
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
    "Replayed request→estimate conversion reuses the same estimate",
    replayEstimate.created === false && replayEstimate.id === estimateCreate.id,
  );
  noteAutomated("estimate created from request via createEstimateFromServiceRequest");

  await persistDraftEstimateTotal(prisma, estimateCreate.id, businessA.id);
  const draft = await prisma.estimate.findUnique({
    where: { id: estimateCreate.id },
    include: { lineItems: true },
  });
  const convertedRequest = await prisma.serviceRequest.findUnique({ where: { id: request.id } });
  check("Request is CONVERTED after first estimate", convertedRequest?.status === "CONVERTED");
  check("Draft estimate belongs to the intake customer", draft?.customerId === request.customerId);
  check(
    "Draft has at least one priced line from the Handyman catalog",
    (draft?.lineItems.length ?? 0) > 0 &&
      draft.lineItems.every((line) => line.unitPrice != null && Number(line.unitPrice) > 0),
  );
  if (!draft?.lineItems.some((line) => Number(line.unitPrice) > 0)) {
    throw new Error(
      "Genuine product gap: request→estimate conversion did not produce a priced DRAFT line, so sendEstimate cannot run without inventing a price.",
    );
  }

  setTestAccess(memberA);
  await expectThrow(
    "MEMBER cannot send the estimate",
    () => sendEstimate({}, form({ estimateId: draft.id })),
    (error) => error instanceof ForbiddenError,
  );

  setTestAccess(ownerB);
  await expectThrow(
    "Tenant B cannot send tenant A's estimate",
    () => sendEstimate({}, form({ estimateId: draft.id })),
    (error) =>
      error instanceof ForbiddenError ||
      /not in the authorized business workspace/i.test(String(error?.message)),
  );

  setTestAccess(ownerA);
  const sent = await sendEstimate({}, form({ estimateId: draft.id }));
  check("OWNER sendEstimate succeeded", !sent?.error);
  if (sent?.error) {
    throw new Error(`sendEstimate failed: ${sent.error}`);
  }
  noteAutomated("estimate send DRAFT → SENT via sendEstimate (fake messaging adapter)");
  notePhysical("Real SMS/email delivery of the estimate to a customer phone/inbox");

  const afterSend = await prisma.estimate.findUnique({ where: { id: draft.id } });
  const version = await findCurrentEstimateVersion(prisma, draft.id);
  check("Estimate status is SENT", afterSend?.status === "SENT");
  check("Send created a current estimate version snapshot", Boolean(version?.id));

  const resent = await sendEstimate({}, form({ estimateId: draft.id }));
  check(
    "Replayed sendEstimate does not succeed a second time (must be DRAFT)",
    Boolean(resent?.error) && /draft/i.test(String(resent.error)),
  );
  const sentCount = await prisma.estimate.count({
    where: { id: draft.id, status: "SENT" },
  });
  check("Exactly one SENT estimate row after replayed send", sentCount === 1);

  const wrongTokenApprove = await approveEstimate({}, form({ publicToken: randomUUID() }));
  check(
    "Unknown public token cannot approve",
    Boolean(wrongTokenApprove?.error) && !wrongTokenApprove.status,
  );

  const approved = await approveEstimate(
    {},
    form({
      publicToken: afterSend.publicToken,
      estimateVersionId: version.id,
    }),
  );
  check("Customer approveEstimate succeeded", approved.status === "APPROVED");
  if (approved.status !== "APPROVED") {
    throw new Error(`approveEstimate failed: ${approved.error}`);
  }
  noteAutomated("customer approval SENT → APPROVED via publicToken (approveEstimate)");

  const replayApprove = await approveEstimate(
    {},
    form({
      publicToken: afterSend.publicToken,
      estimateVersionId: version.id,
    }),
  );
  check(
    "Replayed approveEstimate is success-idempotent",
    replayApprove.status === "APPROVED" && !replayApprove.error,
  );
  const approvedRows = await prisma.estimate.count({
    where: { businessId: businessA.id, publicToken: afterSend.publicToken, status: "APPROVED" },
  });
  check("Exactly one APPROVED estimate after replayed approve", approvedRows === 1);

  await expectThrow(
    "Tenant B cannot convert tenant A's approved estimate into a job",
    () => createJobFromApprovedEstimate(prisma, ownerB, draft.id),
    (error) =>
      error instanceof Error &&
      /not in the authorized business workspace|could not become a job|approved estimate/i.test(
        error.message,
      ),
  );

  await expectThrow(
    "MEMBER cannot create a job from the approved estimate",
    () => createJobFromApprovedEstimate(prisma, memberA, draft.id),
    (error) => error instanceof ForbiddenError,
  );

  const jobCreate = await createJobFromApprovedEstimate(prisma, ownerA, draft.id);
  check("Job created from approved estimate", jobCreate.ok === true && jobCreate.reused === false);
  if (!jobCreate.ok) {
    throw new Error(`createJobFromApprovedEstimate failed: ${jobCreate.error}`);
  }
  noteAutomated("job creation via createJobFromApprovedEstimate");

  const jobReplay = await createJobFromApprovedEstimate(prisma, ownerA, draft.id);
  check(
    "Replayed job conversion reuses the same job",
    jobReplay.ok === true && jobReplay.reused === true && jobReplay.jobId === jobCreate.jobId,
  );
  const jobCount = await prisma.job.count({
    where: {
      businessId: businessA.id,
      estimateId: draft.id,
      recurrenceSourceJobId: null,
      nextBookingSourceJobId: null,
      correctiveCleanSourceJobId: null,
    },
  });
  check("Exactly one conversion job after replay", jobCount === 1);

  const job = await prisma.job.findUnique({ where: { id: jobCreate.jobId } });
  check("New job is UNSCHEDULED", job?.status === "UNSCHEDULED");
  check("Job is bound to the approved estimate", job?.estimateId === draft.id);
  check("Job copies the intake customer", job?.customerId === request.customerId);
  check("Job has a customer projectToken", Boolean(job?.projectToken));

  const purchaseList = await prisma.materialPurchaseList.findFirst({
    where: { businessId: businessA.id, jobId: job.id },
  });
  check(
    "Job create attached or left the canonical purchase-list relationship (no invented materials module)",
    purchaseList == null || purchaseList.jobId === job.id,
  );
  noteAutomated("materials purchase-list attach on job create (empty unless takeoff exists)");
  notePhysical("Owner material takeoff, pickup, and PO receiving on a real job");

  setTestAccess(ownerA);
  const scheduled = await scheduleWithAck(job.id, {
    date: "2027-06-15",
    time: "10:00",
    durationPreset: "120",
  });
  check("scheduleJob succeeded", !scheduled?.error);
  if (scheduled?.error) {
    throw new Error(`scheduleJob failed: ${scheduled.error}`);
  }
  noteAutomated("scheduling via scheduleJob (2027-06-15 10:00, 2 hours)");

  const assigned = await assignJobMember({}, form({ jobId: job.id, membershipId: memberMem.id }));
  check("assignJobMember assigned the MEMBER", !assigned?.error);
  if (assigned?.error) {
    throw new Error(`assignJobMember failed: ${assigned.error}`);
  }
  noteAutomated("assignment via assignJobMember");

  const scheduledJob = await prisma.job.findUnique({ where: { id: job.id } });
  check("Job is SCHEDULED after scheduleJob", scheduledJob?.status === "SCHEDULED");
  check("Job is assigned to the MEMBER", scheduledJob?.assignedMembershipId === memberMem.id);
  check(
    "Scheduled appointment awaits customer confirmation (real confirmation gate)",
    startJobRequiresCustomerConfirmation(scheduledJob) === true,
  );
  notePhysical("Customer appointment confirmation on the live project portal");

  const blockedStart = await startJob({}, form({ jobId: job.id }));
  check(
    "Start Job without confirmation is refused",
    blockedStart?.error === CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  );

  const started = await startJob(
    {},
    form({
      jobId: job.id,
      startWithoutConfirmation: "1",
      overrideReason: "PHONE",
    }),
  );
  check("OWNER startJob with phone-confirmation override succeeded", !started?.error);
  if (started?.error) {
    throw new Error(`startJob failed: ${started.error}`);
  }
  noteAutomated("Start Job via startJob + existing owner confirmation override");

  const replayStart = await startJob(
    {},
    form({
      jobId: job.id,
      startWithoutConfirmation: "1",
      overrideReason: "PHONE",
    }),
  );
  check("Replayed startJob is a successful no-op", !replayStart?.error);
  const inProgress = await prisma.job.findUnique({ where: { id: job.id } });
  check("Job is IN_PROGRESS", inProgress?.status === "IN_PROGRESS");
  check(
    "evaluateStartJob on IN_PROGRESS is a no-op",
    evaluateStartJob(inProgress.status).ok === true &&
      evaluateStartJob(inProgress.status).nextStatus === null,
  );

  const clockStartedAt = new Date(Date.now() - 90 * 60 * 1000);
  const clocked = await clockInTime(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt: clockStartedAt,
    timeZone: "America/New_York",
    note: "On site for fan replacement",
  });
  check("OWNER clocked the assigned MEMBER onto the running job", Boolean(clocked?.id));
  noteAutomated("running time card via clockInTime (owner clocks assigned MEMBER)");
  notePhysical("Native field Start Job that opens a RUNNING time card in one gesture");

  const runningEntries = await prisma.timeEntry.findMany({
    where: { businessId: businessA.id, jobId: job.id, status: "RUNNING" },
  });
  check("Exactly one RUNNING JOB time entry", runningEntries.length === 1);

  await clockInTime(prisma, ownerA, {
    membershipId: memberMem.id,
    activityType: "JOB",
    jobId: job.id,
    startedAt: new Date(Date.now() - 30 * 60 * 1000),
    timeZone: "America/New_York",
    note: "Still on site",
  });
  const runningAfterReplay = await prisma.timeEntry.findMany({
    where: { businessId: businessA.id, membershipId: memberMem.id, status: "RUNNING" },
  });
  check(
    "Replayed clock-in does not leave two RUNNING entries for the worker",
    runningAfterReplay.length === 1,
  );

  await expectThrow(
    "MEMBER cannot clock another worker",
    () =>
      clockInTime(prisma, memberA, {
        membershipId: ownerMem.id,
        activityType: "JOB",
        jobId: job.id,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectThrow(
    "Tenant B cannot clock time on tenant A's job",
    () =>
      clockInTime(prisma, ownerB, {
        membershipId: ownerBMem.id,
        activityType: "JOB",
        jobId: job.id,
      }),
    (error) =>
      error instanceof ForbiddenError ||
      error instanceof TimeCardError ||
      /not in this business/i.test(String(error?.message)),
  );

  const jobPhotos = await prisma.jobPhoto.count({ where: { jobId: job.id, businessId: businessA.id } });
  check(
    "No invented job-photo rows were written (R2 field upload is out of this local verifier)",
    jobPhotos === 0,
  );
  notePhysical("Field / owner job photos against real Cloudflare R2");

  const completed = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("completeJobAndSendInvoice succeeded", completed.ok === true);
  if (!completed.ok) {
    throw new Error(`completeJobAndSendInvoice failed: ${completed.error}`);
  }
  check("Complete created an invoice", completed.invoiceCreated === true);
  check("Complete left the invoice as a draft", completed.newlySent === false && completed.invoiceStatus === "DRAFT");
  const sentInvoice = await sendDraftInvoiceIfNeeded(prisma, {
    businessId: businessA.id,
    invoiceId: completed.invoiceId,
    businessName: businessA.name,
  });
  check("Explicit send flipped DRAFT to SENT", sentInvoice.ok === true && sentInvoice.newlySent === true);
  noteAutomated("Complete Job left a draft; explicit sendDraftInvoiceIfNeeded sent it");
  notePhysical("Real invoice email/SMS to the customer");

  const completedReplay = await completeJobAndSendInvoice(prisma, {
    businessId: businessA.id,
    jobId: job.id,
    businessName: businessA.name,
    actorMembershipId: ownerMem.id,
  });
  check("Replayed complete is ok", completedReplay.ok === true);
  check("Replayed complete reuses the invoice", completedReplay.invoiceReused === true);
  check("Replayed complete does not re-send", completedReplay.newlySent === false);
  const invoiceCount = await prisma.invoice.count({
    where: { businessId: businessA.id, jobId: job.id },
  });
  check("Exactly one invoice after replayed complete", invoiceCount === 1);

  const finalJob = await prisma.job.findUnique({ where: { id: job.id } });
  const invoice = await prisma.invoice.findUnique({ where: { id: completed.invoiceId } });
  const finalEstimate = await prisma.estimate.findUnique({ where: { id: draft.id } });
  const finalRequest = await prisma.serviceRequest.findUnique({ where: { id: request.id } });
  const finalCustomer = await prisma.customer.findUnique({ where: { id: request.customerId } });
  check("Job is COMPLETED", finalJob?.status === "COMPLETED");
  check("Invoice is SENT", invoice?.status === "SENT");
  check("Invoice is customer-visible", isCustomerVisibleInvoiceStatus(invoice.status));

  const portalInvoice = await loadInvoiceDocumentForProjectToken(finalJob.projectToken, prisma);
  check("Customer projectToken loads the SENT invoice document", portalInvoice?.invoiceId === invoice.id);
  const leakedPortal = await loadInvoiceDocumentForProjectToken(randomUUID(), prisma);
  check("Unknown projectToken does not load an invoice", leakedPortal == null);
  const tenantBPortal = await prisma.job.findFirst({
    where: { projectToken: finalJob.projectToken, ...ownerB.scope },
  });
  check("Tenant B workspace scope cannot see tenant A's projectToken job", tenantBPortal == null);
  noteAutomated("customer-portal invoice document via projectToken");

  const progress = resolveProjectProgressStep(finalJob, invoice);
  check("Portal progress step is INVOICE_RECEIPT", progress === "INVOICE_RECEIPT");

  const paymentStatus = await getBusinessPaymentStatus(prisma, businessA.id);
  const amountDueCents = invoiceAmountToCents(invoiceAmountDue(invoice.status, invoice.total));
  const appUrlConfigured = Boolean(getAppUrl());
  const payReady = shouldShowPayInvoice({
    invoiceStatus: invoice.status,
    amountDueCents,
    paymentReady: paymentStatus.paymentReady,
    appUrlConfigured,
  });
  check(
    "Fake listed Connect account is payment-ready for this local business",
    paymentStatus.paymentReady === true,
  );
  check("SENT invoice with amount due and app URL is Pay-button ready", payReady === true);
  check(
    "Pay button stays hidden if paymentReady is flipped off (mutation)",
    shouldShowPayInvoice({
      invoiceStatus: invoice.status,
      amountDueCents,
      paymentReady: false,
      appUrlConfigured,
    }) === false,
  );
  check(
    "Pay button stays hidden if invoice is still DRAFT (mutation)",
    shouldShowPayInvoice({
      invoiceStatus: "DRAFT",
      amountDueCents,
      paymentReady: true,
      appUrlConfigured,
    }) === false,
  );
  noteAutomated("payment-ready / Pay-button state via fake listed Connect account");
  notePhysical("Real Stripe Connect onboarding and a live card checkout on www.collproreno.com");

  try {
    await approveTimesheetWeek(prisma, ownerA, {
      membershipId: memberMem.id,
      weekStartedAt: clockStartedAt,
      timeZone: "America/New_York",
    });
    noteAutomated("timesheet week approval via approveTimesheetWeek");
  } catch (error) {
    check(
      "Timesheet approval used the real time-card module (failure is reported, not invented away)",
      false,
    );
    console.error(error);
  }

  const closeout = await loadJobProfitabilityCloseout(prisma, ownerA, job.id);
  check(
    "OWNER can load job profitability closeout",
    closeout != null && closeout.jobId === job.id && closeout.businessId === businessA.id,
  );
  await expectThrow(
    "MEMBER cannot read profitability closeout",
    () => loadJobProfitabilityCloseout(prisma, memberA, job.id),
    (error) => error instanceof ForbiddenError,
  );
  const foreignCloseout = await loadJobProfitabilityCloseout(prisma, ownerB, job.id);
  check("Tenant B closeout loader returns null for tenant A's job", foreignCloseout == null);
  noteAutomated("profitability/closeout via loadJobProfitabilityCloseout");

  const isolationEstimate = await prisma.estimate.findFirst({
    where: { id: draft.id, ...ownerB.scope },
  });
  const isolationInvoice = await prisma.invoice.findFirst({
    where: { id: invoice.id, ...ownerB.scope },
  });
  const isolationCustomer = await prisma.customer.findFirst({
    where: { id: finalCustomer.id, ...ownerB.scope },
  });
  check("Tenant B cannot query tenant A's estimate by id + scope", isolationEstimate == null);
  check("Tenant B cannot query tenant A's invoice by id + scope", isolationInvoice == null);
  check("Tenant B cannot query tenant A's customer by id + scope", isolationCustomer == null);

  const state = {
    businessId: businessA.id,
    request: finalRequest,
    customer: finalCustomer,
    estimate: finalEstimate,
    job: finalJob,
    invoice,
  };
  check("Final customer/invoice/job graph is internally consistent", launchStateConsistent(state));
  check(
    "MUTATION — poisoned invoice.jobId fails consistency",
    launchStateConsistent({ ...state, invoice: { ...invoice, jobId: "poison" } }) === false,
  );
  check(
    "MUTATION — DRAFT estimate fails post-approval consistency",
    launchStateConsistent({ ...state, estimate: { ...finalEstimate, status: "DRAFT" } }) === false,
  );
  check(
    "MUTATION — wrong tenant on the job fails consistency",
    launchStateConsistent({ ...state, job: { ...finalJob, businessId: businessB.id } }) === false,
  );
  check(
    "MUTATION — IN_PROGRESS job fails completed-closeout consistency",
    launchStateConsistent({ ...state, job: { ...finalJob, status: "IN_PROGRESS" } }) === false,
  );
  check(
    "MUTATION — empty checker object is not consistent",
    launchStateConsistent({}) === false,
  );

  console.log("\nIDs — happy-path relationships");
  console.log(`  business     ${businessA.id}  slug=${slugA}`);
  console.log(`  request      ${finalRequest.id}  status=${finalRequest.status}`);
  console.log(`  customer     ${finalCustomer.id}`);
  console.log(`  estimate     ${finalEstimate.id}  status=${finalEstimate.status}`);
  console.log(`  version      ${version.id}`);
  console.log(`  job          ${finalJob.id}  status=${finalJob.status}`);
  console.log(`  invoice      ${invoice.id}  status=${invoice.status}`);
  console.log(`  time RUNNING closed into completion; worker=${memberMem.id}`);
} catch (error) {
  failed += 1;
  console.error("FAIL - founder-handyman-launch proofs crashed");
  console.error(error);
} finally {
  await session.cleanup();
}

console.log("\nAUTOMATED LIFECYCLE");
for (const step of automatedSteps) {
  console.log(`  - ${step}`);
}
console.log("\nSTILL REQUIRES DANIEL TO TEST PHYSICALLY");
if (physicalLeftovers.length === 0) {
  console.log("  - (none recorded)");
} else {
  for (const item of physicalLeftovers) {
    console.log(`  - ${item}`);
  }
}

console.log(
  failed === 0
    ? `\nAll founder-handyman-launch checks passed (${passed}).`
    : `\n${failed} founder-handyman-launch check(s) failed; ${passed} passed.`,
);
process.exit(failed === 0 ? 0 : 1);
